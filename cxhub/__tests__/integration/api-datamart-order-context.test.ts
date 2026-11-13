import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/datamart/order-context/route';
import { createRequest } from '../helpers/api-test-utils';

/**
 * `GET /api/datamart/order-context?brand=&order=`: o que o servidor vai gravar para o pedido de uma marca sem Cosmos
 * (ADR-018) — NF, CD, status sugerido, avisos e kits —, com as mesmas leituras e regras da gravação. O Metabase falso
 * responde com o pedido real SH1731559AP da Ápice.
 */

const AUTH = 'Bearer test-token';
const COSMOS = 'https://api.cosmos.test';
const METABASE = 'https://metabase.test';

let tokenCosmos: number;
let respostaMetabase: (sql: string) => Response;

const linhas = (rows: unknown[][]) => new Response(JSON.stringify({ status: 'completed', data: { rows } }), { status: 202 });

/** O pedido SH1731559AP como o Data Mart o tem (os números do Tiny vêm como texto). */
function dataMartDoPedidoReal(sql: string): Response {
    if (sql.includes('vw_shopify_order_items_exploded_priced_enriched')) {
        return linhas([
            ['40132', '20683', true, 1, 1, 31.5], ['40132', '20684', true, 1, 1, 37.3], ['40132', '20688', true, 1, 1, 35.36],
            ['40132', '20690', true, 1, 1, 54.74], ['40132', '20696', true, 1, 1, 31],
            ['46194', '20910', true, 1, 1, 46.15], ['46194', '20911', true, 1, 1, 53.75],
        ]);
    }
    if (sql.includes('gold.fct_intelipost_orders')) {
        return linhas([['10157987', 'ES', '1061809849', '2026-10-27T20:09:43+00:00', null, true]]);
    }
    if (sql.includes('gold.fct_shopify_orders')) return linhas([['7001', '2026-10-27T11:20:00+00:00', 305.7, 15.9, false, true]]);
    if (sql.includes('tiny_pedidos_ap_cosmetics')) {
        return linhas([
            ['es', '1061809849', '1061811664', '2026-10-27', true, '40132', 'Kit Cachos - Shampoo, Condicionador, Gelatina, Máscara e Ativador (5 ITENS)', 1],
            ['es', '1061809849', '1061811664', '2026-10-27', true, '46194', 'KIT BRILHO PERFEITO - Shampoo em óleo e Óleo Árabe', 1],
        ]);
    }
    if (sql.includes('tiny_nfe_ap_cosmetics_es')) {
        const itens: Array<[string, string]> = [['20683', '37.2'], ['20684', '38.76'], ['20688', '37.2'], ['20690', '41.86'], ['20696', '34.88'], ['20910', '48.13'], ['20911', '51.77']];
        return linhas(itens.map(([sku, preco]) => ['1061811664', '10157987', 'Autorizada', '305.70', '289.80', '0.00', '15.90', true, sku, '1.0', preco]));
    }
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
}

function instalarFetch() {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith(`${COSMOS}/organizations/`)) {
            return new Response(JSON.stringify(tokenCosmos === 200 ? [] : { error: 'Token inválido' }), { status: tokenCosmos });
        }
        if (url === `${METABASE}/api/dataset`) return respostaMetabase(JSON.parse(String(init?.body)).native.query as string);
        throw new Error(`fetch inesperado: ${url}`);
    });
}

function pedir(query: string, headers: Record<string, string> = { Authorization: AUTH }) {
    return GET(createRequest(`http://localhost/api/datamart/order-context?${query}`, { headers }));
}

beforeEach(() => {
    vi.stubEnv('COSMOS_API_URL', COSMOS);
    vi.stubEnv('METABASE_URL', METABASE);
    vi.stubEnv('METABASE_API_KEY', 'chave');
    vi.stubEnv('METABASE_DATABASE_ID', '43');
    tokenCosmos = 200;
    respostaMetabase = dataMartDoPedidoReal;
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/datamart/order-context', () => {
    it('o pedido real SH1731559AP: NF, CD, status sugerido e a composição dos dois kits', async () => {
        instalarFetch();

        const res = await pedir('brand=apice&order=SH1731559AP');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            brand: 'apice',
            order: 'SH1731559AP',
            nf: '10157987',
            nfStatus: 'achada',
            cd: 'CD ES',
            statusSugerido: 'Pedido não entregue (em trânsito)',
            avisos: [],
            kits: [
                { sku: '40132', componentes: ['20683', '20684', '20688', '20690', '20696'].map((sku) => ({ sku, quantidade: 1 })) },
                { sku: '46194', componentes: [{ sku: '20910', quantidade: 1 }, { sku: '20911', quantidade: 1 }] },
            ],
            naoConferidos: [],
        });
    });

    it('aceita o número sem o prefixo e o sufixo, e a marca em qualquer caixa', async () => {
        instalarFetch();

        const res = await pedir('brand=APICE&order=%231731559');

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ brand: 'apice', order: 'SH1731559AP', nf: '10157987' });
    });

    it('pedido sem NF no Data Mart: nfStatus ausente e o aviso (o servidor recusaria a solicitação)', async () => {
        instalarFetch();
        respostaMetabase = (sql) => (sql.includes('fct_intelipost_orders') || sql.includes('fct_shopify_orders') ? linhas([]) : dataMartDoPedidoReal(sql));

        const corpo = await (await pedir('brand=apice&order=SH1731559AP')).json();

        expect(corpo).toMatchObject({ nf: null, nfStatus: 'ausente', naoConferidos: [] });
        expect(corpo.avisos).toContain('O pedido ainda não tem NF de venda autorizada no Tiny nem na Intelipost.');
    });

    it('o Data Mart fora do ar: 200 com o que não foi conferido e o aviso de que a gravação confere de novo', async () => {
        instalarFetch();
        respostaMetabase = () => new Response('erro', { status: 503 });

        const res = await pedir('brand=yenzah&order=SH5478YE');

        expect(res.status).toBe(200);
        const corpo = await res.json();
        expect(corpo).toMatchObject({ order: 'SH5478YE', nf: null, nfStatus: 'desconhecida', cd: null, naoConferidos: ['nf', 'cd'] });
        expect(corpo.avisos).toEqual(['O Data Mart não respondeu a tempo para conferir a NF e o CD; ao gravar, o servidor confere de novo.']);
    });

    it('marca fora das três (inclusive a Gobeaute) e número inválido: 400, sem consultar nada', async () => {
        const fetchSpy = instalarFetch();

        for (const query of ['', 'brand=lescent&order=SH1', 'brand=gobeaute&order=SH1001GB', 'brand=apice', 'brand=apice&order=SH']) {
            expect((await pedir(query)).status, query).toBe(400);
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sem o token, ou com o token recusado no Cosmos: 401, sem ler o Data Mart', async () => {
        const fetchSpy = instalarFetch();

        expect((await pedir('brand=apice&order=SH1731559AP', {})).status).toBe(401);
        tokenCosmos = 401;
        expect((await pedir('brand=apice&order=SH1731559AP')).status).toBe(401);
        expect(fetchSpy.mock.calls.some(([url]) => String(url).startsWith(METABASE))).toBe(false);
    });
});
