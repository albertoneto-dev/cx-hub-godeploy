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
const GATEWAY = 'https://api.gateway.test/v1';

let tokenCosmos: number;
let respostaMetabase: (sql: string) => Response;
/**
 * O gateway (2026-11-19): o metacampo da Shopify (`/shopify/…`) e a Intelipost ao vivo (`/intelipost/…`),
 * que só são lidos quando o Data Mart não tem a NF. Por padrão, a Intelipost não acha o envio (400) e a Shopify não tem
 * o pedido.
 */
let respostaGateway: (url: string) => Response;
const semEnvioNemPedido = (url: string): Response => (url.includes('/intelipost/')
    ? new Response(JSON.stringify({ status: 'ERROR' }), { status: 400 })
    : new Response(JSON.stringify({ data: { orders: { edges: [] } } }), { status: 200 }));

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
        if (url.startsWith(`${GATEWAY}/`)) return respostaGateway(url);
        throw new Error(`fetch inesperado: ${url}`);
    });
}

const chamadasAoGateway = (fetchSpy: ReturnType<typeof instalarFetch>) =>
    fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(GATEWAY));

function pedir(query: string, headers: Record<string, string> = { Authorization: AUTH }) {
    return GET(createRequest(`http://localhost/api/datamart/order-context?${query}`, { headers }));
}

beforeEach(() => {
    vi.stubEnv('COSMOS_API_URL', COSMOS);
    vi.stubEnv('METABASE_URL', METABASE);
    vi.stubEnv('METABASE_API_KEY', 'chave');
    vi.stubEnv('METABASE_DATABASE_ID', '43');
    vi.stubEnv('SHOPIFY_GATEWAY_URL', `${GATEWAY}/shopify`);
    vi.stubEnv('SHOPIFY_GATEWAY_KEY', 'igw_leitura_de_teste');
    vi.stubEnv('INTELIPOST_GATEWAY_URL', `${GATEWAY}/intelipost`);
    vi.stubEnv('INTELIPOST_GATEWAY_KEY', 'igw_intelipost_de_teste');
    tokenCosmos = 200;
    respostaMetabase = dataMartDoPedidoReal;
    respostaGateway = semEnvioNemPedido;
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/datamart/order-context', () => {
    it('o pedido real SH1731559AP: NF, CD, status sugerido e a composição dos dois kits', async () => {
        const fetchSpy = instalarFetch();

        const res = await pedir('brand=apice&order=SH1731559AP');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            brand: 'apice',
            order: 'SH1731559AP',
            nf: '10157987',
            nfStatus: 'achada',
            nfOrigem: 'datamart',
            cd: 'CD ES',
            statusSugerido: 'Pedido não entregue (em trânsito)',
            avisos: [],
            kits: [
                { sku: '40132', componentes: ['20683', '20684', '20688', '20690', '20696'].map((sku) => ({ sku, quantidade: 1 })) },
                { sku: '46194', componentes: [{ sku: '20910', quantidade: 1 }, { sku: '20911', quantidade: 1 }] },
            ],
            naoConferidos: [],
        });
        // Com a NF no Data Mart, nada sai para a Shopify nem para a Intelipost ao vivo: o caminho comum não fica mais lento.
        expect(chamadasAoGateway(fetchSpy)).toEqual([]);
    });

    it('aceita o número sem o prefixo e o sufixo, e a marca em qualquer caixa', async () => {
        instalarFetch();

        const res = await pedir('brand=APICE&order=%231731559');

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ brand: 'apice', order: 'SH1731559AP', nf: '10157987' });
    });

    it('pedido sem NF no Data Mart nem na Intelipost ao vivo: nfStatus ausente e o aviso (o servidor recusaria a solicitação)', async () => {
        const fetchSpy = instalarFetch();
        respostaMetabase = (sql) => (sql.includes('fct_intelipost_orders') || sql.includes('fct_shopify_orders') ? linhas([]) : dataMartDoPedidoReal(sql));

        const corpo = await (await pedir('brand=apice&order=SH1731559AP')).json();

        expect(corpo).toMatchObject({ nf: null, nfStatus: 'ausente', naoConferidos: [] });
        expect(corpo).not.toHaveProperty('nfMotivo');
        expect(corpo).not.toHaveProperty('nfOrigem');
        expect(corpo.avisos).toContain('O pedido ainda não tem NF de venda autorizada no Tiny nem na Intelipost.');
        // A Ápice não tem o metacampo: só a Intelipost ao vivo é lida, pelo SH da marca.
        expect(chamadasAoGateway(fetchSpy)).toEqual([`${GATEWAY}/intelipost/apice/shipment_order/sales_order_number/SH1731559AP`]);
    });

    it('a Yenzah sem NF no Data Mart e com o metacampo: nfStatus achada e nfOrigem shopify, sem ir à Intelipost', async () => {
        const fetchSpy = instalarFetch();
        respostaMetabase = (sql) => (sql.includes('fct_intelipost_orders') ? linhas([]) : dataMartDoPedidoReal(sql));
        respostaGateway = (url) => (url.includes('/shopify/yenzah')
            ? new Response(JSON.stringify({ data: { orders: { edges: [{ node: { name: 'SH5478YE', nf: { value: '001588301' } } }] } } }), { status: 200 })
            : semEnvioNemPedido(url));

        const res = await pedir('brand=yenzah&order=SH5478YE');

        expect(res.status).toBe(200);
        const corpo = await res.json();
        expect(corpo).toMatchObject({ order: 'SH5478YE', nf: '1588301', nfStatus: 'achada', nfOrigem: 'shopify', naoConferidos: [] });
        expect(corpo).not.toHaveProperty('nfMotivo');
        expect(chamadasAoGateway(fetchSpy)).toEqual([`${GATEWAY}/shopify/yenzah`]);
    });

    it('a Intelipost ao vivo com a chave recusada: desconhecida, sem resposta, com o aviso dela (e não "o Data Mart não respondeu")', async () => {
        instalarFetch();
        respostaMetabase = (sql) => (sql.includes('fct_intelipost_orders') || sql.includes('fct_shopify_orders') ? linhas([]) : dataMartDoPedidoReal(sql));
        respostaGateway = () => new Response(JSON.stringify({ error: 'invalid_key' }), { status: 401 });

        const corpo = await (await pedir('brand=apice&order=SH1731559AP')).json();

        expect(corpo).toMatchObject({ nf: null, nfStatus: 'desconhecida', nfMotivo: 'sem_resposta', naoConferidos: ['nf'] });
        expect(corpo.avisos[0]).toBe('O Data Mart ainda não tem a NF deste pedido, e a Intelipost não respondeu a tempo para confirmar. '
            + 'Confira o número na Intelipost; ao gravar, o servidor confere de novo.');
        expect(corpo.avisos.some((a: string) => a.startsWith('O Data Mart não respondeu'))).toBe(false);
    });

    it('o Data Mart fora do ar: 200 com o que não foi conferido, o motivo e o aviso de que a gravação confere de novo', async () => {
        instalarFetch();
        respostaMetabase = () => new Response('erro', { status: 503 });

        const res = await pedir('brand=yenzah&order=SH5478YE');

        expect(res.status).toBe(200);
        const corpo = await res.json();
        expect(corpo).toMatchObject({ order: 'SH5478YE', nf: null, nfStatus: 'desconhecida', nfMotivo: 'sem_resposta', cd: null, naoConferidos: ['nf', 'cd'] });
        expect(corpo.avisos).toEqual(['O Data Mart não respondeu a tempo para conferir a NF e o CD; ao gravar, o servidor confere de novo.']);
    });

    describe('o caso real SH1832330AP: cancelado no ES e refeito no RJ, antes de a Intelipost chegar ao gold', () => {
        // O Tiny tem as colunas cd, id_pedido, id_nota_fiscal, data_pedido, tem_rastreio, codigo_produto, descricao_produto,
        // quantidade_produto e situacao.
        const ES = ['es', '1063282732', '0', '2026-11-16', false, '20585', 'COND ACQUACREAM 100ML', '1.0000', 'Cancelado'];
        const RJ = ['rj', '858035694', '858039410', '2026-11-16', true, '20585', 'COND ACQUACREAM 100ML', '1.0000', 'Enviado'];

        function dataMart(tinyRj: unknown[][]) {
            return (sql: string): Response => {
                if (sql.includes('vw_shopify_order_items_exploded_priced_enriched')) return linhas([]);
                if (sql.includes('gold.fct_intelipost_orders')) return linhas([]);
                if (sql.includes('gold.fct_shopify_orders')) return linhas([['7874560426206', '2026-11-16T11:52:05+00:00', 189.81, 0, false, true]]);
                if (sql.includes("select 'es' as cd")) return linhas([ES]);
                if (sql.includes("select 'rj' as cd")) return linhas(tinyRj);
                // A NF 858039410 ainda não chegou à tabela de NFs do RJ.
                if (sql.includes('tiny_nfe_ap_cosmetics_rj')) return linhas([]);
                throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
            };
        }

        it('a NF emitida e ainda fora do Data Mart: desconhecida, com o motivo, o CD RJ e o aviso, sem dizer que o Data Mart não respondeu', async () => {
            instalarFetch();
            respostaMetabase = dataMart([RJ]);

            const res = await pedir('brand=apice&order=SH1832330AP');

            expect(res.status).toBe(200);
            const corpo = await res.json();
            expect(corpo).toMatchObject({
                order: 'SH1832330AP',
                nf: null,
                nfStatus: 'desconhecida',
                nfMotivo: 'nf_fora_do_data_mart',
                cd: 'CD RJ',
                naoConferidos: ['nf'],
            });
            expect(corpo.avisos).toEqual([
                'A NF deste pedido já foi emitida no Tiny do CD RJ, mas ainda não chegou ao Data Mart. Confira o número na Intelipost.',
                'Pedido encontrado em mais de um CD (ES cancelado, RJ); usando o CD RJ.',
            ]);
        });

        it('a NF 183916 já na Intelipost ao vivo: achada, com nfOrigem intelipost, o CD RJ e sem o aviso da NF', async () => {
            const fetchSpy = instalarFetch();
            respostaMetabase = dataMart([RJ]);
            respostaGateway = (url) => (url.endsWith('/intelipost/apice/shipment_order/sales_order_number/SH1832330AP')
                ? new Response(JSON.stringify({
                    status: 'OK',
                    content: [{ order_number: 'SH1832330AP001', shipment_order_volume_array: [{ shipment_order_volume_invoice: { invoice_number: '000183916' } }] }],
                }), { status: 200 })
                : semEnvioNemPedido(url));

            const corpo = await (await pedir('brand=apice&order=SH1832330AP')).json();

            expect(corpo).toMatchObject({ nf: '183916', nfStatus: 'achada', nfOrigem: 'intelipost', cd: 'CD RJ', naoConferidos: [] });
            expect(corpo.avisos).toEqual(['Pedido encontrado em mais de um CD (ES cancelado, RJ); usando o CD RJ.']);
            expect(chamadasAoGateway(fetchSpy)).toHaveLength(1);
        });

        it('só o pedido cancelado no ES: desconhecida pelo cancelamento, e o CD também, sem dizer que o Data Mart não respondeu', async () => {
            instalarFetch();
            respostaMetabase = dataMart([]);

            const corpo = await (await pedir('brand=apice&order=SH1832330AP')).json();

            expect(corpo).toMatchObject({ nfStatus: 'desconhecida', nfMotivo: 'pedido_cancelado_no_tiny', cd: null, naoConferidos: ['nf', 'cd'] });
            expect(corpo.avisos).toEqual(['O pedido está cancelado no Tiny do CD ES e pode ter sido refeito em outro CD. Confira a NF na Intelipost.']);
        });
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
