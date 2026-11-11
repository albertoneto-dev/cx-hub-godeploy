import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '../../app/api/reenvio/bot/route';
import { createRequest } from '../helpers/api-test-utils';
import { createErpPayloadItem, createNormalizedOrder, createNormalizedProduct } from '../helpers/factories';

/**
 * Reenvio PARCIAL pelo Portal de Cancelamento (`reshipment.isFullReshipment: false` + `items`).
 *
 * De ponta a ponta dentro do CXHub: o `buildBotResendData` e o `buildSubmissionData` são os REAIS, só o
 * Cosmos e o n8n são simulados. É o que prova que o corpo que iria ao ERP leva exatamente os itens e as
 * quantidades que o portal pediu, e nada do que a cliente desistiu.
 */

vi.mock('@shared/lib/cosmos/server', () => ({
    getCosmosServiceToken: vi.fn(),
    fetchNormalizedCosmosOrder: vi.fn(),
    __resetCosmosTokenCache: vi.fn(),
}));

vi.mock('@modules/reenvios/actions/postResendWebhook', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@modules/reenvios/actions/postResendWebhook')>();
    return { ...actual, postResendWebhook: vi.fn() };
});

import { getCosmosServiceToken, fetchNormalizedCosmosOrder } from '@shared/lib/cosmos/server';
import { postResendWebhook } from '@modules/reenvios/actions/postResendWebhook';

const mFetchOrder = vi.mocked(fetchNormalizedCosmosOrder);
const mToken = vi.mocked(getCosmosServiceToken);
const mPost = vi.mocked(postResendWebhook);

const URL = 'http://localhost/api/reenvio/bot';
const BOT_SECRET = 'segredo-do-bot-123';

function post(body: unknown) {
    return POST(createRequest(URL, { method: 'POST', body, headers: { 'x-bot-secret': BOT_SECRET } }));
}

// Pedido do exemplo do portal: 3 linhas, a cliente desistiu do sérum (KS05007).
const ORDER = createNormalizedOrder({
    numeroPedido: 'SH1234567KS',
    transportadora: 'PAC',
    produtos: [
        createNormalizedProduct({ id: '9912001', product_id: 101, sku: 'KS01002', nome: 'Tônico', quantidade: 1, preco: '50.00' }),
        createNormalizedProduct({ id: '9912002', product_id: 102, sku: 'KS03010', nome: 'Máscara', quantidade: 2, preco: '30.00' }),
        createNormalizedProduct({ id: '9912003', product_id: 103, sku: 'KS05007', nome: 'Sérum', quantidade: 1, preco: '90.00' }),
    ],
    erpPayloadItems: [
        createErpPayloadItem({ sku: 'KS01002', quantity: 1, unit_price: 50 }),
        createErpPayloadItem({ sku: 'KS03010', quantity: 2, unit_price: 30 }),
        createErpPayloadItem({ sku: 'KS05007', quantity: 1, unit_price: 90 }),
    ],
});

function corpoParcial(reshipment: Record<string, unknown> = {}) {
    return {
        brand: 'kokeshi',
        testMode: true,
        externalRequestId: '7f3c2a10-5b8e-4d1a-9c22-0e6f4b9a1d33',
        handledBy: 'maria.silva@gocase.com',
        sourceChannel: 'WhatsApp',
        customer: { name: 'Ana Souza' },
        order: { ecommerceOrderId: 'SH1234567KS' },
        reshipment: {
            isFullReshipment: false,
            requiresReturn: false,
            reason: 'Cancelamento para troca de item',
            carrier: { name: 'PAC' },
            items: [
                { sku: 'KS01002', quantity: 1, lineItemId: 9912001 },
                { sku: 'KS03010', quantity: 2, lineItemId: 9912002 },
            ],
            removedItems: [{ sku: 'KS05007', quantity: 1, lineItemId: 9912003 }],
            ...reshipment,
        },
        notes: 'Reenvio criado pelo Portal de Cancelamento. Atendimento 173482.',
    };
}

describe('POST /api/reenvio/bot — reenvio parcial (Portal de Cancelamento)', () => {
    beforeEach(() => {
        vi.stubEnv('TIMEOUT', '10000');
        vi.stubEnv('BOT_RESEND_SECRET', BOT_SECRET);
        vi.stubEnv('BOT_RESEND_EXECUTE', undefined as unknown as string);
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
        vi.stubEnv('COSMOS_EMAIL', 'robo@gocase.com');
        vi.stubEnv('COSMOS_PASSWORD', 'senha-do-robo');

        mToken.mockReset().mockResolvedValue('token-de-servico');
        mFetchOrder.mockReset().mockResolvedValue(ORDER);
        mPost.mockReset().mockResolvedValue({
            body: { code: 'SUCCESS_TEST_MODE', message: 'ensaio', sentToAPI: false },
            status: 200,
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('manda ao ERP só os itens pedidos, com as quantidades pedidas', async () => {
        await post(corpoParcial());

        expect(mPost).toHaveBeenCalledTimes(1);
        const { data } = mPost.mock.calls[0][0];
        expect(data.apiData?.resendProducts).toEqual([
            { product_id: 101, quantity: 1, unit_price: '50' },
            { product_id: 102, quantity: 2, unit_price: '30' },
        ]);
        expect(data.ReenvioCompleto).toBe('Não');
    });

    it('a linha registra os itens que vão, os removidos e o ID do portal', async () => {
        await post(corpoParcial());

        const { data } = mPost.mock.calls[0][0];
        expect(data.produtoReenviar).toContain('KS01002');
        expect(data.produtoReenviar).toContain('KS03010');
        expect(data.produtoReenviar).not.toContain('KS05007');
        expect(data.comentarios).toContain('Itens removidos: KS05007 - 1');
        expect(data.comentarios).toContain('Portal: 7f3c2a10-5b8e-4d1a-9c22-0e6f4b9a1d33');
    });

    it('a resposta ecoa os itens do reenvio', async () => {
        const res = await post(corpoParcial());
        const body = await res.json();

        expect(body.items).toEqual([{ sku: 'KS01002', quantity: 1 }, { sku: 'KS03010', quantity: 2 }]);
    });

    it('item fora do pedido ⇒ 422 INVALID_ITEMS e nenhuma linha gravada', async () => {
        const res = await post(corpoParcial({ items: [{ sku: 'KS99999', quantity: 1 }] }));
        const body = await res.json();

        expect(res.status).toBe(422);
        expect(body.code).toBe('INVALID_ITEMS');
        expect(body.message).toContain('KS99999');
        expect(mPost).not.toHaveBeenCalled();
    });

    it('quantidade acima da original ⇒ 422 INVALID_ITEMS', async () => {
        const res = await post(corpoParcial({ items: [{ sku: 'KS03010', quantity: 3, lineItemId: 9912002 }] }));

        expect(res.status).toBe(422);
        expect(mPost).not.toHaveBeenCalled();
    });

    it('lista vazia ⇒ 422 INVALID_ITEMS sem nem consultar o Cosmos', async () => {
        const res = await post(corpoParcial({ items: [] }));
        const body = await res.json();

        expect(res.status).toBe(422);
        expect(body.code).toBe('INVALID_ITEMS');
        expect(mFetchOrder).not.toHaveBeenCalled();
        expect(mPost).not.toHaveBeenCalled();
    });

    it('isFullReshipment: true segue reenviando o pedido inteiro (extravio, sem mudança)', async () => {
        await post(corpoParcial({ isFullReshipment: true, items: undefined }));

        const { data } = mPost.mock.calls[0][0];
        expect(data.apiData?.resendProducts.map((p: { product_id: number }) => p.product_id)).toEqual([101, 102, 103]);
    });
});
