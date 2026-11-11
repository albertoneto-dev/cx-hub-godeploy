import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enrichOrderWithProductDetails } from '@shared/lib/cosmos/client';
import type { EnrichDeps } from '@shared/lib/cosmos/client';
import type { CosmosProduct, NormalizedOrder } from '@shared/types';
import {
    createNormalizedOrder,
    createNormalizedProduct,
    createErpPayloadItem,
} from '../helpers/factories';

// ─── Fixtures ───────────────────────────────────────────────────────

function makeCosmosProduct(overrides: Partial<CosmosProduct> = {}): CosmosProduct {
    return {
        id: 1,
        name: 'Produto',
        price: '100.00',
        sku: 'SKU-DEFAULT',
        gtin: '',
        ncm: '',
        active: true,
        is_kit: false,
        isGift: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

/** Pedido com um kit de topo; os componentes só existem no catálogo/detalhe. */
function makeKitOrder(): NormalizedOrder {
    return createNormalizedOrder({
        produtos: [
            createNormalizedProduct({
                id: 'p1', product_id: 10, nome: 'Kit Completo',
                sku: 'KIT-001', quantidade: 1, preco: '100.00',
            }),
        ],
        erpPayloadItems: [
            createErpPayloadItem({ sku: 'COMP-A', quantity: 1, unit_price: 50, discount_value: 0 }),
            createErpPayloadItem({ sku: 'COMP-B', quantity: 1, unit_price: 30, discount_value: 0 }),
        ],
    });
}

const CATALOGO: CosmosProduct[] = [
    makeCosmosProduct({ id: 10, sku: 'KIT-001', name: 'Kit Completo', is_kit: true, price: '100.00' }),
    makeCosmosProduct({ id: 11, sku: 'COMP-A', name: 'Componente A', price: '55.00' }),
    makeCosmosProduct({ id: 12, sku: 'COMP-B', name: 'Componente B', price: '35.00' }),
];

function makeDeps(): EnrichDeps & {
    getProducts: ReturnType<typeof vi.fn>;
    getProductDetails: ReturnType<typeof vi.fn>;
    getProductBySku: ReturnType<typeof vi.fn>;
} {
    return {
        getProducts: vi.fn(async () => CATALOGO),
        getProductDetails: vi.fn(async () => ({ id: 10, kit_skus: ['COMP-A', 'COMP-B'] })),
        getProductBySku: vi.fn(async (_brandId: string, sku: string) =>
            CATALOGO.filter(p => p.sku === sku)
        ),
    };
}

describe('enrichOrderWithProductDetails — injeção de dependência', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => [],
        })) as unknown as ReturnType<typeof vi.fn>;
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('usa as deps injetadas e NÃO faz fetch', async () => {
        const deps = makeDeps();

        await enrichOrderWithProductDetails(makeKitOrder(), '3', 'token-fake', undefined, deps);

        expect(deps.getProducts).toHaveBeenCalledWith('3', 'token-fake');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('expande os componentes do kit a partir do kit_skus devolvido pela dep', async () => {
        const deps = makeDeps();

        const enriched = await enrichOrderWithProductDetails(
            makeKitOrder(), '3', 'token-fake', undefined, deps
        );

        expect(deps.getProductDetails).toHaveBeenCalledWith('3', 10, 'token-fake');

        const kit = enriched.produtos[0];
        expect(kit.isKit).toBe(true);
        expect(kit.kitComponents).toBeDefined();
        expect(kit.kitComponents!.map(c => c.sku)).toEqual(['COMP-A', 'COMP-B']);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('precifica os componentes pelo erpPayloadItems (preço real da venda)', async () => {
        const deps = makeDeps();

        const enriched = await enrichOrderWithProductDetails(
            makeKitOrder(), '3', 'token-fake', undefined, deps
        );

        const componentes = enriched.produtos[0].kitComponents!;
        const precoPorSku = new Map(componentes.map(c => [c.sku, Number(c.preco)]));
        expect(precoPorSku.get('COMP-A')).toBe(50);
        expect(precoPorSku.get('COMP-B')).toBe(30);
    });

    it('com existingProducts, não chama getProducts e ainda não faz fetch', async () => {
        const deps = makeDeps();

        const enriched = await enrichOrderWithProductDetails(
            makeKitOrder(), '3', 'token-fake', CATALOGO, deps
        );

        expect(deps.getProducts).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(enriched.produtos[0].kitComponents).toHaveLength(2);
    });

    it('sem deps, cai no default do módulo (usa fetch) — callers de página não mudam', async () => {
        await enrichOrderWithProductDetails(makeKitOrder(), '3', 'token-fake');

        expect(fetchSpy).toHaveBeenCalled();
    });
});
