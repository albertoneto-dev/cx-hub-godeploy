import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// As portas de registro delegam ao `process*`, que tem testes próprios (`processSemCosmos.test.ts`): aqui importa
// QUEM a porta deixa passar.
vi.mock('@modules/reenvios/actions/processResend', () => ({ processResend: vi.fn() }));
vi.mock('@modules/reembolsos/actions/processRefund', () => ({ processRefund: vi.fn() }));

import { POST as postarReenvioDaTela } from '../../app/api/sheets/append/route';
import { POST as postarReembolso } from '../../app/api/refund/submit/route';
import { GET as pedidosDoCosmos } from '../../app/api/cosmos/orders/route';
import { GET as produtosDoCosmos } from '../../app/api/cosmos/products/route';
import { GET as transportadorasDoCosmos } from '../../app/api/cosmos/carriers/route';
import { processResend } from '@modules/reenvios/actions/processResend';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import { VALID_RESEND_BRANDS } from '@modules/reenvios/actions/postResendWebhook';
import { adaptShopifyOrder } from '@shared/lib/shopify/adapter';
import { createRequest } from '../helpers/api-test-utils';
import { RESEND_DATA } from '../helpers/resend-fixtures';

/**
 * As marcas sem Cosmos (ADR-013) nas rotas: o reenvio da tela e o reembolso as aceitam (o bot também, ADR-015, com
 * testes em `api-reenvio-bot-sem-cosmos.test.ts`), nenhuma rota do Cosmos é chamada com elas, e o pedido delas é lido
 * pelo integrations-gateway (GraphQL), tentando `SH{n}{sufixo}` e depois `#n`.
 */

beforeEach(() => {
    vi.mocked(processResend).mockReset().mockResolvedValue({
        body: { code: 'SUCCESS_SHEETS_ONLY', message: 'ok', sentToAPI: false }, status: 200,
    });
    vi.mocked(processRefund).mockReset().mockResolvedValue({ body: { code: 'SUCCESS', message: 'ok' }, status: 200 });
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('portas de registro', () => {
    it('as marcas de reenvio do código são as 6 do Cosmos e as 4 sem Cosmos (a tela e a reserva do bot)', () => {
        expect(VALID_RESEND_BRANDS).toEqual([
            'lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria', 'apice', 'yenzah', 'denavita', 'gobeaute',
        ]);
    });

    it.each(['apice', 'yenzah', 'denavita', 'gobeaute'])('POST /api/sheets/append aceita %s e repassa ao processResend', async (brand) => {
        const res = await postarReenvioDaTela(createRequest('http://localhost/api/sheets/append', {
            method: 'POST', body: { brand, data: RESEND_DATA, token: 'tk' },
        }));

        expect(res.status).toBe(200);
        expect(vi.mocked(processResend).mock.calls[0][0]).toMatchObject({ brand });
    });

    it.each(['apice', 'yenzah', 'denavita', 'gobeaute'])('POST /api/refund/submit aceita %s', async (brand) => {
        const res = await postarReembolso(createRequest('http://localhost/api/refund/submit', {
            method: 'POST', body: { brand, data: { brand } },
        }));

        expect(res.status).toBe(200);
        expect(vi.mocked(processRefund).mock.calls[0][0]).toBe(brand);
    });

    it.each(['gocase', 'Apice', '__proto__'])('POST /api/refund/submit recusa %s', async (brand) => {
        const res = await postarReembolso(createRequest('http://localhost/api/refund/submit', {
            method: 'POST', body: { brand, data: {} },
        }));

        expect(res.status).toBe(400);
        expect(processRefund).not.toHaveBeenCalled();
    });
});

describe('rotas do Cosmos', () => {
    it.each([
        ['orders', () => pedidosDoCosmos(createRequest('http://localhost/api/cosmos/orders?brand=apice&orderId=1629891', { headers: { Authorization: 'Bearer tk' } }))],
        ['products', () => produtosDoCosmos(createRequest('http://localhost/api/cosmos/products?brand=yenzah', { headers: { Authorization: 'Bearer tk' } }))],
        ['carriers', () => transportadorasDoCosmos(createRequest('http://localhost/api/cosmos/carriers?brand=denavita&shopify_name=PAC', { headers: { Authorization: 'Bearer tk' } }))],
        ['orders (Gobeaute)', () => pedidosDoCosmos(createRequest('http://localhost/api/cosmos/orders?brand=gobeaute&orderId=1041', { headers: { Authorization: 'Bearer tk' } }))],
    ])('/api/cosmos/%s recusa marca sem Cosmos com 400 (o 401 do Cosmos deslogaria a agente) e não chama nada', async (_rota, chamar) => {
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
        const fetchSpy = vi.spyOn(global, 'fetch');

        const res = await chamar();

        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/não tem organização no Cosmos/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('GET /api/shopify/orders — marcas sem Cosmos e Rituária, pelo integrations-gateway', () => {
    type GetFn = (req: import('next/server').NextRequest) => Promise<import('next/server').NextResponse>;
    let GET: GetFn;
    const GATEWAY = 'https://integrations-gateway-prod.rpa-ia.workers.dev';

    beforeEach(async () => {
        // O mapa das lojas REST lê o token no carregamento do módulo; a chave do gateway é lida a cada chamada.
        vi.resetModules();
        vi.stubEnv('INTEGRATIONS_GATEWAY_READ_KEY', 'igw_chave_de_teste');
        vi.stubEnv('SHOPIFY_TOKEN_LESCENT', 'token-lescent');
        GET = (await import('../../app/api/shopify/orders/route')).GET;
    });

    /** Um pedido no formato GraphQL do gateway, com dado de mentira. */
    const no = (name: string, extra: Record<string, unknown> = {}) => ({
        id: 'gid://shopify/Order/9001', legacyResourceId: '9001', name, createdAt: '2026-11-01T12:00:00Z',
        email: 'cliente@exemplo.com', displayFinancialStatus: 'PAID',
        currentTotalPriceSet: { shopMoney: { amount: '159.80' } },
        totalShippingPriceSet: { shopMoney: { amount: '19.90' } },
        customer: { firstName: 'Maria', lastName: 'Teste', phone: null },
        shippingAddress: {
            name: 'Maria Teste', address1: 'Rua A, 10', address2: 'Centro', city: 'São Paulo', zip: '01001-000',
            province: 'São Paulo', provinceCode: 'SP', phone: '+5511999990000',
        },
        shippingLines: { edges: [{ node: { title: 'NORMAL_J&T' } }] },
        customAttributes: [{ key: 'additional_cpf_cnpj', value: '00000000191' }, { key: 'Rua', value: 'Rua A' }],
        lineItems: { edges: [{ node: {
            id: 'gid://shopify/LineItem/555', name: 'Sérum', sku: 'AP001', vendor: 'Apice Cosmeticos', quantity: 2,
            originalUnitPriceSet: { shopMoney: { amount: '69.95' } }, totalDiscountSet: { shopMoney: { amount: '10.00' } },
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

    it('Ápice: busca SH{n}AP e depois os dígitos, pela chave do gateway, e escolhe o pedido de nome exato', async () => {
        const fetchSpy = gateway({ 'name:1475900': [no('SH14759001AP'), no('#1475900')] });

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=apice&orderId=1475900'));

        expect(res.status).toBe(200);
        expect((await res.json()).orders.map((o: { name: string }) => o.name)).toEqual(['#1475900']);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(`${GATEWAY}/shopify/apice/graphql`);
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer igw_chave_de_teste');
        expect(JSON.parse(String(init?.body)).variables).toEqual({ q: 'name:SH1475900AP' });
        expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body)).variables).toEqual({ q: 'name:1475900' });
        // Nunca pede as tags (CPF) nem o local de atendimento (o gateway nega e anula a consulta inteira).
        expect(JSON.parse(String(init?.body)).query).not.toMatch(/tags|fulfillmentOrders/);
    });

    it('Gobeaute (o site multimarca, ADR-014): busca SH{n}GB na loja gobeaute do gateway', async () => {
        const fetchSpy = gateway({ 'name:SH1041GB': [no('SH1041GB')] });

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=gobeaute&orderId=1041'));

        expect(res.status).toBe(200);
        expect((await res.json()).orders.map((o: { name: string }) => o.name)).toEqual(['SH1041GB']);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(`${GATEWAY}/shopify/gobeaute/graphql`);
        expect(JSON.parse(String(init?.body)).variables).toEqual({ q: 'name:SH1041GB' });
    });

    it('devolve o pedido no formato REST que o adapter lê, sem os atributos com CPF e endereço', async () => {
        gateway({ 'name:SH3287YE': [no('SH3287YE')] });

        const corpo = await (await GET(createRequest('http://localhost/api/shopify/orders?brand=yenzah&orderId=SH3287YE'))).json();

        expect(corpo.orders[0]).toMatchObject({
            id: 9001,
            name: 'SH3287YE',
            financial_status: 'paid',
            current_total_price: '159.80',
            total_shipping_price_set: { shop_money: { amount: '19.90' } },
            customer: { first_name: 'Maria', last_name: 'Teste', phone: null },
            shipping_address: { province_code: 'SP', city: 'São Paulo', zip: '01001-000' },
            shipping_lines: [{ title: 'NORMAL_J&T' }],
            note_attributes: [],
            line_items: [{ id: 555, sku: 'AP001', quantity: 2, price: '69.95', discount_allocations: [{ amount: '10.00' }] }],
        });
        expect(JSON.stringify(corpo)).not.toContain('00000000191');
    });

    it('o nf_number, quando a loja o tem, segue como note_attributes', async () => {
        gateway({ 'name:SH416884DN': [no('SH416884DN', { customAttributes: [{ key: 'nf_number', value: '12345' }] })] });

        const corpo = await (await GET(createRequest('http://localhost/api/shopify/orders?brand=denavita&orderId=416884'))).json();

        expect(corpo.orders[0].note_attributes).toEqual([{ name: 'nf_number', value: '12345' }]);
    });

    it('nenhum dos dois nomes acha ⇒ lista vazia (a tela diz "não encontrado", com o aviso dos 60 dias)', async () => {
        const fetchSpy = gateway({});

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=apice&orderId=999'));

        expect(await res.json()).toEqual({ orders: [] });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('sem a INTEGRATIONS_GATEWAY_READ_KEY ⇒ 500, sem chamar o gateway', async () => {
        vi.stubEnv('INTEGRATIONS_GATEWAY_READ_KEY', '');
        const fetchSpy = gateway({});

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=yenzah&orderId=3287'));

        expect(res.status).toBe(500);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['erro do GraphQL com 200 (campo sem permissão)', { status: 200, json: { data: null, errors: [{ message: 'Access denied' }] } }],
        ['chave recusada', { status: 401, json: { error: 'invalid_key' } }],
        ['marca que o gateway não conhece', { status: 404, json: { error: 'unknown_store' } }],
    ])('%s ⇒ 502', async (_caso, resposta) => {
        gateway({}, resposta);

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=apice&orderId=1629891'));

        expect(res.status).toBe(502);
    });

    it('429 (limite de taxa da chave) ⇒ espera o Retry-After e tenta o mesmo nome de novo', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '0' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ data: { orders: { edges: [{ node: no('SH3287YE') }] } } }), { status: 200 }));

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=yenzah&orderId=3287'));

        expect(res.status).toBe(200);
        expect((await res.json()).orders[0].name).toBe('SH3287YE');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body)).variables).toEqual({ q: 'name:SH3287YE' });
    });

    it('429 também na nova tentativa ⇒ 502, sem uma terceira chamada', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () =>
            new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '0' } }));

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=apice&orderId=1629891'));

        expect(res.status).toBe(502);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('200 sem JSON ⇒ 502, e não lista vazia (que a tela mostraria como "pedido não encontrado")', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>erro</html>', { status: 200 }));

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=yenzah&orderId=3287'));

        expect(res.status).toBe(502);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('o gateway não responde no prazo ⇒ 504', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=denavita&orderId=416884'));

        expect(res.status).toBe(504);
    });

    it('Rituária (só neste app, sem o token da loja): pelo gateway, buscando só os dígitos, e nunca pelo REST', async () => {
        vi.stubEnv('SHOPIFY_TOKEN_RITUARIA', 'shpat_que_nao_deve_ser_usado');
        const rj = {
            name: 'Ana Teste', address1: 'Rua B, 20', address2: 'Centro', city: 'Rio de Janeiro', zip: '20010-000',
            province: 'Rio de Janeiro', provinceCode: 'RJ', phone: null,
        };
        const fetchSpy = gateway({ 'name:123456': [no('#1234567'), no('#123456', { shippingAddress: rj })] });

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=rituaria&orderId=123456'));

        expect(res.status).toBe(200);
        const { orders } = await res.json();
        expect(orders.map((o: { name: string }) => o.name)).toEqual(['#123456']);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(`${GATEWAY}/shopify/rituaria/graphql`);
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer igw_chave_de_teste');
        expect(JSON.parse(String(init?.body)).variables).toEqual({ q: 'name:123456' });
        expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain('shpat_que_nao_deve_ser_usado');
        // No adapter ela continua marca do Cosmos: o título do frete como veio (a tela faz o de-para pelo Cosmos) e a
        // regra de CD dela (RJ → RJ; na regra geral seria ES).
        expect(adaptShopifyOrder(orders[0], 'rituaria')).toMatchObject({ transportadora: 'NORMAL_J&T', cdOrigem: 'RJ' });
    });

    it('Rituária sem a INTEGRATIONS_GATEWAY_READ_KEY ⇒ 500 sem chamar nada, mesmo com um SHOPIFY_TOKEN_RITUARIA no ambiente', async () => {
        vi.stubEnv('INTEGRATIONS_GATEWAY_READ_KEY', '');
        vi.stubEnv('SHOPIFY_TOKEN_RITUARIA', 'shpat_da_loja');
        const fetchSpy = gateway({});

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=rituaria&orderId=123456'));

        expect(res.status).toBe(500);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('as outras 5 marcas do Cosmos seguem no REST da loja, com o token delas e uma busca só', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ orders: [{ id: 1 }] }), { status: 200 }));

        const res = await GET(createRequest('http://localhost/api/shopify/orders?brand=lescent&orderId=220183'));

        expect(await res.json()).toEqual({ orders: [{ id: 1 }] });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0][0])).toBe('https://568499-ef.myshopify.com/admin/api/2025-01/orders.json?status=any&name=220183');
        expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('token-lescent');
    });
});
