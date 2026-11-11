import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as listResends } from '../../app/api/cosmos/resends/route';
import { PATCH as updateResendRoute } from '../../app/api/cosmos/resends/[id]/route';
import { POST as cancelResendRoute } from '../../app/api/cosmos/resends/[id]/cancel/route';
import { createRequest } from '../helpers/api-test-utils';

const AUTH = 'Bearer test-token';
const BASE = 'https://api.cosmos.test';

const RESEND = {
    id: 42,
    external_id: 'SH12345LC-R-1',
    origin: 'resend',
    status: 'pending',
    erp_status: 'waiting',
    customer: { name: 'Cliente Teste', email: 'cliente@example.com', phone: '11900000000', document: '00000000000', type: 'cpf' },
    shipping: {
        name: 'Cliente Teste',
        phone: '11900000000',
        address: {
            street: 'Rua Antiga',
            number: '10',
            complement: 'Ap 1',
            neighborhood: 'Centro',
            city: 'São Paulo',
            state: 'SP',
            postal_code: '01000-000',
        },
        service_name: 'NORMAL_J&T',
        cost: '12.5',
    },
};

function cosmosResponse(status: number, json: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: () => Promise.resolve(json),
        text: () => Promise.resolve(JSON.stringify(json)),
    } as Response;
}

/** Respostas do Cosmos na ordem em que a rota chama. */
function mockCosmos(...responses: Response[]) {
    const fetchSpy = vi.spyOn(global, 'fetch');
    for (const response of responses) {
        fetchSpy.mockResolvedValueOnce(response);
    }
    return fetchSpy;
}

function forbidFetch() {
    return vi.spyOn(global, 'fetch').mockRejectedValue(new Error('não deveria chamar o Cosmos'));
}

function sentBody(fetchSpy: ReturnType<typeof mockCosmos>, call: number): { order: Record<string, unknown> } {
    return JSON.parse(String((fetchSpy.mock.calls[call][1] as RequestInit).body));
}

function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
    vi.stubEnv('COSMOS_API_URL', BASE);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/cosmos/resends', () => {
    function list(query: string, headers: Record<string, string> = { Authorization: AUTH }) {
        return listResends(createRequest(`http://localhost/api/cosmos/resends?${query}`, { headers }));
    }

    it('busca só reenvios na org da marca e fica com os do pedido', async () => {
        const fetchSpy = mockCosmos(cosmosResponse(200, [
            { id: 42, external_id: 'SH12345LC-R-1', origin: 'resend' },
            { id: 43, external_id: 'SH112345LC-R-1', origin: 'resend' },
        ]));

        const res = await list('brand=lescent&orderId=%2312345');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('SUCCESS');
        expect(body.resends.map((resend: { id: number }) => resend.id)).toEqual([42]);
        expect(fetchSpy.mock.calls[0][0])
            .toBe(`${BASE}/organizations/3/orders?external_id=12345&origin=resend&per_page=100`);
    });

    it('recusa marca fora do CX Hub em vez de usar o valor cru como org', async () => {
        const fetchSpy = forbidFetch();

        const res = await list('brand=apice&orderId=12345');

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('INVALID_REQUEST');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('retorna 401 sem Authorization', async () => {
        const res = await list('brand=lescent&orderId=12345', {});
        expect(res.status).toBe(401);
    });

    it('retorna 400 sem orderId', async () => {
        const res = await list('brand=lescent');
        expect(res.status).toBe(400);
    });

    it('repassa o 401 do Cosmos como UNAUTHORIZED, com a mensagem dele', async () => {
        mockCosmos(cosmosResponse(401, { error: 'Token inválido' }));

        const res = await list('brand=lescent&orderId=12345');

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Token inválido' });
    });
});

describe('POST /api/cosmos/resends/[id]/cancel', () => {
    function cancel(body: unknown, id = '42') {
        return cancelResendRoute(
            createRequest(`http://localhost/api/cosmos/resends/${id}/cancel?brand=lescent`, {
                method: 'POST',
                headers: { Authorization: AUTH },
                body,
            }),
            makeParams(id),
        );
    }

    it('relê o reenvio, cancela no Cosmos e registra o agente no motivo', async () => {
        const fetchSpy = mockCosmos(
            cosmosResponse(200, RESEND),
            cosmosResponse(200, { ...RESEND, status: 'cancelled' }),
        );

        const res = await cancel({ handledBy: 'Ana', reason: 'Cliente desistiu' });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('SUCCESS');
        expect(body.order.status).toBe('cancelled');
        expect(fetchSpy.mock.calls[0][0]).toBe(`${BASE}/organizations/3/orders/42`);
        expect(fetchSpy.mock.calls[1][0]).toBe(`${BASE}/organizations/3/orders/42/cancel`);
        expect((fetchSpy.mock.calls[1][1] as RequestInit).method).toBe('POST');
        expect(sentBody(fetchSpy, 1)).toEqual({ order: { reason: 'Cancelado via CX Hub por Ana: Cliente desistiu' } });
    });

    it('não cancela pedido que não é reenvio', async () => {
        const fetchSpy = mockCosmos(cosmosResponse(200, { ...RESEND, origin: 'shopify' }));

        const res = await cancel({ handledBy: 'Ana', reason: 'Cliente desistiu' });

        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('NOT_A_RESEND');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('não cancela reenvio com faturamento em andamento', async () => {
        const fetchSpy = mockCosmos(cosmosResponse(200, { ...RESEND, erp_status: 'invoicing' }));

        const res = await cancel({ handledBy: 'Ana', reason: 'Cliente desistiu' });

        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('RESEND_LOCKED');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('repassa a recusa do Cosmos com a mensagem dele', async () => {
        mockCosmos(cosmosResponse(200, RESEND), cosmosResponse(422, { error: 'Pedido já cancelado' }));

        const res = await cancel({ handledBy: 'Ana', reason: 'Cliente desistiu' });

        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ code: 'COSMOS_REJECTED', message: 'Pedido já cancelado' });
    });

    it('diz qual permissão falta quando o Cosmos recusa o cancelamento com 403', async () => {
        mockCosmos(
            cosmosResponse(200, RESEND),
            cosmosResponse(403, { error: 'Você não tem permissão para executar esta ação' }),
        );

        const res = await cancel({ handledBy: 'Ana', reason: 'Cliente desistiu' });

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
            code: 'FORBIDDEN',
            message: 'O usuário de serviço do CX Hub não tem a permissão cancel_order no Cosmos para esta marca (org 3).',
        });
    });

    it('retorna 404 quando o reenvio não existe na marca', async () => {
        mockCosmos(cosmosResponse(404, { error: 'Order not found' }));

        const res = await cancel({ handledBy: 'Ana', reason: 'Cliente desistiu' });

        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('NOT_FOUND');
    });

    it('retorna 504 quando o Cosmos estoura o timeout', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

        const res = await cancel({ handledBy: 'Ana', reason: 'Cliente desistiu' });

        expect(res.status).toBe(504);
        expect((await res.json()).code).toBe('API_TIMEOUT');
    });

    it('valida id e corpo antes de chamar o Cosmos', async () => {
        const fetchSpy = forbidFetch();

        expect((await cancel({ handledBy: 'Ana', reason: 'Cliente desistiu' }, 'abc')).status).toBe(400);
        expect((await cancel({ handledBy: 'Ana' })).status).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('PATCH /api/cosmos/resends/[id]', () => {
    function update(body: unknown, id = '42') {
        return updateResendRoute(
            createRequest(`http://localhost/api/cosmos/resends/${id}?brand=lescent`, {
                method: 'PATCH',
                headers: { Authorization: AUTH },
                body,
            }),
            makeParams(id),
        );
    }

    it('manda o endereço inteiro, com frete e serviço preservados', async () => {
        const fetchSpy = mockCosmos(cosmosResponse(200, RESEND), cosmosResponse(200, RESEND));

        const res = await update({ handledBy: 'Ana', shippingAddress: { street: 'Rua Nova', number: '200' } });

        expect(res.status).toBe(200);
        expect((await res.json()).code).toBe('SUCCESS');
        expect(fetchSpy.mock.calls[1][0]).toBe(`${BASE}/organizations/3/orders/42`);
        expect((fetchSpy.mock.calls[1][1] as RequestInit).method).toBe('PUT');

        const sent = sentBody(fetchSpy, 1);
        expect(sent.order.shipping_address).toMatchObject({
            street: 'Rua Nova',
            number: '200',
            city: 'São Paulo',
            service_name: 'NORMAL_J&T',
            cost: '12.5',
        });
        expect(sent.order.billing_address).toMatchObject({ street: 'Rua Nova', number: '200' });
        expect(sent.order).not.toHaveProperty('metadata');
    });

    it('confere a transportadora na marca antes de trocar', async () => {
        const fetchSpy = mockCosmos(
            cosmosResponse(200, RESEND),
            cosmosResponse(200, { id: 161, shopify_name: 'NORMAL_LOGGI_STANDARD', active: true }),
            cosmosResponse(200, RESEND),
        );

        const res = await update({ handledBy: 'Ana', carrierId: 161 });

        expect(res.status).toBe(200);
        expect(fetchSpy.mock.calls[1][0]).toBe(`${BASE}/organizations/3/carriers/161`);
        const sent = sentBody(fetchSpy, 2);
        expect(sent.order.carrier_id).toBe(161);
        expect(sent.order.shipping_address).toMatchObject({ service_name: 'NORMAL_LOGGI_STANDARD' });
    });

    it('recusa transportadora de outra marca sem chamar o PUT', async () => {
        const fetchSpy = mockCosmos(cosmosResponse(200, RESEND), cosmosResponse(404, { error: 'Carrier not found' }));

        const res = await update({ handledBy: 'Ana', carrierId: 999 });

        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('CARRIER_NOT_FOUND');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('recusa transportadora inativa', async () => {
        const fetchSpy = mockCosmos(
            cosmosResponse(200, RESEND),
            cosmosResponse(200, { id: 161, shopify_name: 'NORMAL_LOGGI_STANDARD', active: false }),
        );

        const res = await update({ handledBy: 'Ana', carrierId: 161 });

        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ code: 'CARRIER_NOT_FOUND', message: 'Transportadora inativa nesta marca.' });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('não edita reenvio cancelado', async () => {
        const fetchSpy = mockCosmos(cosmosResponse(200, { ...RESEND, status: 'cancelled' }));

        const res = await update({ handledBy: 'Ana', shippingAddress: { number: '200' } });

        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('RESEND_CANCELLED');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('recusa endereço que ficaria incompleto, sem chamar o PUT', async () => {
        const fetchSpy = mockCosmos(cosmosResponse(200, RESEND));

        const res = await update({ handledBy: 'Ana', shippingAddress: { city: '' } });

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('INVALID_REQUEST');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('recusa produtos antes de chamar o Cosmos', async () => {
        const fetchSpy = forbidFetch();

        const res = await update({ handledBy: 'Ana', products: [{ id: 1, quantity: 1 }] });

        expect(res.status).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
