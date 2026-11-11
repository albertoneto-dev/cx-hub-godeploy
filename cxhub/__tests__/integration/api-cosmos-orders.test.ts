import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/cosmos/orders/route';
import { createRequest, mockFetch, mockFetchError } from '../helpers/api-test-utils';

const AUTH = 'Bearer test-token';

describe('GET /api/cosmos/orders', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('retorna 200 com dados do Cosmos', async () => {
        mockFetch({ status: 200, json: [{ id: 1 }] });

        const req = createRequest('http://localhost/api/cosmos/orders?brand=lescent&orderId=123', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual([{ id: 1 }]);
    });

    it('mapeia brand=kokeshi para orgId=4 na URL', async () => {
        const fetchSpy = mockFetch({ status: 200, json: [] });

        const req = createRequest('http://localhost/api/cosmos/orders?brand=kokeshi&orderId=123', {
            headers: { Authorization: AUTH },
        });
        await GET(req);

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain('/organizations/4/');
    });

    it('usa brand desconhecida como orgId na URL', async () => {
        const fetchSpy = mockFetch({ status: 200, json: [] });

        const req = createRequest('http://localhost/api/cosmos/orders?brand=xyz&orderId=123', {
            headers: { Authorization: AUTH },
        });
        await GET(req);

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain('/organizations/xyz/');
    });

    it('retorna 400 se brand faltando', async () => {
        const req = createRequest('http://localhost/api/cosmos/orders?orderId=123', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(400);
    });

    it('retorna 400 se orderId faltando', async () => {
        const req = createRequest('http://localhost/api/cosmos/orders?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(400);
    });

    it('retorna 401 se sem Authorization header', async () => {
        const req = createRequest('http://localhost/api/cosmos/orders?brand=lescent&orderId=123');
        const res = await GET(req);

        expect(res.status).toBe(401);
    });

    it('retorna 500 se COSMOS_API_URL nao configurada', async () => {
        vi.unstubAllEnvs();

        const req = createRequest('http://localhost/api/cosmos/orders?brand=lescent&orderId=123', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(500);
    });

    it('passa status 404 do Cosmos', async () => {
        mockFetch({ status: 404, ok: false });

        const req = createRequest('http://localhost/api/cosmos/orders?brand=lescent&orderId=123', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(404);
    });

    it('retorna 500 quando fetch falha', async () => {
        mockFetchError(new Error('Network error'));

        const req = createRequest('http://localhost/api/cosmos/orders?brand=lescent&orderId=123', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(500);
    });
});
