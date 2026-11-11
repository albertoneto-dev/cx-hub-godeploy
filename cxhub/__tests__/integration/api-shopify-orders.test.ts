import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequest, mockFetch } from '../helpers/api-test-utils';

// The Shopify route captures env vars at module load time (SHOPIFY_STORES const).
// We use vi.resetModules() + dynamic import in beforeEach so each test gets
// a fresh module evaluation with the stubbed env vars.

type GetFn = (req: import('next/server').NextRequest) => Promise<import('next/server').NextResponse>;

describe('GET /api/shopify/orders', () => {
    let GET: GetFn;

    beforeEach(async () => {
        vi.resetModules();
        vi.stubEnv('SHOPIFY_TOKEN_LESCENT', 'token-lescent');
        vi.stubEnv('SHOPIFY_TOKEN_KOKESHI', 'token-kokeshi');
        vi.stubEnv('SHOPIFY_TOKEN_BYSAMIA', 'token-bysamia');
        vi.stubEnv('SHOPIFY_TOKEN_AUA', 'token-aua');
        vi.stubEnv('SHOPIFY_TOKEN_BARBOURS', 'token-barbours');
        const mod = await import('../../app/api/shopify/orders/route');
        GET = mod.GET;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('retorna 200 com dados do Shopify', async () => {
        mockFetch({ status: 200, json: { orders: [{ id: 1 }] } });

        const req = createRequest('http://localhost/api/shopify/orders?brand=lescent&orderId=12345');
        const res = await GET(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ orders: [{ id: 1 }] });
    });

    it('usa token correto para brand=kokeshi', async () => {
        const fetchSpy = mockFetch({ status: 200, json: { orders: [] } });

        const req = createRequest('http://localhost/api/shopify/orders?brand=kokeshi&orderId=12345');
        await GET(req);

        const calledHeaders = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
        expect(calledHeaders['X-Shopify-Access-Token']).toBe('token-kokeshi');
    });

    it('usa URL da loja correta para brand=bysamia', async () => {
        const fetchSpy = mockFetch({ status: 200, json: { orders: [] } });

        const req = createRequest('http://localhost/api/shopify/orders?brand=bysamia&orderId=12345');
        await GET(req);

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain('gcpf8a-ki.myshopify.com');
    });

    it('retorna 400 para brand desconhecida', async () => {
        const req = createRequest('http://localhost/api/shopify/orders?brand=xyz&orderId=12345');
        const res = await GET(req);

        expect(res.status).toBe(400);
    });

    it('retorna 500 se token nao configurado', async () => {
        vi.resetModules();
        vi.unstubAllEnvs();
        // Reimport sem tokens configurados
        const mod = await import('../../app/api/shopify/orders/route');
        GET = mod.GET;

        const req = createRequest('http://localhost/api/shopify/orders?brand=lescent&orderId=12345');
        const res = await GET(req);

        expect(res.status).toBe(500);
    });

    it('retorna 400 se brand faltando', async () => {
        const req = createRequest('http://localhost/api/shopify/orders?orderId=12345');
        const res = await GET(req);

        expect(res.status).toBe(400);
    });

    it('passa status 401 do Shopify', async () => {
        mockFetch({ status: 401, ok: false });

        const req = createRequest('http://localhost/api/shopify/orders?brand=lescent&orderId=12345');
        const res = await GET(req);

        expect(res.status).toBe(401);
    });
});
