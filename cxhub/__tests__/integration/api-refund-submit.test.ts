import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ADR-012: quem registra (fila do Metabase e planilha) é o processRefund, que tem teste próprio. Aqui só a fiação da rota — por isso ele é substituído.
vi.mock('@modules/reembolsos/actions/processRefund', () => ({ processRefund: vi.fn() }));

import { POST, maxDuration } from '../../app/api/refund/submit/route';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import type { RefundSubmitResponse } from '@modules/reembolsos/types';
import { createRequest } from '../helpers/api-test-utils';

const processRefundMock = vi.mocked(processRefund);

const SAMPLE_REFUND_DATA = {
    brand: 'lescent',
    handledBy: 'João Silva',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'TICKET-123',
    originWarehouse: 'SP',
    customerName: 'Cliente Teste',
    invoiceNumber: '123456',
    batchNumber: null,
    ecommerceOrderId: '#SHOPIFY220183',
    refundAmount: 150.50,
    refundReason: 'Cliente desistiu da compra',
    refundScope: 'SKU01 - 1;Frete',
    requiresReturn: false,
    carrierTicketId: null,
    carrierName: 'PAC',
    orderStatus: 'Pedido não foi enviado',
    isFullRefund: true,
    notes: null,
};

function postar(body: unknown) {
    return POST(createRequest('http://localhost/api/refund/submit', { method: 'POST', body }));
}

describe('POST /api/refund/submit', () => {
    beforeEach(() => {
        processRefundMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('entrega marca e dados ao processRefund e devolve a resposta dele', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch');
        const resposta: RefundSubmitResponse = { code: 'SUCCESS', message: 'Reembolso registrado com sucesso', idSolicitacao: 'id-1' };
        processRefundMock.mockResolvedValue({ body: resposta, status: 200 });

        const res = await postar({ brand: 'lescent', data: SAMPLE_REFUND_DATA });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(resposta);
        expect(processRefundMock).toHaveBeenCalledTimes(1);
        // Sem opções: o prazo da fila é o padrão.
        expect(processRefundMock).toHaveBeenCalledWith('lescent', SAMPLE_REFUND_DATA);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('o maxDuration cabe o dedup, a fila e a planilha com folga', () => {
        expect(maxDuration).toBe(120);
    });

    it('um assincrono que ainda venha no corpo (tela antiga) é ignorado, sem 400', async () => {
        processRefundMock.mockResolvedValue({ body: { code: 'SUCCESS', message: 'ok' }, status: 200 });

        const res = await postar({ brand: 'lescent', data: SAMPLE_REFUND_DATA, assincrono: 'true' });

        expect(res.status).toBe(200);
        expect(processRefundMock).toHaveBeenCalledWith('lescent', SAMPLE_REFUND_DATA);
    });

    it('falha do processRefund volta com o status e o corpo dele', async () => {
        const resposta: RefundSubmitResponse = {
            code: 'API_TIMEOUT',
            message: 'O reembolso foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (timeout). NÃO repita a solicitação: avise o suporte.',
            idSolicitacao: 'id-1',
        };
        processRefundMock.mockResolvedValue({ body: resposta, status: 504 });

        const res = await postar({ brand: 'lescent', data: SAMPLE_REFUND_DATA });

        expect(res.status).toBe(504);
        expect(await res.json()).toEqual(resposta);
    });

    it('retorna 400 para brand invalida, sem chegar ao processRefund', async () => {
        const res = await postar({ brand: 'xyz', data: SAMPLE_REFUND_DATA });

        expect(res.status).toBe(400);
        expect(processRefundMock).not.toHaveBeenCalled();
    });

    it('retorna 400 se data faltando', async () => {
        const res = await postar({ brand: 'lescent' });

        expect(res.status).toBe(400);
        expect(processRefundMock).not.toHaveBeenCalled();
    });

    it('retorna 500 se o processRefund lançar', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        processRefundMock.mockRejectedValue(new Error('boom'));

        const res = await postar({ brand: 'lescent', data: SAMPLE_REFUND_DATA });

        expect(res.status).toBe(500);
        expect((await res.json()).code).toBe('UNKNOWN_ERROR');
    });
});
