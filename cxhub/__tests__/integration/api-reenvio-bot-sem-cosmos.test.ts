import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * O bot com as marcas da rota dados e as marcas sem Cosmos (ADR-015).
 *
 * De ponta a ponta dentro da rota: o `buildBotResendData`, o `buildSubmissionData` e o adapter da Shopify são os
 * REAIS; a rota dados, o integrations-gateway (pelo `fetch`), o Cosmos e o transporte são simulados. A régua: a marca
 * sem Cosmos **nunca** chega ao Cosmos (INV-07) e a solicitação dela é sempre registrada, sem automação.
 */

vi.mock('@shared/lib/formDataApi', () => ({ buscarDadosDoFormulario: vi.fn() }));
vi.mock('@shared/lib/cosmos/server', () => ({
    getCosmosServiceToken: vi.fn(),
    fetchNormalizedCosmosOrder: vi.fn(),
    __resetCosmosTokenCache: vi.fn(),
}));
vi.mock('@modules/reenvios/actions/postResendWebhook', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@modules/reenvios/actions/postResendWebhook')>()),
    postResendWebhook: vi.fn(),
}));
vi.mock('@shared/lib/alerts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/alerts')>()),
    sendAlert: vi.fn(),
}));

import { POST } from '../../app/api/reenvio/bot/route';
import { buscarDadosDoFormulario } from '@shared/lib/formDataApi';
import { getCosmosServiceToken, fetchNormalizedCosmosOrder } from '@shared/lib/cosmos/server';
import { postResendWebhook } from '@modules/reenvios/actions/postResendWebhook';
import { sendAlert } from '@shared/lib/alerts';
import { createRequest } from '../helpers/api-test-utils';

const mRotaDados = vi.mocked(buscarDadosDoFormulario);
const mToken = vi.mocked(getCosmosServiceToken);
const mFetchOrder = vi.mocked(fetchNormalizedCosmosOrder);
const mPost = vi.mocked(postResendWebhook);
const mAlerta = vi.mocked(sendAlert);

const URL = 'http://localhost/api/reenvio/bot';
const BOT_SECRET = 'segredo-do-bot-123';
const GATEWAY = 'https://integrations-gateway-prod.rpa-ia.workers.dev';

function post(body: unknown) {
    return POST(createRequest(URL, { method: 'POST', body, headers: { 'x-bot-secret': BOT_SECRET } }));
}

/** O corpo da Central de Fluxos (fluxo Ápice extravio/avaria), com dado de mentira. */
function corpo(brand: string, extra: Record<string, unknown> = {}) {
    return {
        brand,
        testMode: false,
        handledBy: 'Typebot',
        sourceChannel: 'CHAT_ATENDIMENTO',
        customer: { name: 'Cliente Teste' },
        order: { ecommerceOrderId: '1724179' },
        reshipment: {
            isFullReshipment: true,
            requiresReturn: false,
            reason: 'Avaria confirmada pela transportadora',
            carrier: { name: 'Anjun Express' },
        },
        notes: 'Registrado automaticamente pela Central de Fluxos.',
        ...extra,
    };
}

/** Um pedido no formato GraphQL do gateway, com dado de mentira. */
const no = (name: string) => ({
    id: 'gid://shopify/Order/9001', legacyResourceId: '9001', name, createdAt: '2026-11-01T12:00:00Z',
    email: 'cliente@exemplo.com', displayFinancialStatus: 'PAID',
    currentTotalPriceSet: { shopMoney: { amount: '159.80' } },
    totalShippingPriceSet: { shopMoney: { amount: '19.90' } },
    customer: { firstName: 'Cliente', lastName: 'Teste', phone: null },
    shippingAddress: {
        name: 'Cliente Teste', address1: 'Rua A, 10', address2: 'Centro', city: 'Contagem', zip: '32146-027',
        province: 'Minas Gerais', provinceCode: 'MG', phone: '+5531999990000',
    },
    shippingLines: { edges: [{ node: { title: 'NORMAL_ANJUN' } }] },
    customAttributes: [],
    lineItems: { edges: [{ node: {
        id: 'gid://shopify/LineItem/555', name: 'Sérum', sku: 'AP001', vendor: 'Apice Cosmeticos', quantity: 2,
        originalUnitPriceSet: { shopMoney: { amount: '69.95' } }, totalDiscountSet: { shopMoney: { amount: '10.00' } },
    } }] },
    fulfillments: [],
});

/** O gateway falso: responde pelo `q` das variables (ou com uma resposta fixa). */
function gateway(porBusca: Record<string, unknown[]>, resposta?: { status: number; json: unknown }) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
        if (resposta) return new Response(JSON.stringify(resposta.json), { status: resposta.status });
        const { variables } = JSON.parse(String(init?.body)) as { variables: { q: string } };
        const nos = porBusca[variables.q] ?? [];
        return new Response(JSON.stringify({ data: { orders: { edges: nos.map((node) => ({ node })) } } }), { status: 200 });
    });
}

const rotaDadosCom = (marcas: string[]) => ({
    status: 200,
    body: { marcas, 'responsáveis': ['Ana'], motivos: [], transportadoras_reenvio: [] },
});

beforeEach(() => {
    vi.stubEnv('TIMEOUT', '10000');
    vi.stubEnv('BOT_RESEND_SECRET', BOT_SECRET);
    vi.stubEnv('INTEGRATIONS_GATEWAY_READ_KEY', 'igw_chave_de_teste');
    mRotaDados.mockReset().mockResolvedValue(rotaDadosCom(['lescent', 'kokeshi', 'apice', 'yenzah', 'denavita', 'gobeaute']));
    mToken.mockReset();
    mFetchOrder.mockReset();
    mAlerta.mockReset().mockResolvedValue(true);
    mPost.mockReset().mockResolvedValue({
        body: { code: 'SUCCESS_SHEETS_ONLY', message: 'Reenvio registrado.', sentToAPI: false, idSolicitacao: 'id-1' },
        status: 200,
    });
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('POST /api/reenvio/bot — as marcas vêm da rota dados', () => {
    it('marca que a rota dados não lista ⇒ 400 INVALID_PAYLOAD, sem consultar pedido nem registrar', async () => {
        const fetchSpy = gateway({});

        const res = await post(corpo('aua'));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toMatchObject({ code: 'UNKNOWN_ERROR', reason: 'INVALID_PAYLOAD' });
        expect(body.message).toBe('Invalid brand: aua (não está entre as marcas de reenvio da rota dados)');
        expect(mFetchOrder).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mPost).not.toHaveBeenCalled();
    });

    it('marca que a rota dados lista mas o código não conhece ⇒ 400 do mesmo jeito', async () => {
        mRotaDados.mockResolvedValue(rotaDadosCom(['gocase']));

        const res = await post(corpo('gocase'));

        expect(res.status).toBe(400);
        expect(mPost).not.toHaveBeenCalled();
    });

    it('rota dados fora ⇒ as marcas do código, e a Ápice é aceita', async () => {
        mRotaDados.mockResolvedValue({ status: 504, body: { error: 'O app de configuração do formulário não respondeu a tempo' } });
        gateway({ 'name:SH1724179AP': [no('SH1724179AP')] });

        const res = await post(corpo('apice'));

        expect(res.status).toBe(200);
        expect(mPost).toHaveBeenCalledTimes(1);
        expect(mPost.mock.calls[0][0].brand).toBe('apice');
    });

    it('rota dados fora e marca desconhecida ⇒ 400 "marca desconhecida"', async () => {
        mRotaDados.mockResolvedValue({ status: 500, body: { error: 'App de configuração do formulário não configurado' } });

        const res = await post(corpo('gocase'));

        expect(res.status).toBe(400);
        expect((await res.json()).message).toBe('Invalid brand: gocase (marca desconhecida)');
    });

    it('sem marca ⇒ 400 sem nem consultar a rota dados', async () => {
        const res = await post(corpo(''));

        expect(res.status).toBe(400);
        expect(mRotaDados).not.toHaveBeenCalled();
    });
});

describe('POST /api/reenvio/bot — marca sem Cosmos', () => {
    it('pedido achado na Shopify ⇒ só registro, com os dados do pedido e sem nenhuma chamada ao Cosmos', async () => {
        const fetchSpy = gateway({ 'name:SH1724179AP': [no('SH1724179AP')] });

        const res = await post(corpo('apice'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ code: 'SUCCESS_SHEETS_ONLY', message: 'Reenvio registrado.', sentToAPI: false, idSolicitacao: 'id-1' });
        expect(mToken).not.toHaveBeenCalled();
        expect(mFetchOrder).not.toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe(`${GATEWAY}/shopify/apice/graphql`);

        const enviado = mPost.mock.calls[0][0];
        expect(enviado).toMatchObject({ brand: 'apice', testMode: false });
        expect(enviado.token).toBeUndefined();
        expect(typeof enviado.timeoutMs).toBe('number');
        expect(enviado.idSolicitacao).toBeTruthy();
        expect(enviado.data.apiData).toBeUndefined();
        expect(enviado.data.automacao).toBe('');
        // O número do pedido da linha é o nome do pedido na Shopify, como a tela grava.
        expect(enviado.data.numeroPedido).toBe('SH1724179AP');
        expect(enviado.data.produtoReenviar).toContain('AP001');
        expect(enviado.data.transportadoraReenvio).toBe('Anjun Express');
        // Registrar é o caminho normal dessas marcas: nada no Chat, e nenhuma causa anotada na linha.
        expect(enviado.data.comentarios).not.toContain('[CXHub]');
        expect(mAlerta).not.toHaveBeenCalled();
    });

    it('a Gobeaute busca o pedido na loja dela (SH{n}GB) e também só registra', async () => {
        const fetchSpy = gateway({ 'name:SH1041GB': [no('SH1041GB')] });

        const res = await post(corpo('gobeaute', { order: { ecommerceOrderId: '1041' } }));

        expect(res.status).toBe(200);
        expect(fetchSpy.mock.calls[0][0]).toBe(`${GATEWAY}/shopify/gobeaute/graphql`);
        expect(mPost.mock.calls[0][0]).toMatchObject({ brand: 'gobeaute' });
        expect(mPost.mock.calls[0][0].data.apiData).toBeUndefined();
        expect(mFetchOrder).not.toHaveBeenCalled();
    });

    it('pedido não achado (só 60 dias no gateway) ⇒ registra com o que o bot mandou, ORDER_NOT_FOUND e sem aviso', async () => {
        gateway({});

        const res = await post(corpo('yenzah'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reason).toBe('ORDER_NOT_FOUND');
        expect(body.message).toContain('Pedido 1724179 não foi encontrado na Shopify');
        expect(mPost).toHaveBeenCalledTimes(1);
        expect(mPost.mock.calls[0][0].data.comentarios).toContain('[CXHub] Pedido 1724179 não foi encontrado na Shopify');
        expect(mFetchOrder).not.toHaveBeenCalled();
        expect(mAlerta).not.toHaveBeenCalled();
    });

    it('gateway fora (chave recusada) ⇒ registra com o que o bot mandou, SHOPIFY_UNAVAILABLE, e avisa no Chat', async () => {
        gateway({}, { status: 401, json: { error: 'invalid_key' } });

        const res = await post(corpo('denavita'));

        expect(res.status).toBe(200);
        expect((await res.json()).reason).toBe('SHOPIFY_UNAVAILABLE');
        expect(mPost).toHaveBeenCalledTimes(1);
        expect(mAlerta).toHaveBeenCalledTimes(1);
        expect(mAlerta.mock.calls[0][0]).toMatchObject({ reason: 'SHOPIFY_UNAVAILABLE', brand: 'denavita', detalhe: 'Shopify gateway error: 401' });
    });

    it('sem a INTEGRATIONS_GATEWAY_READ_KEY ⇒ registra mesmo assim (SHOPIFY_UNAVAILABLE), sem chamar o gateway', async () => {
        vi.stubEnv('INTEGRATIONS_GATEWAY_READ_KEY', '');
        const fetchSpy = gateway({});

        const res = await post(corpo('apice'));

        expect(res.status).toBe(200);
        expect((await res.json()).reason).toBe('SHOPIFY_UNAVAILABLE');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mPost).toHaveBeenCalledTimes(1);
    });

    it('o interruptor BOT_RESEND_EXECUTE=off não muda nada: não há automação a desligar, e o pedido é buscado', async () => {
        vi.stubEnv('BOT_RESEND_EXECUTE', 'off');
        gateway({ 'name:SH1724179AP': [no('SH1724179AP')] });

        const res = await post(corpo('apice'));

        const body = await res.json();
        expect(body.reason).toBeUndefined();
        expect(mPost.mock.calls[0][0].data.produtoReenviar).toContain('AP001');
    });

    it('reenvio parcial com SKU que não está no pedido ⇒ 422 INVALID_ITEMS, nada registrado', async () => {
        gateway({ 'name:SH1724179AP': [no('SH1724179AP')] });

        const res = await post(corpo('apice', {
            reshipment: {
                isFullReshipment: false, requiresReturn: false, reason: 'Troca', carrier: { name: 'J&T' },
                items: [{ sku: 'XX999', quantity: 1 }],
            },
        }));

        expect(res.status).toBe(422);
        expect((await res.json()).reason).toBe('INVALID_ITEMS');
        expect(mPost).not.toHaveBeenCalled();
    });

    it('reenvio parcial que confere ⇒ registra só o item pedido e ecoa os itens', async () => {
        gateway({ 'name:SH1724179AP': [no('SH1724179AP')] });

        const res = await post(corpo('apice', {
            reshipment: {
                isFullReshipment: false, requiresReturn: false, reason: 'Troca', carrier: { name: 'J&T' },
                items: [{ sku: 'AP001', quantity: 1, lineItemId: 555 }],
            },
        }));

        expect(res.status).toBe(200);
        expect((await res.json()).items).toEqual([{ sku: 'AP001', quantity: 1 }]);
        expect(mPost.mock.calls[0][0].data.ReenvioCompleto).toBe('Não');
    });
});
