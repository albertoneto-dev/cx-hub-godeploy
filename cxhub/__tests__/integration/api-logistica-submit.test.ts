import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '../../app/api/logistica/submit/route';
import { createRequest, mockFetch } from '../helpers/api-test-utils';

const VALID_PAYLOAD = {
    orderId: '#LSC12345',
    issue: 'Pedido Atrasado',
    brand: 'lescent',
    handledBy: 'Fulano',
};

describe('POST /api/logistica/submit', () => {
    beforeEach(() => {
        vi.stubEnv('TICKETCREATOR_URL', 'https://ticketcreator.test');
        vi.stubEnv('TICKETCREATOR_SECRET', 'segredo-de-teste');
        vi.stubEnv('TIMEOUT', '10000');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    // ─── Validação de entrada ───────────────────────────────────────

    it('retorna 500 quando TICKETCREATOR_URL não está configurado', async () => {
        vi.unstubAllEnvs();

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.code).toBe('UNKNOWN_ERROR');
    });

    it('retorna 500 sem chamar o worker quando TICKETCREATOR_SECRET falta', async () => {
        vi.unstubAllEnvs();
        vi.stubEnv('TICKETCREATOR_URL', 'https://ticketcreator.test');
        const fetchSpy = mockFetch({ status: 200, json: { code: 'DELAY_TICKET_CREATED', message: 'ok' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(500);
        expect(fetchSpy).not.toHaveBeenCalled();
        const body = await res.json();
        expect(body.code).toBe('UNKNOWN_ERROR');
    });

    it('retorna 400 quando faltam campos obrigatórios', async () => {
        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: { orderId: '#LSC1', issue: 'Pedido Atrasado' }, // falta brand
        });
        const res = await POST(req);

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe('UNKNOWN_ERROR');
    });

    it('retorna 400 para brand inválida', async () => {
        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: { ...VALID_PAYLOAD, brand: 'xyz' },
        });
        const res = await POST(req);

        expect(res.status).toBe(400);
    });

    // ─── Sucessos ───────────────────────────────────────────────────

    it.each([
        ['DELAY_TICKET_CREATED'],
        ['INVESTIGATION_CREATED'],
        ['ADDRESS_TICKET_CREATED'],
    ])('mapeia código de sucesso %s para o próprio código', async (code) => {
        mockFetch({ status: 200, json: { code, message: 'ok', data: {}, action: 'ticket_created' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe(code);
        expect(body.message).toBe('ok');
    });

    // ─── Info ───────────────────────────────────────────────────────

    it.each([
        ['TICKET_EXISTS'],
        ['TICKET_COMPLETED'],
        ['ORDER_ON_TIME'],
    ])('mapeia código informacional %s para o próprio código', async (code) => {
        mockFetch({ status: 200, json: { code, message: 'info', data: {}, action: 'none' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe(code);
    });

    it('normaliza o typo "ORDER NO SENT" (com espaço) para ORDER_NOT_SENT', async () => {
        mockFetch({
            status: 200,
            json: { code: 'ORDER NO SENT', message: 'Pedido ainda não foi enviado', data: {}, action: 'no_ticket_needed' },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('ORDER_NOT_SENT');
    });

    // ─── Rejeições ──────────────────────────────────────────────────

    it.each([
        ['INVESTIGATION_INVALID'],
        ['AVARIA_INVALID'],
        ['BARRA_ENTREGA_INVALID'],
        ['ADDRESS_MISSING'],
    ])('mapeia código de rejeição %s para o próprio código', async (code) => {
        mockFetch({ status: 200, json: { code, message: 'rejeitado', data: {}, action: 'ticket_rejected' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe(code);
    });

    // ─── Escalação ──────────────────────────────────────────────────

    it.each([
        ['DELAY_ESCALATED'],
        ['INVESTIGATION_EXPIRED'],
        ['CARRIER_NOT_AUTOMATED'],
    ])('mapeia código de escalação %s (via code) para o próprio código', async (code) => {
        mockFetch({ status: 200, json: { code, message: 'escalar', data: {}, action: 'escalate_to_human' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe(code);
    });

    it('mapeia shape { status: "ESCALATE_TO_HUMAN" } COM ticket_id para TICKET_DEADLINE_EXPIRED', async () => {
        mockFetch({
            status: 200,
            json: {
                status: 'ESCALATE_TO_HUMAN',
                message: 'agente_instructions: escalar para atendimento humano',
                ticket_id: '42',
                reference: 'LSC12345',
                response_deadline: '2026-04-10 10:00:00',
                days_overdue: '5',
            },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('TICKET_DEADLINE_EXPIRED');
        expect(body.message).toContain('escalar para atendimento humano');
    });

    it('mapeia shape { status: "ESCALATE_TO_HUMAN" } SEM ticket_id para ORDER_FETCH_FAILED', async () => {
        mockFetch({
            status: 200,
            json: { status: 'ESCALATE_TO_HUMAN', message: 'agente_instructions: escalar para atendimento humano' },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('ORDER_FETCH_FAILED');
        expect(body.message).toContain('escalar para atendimento humano');
    });

    it('mapeia ESCALATE_TO_HUMAN em `code` COM ticket_id para TICKET_DEADLINE_EXPIRED', async () => {
        mockFetch({
            status: 200,
            json: { code: 'ESCALATE_TO_HUMAN', message: 'prazo vencido', ticket_id: 99 },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('TICKET_DEADLINE_EXPIRED');
    });

    it('mapeia ESCALATE_TO_HUMAN em `code` SEM ticket_id para ORDER_FETCH_FAILED', async () => {
        mockFetch({
            status: 200,
            json: { code: 'ESCALATE_TO_HUMAN', message: 'pedido não encontrado' },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('ORDER_FETCH_FAILED');
    });

    // ─── Fallbacks / erros ──────────────────────────────

    it('retorna 502 com UNKNOWN_ERROR quando o worker recusa o secret (401)', async () => {
        mockFetch({ status: 401, ok: false, json: { error: 'unauthorized' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.code).toBe('UNKNOWN_ERROR');
    });

    it('retorna UNKNOWN_ERROR quando o worker recusa o payload (400)', async () => {
        mockFetch({ status: 400, ok: false, json: { error: 'invalid issue' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe('UNKNOWN_ERROR');
    });

    it('normaliza código desconhecido para UNKNOWN_ERROR', async () => {
        mockFetch({ status: 200, json: { code: 'BANANA', message: 'wat' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('UNKNOWN_ERROR');
    });

    it('retorna 504 com API_TIMEOUT quando o fetch é abortado', async () => {
        const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
        vi.spyOn(global, 'fetch').mockRejectedValue(abortError);

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(504);
        const body = await res.json();
        expect(body.code).toBe('API_TIMEOUT');
    });

    it('retorna UNKNOWN_ERROR quando o webhook retorna HTTP != 2xx sem código conhecido', async () => {
        mockFetch({ status: 500, ok: false, json: { error: 'server error' } });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.code).toBe('UNKNOWN_ERROR');
    });

    it('retorna UNKNOWN_ERROR quando o webhook retorna body vazio', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            statusText: '200',
            json: () => Promise.reject(new Error('no body')),
            text: () => Promise.resolve(''),
        } as Response);

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        const res = await POST(req);

        const body = await res.json();
        expect(body.code).toBe('UNKNOWN_ERROR');
    });

    // ─── Contrato do POST para o webhook ────────────────────────────

    it('faz POST para TICKETCREATOR_URL + /gogroup-tickets-clind', async () => {
        const fetchSpy = mockFetch({
            status: 200,
            json: { code: 'DELAY_TICKET_CREATED', message: 'ok' },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        await POST(req);

        expect(fetchSpy.mock.calls[0][0]).toBe('https://ticketcreator.test/gogroup-tickets-clind');
    });

    it('não duplica a barra quando TICKETCREATOR_URL termina em "/"', async () => {
        vi.stubEnv('TICKETCREATOR_URL', 'https://ticketcreator.test/');
        const fetchSpy = mockFetch({
            status: 200,
            json: { code: 'DELAY_TICKET_CREATED', message: 'ok' },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        await POST(req);

        expect(fetchSpy.mock.calls[0][0]).toBe('https://ticketcreator.test/gogroup-tickets-clind');
    });

    it('envia o secret no header x-webhook-secret', async () => {
        const fetchSpy = mockFetch({
            status: 200,
            json: { code: 'DELAY_TICKET_CREATED', message: 'ok' },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        await POST(req);

        const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
        expect(headers['x-webhook-secret']).toBe('segredo-de-teste');
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('encaminha o corpo recebido sem reescrever o issue', async () => {
        const fetchSpy = mockFetch({
            status: 200,
            json: { code: 'ADDRESS_TICKET_CREATED', message: 'ok' },
        });

        const payload = { ...VALID_PAYLOAD, issue: 'Endereco Errado' };
        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: payload,
        });
        await POST(req);

        expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)).toEqual({ ...payload, callerType: 'agent' });
    });

    it('acrescenta callerType = agent mesmo se o corpo recebido não trouxer', async () => {
        const fetchSpy = mockFetch({
            status: 200,
            json: { code: 'DELAY_TICKET_CREATED', message: 'ok' },
        });

        const req = createRequest('http://localhost/api/logistica/submit', {
            method: 'POST',
            body: VALID_PAYLOAD,
        });
        await POST(req);

        const sent = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
        expect(sent.callerType).toBe('agent');
    });
});
