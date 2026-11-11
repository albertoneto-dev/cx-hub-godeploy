import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Quem cancela e edita (fila do Metabase e planilha, ADR-012) é o refundGold, que tem teste próprio. Aqui só a fiação
// das rotas — por isso ele é substituído.
vi.mock('@modules/reembolsos/actions/refundGold', () => ({
    cancelarReembolsoNaGold: vi.fn(),
    editarReembolsoNaGold: vi.fn(),
}));

import { POST as cancelRefundRoute } from '../../app/api/refund/cancel/route';
import { POST as updateRefundRoute } from '../../app/api/refund/update/route';
import { cancelarReembolsoNaGold, editarReembolsoNaGold } from '@modules/reembolsos/actions/refundGold';
import type { RefundManagementCode } from '@modules/reembolsos/types';
import { createRequest } from '../helpers/api-test-utils';

const cancelarNaGoldMock = vi.mocked(cancelarReembolsoNaGold);
const editarNaGoldMock = vi.mocked(editarReembolsoNaGold);

/**
 * Cancelar e editar reembolso. O reembolso não existe no Cosmos: quem altera a solicitação (fila do Metabase e
 * planilha) é o refundGold. O Cosmos só confere o token de quem chamou, como nas rotas de reenvio.
 */

const AUTH = 'Bearer test-token';
const COSMOS = 'https://api.cosmos.test';

const CANCELAR = { brand: 'lescent', ecommerceOrderId: 'SH9000105LC', handledBy: 'Ana', reason: 'Cliente desistiu' };
const EDITAR = { brand: 'lescent', ecommerceOrderId: 'SH9000105LC', handledBy: 'Ana', changes: { refundAmount: 59.9 } };

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

function cancelar(body: unknown, headers: Record<string, string> = { Authorization: AUTH }) {
    return cancelRefundRoute(createRequest('http://localhost/api/refund/cancel', { method: 'POST', headers, body }));
}

function editar(body: unknown, headers: Record<string, string> = { Authorization: AUTH }) {
    return updateRefundRoute(createRequest('http://localhost/api/refund/update', { method: 'POST', headers, body }));
}

beforeEach(() => {
    vi.stubEnv('COSMOS_API_URL', COSMOS);
    tokenCosmos = 200;
    cancelarNaGoldMock.mockReset();
    editarNaGoldMock.mockReset();
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('POST /api/refund/cancel', () => {
    it.each<[number, RefundManagementCode, string]>([
        [200, 'SUCCESS', 'Reembolso cancelado.'],
        [404, 'NOT_FOUND', 'Nenhuma solicitação de reembolso deste pedido.'],
    ])('confere o token e entrega o pedido validado ao refundGold; o %i %s dele volta como veio', async (status, code, message) => {
        const fetchSpy = instalarFetch();
        cancelarNaGoldMock.mockResolvedValue({ status, body: { code, message } });

        // Com espaços e maiúsculas: o que chega ao refundGold é o pedido validado, não o corpo cru.
        const res = await cancelar({ brand: ' Lescent ', ecommerceOrderId: ' SH9000105LC ', handledBy: ' Ana ', reason: ' Cliente desistiu ' });

        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ code, message });
        expect(cancelarNaGoldMock).toHaveBeenCalledTimes(1);
        expect(cancelarNaGoldMock).toHaveBeenCalledWith(CANCELAR, expect.objectContaining({ planilha: expect.anything() }));
        expect(String(fetchSpy.mock.calls[0][0])).toBe(`${COSMOS}/organizations/3/carriers?per_page=1`);
        expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: AUTH });
        expect(editarNaGoldMock).not.toHaveBeenCalled();
    });

    it('sem Authorization recusa antes de qualquer chamada', async () => {
        const fetchSpy = instalarFetch();
        const res = await cancelar(CANCELAR, {});
        expect(res.status).toBe(401);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(cancelarNaGoldMock).not.toHaveBeenCalled();
    });

    it('corpo inválido recusa sem chamar o Cosmos nem o refundGold', async () => {
        const fetchSpy = instalarFetch();
        const res = await cancelar({ ...CANCELAR, brand: 'apice' });
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('INVALID_REQUEST');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(cancelarNaGoldMock).not.toHaveBeenCalled();
    });
});

describe('POST /api/refund/update', () => {
    it.each<[number, RefundManagementCode, string]>([
        [200, 'SUCCESS', 'Reembolso atualizado. As observações não são mais guardadas.'],
        [504, 'API_TIMEOUT', 'Não deu para confirmar a entrada da alteração na fila do Metabase (timeout). Repita a ação: repetir não duplica a alteração.'],
    ])('entrega o pedido validado ao refundGold; o %i %s dele volta como veio', async (status, code, message) => {
        const fetchSpy = instalarFetch();
        editarNaGoldMock.mockResolvedValue({ status, body: { code, message } });

        const res = await editar({
            brand: 'LESCENT', ecommerceOrderId: 'SH9000105LC ', handledBy: ' Ana',
            changes: { refundAmount: 59.9, refundReason: ' Extravio ', notes: ' Cliente pediu PIX ' },
        });

        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ code, message });
        expect(editarNaGoldMock).toHaveBeenCalledTimes(1);
        expect(editarNaGoldMock).toHaveBeenCalledWith({
            brand: 'lescent', ecommerceOrderId: 'SH9000105LC', handledBy: 'Ana',
            changes: { refundAmount: 59.9, refundReason: 'Extravio', notes: 'Cliente pediu PIX' },
        }, expect.objectContaining({ planilha: expect.anything() }));
        expect(String(fetchSpy.mock.calls[0][0])).toBe(`${COSMOS}/organizations/3/carriers?per_page=1`);
        expect(cancelarNaGoldMock).not.toHaveBeenCalled();
    });

    it('campo fora de valor, motivo e observações é recusado', async () => {
        const fetchSpy = instalarFetch();
        const res = await editar({ ...EDITAR, changes: { refundScope: 'Frete' } });
        expect(res.status).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

it('token recusado pelo Cosmos não chega ao refundGold', async () => {
    instalarFetch();
    tokenCosmos = 401;

    const respostas = [await cancelar(CANCELAR), await editar(EDITAR)];

    expect(respostas.map((r) => r.status)).toEqual([401, 401]);
    expect(await respostas[0].json()).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(cancelarNaGoldMock).not.toHaveBeenCalled();
    expect(editarNaGoldMock).not.toHaveBeenCalled();
});

describe.each([
    ['cancel', (body: unknown) => cancelar(body), cancelarNaGoldMock, CANCELAR],
    ['update', (body: unknown) => editar(body), editarNaGoldMock, EDITAR],
])('POST /api/refund/%s: as dependências da gestão', (_nome, chamar, acao, corpo) => {
    it('levam as peças que a gestão precisa (planilha, estado, fila, configuração e aviso)', async () => {
        instalarFetch();
        acao.mockResolvedValue({ status: 200, body: { code: 'SUCCESS', message: 'feito' } });

        await chamar(corpo);

        expect(acao.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                planilha: expect.anything(),
                buscarReembolsoMaisRecente: expect.any(Function),
                buscarCasoPorId: expect.any(Function),
                enfileirarAtualizacao: expect.any(Function),
                prazoDaPlanilha: expect.any(Function),
                configuracaoQueFalta: expect.any(Function),
                avisar: expect.any(Function),
            }),
        );
    });

    it('não sobrou nada da espera do run da gold nas dependências', async () => {
        instalarFetch();
        acao.mockResolvedValue({ status: 200, body: { code: 'SUCCESS', message: 'feito' } });

        await chamar(corpo);

        const deps = acao.mock.calls[0][1];
        expect(deps).not.toHaveProperty('gravarAtualizacaoNaGold');
        expect(deps).not.toHaveProperty('prazoDaGravacao');
    });
});
