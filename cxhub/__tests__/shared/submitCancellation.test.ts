import { describe, it, expect, afterEach, vi } from 'vitest';
import { submitCancellation } from '@shared/lib/cancellation';
import type { CancellationPayload } from '@shared/lib/cancellation';

/**
 * O cliente do cancelamento no navegador (ADR-012): a resposta traz o `idSolicitacao` do caso que foi à fila do
 * Metabase, que a lista acompanha junto da solicitação principal.
 */

const PAYLOAD = { brand: 'barbours' } as CancellationPayload;
const ID = '4efd9528-aad6-445b-93f3-9729a1dc9d75';

describe('submitCancellation', () => {
    afterEach(() => vi.restoreAllMocks());

    it('manda a marca e o payload, sem o assincrono de antes', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ code: 'SUCCESS', message: 'Cancelamento registrado com sucesso', idSolicitacao: ID }),
            { status: 200 },
        ));

        await submitCancellation('barbours', PAYLOAD);

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('/api/cancellation/submit');
        expect(JSON.parse(String(init?.body))).toEqual({ brand: 'barbours', data: PAYLOAD });
    });

    it('SUCCESS volta com o caso que a lista acompanha', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ code: 'SUCCESS', message: 'Cancelamento registrado com sucesso', idSolicitacao: ID }),
            { status: 200 },
        ));

        await expect(submitCancellation('barbours', PAYLOAD)).resolves.toEqual({
            code: 'SUCCESS',
            message: 'Cancelamento registrado com sucesso',
            idSolicitacao: ID,
        });
    });

    it('só a planilha falhou ⇒ o reason e o caso voltam: a lista acompanha o cancelamento no Metabase', async () => {
        const message = 'O cancelamento entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.';
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ code: 'UNKNOWN_ERROR', message, reason: 'SHEET_WRITE_FAILED', idSolicitacao: ID }),
            { status: 200 },
        ));

        await expect(submitCancellation('barbours', PAYLOAD)).resolves.toEqual({
            code: 'UNKNOWN_ERROR',
            message,
            reason: 'SHEET_WRITE_FAILED',
            idSolicitacao: ID,
        });
    });

    it('reason que a tela não conhece e caso que não é texto ficam de fora', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ code: 'SUCCESS', message: 'Cancelamento registrado com sucesso', reason: 'OUTRA_COISA', idSolicitacao: 42 }),
            { status: 200 },
        ));

        await expect(submitCancellation('barbours', PAYLOAD)).resolves.toEqual({
            code: 'SUCCESS',
            message: 'Cancelamento registrado com sucesso',
        });
    });

    it('504 da rota (fila incerta, linha na planilha) ⇒ API_TIMEOUT com o caso', async () => {
        const message = 'O cancelamento foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.';
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ code: 'API_TIMEOUT', message, idSolicitacao: ID }),
            { status: 504 },
        ));

        await expect(submitCancellation('barbours', PAYLOAD)).resolves.toEqual({ code: 'API_TIMEOUT', message, idSolicitacao: ID });
    });

    it('504 que não é da rota (sem corpo) ⇒ API_TIMEOUT sem caso', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>timeout</html>', { status: 504 }));

        await expect(submitCancellation('barbours', PAYLOAD)).resolves.toEqual({
            code: 'API_TIMEOUT',
            message: 'O sistema demorou para responder.',
        });
    });

    it('erro da rota e falha de rede viram UNKNOWN_ERROR', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(
            JSON.stringify({ code: 'UNKNOWN_ERROR', message: 'Erro ao registrar o cancelamento (a fila respondeu HTTP 400).' }),
            { status: 500 },
        ));
        await expect(submitCancellation('barbours', PAYLOAD)).resolves.toEqual({
            code: 'UNKNOWN_ERROR',
            message: 'Erro ao registrar o cancelamento (a fila respondeu HTTP 400).',
        });

        vi.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
        await expect(submitCancellation('barbours', PAYLOAD)).resolves.toEqual({
            code: 'UNKNOWN_ERROR',
            message: 'Erro de conexão ao enviar cancelamento.',
        });
    });
});
