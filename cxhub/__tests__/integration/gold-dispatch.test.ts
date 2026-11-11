import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('next/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: vi.fn(),
}));
// Os processadores (cada um com o seu teste).
vi.mock('@modules/reembolsos/actions/processRefund', () => ({ processRefund: vi.fn() }));
vi.mock('@shared/lib/cancellation/processCancellation', () => ({ processCancellation: vi.fn() }));
vi.mock('@modules/reenvios/actions/processResend', () => ({ processResend: vi.fn() }));

import { after } from 'next/server';
import { POST as postRefund } from '../../app/api/refund/submit/route';
import { POST as postCancellation } from '../../app/api/cancellation/submit/route';
import { POST as postSheetsAppend } from '../../app/api/sheets/append/route';
import { POST as postBot } from '../../app/api/reenvio/bot/route';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import { processCancellation } from '@shared/lib/cancellation/processCancellation';
import { processResend } from '@modules/reenvios/actions/processResend';
import { createRequest } from '../helpers/api-test-utils';

/**
 * O registro é a fila do Metabase e a planilha (ADR-010, ADR-012): o processador entrega o caso à fila e grava a
 * linha antes de responder. Nada pode ficar agendado para depois da resposta — uma cópia entregaria o mesmo caso duas
 * vezes. A fila fica configurada: um agendamento indevido apareceria no `after`, e uma chamada solta, no `fetch`.
 */

function instalarFetch() {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        throw new Error(`fetch inesperado: ${String(input)}`);
    });
}

const REFUND_DATA = {
    brand: 'lescent', data_criacao: '06/10/2026', handledBy: 'Agente Teste', sourceChannel: 'Chat Atendimento',
    supportTicketId: '123456', originWarehouse: 'CD ES', customerName: 'Cliente Teste', invoiceNumber: '12345',
    nfeAccessKey: '', batchNumber: null, ecommerceOrderId: 'SH9000002LE', policyException: false,
    refundAmount: 59.9, refundReason: 'Extravio', refundScope: 'Frete', requiresReturn: false,
    carrierTicketId: null, carrierName: 'Jadlog', orderStatus: 'Entregue', isFullRefund: false, notes: null,
};

const CANCEL_DATA = {
    brand: 'rituaria', 'Responsável': 'Agente Teste', 'Nome do(a) cliente': 'Cliente Teste',
    'Número do pedido (Shopify)': 'SH9000003RT', 'Observações': '', 'Número da NF': '12345',
    'CD de origem': 'CD ES', 'Status': 'Pendente', 'Local da Tratativa': 'Unilog', 'Tratativa': 'Reenvio',
};

const RESEND_DATA = {
    timestamp: '27/10/2026, 14:00:00', dataSolicitacao: '27/10/2026', data_criacao: '06/10/2026',
    tipoSolicitacao: 'Reenvio', responsavel: 'Agente Teste', origemReclamacao: 'Chat Atendimento',
    idAtendimento: '123456', cdOrigem: 'CD ES', nomeCliente: 'Cliente Teste', telefoneCliente: '',
    enderecoCliente: 'Rua A, 1', cep: '29000-000', estado: 'ES', numeroPedido: 'SH9000001KS', numeroNF: '12345',
    chaveNF: '', cosmosId: '987', produtoComProblema: 'SKU-A', produtoReenviar: 'SKU-A - 1', loteProduto: '',
    problemaProduto: 'Produto vazando', transportadoraOriginal: 'Jadlog', transportadoraReenvio: 'Jadlog',
    devolucao: 'Não', ticketTransportadora: '', statusPedido: 'Entregue', ReenvioCompleto: 'Sim',
    valorReenvio: '', status: '', codNfd: '', automacao: '', erp: '', comentarios: '',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('nada é agendado para depois da resposta', () => {
    beforeEach(() => {
        vi.mocked(after).mockReset();
        vi.mocked(processRefund).mockReset();
        vi.mocked(processCancellation).mockReset();
        vi.mocked(processResend).mockReset();
        vi.stubEnv('TIMEOUT', '10000');
        vi.stubEnv('CXHUB_FILA_URL', 'https://cx-hub.test');
        vi.stubEnv('CXHUB_FILA_TOKEN', 'token-da-fila');
        for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
        instalarFetch();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('reembolso: a resposta é a do processRefund, e a fila não é chamada pela rota', async () => {
        vi.mocked(processRefund).mockResolvedValue({
            body: { code: 'SUCCESS', message: 'Reembolso registrado com sucesso' }, status: 200,
        });

        const res = await postRefund(createRequest('http://localhost/api/refund/submit', {
            method: 'POST', body: { brand: 'lescent', data: REFUND_DATA },
        }));

        expect(await res.json()).toEqual({ code: 'SUCCESS', message: 'Reembolso registrado com sucesso' });
        expect(processRefund).toHaveBeenCalledTimes(1);
        expect(after).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('cancelamento: a resposta é a do processCancellation, e a fila não é chamada pela rota', async () => {
        vi.mocked(processCancellation).mockResolvedValue({
            body: { code: 'SUCCESS', message: 'Cancelamento registrado com sucesso' }, status: 200,
        });

        const res = await postCancellation(createRequest('http://localhost/api/cancellation/submit', {
            method: 'POST', body: { brand: 'rituaria', data: CANCEL_DATA },
        }));

        expect(await res.json()).toEqual({ code: 'SUCCESS', message: 'Cancelamento registrado com sucesso' });
        expect(processCancellation).toHaveBeenCalledTimes(1);
        expect(after).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('reenvio da tela: a resposta é a do processResend, e a fila não é chamada pela rota', async () => {
        vi.mocked(processResend).mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'Reenvio registrado com sucesso.', sentToAPI: false }, status: 200,
        });

        const res = await postSheetsAppend(createRequest('http://localhost/api/sheets/append', {
            method: 'POST', body: { brand: 'kokeshi', data: RESEND_DATA },
        }));

        expect(await res.json()).toEqual({ code: 'SUCCESS_SHEETS_ONLY', message: 'Reenvio registrado com sucesso.', sentToAPI: false });
        expect(processResend).toHaveBeenCalledTimes(1);
        expect(after).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('reenvio do bot degradado: o processResend registra com o requestId como id do caso, e nada é agendado', async () => {
        vi.stubEnv('BOT_RESEND_SECRET', 'segredo-do-bot');
        vi.stubEnv('COSMOS_API_URL', undefined as unknown as string);
        vi.mocked(processResend).mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'Reenvio registrado com sucesso.', sentToAPI: false }, status: 200,
        });

        const res = await postBot(createRequest('http://localhost/api/reenvio/bot', {
            method: 'POST',
            headers: { 'x-bot-secret': 'segredo-do-bot' },
            body: {
                brand: 'lescent',
                handledBy: 'Agente Teste',
                order: { ecommerceOrderId: '#220183' },
                reshipment: { isFullReshipment: true, reason: 'Produto avariado', carrier: { name: 'Jadlog' } },
            },
        }));

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ code: 'SUCCESS_SHEETS_ONLY' });
        expect(processResend).toHaveBeenCalledTimes(1);
        const entrada = vi.mocked(processResend).mock.calls[0][0];
        expect(entrada.idSolicitacao).toMatch(UUID);
        expect(typeof entrada.prazoFila).toBe('number');
        expect(after).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
