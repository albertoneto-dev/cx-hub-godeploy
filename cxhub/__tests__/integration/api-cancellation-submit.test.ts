import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ADR-012: quem registra (fila do Metabase e planilha) é o processCancellation, que tem teste próprio. Aqui só a fiação da rota — por isso ele é substituído.
vi.mock('@shared/lib/cancellation/processCancellation', () => ({ processCancellation: vi.fn() }));

import { POST, maxDuration } from '../../app/api/cancellation/submit/route';
import { processCancellation } from '@shared/lib/cancellation/processCancellation';
import type { CancellationResponse } from '@shared/lib/cancellation';
import { createRequest } from '../helpers/api-test-utils';

const processCancellationMock = vi.mocked(processCancellation);

const SAMPLE_CANCELLATION_DATA = {
    brand: 'lescent',
    'Responsável': 'Maria Silva',
    'Nome do(a) cliente': 'João Santos',
    'Número do pedido (Shopify)': '#SHOPIFY220183',
    'Observações': 'Cliente reclamou de produto avariado',
    'Número da NF': '123456',
    'CD de origem': 'Unilog SP',
    'Status': 'Realizado',
    'Local da Tratativa': 'Transportador',
    'Tratativa': 'Reenvio',
};

function postar(body: unknown) {
    return POST(createRequest('http://localhost/api/cancellation/submit', { method: 'POST', body }));
}

describe('POST /api/cancellation/submit', () => {
    beforeEach(() => {
        processCancellationMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('entrega marca e dados ao processCancellation e devolve a resposta dele', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch');
        const resposta: CancellationResponse = { code: 'SUCCESS', message: 'Cancelamento registrado com sucesso', idSolicitacao: 'id-1' };
        processCancellationMock.mockResolvedValue({ body: resposta, status: 200 });

        const res = await postar({ brand: 'lescent', data: SAMPLE_CANCELLATION_DATA });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(resposta);
        expect(processCancellationMock).toHaveBeenCalledTimes(1);
        // Sem opções: o prazo da fila é o padrão.
        expect(processCancellationMock).toHaveBeenCalledWith('lescent', SAMPLE_CANCELLATION_DATA);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('o maxDuration cabe a fila e a planilha com folga', () => {
        expect(maxDuration).toBe(120);
    });

    it('um assincrono que ainda venha no corpo (tela antiga) é ignorado, sem 400', async () => {
        processCancellationMock.mockResolvedValue({ body: { code: 'SUCCESS', message: 'ok' }, status: 200 });

        const res = await postar({ brand: 'lescent', data: SAMPLE_CANCELLATION_DATA, assincrono: 'true' });

        expect(res.status).toBe(200);
        expect(processCancellationMock).toHaveBeenCalledWith('lescent', SAMPLE_CANCELLATION_DATA);
    });

    it('falha do processCancellation volta com o status e o corpo dele', async () => {
        const resposta: CancellationResponse = {
            code: 'API_TIMEOUT',
            message: 'O cancelamento foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (timeout). NÃO repita a solicitação: avise o suporte.',
            idSolicitacao: 'id-1',
        };
        processCancellationMock.mockResolvedValue({ body: resposta, status: 504 });

        const res = await postar({ brand: 'lescent', data: SAMPLE_CANCELLATION_DATA });

        expect(res.status).toBe(504);
        expect(await res.json()).toEqual(resposta);
    });

    it('retorna 400 para brand invalida, sem chegar ao processCancellation', async () => {
        const res = await postar({ brand: 'xyz', data: SAMPLE_CANCELLATION_DATA });

        expect(res.status).toBe(400);
        expect(processCancellationMock).not.toHaveBeenCalled();
    });

    it('retorna 400 se data faltando', async () => {
        const res = await postar({ brand: 'lescent' });

        expect(res.status).toBe(400);
        expect(processCancellationMock).not.toHaveBeenCalled();
    });

    it('retorna 500 se o processCancellation lançar', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        processCancellationMock.mockRejectedValue(new Error('boom'));

        const res = await postar({ brand: 'lescent', data: SAMPLE_CANCELLATION_DATA });

        expect(res.status).toBe(500);
        expect((await res.json()).code).toBe('UNKNOWN_ERROR');
    });
});
