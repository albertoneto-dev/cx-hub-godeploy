import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/cosmos/products/[id]/route';
import { createRequest, mockFetch } from '../helpers/api-test-utils';

const AUTH = 'Bearer test-token';

function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
}

describe('GET /api/cosmos/products/[id]', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('retorna 200 com detalhe do produto', async () => {
        mockFetch({ status: 200, json: { id: 99, kit_skus: [] } });

        const req = createRequest('http://localhost/api/cosmos/products/99?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req, makeParams('99'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ id: 99, kit_skus: [] });
    });

    it('retorna 400 se brand faltando', async () => {
        const req = createRequest('http://localhost/api/cosmos/products/99', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req, makeParams('99'));

        expect(res.status).toBe(400);
    });

    it('retorna 401 se sem Authorization header', async () => {
        const req = createRequest('http://localhost/api/cosmos/products/99?brand=lescent');
        const res = await GET(req, makeParams('99'));

        expect(res.status).toBe(401);
    });
});
