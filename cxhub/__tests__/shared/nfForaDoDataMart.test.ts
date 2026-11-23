import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { lerNfForaDoDataMart } from '@shared/lib/datamart/nfForaDoDataMartServer';
import {
    CONTA_INTELIPOST_NO_GATEWAY,
    lerRespostaDaIntelipost,
    nfDoEnvio,
    pedidoNaIntelipost,
} from '@shared/lib/intelipost/gateway';
import { nfNaIntelipostAoVivo } from '@shared/lib/intelipost/nfNaIntelipostServer';
import { MARCAS_COM_NF_NA_SHOPIFY, normalizarNf } from '@shared/lib/nfDaVenda';
import { nfNoMetacampoDaShopify } from '@shared/lib/shopify/buscarPedidoNoGateway';
import {
    acessoAoGateway,
    baseDoServicoNoGateway,
    CONSULTA_DA_NF,
    CONSULTA_DO_PEDIDO,
    escolherPedido,
    pedidoDoGatewayParaShopify,
    type PedidoDoGateway,
} from '@shared/lib/shopify/gateway';
import { adaptShopifyOrder } from '@shared/lib/shopify/adapter';

/**
 * A NF de venda fora do Data Mart (2026-11-19): o metacampo `custom.nf_numero` da Shopify e a Intelipost ao vivo, as duas
 * pelo gateway. Os números de pedido e de NF são os da medição de 19/11 (SH52988BS tem o metacampo 1834451;
 * o reenvio dele, SH52988BS-R-1, o 1905557); o resto é de mentira. Nenhuma chamada real.
 */

const GATEWAY = 'https://api.gateway.test/v1';

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

/** O pedido no formato GraphQL do gateway, só com o que importa à NF. */
const no = (name: string, nf: string | null, extra: Partial<PedidoDoGateway> = {}): PedidoDoGateway => ({
    id: 'gid://shopify/Order/9001', legacyResourceId: '9001', name, createdAt: '2026-11-10T12:00:00Z',
    totalPriceSet: { shopMoney: { amount: '99.90' } }, totalShippingPriceSet: { shopMoney: { amount: '0.00' } },
    customAttributes: [], nf: nf === null ? null : { value: nf }, lineItems: { edges: [] }, fulfillments: [],
    ...extra,
});

/** A resposta GraphQL do gateway com estes pedidos. */
const pedidos = (...nos: PedidoDoGateway[]) => json({ data: { orders: { edges: nos.map((node) => ({ node })) } } });

/** Um envio da Intelipost, de mentira, com a NF no volume (ou sem). */
const envio = (orderNumber: string, nf: string | null) => ({
    order_number: orderNumber,
    sales_order_number: orderNumber.slice(0, -3),
    shipment_order_volume_array: nf === null ? [{ shipment_order_volume_invoice: null }] : [{ shipment_order_volume_invoice: { invoice_number: nf } }],
});

let fetchSpy: MockInstance<typeof fetch>;
/** O gateway falso de cada caso. O `spyOn` repetido devolve o mesmo espião: as chamadas do caso anterior saem. */
const responder = (porUrl: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockClear().mockImplementation(async (input, init) => porUrl(String(input), init));
    return fetchSpy;
};

const prazo = () => Date.now() + 10_000;

beforeEach(() => {
    vi.stubEnv('SHOPIFY_GATEWAY_URL', `${GATEWAY}/shopify`);
    vi.stubEnv('SHOPIFY_GATEWAY_KEY', 'igw_leitura_de_teste');
    vi.stubEnv('INTELIPOST_GATEWAY_URL', `${GATEWAY}/intelipost`);
    vi.stubEnv('INTELIPOST_GATEWAY_KEY', 'igw_intelipost_de_teste');
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('normalizarNf e as marcas com o metacampo', () => {
    it('só dígitos, sem os zeros à esquerda, até 9; o resto é null', () => {
        expect(normalizarNf('001834451')).toBe('1834451');
        expect(normalizarNf(183916)).toBe('183916');
        expect(normalizarNf(' 1588301 ')).toBe('1588301');
        for (const nada of [null, undefined, '', '-', '0', '000', 'NF-1', '1234567890']) expect(normalizarNf(nada)).toBeNull();
    });

    it('as 6 do Cosmos e a Yenzah; nunca a Ápice, a Denavita nem a Gobeaute (medição de 19/11)', () => {
        expect([...MARCAS_COM_NF_NA_SHOPIFY].sort()).toEqual(['aua', 'barbours', 'bysamia', 'kokeshi', 'lescent', 'rituaria', 'yenzah']);
    });
});

describe('o metacampo no pedidoDoGatewayParaShopify', () => {
    it('as duas consultas pedem o metacampo custom.nf_numero; a da NF não pede dado da cliente', () => {
        const metacampo = 'nf: metafield(namespace: "custom", key: "nf_numero") { value }';
        expect(CONSULTA_DO_PEDIDO).toContain(metacampo);
        expect(CONSULTA_DA_NF).toContain(metacampo);
        for (const campo of ['customer', 'shippingAddress', 'email', 'tags', 'note']) expect(CONSULTA_DA_NF).not.toContain(campo);
    });

    it('o pedido e o reenvio SH…-R-1 vêm juntos no filtro: vale só a NF do que tem o nome procurado', () => {
        const nos = [no('SH52988BS-R-1', '001905557'), no('SH52988BS', '001834451')];
        // Nas marcas do Cosmos a busca é pelos dígitos; o reenvio tem outros dígitos e não é escolhido.
        const escolhido = escolherPedido(nos, '52988');
        expect(escolhido?.name).toBe('SH52988BS');
        const rest = pedidoDoGatewayParaShopify(escolhido!);
        expect(rest.note_attributes).toEqual([{ name: 'nf_number', value: '1834451' }]);
        expect(adaptShopifyOrder(rest, 'bysamia').numeroNF).toBe('1834451');
        // Nas sem Cosmos, o nome exato.
        const yenzah = [no('SH11249YE-R-1', '1600000'), no('SH11249YE', '1588301')];
        expect(pedidoDoGatewayParaShopify(escolherPedido(yenzah, 'SH11249YE')!).note_attributes).toEqual([{ name: 'nf_number', value: '1588301' }]);
    });

    it('sem o metacampo, o atributo nf_number fica de reserva; sem os dois, a tela recebe "-"', () => {
        const comAtributo = no('SH1832330AP', null, { customAttributes: [{ key: 'nf_number', value: '183916' }, { key: 'cpf', value: 'x' }] });
        expect(pedidoDoGatewayParaShopify(comAtributo).note_attributes).toEqual([{ name: 'nf_number', value: '183916' }]);
        const semNada = pedidoDoGatewayParaShopify(no('SH1832330AP', null));
        expect(semNada.note_attributes).toEqual([]);
        expect(adaptShopifyOrder(semNada, 'apice').numeroNF).toBe('-');
        // O metacampo vale antes do atributo.
        const osDois = no('SH52988BS', '1834451', { customAttributes: [{ key: 'nf_number', value: '999' }] });
        expect(pedidoDoGatewayParaShopify(osDois).note_attributes).toEqual([{ name: 'nf_number', value: '1834451' }]);
    });
});

describe('nfNoMetacampoDaShopify', () => {
    it('procura pelo SH da marca sem Cosmos (ou pelos dígitos, nas do Cosmos), com a consulta enxuta e a chave de leitura', async () => {
        responder(() => pedidos(no('SH11249YE', '1588301')));

        expect(await nfNoMetacampoDaShopify('yenzah', '11249', prazo())).toEqual({ ok: true, dados: '1588301' });
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${GATEWAY}/shopify/yenzah/graphql`);
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer igw_leitura_de_teste');
        expect(JSON.parse(String(init.body))).toEqual({ query: CONSULTA_DA_NF, variables: { q: 'name:SH11249YE' } });

        responder(() => pedidos(no('SH52988BS-R-1', '001905557'), no('SH52988BS', '001834451')));
        expect(await nfNoMetacampoDaShopify('bysamia', 'SH52988BS', prazo())).toEqual({ ok: true, dados: '1834451' });
        expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)).variables).toEqual({ q: 'name:52988' });
    });

    it('a Shopify respondeu: sem o pedido, ou o pedido sem o metacampo, é "sem NF" (ok com null)', async () => {
        responder(() => pedidos());
        expect(await nfNoMetacampoDaShopify('yenzah', '11249', prazo())).toEqual({ ok: true, dados: null });
        responder(() => pedidos(no('SH11249YE', null)));
        expect(await nfNoMetacampoDaShopify('yenzah', '11249', prazo())).toEqual({ ok: true, dados: null });
    });

    it('não respondeu: erro HTTP, erro do GraphQL, 200 sem JSON, rede, sem a chave ou sem prazo — nunca "sem NF"', async () => {
        const casos: Array<[string, () => Response | Promise<Response>]> = [
            ['HTTP 401', () => json({ error: 'invalid_key' }, 401)],
            ['erro do GraphQL', () => json({ errors: [{ message: 'Access denied' }] })],
            ['resposta 200 sem JSON', () => new Response('<html>', { status: 200 })],
            ['falha de rede', () => { throw new TypeError('fetch failed'); }],
        ];
        for (const [motivo, resposta] of casos) {
            responder(resposta);
            expect(await nfNoMetacampoDaShopify('yenzah', '11249', prazo()), motivo).toEqual({ ok: false, motivo });
        }

        const semChamada = responder(() => pedidos());
        expect(await nfNoMetacampoDaShopify('yenzah', '11249', Date.now() + 100)).toEqual({ ok: false, motivo: 'prazo esgotado antes da consulta' });
        vi.stubEnv('SHOPIFY_GATEWAY_KEY', '');
        expect(await nfNoMetacampoDaShopify('yenzah', '11249', prazo())).toEqual({ ok: false, motivo: 'sem a SHOPIFY_GATEWAY_KEY' });
        expect(semChamada).not.toHaveBeenCalled();
    });

    it('429: uma nova tentativa, se couber no prazo', async () => {
        let chamadas = 0;
        responder(() => (++chamadas === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : pedidos(no('SH11249YE', '1588301'))));
        expect(await nfNoMetacampoDaShopify('yenzah', '11249', prazo())).toEqual({ ok: true, dados: '1588301' });
        expect(chamadas).toBe(2);
    });
});

describe('a Intelipost pelo gateway (puro)', () => {
    it('as contas de cada marca, como na Central de Tickets e no Airflow', () => {
        expect(CONTA_INTELIPOST_NO_GATEWAY).toEqual({
            lescent: 'lescent', kokeshi: 'lescent', bysamia: 'lescent', aua: 'lescent',
            barbours: 'beautyhub', rituaria: 'beautyhub', yenzah: 'beautyhub',
            apice: 'apice', denavita: 'denavita',
        });
    });

    it('o pedido é o SH da própria marca, com a sigla dela', () => {
        expect(pedidoNaIntelipost('apice', '1832330')).toBe('SH1832330AP');
        expect(pedidoNaIntelipost('apice', 'SH1832330AP')).toBe('SH1832330AP');
        expect(pedidoNaIntelipost('yenzah', '11249')).toBe('SH11249YE');
        expect(pedidoNaIntelipost('denavita', '#430489')).toBe('SH430489DN');
        expect(pedidoNaIntelipost('bysamia', '52988')).toBe('SH52988BS');
        expect(pedidoNaIntelipost('rituaria', '1452727')).toBe('SH1452727RT');
        expect(pedidoNaIntelipost('lescent', '712937')).toBe('SH712937LC');
        expect(pedidoNaIntelipost('kokeshi', '1595343')).toBe('SH1595343KS');
        expect(pedidoNaIntelipost('aua', '1')).toBe('SH1AU');
        expect(pedidoNaIntelipost('barbours', '2813130')).toBe('SH2813130BB');
        expect(pedidoNaIntelipost('apice', 'sem número')).toBeNull();
    });

    it('a resposta: o envio em objeto, array ou shipment_orders[]; 400 e 404 são "não achou"; o resto é erro', () => {
        const e = envio('SH1832330AP001', '000183916');
        for (const content of [e, [e], { shipment_orders: [e] }]) {
            expect(lerRespostaDaIntelipost(200, { status: 'OK', content })).toEqual({ envio: e });
        }
        expect(lerRespostaDaIntelipost(200, { status: 'OK', content: [] })).toEqual({ naoAchou: true });
        expect(lerRespostaDaIntelipost(200, { status: 'OK', content: { shipment_orders: [] } })).toEqual({ naoAchou: true });
        expect(lerRespostaDaIntelipost(400, null)).toEqual({ naoAchou: true });
        expect(lerRespostaDaIntelipost(404, { error: 'not_found' })).toEqual({ naoAchou: true });
        for (const status of [401, 403, 429, 500, 502, 302]) expect(lerRespostaDaIntelipost(status, null)).toHaveProperty('erro');
        expect(lerRespostaDaIntelipost(200, null)).toEqual({ erro: 'resposta 200 sem JSON' });
        expect(lerRespostaDaIntelipost(200, { status: 'ERROR', messages: [] })).toHaveProperty('erro');
    });

    it('a NF é a do primeiro volume que tiver uma, sem os zeros à esquerda', () => {
        expect(nfDoEnvio(envio('X', '000183916'))).toBe('183916');
        expect(nfDoEnvio({ shipment_order_volume_array: [{ shipment_order_volume_invoice: { invoice_number: '' } }, { shipment_order_volume_invoice: { invoice_number: 183916 } }] })).toBe('183916');
        expect(nfDoEnvio(envio('X', null))).toBeNull();
        expect(nfDoEnvio({})).toBeNull();
    });
});

describe('nfNaIntelipostAoVivo', () => {
    it('pelo sales_order_number, na conta da marca, com a chave da Intelipost', async () => {
        responder(() => json({ status: 'OK', content: [envio('SH1832330AP001', '183916')] }));

        expect(await nfNaIntelipostAoVivo('apice', '1832330', prazo())).toEqual({ ok: true, dados: '183916' });
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${GATEWAY}/intelipost/apice/shipment_order/sales_order_number/SH1832330AP`);
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer igw_intelipost_de_teste');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('o envio enxuto sem a NF: lê o envio completo pelo order_number', async () => {
        responder((url) => (url.endsWith('/sales_order_number/SH11249YE')
            ? json({ status: 'OK', content: { shipment_orders: [{ order_number: 'SH11249YE001' }] } })
            : json({ status: 'OK', content: envio('SH11249YE001', '001588301') })));

        expect(await nfNaIntelipostAoVivo('yenzah', '11249', prazo())).toEqual({ ok: true, dados: '1588301' });
        expect(fetchSpy.mock.calls.map(([u]) => String(u))).toEqual([
            `${GATEWAY}/intelipost/beautyhub/shipment_order/sales_order_number/SH11249YE`,
            `${GATEWAY}/intelipost/beautyhub/shipment_order/SH11249YE001`,
        ]);
    });

    it('a Intelipost respondeu sem NF: o envio não existe (400), ou existe sem NF', async () => {
        responder(() => json({ status: 'ERROR', messages: [{ text: 'não encontrado' }] }, 400));
        expect(await nfNaIntelipostAoVivo('apice', '1837266', prazo())).toEqual({ ok: true, dados: null });
        responder((url) => json({ status: 'OK', content: url.includes('sales_order_number') ? { order_number: 'SH1837266AP001' } : envio('SH1837266AP001', null) }));
        expect(await nfNaIntelipostAoVivo('apice', '1837266', prazo())).toEqual({ ok: true, dados: null });
    });

    it('não respondeu: chave recusada, limite, fora do ar, rede, sem a chave ou sem prazo — nunca "sem NF"', async () => {
        for (const [status, motivo] of [
            [401, 'chave recusada pelo gateway (HTTP 401)'],
            [403, 'chave recusada ou sem permissão de leitura da Intelipost (HTTP 403)'],
            [429, 'limite de consultas do gateway (HTTP 429)'],
            [503, 'gateway ou Intelipost fora do ar (HTTP 503)'],
        ] as const) {
            responder(() => json({}, status));
            expect(await nfNaIntelipostAoVivo('denavita', '430489', prazo())).toEqual({ ok: false, motivo });
        }
        responder(() => { throw new TypeError('fetch failed'); });
        expect(await nfNaIntelipostAoVivo('denavita', '430489', prazo())).toEqual({ ok: false, motivo: 'falha de rede' });
        // O envio enxuto veio sem NF e o completo falhou: não se sabe.
        responder((url) => (url.includes('sales_order_number') ? json({ status: 'OK', content: { order_number: 'SH430489DN001' } }) : json({}, 502)));
        expect(await nfNaIntelipostAoVivo('denavita', '430489', prazo())).toMatchObject({ ok: false });

        const semChamada = responder(() => json({}));
        expect(await nfNaIntelipostAoVivo('denavita', '430489', Date.now() + 100)).toEqual({ ok: false, motivo: 'prazo esgotado antes da consulta' });
        vi.stubEnv('INTELIPOST_GATEWAY_KEY', ' ');
        expect(await nfNaIntelipostAoVivo('denavita', '430489', prazo())).toEqual({ ok: false, motivo: 'sem a INTELIPOST_GATEWAY_KEY' });
        expect(semChamada).not.toHaveBeenCalled();
    });

    it('o teto de cada consulta é 4 s: sem resposta nele, não respondeu', async () => {
        vi.useFakeTimers();
        try {
            responder((_url, init) => new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('abortado'), { name: 'AbortError' })));
            }));
            const leitura = nfNaIntelipostAoVivo('apice', '1832330', Date.now() + 10_000);
            await vi.advanceTimersByTimeAsync(4_000);
            expect(await leitura).toEqual({ ok: false, motivo: 'sem resposta em 4000 ms' });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('lerNfForaDoDataMart: o metacampo antes da Intelipost ao vivo', () => {
    const fontes = (metacampo: string | null | 'falha', intelipost: string | null) => ({
        metacampo: vi.fn(async () => (metacampo === 'falha' ? { ok: false as const, motivo: 'HTTP 503' } : { ok: true as const, dados: metacampo })),
        intelipost: vi.fn(async () => ({ ok: true as const, dados: intelipost })),
    });

    it('Yenzah: o metacampo achou, a Intelipost nem é consultada', async () => {
        const d = fontes('1588301', '9');
        expect(await lerNfForaDoDataMart('yenzah', '11249', 1, d)).toEqual({ shopify: { ok: true, dados: '1588301' } });
        expect(d.metacampo).toHaveBeenCalledWith('yenzah', '11249', 1);
        expect(d.intelipost).not.toHaveBeenCalled();
    });

    it('Yenzah: sem o metacampo (ou com ele fora), a Intelipost ao vivo', async () => {
        expect(await lerNfForaDoDataMart('yenzah', '11249', 1, fontes(null, '1588301'))).toEqual({
            shopify: { ok: true, dados: null }, intelipost: { ok: true, dados: '1588301' },
        });
        expect(await lerNfForaDoDataMart('yenzah', '11249', 1, fontes('falha', null))).toEqual({
            shopify: { ok: false, motivo: 'HTTP 503' }, intelipost: { ok: true, dados: null },
        });
    });

    it('Ápice e Denavita não têm o metacampo: só a Intelipost ao vivo', async () => {
        for (const marca of ['apice', 'denavita'] as const) {
            const d = fontes('1', '183916');
            expect(await lerNfForaDoDataMart(marca, '1832330', 1, d)).toEqual({ intelipost: { ok: true, dados: '183916' } });
            expect(d.metacampo).not.toHaveBeenCalled();
        }
    });

    it('um defeito numa leitura nunca lança: a fonte fica sem resposta', async () => {
        const d = { metacampo: vi.fn(async () => { throw new Error('bug'); }), intelipost: vi.fn() };
        expect(await lerNfForaDoDataMart('yenzah', '11249', 1, d)).toEqual({
            shopify: { ok: false, motivo: 'falha inesperada' }, intelipost: { ok: false, motivo: 'falha inesperada' },
        });
    });
});

describe('a URL e a chave de cada serviço do gateway (2026-11-23)', () => {
    it('a base aceita a URL com ou sem o nome do serviço no fim, sem duplicá-lo, e só em https', () => {
        expect(baseDoServicoNoGateway('https://api.gateway.test/v1/intelipost', 'intelipost')).toBe('https://api.gateway.test/v1/intelipost');
        expect(baseDoServicoNoGateway(' https://api.gateway.test/v1/Shopify/ ', 'shopify')).toBe('https://api.gateway.test/v1/Shopify');
        expect(baseDoServicoNoGateway('https://api.gateway.test/v1/', 'intelipost')).toBe('https://api.gateway.test/v1/intelipost');
        expect(baseDoServicoNoGateway('https://api.gateway.test', 'shopify')).toBe('https://api.gateway.test/shopify');
        // A URL de um serviço não vale pela do outro: ganha o caminho certo no fim (e o gateway responde 404).
        expect(baseDoServicoNoGateway('https://api.gateway.test/v1/shopify', 'intelipost')).toBe('https://api.gateway.test/v1/shopify/intelipost');
        for (const invalida of [undefined, '', '   ', 'http://api.gateway.test/v1', 'api.gateway.test/v1', 'https://']) {
            expect(baseDoServicoNoGateway(invalida, 'shopify'), String(invalida)).toBeNull();
        }
    });

    it('cada serviço lê os secrets dele, e o motivo diz qual falta', () => {
        expect(acessoAoGateway('shopify')).toEqual({ ok: true, base: `${GATEWAY}/shopify`, chave: 'igw_leitura_de_teste' });
        expect(acessoAoGateway('intelipost')).toEqual({ ok: true, base: `${GATEWAY}/intelipost`, chave: 'igw_intelipost_de_teste' });
        vi.stubEnv('SHOPIFY_GATEWAY_URL', '');
        expect(acessoAoGateway('shopify')).toEqual({ ok: false, motivo: 'sem a SHOPIFY_GATEWAY_URL (https)' });
        expect(acessoAoGateway('intelipost').ok).toBe(true);
        vi.stubEnv('INTELIPOST_GATEWAY_KEY', '');
        expect(acessoAoGateway('intelipost')).toEqual({ ok: false, motivo: 'sem a INTELIPOST_GATEWAY_KEY' });
    });

    it('as INTEGRATIONS_GATEWAY_* antigas não valem por nenhum dos dois', () => {
        for (const nome of ['SHOPIFY_GATEWAY_URL', 'SHOPIFY_GATEWAY_KEY', 'INTELIPOST_GATEWAY_URL', 'INTELIPOST_GATEWAY_KEY']) vi.stubEnv(nome, '');
        vi.stubEnv('INTEGRATIONS_GATEWAY_URL', 'https://integrations-gateway.antigo.test');
        vi.stubEnv('INTEGRATIONS_GATEWAY_READ_KEY', 'igw_antiga');
        vi.stubEnv('INTEGRATIONS_GATEWAY_WRITE_KEY', 'igw_antiga');
        expect(acessoAoGateway('shopify')).toEqual({ ok: false, motivo: 'sem a SHOPIFY_GATEWAY_KEY' });
        expect(acessoAoGateway('intelipost')).toEqual({ ok: false, motivo: 'sem a INTELIPOST_GATEWAY_KEY' });
    });

    it('a Intelipost com a URL sem o /intelipost: o caminho é acrescentado, com a chave dela', async () => {
        vi.stubEnv('INTELIPOST_GATEWAY_URL', 'https://api.gateway.test/v1/');
        const espiao = responder(() => json({ status: 'OK', content: envio('SH1832330AP001', '000183916') }));

        expect(await nfNaIntelipostAoVivo('apice', '1832330', prazo())).toEqual({ ok: true, dados: '183916' });
        const [url, init] = espiao.mock.calls[0];
        expect(url).toBe('https://api.gateway.test/v1/intelipost/apice/shipment_order/sales_order_number/SH1832330AP');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer igw_intelipost_de_teste');
    });

    it('sem a INTELIPOST_GATEWAY_URL, ou em http: não respondeu, sem chamar nada (nunca "sem NF")', async () => {
        const semChamada = responder(() => json({}));
        for (const url of ['', 'http://api.gateway.test/v1/intelipost']) {
            vi.stubEnv('INTELIPOST_GATEWAY_URL', url);
            expect(await nfNaIntelipostAoVivo('denavita', '430489', prazo())).toEqual({ ok: false, motivo: 'sem a INTELIPOST_GATEWAY_URL (https)' });
        }
        vi.stubEnv('SHOPIFY_GATEWAY_URL', '');
        expect(await nfNoMetacampoDaShopify('yenzah', '11249', prazo())).toEqual({ ok: false, motivo: 'sem a SHOPIFY_GATEWAY_URL (https)' });
        expect(semChamada).not.toHaveBeenCalled();
    });
});
