import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/cosmos/carriers/route';
import { createRequest, mockFetch } from '../helpers/api-test-utils';

const AUTH = 'Bearer test-token';

describe('GET /api/cosmos/carriers', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('retorna 200 com carriers', async () => {
        mockFetch({ status: 200, json: [{ name: 'Correios PAC' }] });

        const req = createRequest(
            'http://localhost/api/cosmos/carriers?brand=lescent&shopify_name=Correios',
            { headers: { Authorization: AUTH } }
        );
        const res = await GET(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual([{ name: 'Correios PAC' }]);
    });

    it('retorna 400 se shopify_name faltando', async () => {
        const req = createRequest('http://localhost/api/cosmos/carriers?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(400);
    });

    it('retorna 400 se brand faltando', async () => {
        const req = createRequest('http://localhost/api/cosmos/carriers?shopify_name=Correios', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(400);
    });

    it('encoda shopify_name com espacos na URL', async () => {
        const fetchSpy = mockFetch({ status: 200, json: [] });

        const req = createRequest(
            'http://localhost/api/cosmos/carriers?brand=lescent&shopify_name=Total%20Express',
            { headers: { Authorization: AUTH } }
        );
        await GET(req);

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain('Total%20Express');
    });
});
