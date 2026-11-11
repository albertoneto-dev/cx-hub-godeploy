import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Como em `processSemCosmos.test.ts`: o dedup e a fila têm testes próprios. Aqui importa o que o `process*` faz com a
// Gobeaute (ADR-014): registra só na fila, sem planilha, e sem precisar da configuração do Google.
vi.mock('@shared/lib/fila', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/fila')>()),
    solicitacaoRecenteNoRegistro: vi.fn(),
    enfileirarCasos: vi.fn(),
    prazoDaFila: vi.fn(),
}));
vi.mock('@shared/lib/sheets/gravarLinha', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/sheets/gravarLinha')>()),
    gravarNasPlanilhas: vi.fn(),
}));

import { problemaNoCaso } from '@shared/lib/airflow';
import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro } from '@shared/lib/fila';
import { gravarNasPlanilhas } from '@shared/lib/sheets/gravarLinha';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import { processResend } from '@modules/reenvios/actions/processResend';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { REGISTRO_ENV } from '../helpers/registro-env';

const buscar = vi.mocked(solicitacaoRecenteNoRegistro);
const enfileirar = vi.mocked(enfileirarCasos);
const planilhas = vi.mocked(gravarNasPlanilhas);

const REEMBOLSO: RefundSubmissionData = {
    brand: 'gobeaute',
    data_criacao: '06/11/2026',
    handledBy: 'Ana',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'T-1',
    originWarehouse: 'CD SP',
    customerName: 'Cliente',
    invoiceNumber: '-',
    nfeAccessKey: '',
    batchNumber: 'L1',
    ecommerceOrderId: 'SH1041GB',
    policyException: false,
    refundAmount: 129.9,
    refundReason: 'Ruptura de Estoque',
    refundScope: 'RT01022 - 1',
    requiresReturn: false,
    carrierTicketId: null,
    carrierName: 'J&T',
    orderStatus: 'Pedido não foi enviado',
    isFullRefund: false,
    notes: null,
};

const REENVIO = { ...RESEND_DATA, numeroPedido: 'SH1041GB', cdOrigem: 'CD SP', cosmosId: '' };

/** 06/11/2026 15:00 em SP */
const AGORA = new Date(Date.UTC(2026, 10, 6, 18, 0, 0));

beforeEach(() => {
    buscar.mockReset().mockResolvedValue(null);
    enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
    vi.mocked(prazoDaFila).mockReset().mockReturnValue(1_900_000_000_000);
    planilhas.mockReset().mockResolvedValue({ ok: true });
    // Só a fila: a Gobeaute não depende da configuração do Google.
    vi.stubEnv('CXHUB_FILA_URL', REGISTRO_ENV.CXHUB_FILA_URL);
    vi.stubEnv('CXHUB_FILA_TOKEN', REGISTRO_ENV.CXHUB_FILA_TOKEN);
    for (const nome of ['GOOGLE_PLANILHAS_EMAIL', 'GOOGLE_PLANILHAS_TOKEN', 'SHEETS_ENV']) vi.stubEnv(nome, '');
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('processResend — Gobeaute', () => {
    it('registra só na fila, sem planilha e sem chamar o Cosmos, mesmo com automação no corpo', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch');

        const { body, status } = await processResend({
            brand: 'gobeaute', data: { ...REENVIO, automacao: 'Automação' }, token: 'tk', agora: AGORA,
        });

        expect(status).toBe(200);
        expect(body).toMatchObject({ code: 'SUCCESS_SHEETS_ONLY', sentToAPI: false });
        expect(body.idSolicitacao).toMatch(/^[0-9a-f-]{36}$/);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(planilhas).not.toHaveBeenCalled();
        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ tipo: 'REENVIO', marca: 'gobeaute', numero_pedido: 'SH1041GB', automacao: false, cd_origem: 'CD SP' });
        expect(caso.id_solicitacao).toBe(body.idSolicitacao);
        expect(problemaNoCaso(caso)).toBeNull();
    });

    it('o dedup de 24h vale como nas outras marcas', async () => {
        buscar.mockResolvedValueOnce({ pedido: 'SH1041GB', responsavel: 'Bia', solicitadoEm: '2026-11-06T12:00:00.000Z', idSolicitacao: 'x' });

        const { body } = await processResend({ brand: 'gobeaute', data: REENVIO, agora: AGORA });

        expect(body.code).toBe('DUPLICATE_RESEND');
        expect(buscar).toHaveBeenCalledWith('REENVIO', 'gobeaute', 'SH1041GB');
        expect(enfileirar).not.toHaveBeenCalled();
    });

    it('fila incerta ⇒ ROW_UNCERTAIN com o id, sem falar de planilha, para NÃO repetir', async () => {
        enfileirar.mockResolvedValueOnce({ status: 'incerto', motivo: 'timeout' });

        const { body, status } = await processResend({ brand: 'gobeaute', data: REENVIO, agora: AGORA });

        expect(status).toBe(200);
        expect(body).toMatchObject({ code: 'SHEETS_ERROR', reason: 'ROW_UNCERTAIN', sentToAPI: false });
        expect(body.idSolicitacao).toBeTruthy();
        expect(body.message).toContain('NÃO repita');
        expect(body.message).not.toMatch(/planilha/i);
        expect(planilhas).not.toHaveBeenCalled();
    });

    it('fila recusou ⇒ RECORD_UNAVAILABLE, nada registrado', async () => {
        enfileirar.mockResolvedValueOnce({ status: 'recusado', motivo: 'marca desconhecida: gobeaute' });

        const { body } = await processResend({ brand: 'gobeaute', data: REENVIO, agora: AGORA });

        expect(body).toMatchObject({ code: 'SHEETS_ERROR', reason: 'RECORD_UNAVAILABLE', sentToAPI: false });
        expect(planilhas).not.toHaveBeenCalled();
    });

    it('sem a fila configurada ⇒ 503 antes do dedup', async () => {
        vi.stubEnv('CXHUB_FILA_URL', '');

        const { body, status } = await processResend({ brand: 'gobeaute', data: REENVIO, agora: AGORA });

        expect(status).toBe(503);
        expect(body).toMatchObject({ code: 'UNKNOWN_ERROR', reason: 'RECORD_UNAVAILABLE' });
        expect(body.message).toContain('CXHUB_FILA');
        expect(buscar).not.toHaveBeenCalled();
    });
});

describe('processRefund — Gobeaute', () => {
    it('registra só na fila, sem planilha e sem a configuração do Google', async () => {
        const { body, status } = await processRefund('gobeaute', REEMBOLSO, { agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS');
        expect(body.idSolicitacao).toBeTruthy();
        expect(planilhas).not.toHaveBeenCalled();
        const [casos] = enfileirar.mock.calls[0];
        expect(casos).toHaveLength(1);
        expect(casos[0]).toMatchObject({ tipo: 'REEMBOLSO', marca: 'gobeaute', numero_pedido: 'SH1041GB', valor: 129.9 });
        expect(problemaNoCaso(casos[0])).toBeNull();
    });

    it('fila incerta ⇒ 504 API_TIMEOUT com o id, sem falar de planilha, para NÃO repetir', async () => {
        enfileirar.mockResolvedValueOnce({ status: 'incerto', motivo: 'timeout' });

        const { body, status } = await processRefund('gobeaute', REEMBOLSO, { agora: AGORA });

        expect(status).toBe(504);
        expect(body.code).toBe('API_TIMEOUT');
        expect(body.idSolicitacao).toBeTruthy();
        expect(body.message).toContain('NÃO repita');
        expect(body.message).not.toMatch(/planilha/i);
    });

    it('fila recusou ⇒ SHEETS_ERROR, nada registrado', async () => {
        enfileirar.mockResolvedValueOnce({ status: 'recusado', motivo: 'marca desconhecida: gobeaute' });

        const { body } = await processRefund('gobeaute', REEMBOLSO, { agora: AGORA });

        expect(body.code).toBe('SHEETS_ERROR');
        expect(planilhas).not.toHaveBeenCalled();
    });

    it('o Bot registra o reembolso da Gobeaute com o cancelamento, os dois só na fila (ADR-015)', async () => {
        const { body, status } = await processRefund('gobeaute', { ...REEMBOLSO, handledBy: 'Bot' }, { agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS');
        const casos = enfileirar.mock.calls[0][0];
        expect(casos.map((c) => [c.tipo, c.marca])).toEqual([['REEMBOLSO', 'gobeaute'], ['CANCELAMENTO', 'gobeaute']]);
        expect(casos[1]).toMatchObject({ tratativa: 'Reembolso', responsavel: 'Bot' });
        expect(planilhas).not.toHaveBeenCalled();
    });
});
