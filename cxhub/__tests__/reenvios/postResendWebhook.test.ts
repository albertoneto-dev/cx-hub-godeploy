import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// O processResend é substituído para provar que a guarda do INV-02 vale por CIMA dele: se um dia ele
// responder como produção num teste, o transporte barra.
vi.mock('@modules/reenvios/actions/processResend', () => ({
    processResend: vi.fn(),
}));

import { postResendWebhook, type PostResendWebhookResult } from '@modules/reenvios/actions/postResendWebhook';
import { processResend } from '@modules/reenvios/actions/processResend';
import type { SheetsAppendResponse } from '@modules/reenvios/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';

const processResendMock = vi.mocked(processResend);

const VIOLACAO: PostResendWebhookResult = {
    status: 502,
    body: {
        code: 'UNKNOWN_ERROR',
        message: 'O modo de teste foi ignorado pelo fluxo: a resposta indica reenvio real. '
            + 'Um reenvio pode ter sido executado — avise o time antes de repetir.',
        sentToAPI: false,
        reason: 'TEST_MODE_VIOLATION',
    },
};

function processResendResponde(body: SheetsAppendResponse, status = 200): PostResendWebhookResult {
    const resultado = { body, status };
    processResendMock.mockResolvedValue(resultado);
    return resultado;
}

describe('postResendWebhook (ADR-012)', () => {
    beforeEach(() => {
        vi.stubEnv('TIMEOUT', '12000');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        processResendMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    describe('delegação', () => {
        it('chama o processResend e devolve o resultado dele', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch');
            const resultado = processResendResponde({ code: 'SUCCESS', message: 'Reenvio registrado com sucesso.', sentToAPI: true });

            expect(await postResendWebhook({ brand: 'aua', data: RESEND_DATA, token: 't' })).toBe(resultado);

            expect(fetchSpy).not.toHaveBeenCalled();
            expect(processResendMock).toHaveBeenCalledTimes(1);
            expect(processResendMock).toHaveBeenCalledWith({
                brand: 'aua',
                data: RESEND_DATA,
                token: 't',
                testMode: undefined,
                timeoutMs: 12000,
                idSolicitacao: undefined,
                prazoFila: undefined,
            });
        });

        it('repassa o idSolicitacao e o prazoFila de quem chama (o bot)', async () => {
            processResendResponde({ code: 'SUCCESS_SHEETS_ONLY', message: 'Reenvio registrado com sucesso.', sentToAPI: false });

            await postResendWebhook({
                brand: 'kokeshi',
                data: RESEND_DATA,
                token: 'svc',
                testMode: false,
                timeoutMs: 4000,
                idSolicitacao: 'req-123',
                prazoFila: 1_800_000_000_000,
            });

            expect(processResendMock).toHaveBeenCalledWith({
                brand: 'kokeshi',
                data: RESEND_DATA,
                token: 'svc',
                testMode: false,
                timeoutMs: 4000,
                idSolicitacao: 'req-123',
                prazoFila: 1_800_000_000_000,
            });
        });

        it.each([
            ['ausente', ''],
            ['ilegível', 'abc'],
        ])('TIMEOUT %s ⇒ teto padrão de 10s', async (_caso, valor) => {
            vi.stubEnv('TIMEOUT', valor);
            processResendResponde({ code: 'SUCCESS', message: 'Reenvio registrado com sucesso.', sentToAPI: true });

            await postResendWebhook({ brand: 'aua', data: RESEND_DATA });

            expect(processResendMock.mock.calls[0][0].timeoutMs).toBe(10000);
        });

        it('falha do processResend volta como veio, status incluído', async () => {
            const resultado = processResendResponde({
                code: 'UNKNOWN_ERROR',
                message: 'Não foi possível consultar as solicitações recentes — nada foi registrado nem reenviado. Tente novamente.',
                sentToAPI: false,
                reason: 'RECORD_UNAVAILABLE',
            }, 503);

            expect(await postResendWebhook({ brand: 'aua', data: RESEND_DATA })).toBe(resultado);
        });
    });

    describe('INV-02 por cima do processResend', () => {
        it.each([
            ['SUCCESS', true],
            ['SUCCESS_SHEETS_ONLY', false],
            // registro que falhou DEPOIS do Cosmos: o código não é de sucesso, mas o reenvio saiu
            ['SHEETS_ERROR', true],
        ] as const)('pedido de teste que volta com %s (sentToAPI %s) ⇒ 502 TEST_MODE_VIOLATION', async (code, sentToAPI) => {
            processResendResponde({ code, message: 'resposta do fluxo real', sentToAPI });

            const resultado = await postResendWebhook({ brand: 'aua', data: RESEND_DATA, testMode: true });

            expect(processResendMock.mock.calls[0][0].testMode).toBe(true);
            expect(resultado).toEqual(VIOLACAO);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('INV-02 VIOLADO'),
                { brand: 'aua', code, sentToAPI },
            );
        });

        it.each<[string, PostResendWebhookResult]>([
            ['SUCCESS_TEST_MODE', {
                body: { code: 'SUCCESS_TEST_MODE', message: 'Solicitação de TESTE: nada foi registrado e nenhum reenvio foi executado.', sentToAPI: false },
                status: 200,
            }],
            ['DUPLICATE_RESEND', {
                body: { code: 'DUPLICATE_RESEND', message: 'Já existe um reenvio para o pedido 220183 feito por Ana em 27/10/2026 09:00:00', sentToAPI: false },
                status: 200,
            }],
            ['UNKNOWN_ERROR 503', {
                body: {
                    code: 'UNKNOWN_ERROR',
                    message: 'Não foi possível consultar as solicitações recentes — nada foi registrado nem reenviado. Tente novamente.',
                    sentToAPI: false,
                    reason: 'RECORD_UNAVAILABLE',
                },
                status: 503,
            }],
        ])('pedido de teste que volta com %s, sem efeito real, passa como veio', async (_code, resultado) => {
            processResendMock.mockResolvedValue(resultado);

            expect(await postResendWebhook({ brand: 'aua', data: RESEND_DATA, testMode: true })).toBe(resultado);
        });

        it.each([false, undefined])('fora do modo de teste (testMode=%s), o sucesso de produção passa', async (testMode) => {
            const resultado = processResendResponde({ code: 'SUCCESS', message: 'Reenvio registrado com sucesso.', sentToAPI: true });

            expect(await postResendWebhook({ brand: 'aua', data: RESEND_DATA, testMode })).toBe(resultado);
        });
    });
});
