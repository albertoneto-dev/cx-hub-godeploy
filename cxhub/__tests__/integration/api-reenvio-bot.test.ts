import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// O registro (dedup, Cosmos e gold) é do processResend, que tem teste próprio. Aqui só a porta.
vi.mock('@modules/reenvios/actions/processResend', () => ({ processResend: vi.fn() }));

import { NextRequest } from 'next/server';
import { POST } from '../../app/api/reenvio/bot/route';
import { processResend } from '@modules/reenvios/actions/processResend';
import type { SheetsAppendResponse } from '@modules/reenvios/types';
import { createRequest } from '../helpers/api-test-utils';

const processResendMock = vi.mocked(processResend);

/** O que o processResend responde nesta chamada. Devolve o mock, para conferir se foi chamado. */
function responde(body: SheetsAppendResponse) {
    processResendMock.mockResolvedValue({ body, status: 200 });
    return processResendMock;
}

const URL = 'http://localhost/api/reenvio/bot';

const BOT_SECRET = 'segredo-do-bot-123';

function post(body: unknown, headers: Record<string, string> = { 'x-bot-secret': BOT_SECRET }) {
    return POST(createRequest(URL, { method: 'POST', body, headers }));
}

const MINIMAL_TEST_BODY = { brand: 'lescent', testMode: true };

const REAL_BODY = {
    brand: 'lescent',
    handledBy: 'Ana Souza',
    sourceChannel: 'CHAT_ATENDIMENTO',
    supportTicketId: 'TKT-1',
    customer: { name: 'Maria Cliente' },
    order: { ecommerceOrderId: '#220183', invoiceNumber: '123456' },
    reshipment: {
        isFullReshipment: true,
        requiresReturn: false,
        reason: 'Produto avariado',
        problemItems: [{ sku: 'SKU-A' }],
        reshipmentItems: [{ sku: 'SKU-A', quantity: 1 }],
        carrier: { name: 'Jadlog' },
    },
};

describe('POST /api/reenvio/bot', () => {
    beforeEach(() => {
        processResendMock.mockReset();
        vi.stubEnv('TIMEOUT', '10000');
        vi.stubEnv('BOT_RESEND_SECRET', BOT_SECRET);
        // Este arquivo cobre a PORTA (credencial, validação, repasse de código, guarda do INV-02) — não
        // o caminho de automação. Sem as env do Cosmos, o token de serviço falha e toda requisição
        // degrada para registro sem automação, que é o caminho que estes casos exercitam. Explícito de
        // propósito: dependia de as variáveis simplesmente não existirem no ambiente de teste, e a
        // intenção não estava escrita em lugar nenhum. O caminho executando é coberto por
        // api-reenvio-bot-cosmos.test.ts.
        vi.stubEnv('COSMOS_API_URL', undefined as unknown as string);
        vi.stubEnv('COSMOS_EMAIL', undefined as unknown as string);
        vi.stubEnv('COSMOS_PASSWORD', undefined as unknown as string);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    // ─── Validação: nada chega ao registro ────────────────────────────────

    it('1. retorna 400 e não registra quando brand está ausente', async () => {
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post({ testMode: true, order: { ecommerceOrderId: '#1' } });

        expect(res.status).toBe(400);
        expect(registro).not.toHaveBeenCalled();
    });

    it('2. retorna 400 e não registra quando brand não é suportada', async () => {
        const registro = responde({ code: 'SUCCESS', message: 'ok', sentToAPI: true });

        const res = await post({ brand: 'nivea', order: { ecommerceOrderId: '#1' } });

        expect(res.status).toBe(400);
        expect(registro).not.toHaveBeenCalled();
    });

    it('3. retorna 400 e não registra quando testMode não é boolean', async () => {
        const registro = responde({ code: 'SUCCESS', message: 'ok', sentToAPI: true });

        const res = await post({ brand: 'lescent', testMode: 'true', order: { ecommerceOrderId: '#1' } });

        expect(res.status).toBe(400);
        expect(registro).not.toHaveBeenCalled();
    });

    it('4. retorna 400 e não registra sem ecommerceOrderId e sem testMode', async () => {
        const registro = responde({ code: 'SUCCESS', message: 'ok', sentToAPI: true });

        const res = await post({ brand: 'lescent', handledBy: 'Ana' });

        expect(res.status).toBe(400);
        expect(registro).not.toHaveBeenCalled();
    });

    it('4b. retorna 400 (não 500) e não registra quando o JSON está malformado', async () => {
        const registro = responde({ code: 'SUCCESS', message: 'ok', sentToAPI: true });

        const req = new NextRequest(URL, {
            method: 'POST',
            headers: new Headers({ 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }),
            body: '{"brand": "lescent",',
        });
        const res = await POST(req);

        expect(res.status).toBe(400);
        expect(registro).not.toHaveBeenCalled();
    });

    // ─── Aceite ──────────────────────────────────────────────────────

    it('5. aceita payload sem ecommerceOrderId quando testMode=true', async () => {
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post(MINIMAL_TEST_BODY);

        expect(res.status).not.toBe(400);
        expect(registro).toHaveBeenCalledTimes(1);
    });

    it('6. repassa o code do registro e entrega o pedido correto', async () => {
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post(MINIMAL_TEST_BODY);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('SUCCESS_TEST_MODE');
        expect(body.sentToAPI).toBe(false);

        expect(registro).toHaveBeenCalledTimes(1);
        const entrada = registro.mock.calls[0][0];
        expect(entrada.testMode).toBe(true);
        expect(entrada.brand).toBe('lescent');
        expect(entrada.data).toBeTypeOf('object');

        const values = Object.values(entrada.data as unknown as Record<string, unknown>);
        expect(values.length).toBeGreaterThan(0);
    });

    it('8. repassa 200 com SUCCESS_SHEETS_ONLY fora do modo de teste', async () => {
        responde({ code: 'SUCCESS_SHEETS_ONLY', message: 'ok', sentToAPI: false });

        const res = await post(REAL_BODY);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
        expect(body.sentToAPI).toBe(false);
    });

    // ─── Guarda do modo de teste (INV-02) ────────────────────────────

    it('7. barra com 502 quando testMode=true e a resposta é SUCCESS/sentToAPI=true', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        responde({ code: 'SUCCESS', message: 'ok', sentToAPI: true });

        const res = await post(MINIMAL_TEST_BODY);

        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.code).not.toBe('SUCCESS');
        expect(body.sentToAPI).toBe(false);
    });

    it('7b. barra com 502 quando testMode=true e a resposta é SUCCESS_SHEETS_ONLY/sentToAPI=true', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        responde({ code: 'SUCCESS_SHEETS_ONLY', message: 'ok', sentToAPI: true });

        const res = await post(MINIMAL_TEST_BODY);

        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.sentToAPI).toBe(false);
    });

    // ─── Credencial da porta do bot (RF-18/RF-19, INV-04) ────────────

    it('9. retorna 401 e não registra quando o header x-bot-secret está ausente', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post(MINIMAL_TEST_BODY, {});

        expect(res.status).toBe(401);
        expect(registro).not.toHaveBeenCalled();
    });

    it('10. retorna 401 e não registra quando o x-bot-secret está errado', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post(MINIMAL_TEST_BODY, { 'x-bot-secret': 'valor-errado' });

        expect(res.status).toBe(401);
        expect(registro).not.toHaveBeenCalled();
    });

    it('11. a resposta 401 não revela o segredo esperado nem o recebido', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post(MINIMAL_TEST_BODY, { 'x-bot-secret': 'valor-errado' });
        const texto = JSON.stringify(await res.json());

        expect(res.status).toBe(401);
        expect(texto).not.toContain(BOT_SECRET);
        expect(texto).not.toContain('valor-errado');
    });

    it('11b. recusa ANTES de ler o corpo: JSON malformado sem credencial dá 401, não 400', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        // Prende a ORDEM exigida pelo INV-04: o 400 de JSON torto só pode aparecer para quem já passou
        // pela credencial. Se a checagem descer para depois do parse, este caso volta 400 e o teste cai.
        const req = new NextRequest(URL, {
            method: 'POST',
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: '{"brand": "lescent",',
        });
        const res = await POST(req);

        expect(res.status).toBe(401);
        expect(registro).not.toHaveBeenCalled();
    });

    it('12. com o x-bot-secret correto segue o fluxo normal (não 401)', async () => {
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post(MINIMAL_TEST_BODY, { 'x-bot-secret': BOT_SECRET });

        expect(res.status).toBe(200);
        expect(registro).toHaveBeenCalledTimes(1);
    });

    it('13. falha fechada: sem BOT_RESEND_SECRET no ambiente responde 503 e não registra', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubEnv('BOT_RESEND_SECRET', '');
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post(MINIMAL_TEST_BODY, { 'x-bot-secret': BOT_SECRET });

        expect(res.status).toBe(503);
        expect(registro).not.toHaveBeenCalled();
    });

    it('13b. falha fechada: env var ausente (undefined) também responde 503 e não registra', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubEnv('BOT_RESEND_SECRET', undefined as unknown as string);
        const registro = responde({ code: 'SUCCESS_TEST_MODE', message: 'ok', sentToAPI: false });

        const res = await post(MINIMAL_TEST_BODY, { 'x-bot-secret': BOT_SECRET });

        expect(res.status).toBe(503);
        expect(registro).not.toHaveBeenCalled();
    });
});
