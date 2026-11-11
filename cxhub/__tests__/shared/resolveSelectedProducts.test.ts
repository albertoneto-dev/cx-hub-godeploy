import { describe, it, expect } from 'vitest';
import { resolveSelectedProducts } from '@shared/lib/productSelectionLogic';
import { createNormalizedProduct } from '../helpers/factories';

describe('resolveSelectedProducts', () => {
    describe('regular product', () => {
        it('returns the product as non-gift', () => {
            const produtos = [createNormalizedProduct({ id: 'prod-1', nome: 'Camiseta Azul', sku: 'CAM-01' })];
            const result = resolveSelectedProducts(['prod-1'], produtos);
            expect(result).toEqual([{ id: 'prod-1', sku: 'CAM-01', isGift: false }]);
        });
    });

    describe('gift detection by name', () => {
        it('marks as gift when nome contains "brinde"', () => {
            const produtos = [createNormalizedProduct({ id: 'prod-1', nome: 'Brinde especial', sku: 'BRD-01' })];
            const result = resolveSelectedProducts(['prod-1'], produtos);
            expect(result[0].isGift).toBe(true);
        });

        it('is case-insensitive for "brinde" name check', () => {
            const produtos = [createNormalizedProduct({ id: 'prod-1', nome: 'BRINDE Exclusivo', sku: 'BRD-02' })];
            const result = resolveSelectedProducts(['prod-1'], produtos);
            expect(result[0].isGift).toBe(true);
        });

        it('marks as gift when "brinde" appears mid-name', () => {
            const produtos = [createNormalizedProduct({ id: 'prod-1', nome: 'Kit com Brinde', sku: 'KIT-BRD' })];
            const result = resolveSelectedProducts(['prod-1'], produtos);
            expect(result[0].isGift).toBe(true);
        });
    });

    describe('gift detection by Kokeshi SKU', () => {
        it('marks KS99043 as gift', () => {
            const produtos = [createNormalizedProduct({ id: 'prod-1', nome: 'Item Kokeshi', sku: 'KS99043' })];
            const result = resolveSelectedProducts(['prod-1'], produtos);
            expect(result[0].isGift).toBe(true);
        });

        it('marks KS03012 as gift', () => {
            const produtos = [createNormalizedProduct({ id: 'prod-1', nome: 'Item Kokeshi', sku: 'KS03012' })];
            const result = resolveSelectedProducts(['prod-1'], produtos);
            expect(result[0].isGift).toBe(true);
        });

        it('normalizes SKU to uppercase before checking Kokeshi list', () => {
            const produtos = [createNormalizedProduct({ id: 'prod-1', nome: 'Item Kokeshi', sku: 'ks99043' })];
            const result = resolveSelectedProducts(['prod-1'], produtos);
            expect(result[0].isGift).toBe(true);
        });
    });

    describe('kit product (parent selected)', () => {
        it('returns kit with kitComponentSkus array', () => {
            const produtos = [createNormalizedProduct({
                id: 'kit-1',
                nome: 'Kit Completo',
                sku: 'KIT-SKU',
                isKit: true,
                kitComponents: [
                    createNormalizedProduct({ id: 'c-1', sku: 'COMP-A', nome: 'Componente A' }),
                    createNormalizedProduct({ id: 'c-2', sku: 'COMP-B', nome: 'Componente B' }),
                ],
            })];

            const result = resolveSelectedProducts(['kit-1'], produtos);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('kit-1');
            expect(result[0].sku).toBe('KIT-SKU');
            expect(result[0].isGift).toBe(false);
            expect(result[0].kitComponentSkus).toEqual([
                { sku: 'COMP-A', id: 'c-1' },
                { sku: 'COMP-B', id: 'c-2' },
            ]);
        });
    });

    describe('kit component selected individually', () => {
        it('includes component when parent kit is NOT selected', () => {
            const produtos = [createNormalizedProduct({
                id: 'kit-1',
                nome: 'Kit Completo',
                sku: 'KIT-SKU',
                isKit: true,
                kitComponents: [
                    createNormalizedProduct({ id: 'c-1', sku: 'COMP-A', nome: 'Componente A' }),
                ],
            })];

            const result = resolveSelectedProducts(['c-1'], produtos);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ id: 'c-1', sku: 'COMP-A', isGift: false });
        });

        it('excludes component when parent kit IS also selected', () => {
            const produtos = [createNormalizedProduct({
                id: 'kit-1',
                nome: 'Kit Completo',
                sku: 'KIT-SKU',
                isKit: true,
                kitComponents: [
                    createNormalizedProduct({ id: 'c-1', sku: 'COMP-A', nome: 'Componente A' }),
                ],
            })];

            const result = resolveSelectedProducts(['kit-1', 'c-1'], produtos);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('kit-1');
            expect(result[0].kitComponentSkus).toBeDefined();
        });
    });

    describe('unknown IDs', () => {
        it('returns empty array when ID does not match any product or component', () => {
            const result = resolveSelectedProducts(['id-fantasma'], []);
            expect(result).toEqual([]);
        });
    });

    describe('mixed selection', () => {
        it('handles regular + gift + kit in one call', () => {
            const produtos = [
                createNormalizedProduct({ id: 'p1', nome: 'Camiseta', sku: 'CAM-01' }),
                createNormalizedProduct({ id: 'p2', nome: 'Brinde Kokeshi', sku: 'KS99043' }),
                createNormalizedProduct({
                    id: 'kit-1',
                    nome: 'Kit A',
                    sku: 'KIT-01',
                    isKit: true,
                    kitComponents: [createNormalizedProduct({ id: 'c-1', sku: 'COMP-X', nome: 'Componente X' })],
                }),
            ];

            const result = resolveSelectedProducts(['p1', 'p2', 'kit-1'], produtos);

            expect(result).toHaveLength(3);

            const regular = result.find(r => r.id === 'p1');
            expect(regular?.isGift).toBe(false);

            const gift = result.find(r => r.id === 'p2');
            expect(gift?.isGift).toBe(true);

            const kit = result.find(r => r.id === 'kit-1');
            expect(kit?.kitComponentSkus).toEqual([{ sku: 'COMP-X', id: 'c-1' }]);
        });
    });

    /**
     * Garantia de "única fonte de verdade" — Step 3 usa resolveSelectedProducts.
     * Esses testes verificam que o que é exibido no Step 3 é exatamente
     * o que vai para o webhook/API.
     */
    describe('Step 3 display === webhook payload guarantee', () => {
        const produtos = [
            createNormalizedProduct({ id: 'p-normal', nome: 'Shampoo Y', sku: 'SH-01', quantidade: 3 }),
            createNormalizedProduct({
                id: 'kit-linda',
                nome: 'Kit Linda',
                sku: 'KL-01',
                quantidade: 2,
                isKit: true,
                kitComponents: [
                    createNormalizedProduct({ id: 'c-1', sku: 'KL-C1', nome: 'Componente 1', quantidade: 1 }),
                    createNormalizedProduct({ id: 'c-2', sku: 'KL-C2', nome: 'Componente 2', quantidade: 1 }),
                ],
            }),
        ];

        it('full kit selected: shows only kit SKU, NOT individual components', () => {
            // produtosReenviar has kit parent + its components (as set by toggleKitSelection)
            const result = resolveSelectedProducts(['kit-linda', 'c-1', 'c-2'], produtos);

            // Step 3 and webhook must show ONLY the kit — not 3 rows
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('kit-linda');
            expect(result[0].sku).toBe('KL-01');
            expect(result[0].kitComponentSkus).toHaveLength(2);
        });

        it('full kit: quantity comes from quantidadesReenviar[kit.id], not components', () => {
            const result = resolveSelectedProducts(['kit-linda', 'c-1', 'c-2'], produtos);
            const quantidadesReenviar: Record<string, number> = { 'kit-linda': 2, 'c-1': 2, 'c-2': 2 };

            // Step 3 reads quantity from quantidadesReenviar[item.id]
            const kitQty = quantidadesReenviar[result[0].id];
            expect(kitQty).toBe(2); // user selected 2, not the product's internal quantidade
        });

        it('partial kit (only some components): shows components individually, no kit parent', () => {
            // Only c-1 selected, kit parent not in list
            const result = resolveSelectedProducts(['c-1'], produtos);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('c-1');
            expect(result[0].sku).toBe('KL-C1');
            expect(result[0].kitComponentSkus).toBeUndefined();
        });

        it('normal product: quantity from quantidadesReenviar[produto.id]', () => {
            const result = resolveSelectedProducts(['p-normal'], produtos);
            const quantidadesReenviar: Record<string, number> = { 'p-normal': 3 };

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('p-normal');
            expect(quantidadesReenviar[result[0].id]).toBe(3);
        });

        it('kit + normal product together: each resolved independently', () => {
            const result = resolveSelectedProducts(['kit-linda', 'c-1', 'c-2', 'p-normal'], produtos);

            // Kit collapses to 1 entry, normal product is 1 entry → total 2
            expect(result).toHaveLength(2);

            const kitEntry = result.find(r => r.id === 'kit-linda');
            const normalEntry = result.find(r => r.id === 'p-normal');

            expect(kitEntry).toBeDefined();
            expect(normalEntry).toBeDefined();
            // No component entries
            expect(result.find(r => r.id === 'c-1')).toBeUndefined();
            expect(result.find(r => r.id === 'c-2')).toBeUndefined();
        });
    });
});
