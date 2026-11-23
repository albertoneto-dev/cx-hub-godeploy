import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/shopify/orders/route';
import { adaptShopifyOrder } from '@shared/lib/shopify/adapter';
import { createRequest } from '../helpers/api-test-utils';

/**
 * As 6 marcas do Cosmos no `/api/shopify/orders`. Desde 2026-11-17 o pedido delas vem do gateway da Shopify, com o
 * nome da marca na URL, como o das sem Cosmos (`api-marcas-sem-cosmos.test.ts`): o app não lê token de loja nenhum.
 * Antes, Lescent, Kokeshi, BySamia, Auá e Barbours liam o REST `orders.json` da loja com os `SHOPIFY_TOKEN_*`. Desde
 * 2026-11-23 o gateway é o da `SHOPIFY_GATEWAY_URL`, com a `SHOPIFY_GATEWAY_KEY` (o integrations-gateway foi
 * descontinuado).
 */

const GATEWAY = 'https://api.gateway.test/v1';

/** Um pedido no formato GraphQL do gateway, com dado de mentira. */
const no = (name: string, extra: Record<string, unknown> = {}) => ({
    id: 'gid://shopify/Order/9001', legacyResourceId: '9001', name, createdAt: '2026-11-01T12:00:00Z',
    email: 'cliente@exemplo.com', displayFinancialStatus: 'PAID',
    currentTotalPriceSet: { shopMoney: { amount: '119.80' } },
    totalPriceSet: { shopMoney: { amount: '119.80' } },
    totalShippingPriceSet: { shopMoney: { amount: '19.90' } },
    customer: { firstName: 'Maria', lastName: 'Teste', phone: null },
    shippingAddress: {
        name: 'Maria Teste', address1: 'Rua A, 10', address2: 'Centro', city: 'São Paulo', zip: '01001-000',
        province: 'São Paulo', provinceCode: 'SP', phone: '+5511999990000',
    },
    shippingLines: { edges: [{ node: { title: 'NORMAL_J&T' } }] },
    customAttributes: [],
    lineItems: { edges: [{ node: {
        id: 'gid://shopify/LineItem/555', name: 'Sérum', sku: 'BS001', vendor: 'By Samia', quantity: 2,
        originalUnitPriceSet: { shopMoney: { amount: '49.95' } }, totalDiscountSet: { shopMoney: { amount: '0.00' } },
    } }] },
    fulfillments: [],
    ...extra,
});

/** O gateway falso: responde pelo `q` das variables (ou com uma resposta fixa). */
function gateway(porBusca: Record<string, unknown[]>, resposta?: { status: number; json: unknown }) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
        if (resposta) return new Response(JSON.stringify(resposta.json), { status: resposta.status });
        const corpo = JSON.parse(String(init?.body)) as { variables: { q: string } };
        const nos = porBusca[corpo.variables.q] ?? [];
        return new Response(JSON.stringify({ data: { orders: { edges: nos.map((node) => ({ node })) } } }), { status: 200 });
    });
}

const pedir = (brand: string, orderId: string) =>
    GET(createRequest(`http://localhost/api/shopify/orders?brand=${brand}&orderId=${orderId}`));

beforeEach(() => {
    vi.stubEnv('SHOPIFY_GATEWAY_URL', `${GATEWAY}/shopify`);
    vi.stubEnv('SHOPIFY_GATEWAY_KEY', 'igw_chave_de_teste');
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/shopify/orders — as marcas do Cosmos, pelo gateway da Shopify', () => {
    it.each(['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria'])(
        '%s: uma busca no gateway, com o nome da marca na URL, pela chave do gateway e só pelos dígitos',
        async (marca) => {
            const fetchSpy = gateway({ 'name:220183': [no('SH220183XX')] });

            const res = await pedir(marca, '220183');

            expect(res.status).toBe(200);
            expect((await res.json()).orders.map((o: { name: string }) => o.name)).toEqual(['SH220183XX']);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, init] = fetchSpy.mock.calls[0];
            expect(url).toBe(`${GATEWAY}/shopify/${marca}`);
            expect(init?.method).toBe('POST');
            expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer igw_chave_de_teste');
            expect(JSON.parse(String(init?.body)).variables).toEqual({ q: 'name:220183' });
        },
    );

    it('nunca usa o token da loja nem o REST da Shopify, mesmo com os SHOPIFY_TOKEN_* no ambiente', async () => {
        for (const marca of ['LESCENT', 'KOKESHI', 'BYSAMIA', 'AUA', 'BARBOURS']) {
            vi.stubEnv(`SHOPIFY_TOKEN_${marca}`, 'shpat_que_nao_deve_ser_usado');
        }
        const fetchSpy = gateway({ 'name:220183': [no('SH220183LC')] });

        for (const marca of ['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours']) await pedir(marca, '220183');

        const chamadas = JSON.stringify(fetchSpy.mock.calls);
        expect(chamadas).not.toContain('shpat_que_nao_deve_ser_usado');
        expect(chamadas).not.toContain('myshopify.com');
        expect(chamadas).not.toContain('X-Shopify-Access-Token');
    });

    it('a marca vale sem diferenciar maiúsculas, e vai minúscula à URL do gateway', async () => {
        const fetchSpy = gateway({});

        await pedir('Kokeshi', '1204230');

        expect(fetchSpy.mock.calls[0][0]).toBe(`${GATEWAY}/shopify/kokeshi`);
    });

    it('o reenvio do Cosmos (SH…-R-1), que o filtro também devolve e primeiro, não é escolhido no lugar do original', async () => {
        gateway({ 'name:1452727': [no('SH1452727BB-R-1'), no('SH1452727BB')] });

        const corpo = await (await pedir('barbours', '1452727')).json();

        expect(corpo.orders.map((o: { name: string }) => o.name)).toEqual(['SH1452727BB']);
    });

    it('a NF vem do metacampo custom.nf_numero do pedido procurado, e não do reenvio SH…-R-1 que vem junto (2026-11-19)', async () => {
        const fetchSpy = gateway({
            'name:52988': [no('SH52988BS-R-1', { nf: { value: '001905557' } }), no('SH52988BS', { nf: { value: '001834451' } })],
        });

        const { orders } = await (await pedir('bysamia', '52988')).json();

        expect(orders.map((o: { name: string }) => o.name)).toEqual(['SH52988BS']);
        expect(orders[0].note_attributes).toEqual([{ name: 'nf_number', value: '1834451' }]);
        expect(adaptShopifyOrder(orders[0], 'bysamia').numeroNF).toBe('1834451');
        expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).query).toContain('metafield(namespace: "custom", key: "nf_numero")');
    });

    it('devolve o formato REST que o adapter lê, e o adapter segue as regras da marca do Cosmos', async () => {
        gateway({ 'name:39996': [no('SH39996BS')] });

        const { orders } = await (await pedir('bysamia', '39996')).json();

        expect(orders[0]).toMatchObject({
            id: 9001, name: 'SH39996BS', financial_status: 'paid', total_price: '119.80',
            line_items: [{ id: 555, sku: 'BS001', quantity: 2, price: '49.95' }],
        });
        // Nas marcas do Cosmos, o título do frete vai como veio (a tela faz o de-para pelo Cosmos), e SP sai do CD SP.
        expect(adaptShopifyOrder(orders[0], 'bysamia')).toMatchObject({
            numeroPedido: 'SH39996BS', transportadora: 'NORMAL_J&T', cdOrigem: 'SP',
        });
    });

    it.each([
        ['com o /shopify no fim e a / depois dele', ' https://gateway.exemplo.test/v1/shopify/ '],
        ['sem o /shopify (o caminho é acrescentado)', 'https://gateway.exemplo.test/v1/'],
    ])('a SHOPIFY_GATEWAY_URL %s: a busca vai a ela, sem duplicar o /shopify', async (_caso, url) => {
        vi.stubEnv('SHOPIFY_GATEWAY_URL', url);
        const fetchSpy = gateway({});

        await pedir('aua', '6990');

        expect(fetchSpy.mock.calls[0][0]).toBe('https://gateway.exemplo.test/v1/shopify/aua');
    });

    it('as INTEGRATIONS_GATEWAY_* antigas no ambiente não são lidas (2026-11-23)', async () => {
        vi.stubEnv('INTEGRATIONS_GATEWAY_URL', 'https://integrations-gateway.antigo.test');
        vi.stubEnv('INTEGRATIONS_GATEWAY_READ_KEY', 'igw_antiga_que_nao_deve_ser_usada');
        const fetchSpy = gateway({});

        await pedir('lescent', '592465');

        const chamadas = JSON.stringify(fetchSpy.mock.calls);
        expect(chamadas).not.toContain('integrations-gateway.antigo.test');
        expect(chamadas).not.toContain('igw_antiga_que_nao_deve_ser_usada');
        expect(fetchSpy.mock.calls[0][0]).toBe(`${GATEWAY}/shopify/lescent`);
    });

    it('pedido fora dos 60 dias do gateway ⇒ vem do Data Mart, onde a BySamia é by_samia', async () => {
        const METABASE = 'https://metabase.test';
        vi.stubEnv('METABASE_URL', METABASE);
        vi.stubEnv('METABASE_API_KEY', 'chave');
        vi.stubEnv('METABASE_DATABASE_ID', '43');
        const consultas: string[] = [];
        // A linha do Data Mart, com dado pessoal de mentira, na ordem do SELECT.
        const linha = [
            '7613222846686', 'SH39996BS', '2026-08-14T13:08:34Z', 'cliente@exemplo.com', 'paid', 99.9, 99.9, 0,
            'Maria Teste', null, null, 'Maria', 'Teste', 'Rua A, 10', 'Centro', 'Vitória', '29000-000', 'ES',
            JSON.stringify([{ id: 1, sku: 'BS001', name: 'Sérum', vendor: 'By Samia', quantity: 1, price: '99.90', total_discount: '0.00', discount_allocations: [] }]),
            JSON.stringify([{ title: 'NORMAL_J&T' }]), '[]', '[]', null,
        ];
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
            if (String(input) === `${METABASE}/api/dataset`) {
                consultas.push(JSON.parse(String(init?.body)).native.query as string);
                return new Response(JSON.stringify({ status: 'completed', data: { rows: [linha] } }), { status: 202 });
            }
            return new Response(JSON.stringify({ data: { orders: { edges: [] } } }), { status: 200 });
        });

        const res = await pedir('bysamia', '39996');

        expect(res.status).toBe(200);
        expect((await res.json()).orders.map((o: { name: string }) => o.name)).toEqual(['SH39996BS']);
        // Uma busca no gateway (só os dígitos) e uma no Data Mart.
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(consultas[0]).toContain("brand = 'by_samia' and order_number = 39996");
    });

    it('sem a SHOPIFY_GATEWAY_KEY ⇒ 500 sem chamar nada: não há mais o REST da loja de reserva', async () => {
        vi.stubEnv('SHOPIFY_GATEWAY_KEY', '');
        vi.stubEnv('SHOPIFY_TOKEN_LESCENT', 'shpat_da_loja');
        const fetchSpy = gateway({});

        const res = await pedir('lescent', '592465');

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Shopify gateway key not configured' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['ausente', ''],
        ['em http (a chave iria sem TLS)', 'http://gateway.exemplo.test/v1/shopify'],
        ['sem esquema', 'gateway.exemplo.test/v1/shopify'],
    ])('a SHOPIFY_GATEWAY_URL %s ⇒ 500 sem chamar nada: o gateway não tem endereço padrão', async (_caso, url) => {
        vi.stubEnv('SHOPIFY_GATEWAY_URL', url);
        const fetchSpy = gateway({});

        const res = await pedir('lescent', '592465');

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Shopify gateway key not configured' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('o POST vai ao endereço da marca, sem o /graphql do gateway antigo (que dava 400 no GoAccess)', async () => {
        const fetchSpy = gateway({});

        await pedir('apice', '1752720');

        expect(String(fetchSpy.mock.calls[0][0])).toBe(`${GATEWAY}/shopify/apice`);
        expect(String(fetchSpy.mock.calls[0][0])).not.toContain('/graphql');
    });

    it('o erro do gateway vai ao log com a mensagem dele (só o texto de erro)', async () => {
        gateway({}, { status: 400, json: { error: 'rota desconhecida' } });

        const res = await pedir('apice', '1752720');

        expect(res.status).toBe(502);
        expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0]))).toContain('[Shopify Gateway] apice: HTTP 400 (rota desconhecida)');
    });

    it.each([401, 403])('o gateway recusa a chave (HTTP %i; o novo responde 403 invalid_key) ⇒ 502', async (status) => {
        gateway({}, { status, json: { error: 'invalid_key' } });

        const res = await pedir('kokeshi', '1204230');

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: `Shopify gateway error: ${status}` });
    });

    it('400 para marca desconhecida, sem chamar nada', async () => {
        const fetchSpy = gateway({});

        const res = await pedir('xyz', '12345');

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Unknown brand: xyz' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('400 sem brand ou sem orderId', async () => {
        expect((await GET(createRequest('http://localhost/api/shopify/orders?orderId=12345'))).status).toBe(400);
        expect((await GET(createRequest('http://localhost/api/shopify/orders?brand=lescent'))).status).toBe(400);
    });
});
