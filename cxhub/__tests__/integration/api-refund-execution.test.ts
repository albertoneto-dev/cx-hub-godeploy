import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Quem conclui e sincroniza é o refundExecucao, que tem teste próprio. Aqui só a fiação das rotas — por isso ele é
// substituído.
vi.mock('@modules/reembolsos/actions/refundExecucao', () => ({
    concluirReembolso: vi.fn(),
    sincronizarReembolso: vi.fn(),
}));

import { POST as completeRefundRoute } from '../../app/api/refund/complete/route';
import { POST as syncRefundRoute } from '../../app/api/refund/sync/route';
import { concluirReembolso, sincronizarReembolso } from '@modules/reembolsos/actions/refundExecucao';
import type { RefundManagementCode, RefundManagementReason } from '@modules/reembolsos/types';
import { JANELA_ETAPA_DA_GESTAO_MS } from '@modules/reembolsos/actions/refundGestaoDeps';
import { JANELA_PLANILHA_MS } from '@shared/lib/sheets/gravarLinha';
import { createRequest } from '../helpers/api-test-utils';

const concluirMock = vi.mocked(concluirReembolso);
const sincronizarMock = vi.mocked(sincronizarReembolso);

/**
 * Marcar como concluído (`/api/refund/complete`) e atualizar o acompanhamento (`/api/refund/sync`): o corpo é
 * estrito, o token de quem chamou é conferido no Cosmos antes de qualquer coisa, e o que o refundExecucao
 * responde volta como veio (inclusive o `reason` da planilha).
 */

const AUTH = 'Bearer test-token';
const COSMOS = 'https://api.cosmos.test';

const ID = '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f';
const CORPO = { brand: 'lescent', idSolicitacao: ID, handledBy: '<agente>' };

let tokenCosmos: number;

function instalarFetch() {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.startsWith(`${COSMOS}/organizations/`)) {
            return new Response(JSON.stringify(tokenCosmos === 200 ? [] : { error: 'Token inválido' }), { status: tokenCosmos });
        }
        throw new Error(`fetch inesperado: ${url}`);
    });
}

const ROTAS = [
    { nome: 'complete', rota: completeRefundRoute, url: 'http://localhost/api/refund/complete', acao: concluirMock, outra: sincronizarMock },
    { nome: 'sync', rota: syncRefundRoute, url: 'http://localhost/api/refund/sync', acao: sincronizarMock, outra: concluirMock },
];

beforeEach(() => {
    vi.stubEnv('COSMOS_API_URL', COSMOS);
    tokenCosmos = 200;
    concluirMock.mockReset();
    sincronizarMock.mockReset();
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe.each(ROTAS)('POST /api/refund/$nome', ({ rota, url, acao, outra }) => {
    const chamar = (body: unknown, headers: Record<string, string> = { Authorization: AUTH }) =>
        rota(createRequest(url, { method: 'POST', headers, body }));

    it.each<[number, RefundManagementCode, string, RefundManagementReason | undefined]>([
        [200, 'SUCCESS', 'feito', undefined],
        [200, 'SUCCESS', 'feito, mas a planilha não foi atualizada', 'SHEET_ROW_NOT_FOUND'],
        [200, 'NO_CHANGE', 'nada a atualizar', undefined],
        [404, 'NOT_FOUND', 'sem linha na planilha', 'SHEET_ROW_NOT_FOUND'],
        [422, 'ALREADY_EXECUTED', 'já executado', undefined],
        [502, 'SHEETS_ERROR', 'planilha fora do ar', 'SHEET_READ_FAILED'],
        [504, 'API_TIMEOUT', 'repita a ação: repetir não duplica a alteração', undefined],
    ])('confere o token e entrega o pedido validado; o %i %s dele volta como veio', async (status, code, message, reason) => {
        const fetchSpy = instalarFetch();
        const body = reason ? { code, message, reason } : { code, message };
        acao.mockResolvedValue({ status, body });

        // Com espaços e maiúsculas: o que chega é o pedido validado, não o corpo cru.
        const res = await chamar({ brand: ' Lescent ', idSolicitacao: ` ${ID} `, handledBy: ' <agente> ' });

        expect(res.status).toBe(status);
        expect(await res.json()).toEqual(body);
        expect(acao).toHaveBeenCalledTimes(1);
        expect(acao.mock.calls[0][0]).toEqual(CORPO);
        // As dependências (estado, fila e planilha) são montadas pela rota.
        expect(acao.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                planilha: expect.anything(),
                buscarCasoPorId: expect.any(Function),
                enfileirarAtualizacao: expect.any(Function),
                prazoDaPlanilha: expect.any(Function),
                configuracaoQueFalta: expect.any(Function),
                avisar: expect.any(Function),
            }),
        );
        expect(String(fetchSpy.mock.calls[0][0])).toBe(`${COSMOS}/organizations/3/carriers?per_page=1`);
        expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: AUTH });
        expect(outra).not.toHaveBeenCalled();
    });

    it('a etapa da planilha tem a janela própria, contada de agora; não sobrou nada da espera do run da gold', async () => {
        instalarFetch();
        acao.mockResolvedValue({ status: 200, body: { code: 'SUCCESS', message: 'feito' } });

        await chamar(CORPO);

        const deps = acao.mock.calls[0][1];
        expect(deps).not.toHaveProperty('gravarAtualizacaoNaGold');
        expect(deps).not.toHaveProperty('prazoDaGravacao');
        // A etapa da planilha tem a janela própria de 15 s, contada de agora — não os 25 s da gravação da criação: a
        // gestão tem duas etapas, e as duas cabem nos 120 s da rota.
        expect(JANELA_ETAPA_DA_GESTAO_MS).toBe(15_000);
        expect(JANELA_ETAPA_DA_GESTAO_MS).toBeLessThan(JANELA_PLANILHA_MS);
        const planilha = deps.prazoDaPlanilha();
        expect(planilha).toBeGreaterThanOrEqual(Date.now() + JANELA_ETAPA_DA_GESTAO_MS - 1_000);
        expect(planilha).toBeLessThanOrEqual(Date.now() + JANELA_ETAPA_DA_GESTAO_MS);
    });

    it('sem Authorization ⇒ 401, antes de qualquer chamada', async () => {
        const fetchSpy = instalarFetch();

        const res = await chamar(CORPO, {});

        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe('UNAUTHORIZED');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(acao).not.toHaveBeenCalled();
    });

    it('token recusado pelo Cosmos ⇒ 401, sem concluir nem sincronizar', async () => {
        instalarFetch();
        tokenCosmos = 401;

        const res = await chamar(CORPO);

        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe('UNAUTHORIZED');
        expect(acao).not.toHaveBeenCalled();
    });

    it('token sem acesso à marca ⇒ 403', async () => {
        instalarFetch();
        tokenCosmos = 403;

        const res = await chamar(CORPO);

        expect(res.status).toBe(403);
        expect(acao).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
        ['corpo que não é objeto', null],
        ['marca desconhecida', { ...CORPO, brand: 'apice' }],
        ['sem idSolicitacao', { brand: 'lescent', handledBy: '<agente>' }],
        ['idSolicitacao que não é UUID', { ...CORPO, idSolicitacao: '<id>' }],
        ['idSolicitacao com o número do pedido', { ...CORPO, idSolicitacao: 'SH9000105LC' }],
        ['idSolicitacao com espaço no meio', { ...CORPO, idSolicitacao: `${ID} ${ID}` }],
        ['idSolicitacao que não é texto', { ...CORPO, idSolicitacao: 7 }],
        ['sem handledBy', { brand: 'lescent', idSolicitacao: ID }],
        ['handledBy em branco', { ...CORPO, handledBy: '   ' }],
        ['campo desconhecido', { ...CORPO, ecommerceOrderId: '<pedido>' }],
    ])('%s ⇒ 400 INVALID_REQUEST, sem chamar o Cosmos nem a ação', async (_nome, corpo) => {
        const fetchSpy = instalarFetch();

        const res = await chamar(corpo);

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('INVALID_REQUEST');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(acao).not.toHaveBeenCalled();
    });
});
