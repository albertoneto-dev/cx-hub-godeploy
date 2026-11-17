import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A NF das marcas do Cosmos pela Intelipost no reenvio e no reembolso (2026-11-17). O pedido do Cosmos V3 chega sem
// invoice_number, e a tela mandava "-": a planilha e a gold ficavam sem NF. Como em `processSemCosmos.test.ts`, o
// dedup, a fila e a planilha têm testes próprios; aqui importa a NF que vai para os dois.
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
vi.mock('@shared/lib/datamart/nfDaIntelipostServer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/datamart/nfDaIntelipostServer')>()),
    nfDaIntelipost: vi.fn(),
}));
vi.mock('@shared/lib/datamart/conferenciaServer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/datamart/conferenciaServer')>()),
    conferirPedidoNoDataMart: vi.fn(),
}));

import { conferirPedidoNoDataMart } from '@shared/lib/datamart/conferenciaServer';
import { nfDaIntelipost } from '@shared/lib/datamart/nfDaIntelipostServer';
import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro } from '@shared/lib/fila';
import { gravarNasPlanilhas } from '@shared/lib/sheets/gravarLinha';
import { buildRefundRow, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import { buildResendRow } from '@modules/reenvios/actions/buildResendRow';
import { processResend } from '@modules/reenvios/actions/processResend';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import type { ResendSubmissionData } from '@modules/reenvios/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { stubRegistroEnv } from '../helpers/registro-env';

const enfileirar = vi.mocked(enfileirarCasos);
const planilhas = vi.mocked(gravarNasPlanilhas);
const daIntelipost = vi.mocked(nfDaIntelipost);

/** 17/11/2026 10:00 em SP */
const AGORA = new Date(Date.UTC(2026, 10, 17, 13, 0, 0));
const CARIMBO = '17/11/2026 10:00:00';

/** Reenvio sem automação (não chama o Cosmos) da Barbour's, com a NF que a tela manda quando o Cosmos não a tem. */
const { apiData: _semAutomacao, ...SEM_API_DATA } = RESEND_DATA;
const REENVIO: ResendSubmissionData = {
    ...SEM_API_DATA, numeroPedido: 'SH2813130BB', numeroNF: '-', automacao: '', status: '', erp: '',
};

const REEMBOLSO: RefundSubmissionData = {
    brand: 'rituaria',
    data_criacao: '01/11/2026',
    handledBy: 'Ana',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'T-1',
    originWarehouse: 'CD ES',
    customerName: 'Cliente',
    invoiceNumber: '-',
    nfeAccessKey: '',
    batchNumber: 'L1',
    ecommerceOrderId: 'SH1398512RT',
    policyException: false,
    refundAmount: 59.9,
    refundReason: 'Produto avariado',
    refundScope: 'RT01001 - 1',
    requiresReturn: false,
    carrierTicketId: null,
    carrierName: 'J&T Express',
    orderStatus: 'Pedido não entregue (em trânsito)',
    isFullRefund: false,
    notes: null,
    pixKey: null,
};

beforeEach(() => {
    vi.mocked(solicitacaoRecenteNoRegistro).mockReset().mockResolvedValue(null);
    enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
    vi.mocked(prazoDaFila).mockReset().mockReturnValue(1_900_000_000_000);
    planilhas.mockReset().mockResolvedValue({ ok: true });
    daIntelipost.mockReset().mockResolvedValue('1470167');
    vi.mocked(conferirPedidoNoDataMart).mockReset().mockResolvedValue({ tipo: 'nao_se_aplica' });
    stubRegistroEnv();
    vi.stubEnv('SHEETS_ENV', 'prod');
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('processResend — NF da Intelipost nas marcas do Cosmos', () => {
    it.each([['-'], [''], ['na']])('NF "%s": a da Intelipost vai para a fila e para a planilha', async (nf) => {
        const { body, status } = await processResend({ brand: 'barbours', data: { ...REENVIO, numeroNF: nf }, agora: AGORA });

        expect(status).toBe(200);
        // Sem automação, o reenvio é só registrado: o Cosmos não é chamado.
        expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
        expect(daIntelipost).toHaveBeenCalledWith('barbours', 'SH2813130BB', expect.any(Number));
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ numero_pedido: 'SH2813130BB', nf: '1470167' });
        const [linhas] = planilhas.mock.calls[0];
        expect(linhas[0].linha).toEqual(buildResendRow('barbours', { ...REENVIO, numeroNF: '1470167' }, CARIMBO));
    });

    it('com NF: fica a que veio, e a Intelipost nem é consultada', async () => {
        await processResend({ brand: 'barbours', data: { ...REENVIO, numeroNF: '1365563' }, agora: AGORA });

        expect(daIntelipost).not.toHaveBeenCalled();
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ nf: '1365563' });
    });

    it('a Intelipost sem NF (ou fora): fica a que veio, e o registro segue', async () => {
        daIntelipost.mockResolvedValue(null);

        const { body } = await processResend({ brand: 'barbours', data: REENVIO, agora: AGORA });

        expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ nf: '-' });
    });

    it('marca sem Cosmos: a NF é da conferência da ADR-018, não deste passo', async () => {
        await processResend({ brand: 'apice', data: { ...REENVIO, numeroPedido: 'SH1731559AP' }, agora: AGORA });

        expect(daIntelipost).not.toHaveBeenCalled();
    });
});

describe('processRefund — NF da Intelipost nas marcas do Cosmos', () => {
    it('NF "-": a da Intelipost vai para a fila e para a planilha', async () => {
        const { body, status } = await processRefund('rituaria', REEMBOLSO, { agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS');
        expect(daIntelipost).toHaveBeenCalledWith('rituaria', 'SH1398512RT', expect.any(Number));
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ numero_pedido: 'SH1398512RT', nf: '1470167' });
        const [linhas] = planilhas.mock.calls[0];
        expect(linhas[0].linha).toEqual(buildRefundRow('rituaria', prepararReembolso({ ...REEMBOLSO, invoiceNumber: '1470167' }, CARIMBO)));
    });

    it('com NF: fica a que veio, e a Intelipost nem é consultada', async () => {
        await processRefund('rituaria', { ...REEMBOLSO, invoiceNumber: '1335172' }, { agora: AGORA });

        expect(daIntelipost).not.toHaveBeenCalled();
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ nf: '1335172' });
    });

    it('a Intelipost sem NF: fica o "-", e o registro segue', async () => {
        daIntelipost.mockResolvedValue(null);

        const { body } = await processRefund('rituaria', REEMBOLSO, { agora: AGORA });

        expect(body.code).toBe('SUCCESS');
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ nf: '-' });
    });

    it('marca sem Cosmos: não passa por este passo', async () => {
        await processRefund('apice', { ...REEMBOLSO, brand: 'apice', ecommerceOrderId: 'SH1629891AP' }, { agora: AGORA });

        expect(daIntelipost).not.toHaveBeenCalled();
    });
});
