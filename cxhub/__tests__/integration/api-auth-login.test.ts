import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '../../app/api/auth/login/route';
import { createRequest, mockFetch, mockFetchError } from '../helpers/api-test-utils';

const ENV_DEFAULTS = {
    CX_HUB_EMAIL: 'admin@cxhub.com',
    CX_HUB_PASSWORD: 'senha123',
    COSMOS_EMAIL: 'cosmos@example.com',
    COSMOS_PASSWORD: 'cosmospass',
    COSMOS_API_URL: 'https://api.cosmos.test',
};

describe('POST /api/auth/login', () => {
    beforeEach(() => {
        for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
            vi.stubEnv(key, value);
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('retorna 200 com token quando login OK', async () => {
        mockFetch({ status: 200, json: { credentials: { token: 'abc123' } } });

        const req = createRequest('http://localhost/api/auth/login', {
            method: 'POST',
            body: { email: 'admin@cxhub.com', password: 'senha123' },
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ credentials: { token: 'abc123' } });
    });

    it('retorna 401 para credenciais erradas sem chamar fetch', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch');

        const req = createRequest('http://localhost/api/auth/login', {
            method: 'POST',
            body: { email: 'errado@email.com', password: 'senha123' },
        });
        const res = await POST(req);

        expect(res.status).toBe(401);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('passa status 401 do Cosmos', async () => {
        mockFetch({ status: 401, ok: false, json: { error: 'Unauthorized' } });

        const req = createRequest('http://localhost/api/auth/login', {
            method: 'POST',
            body: { email: 'admin@cxhub.com', password: 'senha123' },
        });
        const res = await POST(req);

        expect(res.status).toBe(401);
    });

    it('retorna 500 se env var faltando', async () => {
        vi.unstubAllEnvs();

        const req = createRequest('http://localhost/api/auth/login', {
            method: 'POST',
            body: { email: 'admin@cxhub.com', password: 'senha123' },
        });
        const res = await POST(req);

        expect(res.status).toBe(500);
    });

    // P-008: a senha tem `$` e fica cadastrada na Vercel escapada (`\$`, contorno do P-007). Builds até
    // 01/09/2026 removiam a contrabarra; o de 20/10 passou a entregá-la literal ao runtime.
    it('aceita a senha digitada quando o env var chega com o `$` escapado', async () => {
        vi.stubEnv('CX_HUB_PASSWORD', 'abc\\$123');
        mockFetch({ status: 200, json: { credentials: { token: 'abc123' } } });

        const req = createRequest('http://localhost/api/auth/login', {
            method: 'POST',
            body: { email: 'admin@cxhub.com', password: 'abc$123' },
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
    });

    it('aceita a senha digitada quando o env var chega com o `$` cru', async () => {
        vi.stubEnv('CX_HUB_PASSWORD', 'abc$123');
        mockFetch({ status: 200, json: { credentials: { token: 'abc123' } } });

        const req = createRequest('http://localhost/api/auth/login', {
            method: 'POST',
            body: { email: 'admin@cxhub.com', password: 'abc$123' },
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
    });

    it('retorna 500 quando fetch falha por erro de rede', async () => {
        mockFetchError(new Error('Network error'));

        const req = createRequest('http://localhost/api/auth/login', {
            method: 'POST',
            body: { email: 'admin@cxhub.com', password: 'senha123' },
        });
        const res = await POST(req);

        expect(res.status).toBe(500);
    });
});
