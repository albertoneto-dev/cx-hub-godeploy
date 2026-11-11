import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Como em `processRefund.test.ts` e `processResend.test.ts`: o dedup e a fila têm testes próprios, e a linha na
// planilha também (`gravarLinha*.test.ts`). Aqui importa o que o `process*` faz com as marcas sem Cosmos (ADR-013).
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
import { buildRefundRow, COLUNA_DA_CHAVE_PIX, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import { processResend } from '@modules/reenvios/actions/processResend';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { stubRegistroEnv } from '../helpers/registro-env';

const buscar = vi.mocked(solicitacaoRecenteNoRegistro);
const enfileirar = vi.mocked(enfileirarCasos);
const planilhas = vi.mocked(gravarNasPlanilhas);

const PIX = 'cliente.secreta@exemplo.com';
const REEMBOLSO: RefundSubmissionData = {
    brand: 'apice',
    data_criacao: '20/10/2026',
    handledBy: 'Ana',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'T-1',
    originWarehouse: 'CD ES',
    customerName: 'Cliente',
    invoiceNumber: '-',
    nfeAccessKey: '',
    batchNumber: 'L1',
    ecommerceOrderId: 'SH1629891AP',
    policyException: false,
    refundAmount: 94.82,
    refundReason: 'Ruptura de Estoque',
    refundScope: 'AP001 - 1',
    requiresReturn: false,
    carrierTicketId: null,
    carrierName: 'J&T Express',
    orderStatus: 'Pedido não foi enviado',
    isFullRefund: false,
    notes: null,
    pixKey: PIX,
};

/** 05/11/2026 15:00 em SP */
const AGORA = new Date(Date.UTC(2026, 10, 5, 18, 0, 0));

beforeEach(() => {
    buscar.mockReset().mockResolvedValue(null);
    enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
    vi.mocked(prazoDaFila).mockReset().mockReturnValue(1_900_000_000_000);
    planilhas.mockReset().mockResolvedValue({ ok: true });
    stubRegistroEnv();
    // As planilhas das marcas sem Cosmos só existem em produção, por enquanto.
    vi.stubEnv('SHEETS_ENV', 'prod');
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('processRefund — marcas sem Cosmos', () => {
    it('registra na fila e na planilha da marca; a chave Pix vai só para a linha, nunca para a fila', async () => {
        const { body, status } = await processRefund('apice', REEMBOLSO, { agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS');
        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ tipo: 'REEMBOLSO', marca: 'apice', numero_pedido: 'SH1629891AP', valor: 94.82 });
        expect(problemaNoCaso(caso)).toBeNull();
        expect(JSON.stringify(enfileirar.mock.calls)).not.toContain(PIX);

        const [linhas] = planilhas.mock.calls[0];
        expect(linhas).toHaveLength(1);
        expect(linhas[0]).toMatchObject({ fluxo: 'reembolso', marca: 'apice', colunasSensiveis: [COLUNA_DA_CHAVE_PIX.apice] });
        expect(linhas[0].linha).toEqual(buildRefundRow('apice', prepararReembolso(REEMBOLSO, '05/11/2026 15:00:00')));
    });

    it('sem a planilha da marca no ambiente (staging ainda sem cópia) ⇒ 503 antes do dedup e da fila', async () => {
        vi.stubEnv('SHEETS_ENV', 'staging');

        const { body, status } = await processRefund('yenzah', { ...REEMBOLSO, brand: 'yenzah' }, { agora: AGORA });

        expect(status).toBe(503);
        expect(body.message).toContain('não há planilha de reembolso da marca yenzah em staging');
        expect(buscar).not.toHaveBeenCalled();
        expect(enfileirar).not.toHaveBeenCalled();
        expect(planilhas).not.toHaveBeenCalled();
    });

    it('o Bot registra o reembolso dessas marcas com o cancelamento junto, mas o cancelamento vai só à fila (ADR-015)', async () => {
        const { body, status } = await processRefund('denavita', { ...REEMBOLSO, brand: 'denavita', handledBy: 'Bot' }, { agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS');
        const casos = enfileirar.mock.calls[0][0];
        expect(casos.map((c) => c.tipo)).toEqual(['REEMBOLSO', 'CANCELAMENTO']);
        expect(casos[1]).toMatchObject({
            marca: 'denavita', numero_pedido: 'SH1629891AP', responsavel: 'Bot', tratativa: 'Reembolso', cd_origem: 'CD ES',
        });
        for (const caso of casos) expect(problemaNoCaso(caso)).toBeNull();
        // Uma linha só, a do reembolso: não há planilha de cancelamento das marcas sem Cosmos.
        const [linhas] = planilhas.mock.calls[0];
        expect(linhas.map((l) => l.fluxo)).toEqual(['reembolso']);
    });

    it('só as fórmulas faltaram ⇒ SHEET_WRITE_FAILED, dizendo que a linha entrou e para NÃO repetir', async () => {
        planilhas.mockResolvedValueOnce({ ok: false, motivo: 'a linha 12 entrou, mas as fórmulas da operação não', linhasGravadas: true });

        const { body } = await processRefund('apice', REEMBOLSO, { agora: AGORA });

        expect(body).toMatchObject({ code: 'SHEETS_ERROR', reason: 'SHEET_WRITE_FAILED' });
        expect(body.message).toBe('O reembolso entrou na fila do Metabase, mas a linha entrou na planilha sem as fórmulas de prazo e SLA (o suporte foi avisado para completar). NÃO repita a solicitação.');
    });
});

describe('processResend — marcas sem Cosmos', () => {
    const DATA = { ...RESEND_DATA, numeroPedido: 'SH416884DN', cdOrigem: 'CD MG', cosmosId: '' };

    it('nunca chama o Cosmos, nem com automação no corpo: registra sem automação', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch');

        const { body, status } = await processResend({ brand: 'denavita', data: DATA, token: 'tk', agora: AGORA });

        expect(status).toBe(200);
        expect(body).toMatchObject({ code: 'SUCCESS_SHEETS_ONLY', sentToAPI: false });
        expect(fetchSpy).not.toHaveBeenCalled();
        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ marca: 'denavita', automacao: false, cd_origem: 'CD MG' });
        expect(planilhas.mock.calls[0][0][0]).toMatchObject({ fluxo: 'reenvio', marca: 'denavita' });
    });

    it('sem a planilha da marca no ambiente ⇒ 503 RECORD_UNAVAILABLE antes do dedup', async () => {
        vi.stubEnv('SHEETS_ENV', 'staging');

        const { body, status } = await processResend({ brand: 'apice', data: DATA, agora: AGORA });

        expect(status).toBe(503);
        expect(body).toMatchObject({ code: 'UNKNOWN_ERROR', reason: 'RECORD_UNAVAILABLE', sentToAPI: false });
        expect(body.message).toContain('não há planilha de reenvio da marca apice em staging');
        expect(buscar).not.toHaveBeenCalled();
    });
});
