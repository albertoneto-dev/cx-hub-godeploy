import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/cosmos/orders/[id]/route';
import { createRequest, mockFetch } from '../helpers/api-test-utils';

const AUTH = 'Bearer test-token';

function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
}

describe('GET /api/cosmos/orders/[id]', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('retorna 200 com detalhe do pedido', async () => {
        mockFetch({ status: 200, json: { id: 42, status: 'delivered' } });

        const req = createRequest('http://localhost/api/cosmos/orders/42?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req, makeParams('42'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ id: 42, status: 'delivered' });
    });

    it('mapeia brand=barbours para orgId=8 na URL', async () => {
        const fetchSpy = mockFetch({ status: 200, json: {} });

        const req = createRequest('http://localhost/api/cosmos/orders/42?brand=barbours', {
            headers: { Authorization: AUTH },
        });
        await GET(req, makeParams('42'));

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain('/organizations/8/orders/42');
    });

    it('retorna 400 se brand faltando', async () => {
        const req = createRequest('http://localhost/api/cosmos/orders/42', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req, makeParams('42'));

        expect(res.status).toBe(400);
    });

    it('retorna 401 se sem Authorization header', async () => {
        const req = createRequest('http://localhost/api/cosmos/orders/42?brand=lescent');
        const res = await GET(req, makeParams('42'));

        expect(res.status).toBe(401);
    });

    it('passa status 404 do Cosmos', async () => {
        mockFetch({ status: 404, ok: false });

        const req = createRequest('http://localhost/api/cosmos/orders/42?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req, makeParams('42'));

        expect(res.status).toBe(404);
    });
});
