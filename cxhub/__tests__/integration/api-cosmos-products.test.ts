import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/cosmos/products/route';
import { createRequest } from '../helpers/api-test-utils';

const AUTH = 'Bearer test-token';

function makeProducts(count: number) {
    return Array.from({ length: count }, (_, i) => ({ id: i + 1, sku: `SKU-${i + 1}` }));
}

describe('GET /api/cosmos/products', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('retorna 200 com lista de produtos (1 pagina)', async () => {
        const products = makeProducts(50);
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve(products),
            text: () => Promise.resolve(JSON.stringify(products)),
        } as Response);

        const req = createRequest('http://localhost/api/cosmos/products?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveLength(50);
    });

    it('pagina ate coletar todos os produtos (2 paginas)', async () => {
        const page1 = makeProducts(100);
        const page2 = makeProducts(30);

        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve(page1),
                text: () => Promise.resolve(JSON.stringify(page1)),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve(page2),
                text: () => Promise.resolve(JSON.stringify(page2)),
            } as Response);

        const req = createRequest('http://localhost/api/cosmos/products?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveLength(130);
    });

    it('para paginacao quando retorna array vazio', async () => {
        const page1 = makeProducts(100);

        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve(page1),
                text: () => Promise.resolve(JSON.stringify(page1)),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve([]),
                text: () => Promise.resolve('[]'),
            } as Response);

        const req = createRequest('http://localhost/api/cosmos/products?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveLength(100);
    });

    it('busca por SKU inclui sku na URL', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve([{ sku: 'ABC' }]),
            text: () => Promise.resolve('[{"sku":"ABC"}]'),
        } as Response);

        const req = createRequest('http://localhost/api/cosmos/products?brand=lescent&sku=ABC', {
            headers: { Authorization: AUTH },
        });
        await GET(req);

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain('?sku=ABC');
    });

    it('retorna 400 se brand faltando', async () => {
        const req = createRequest('http://localhost/api/cosmos/products', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(400);
    });

    it('passa status de erro na paginacao', async () => {
        const page1 = makeProducts(100);

        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve(page1),
                text: () => Promise.resolve(JSON.stringify(page1)),
            } as Response)
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                json: () => Promise.resolve({ error: 'server error' }),
                text: () => Promise.resolve('server error'),
            } as Response);

        const req = createRequest('http://localhost/api/cosmos/products?brand=lescent', {
            headers: { Authorization: AUTH },
        });
        const res = await GET(req);

        expect(res.status).toBe(500);
    });
});
