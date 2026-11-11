import { describe, it, expect } from 'vitest';
import { calculateResendValue } from '@modules/reenvios/actions/calculateResendValue';
import { createCalculateResendValueInput, createErpPayloadItem } from '../helpers/factories';

describe('calculateResendValue', () => {
    describe('regular product', () => {
        it('calculates price for a single product with no discount and no shipping', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                erpPayloadItems: [createErpPayloadItem({ sku: 'SKU-DEFAULT', unit_price: 100, quantity: 1, discount_value: 0 })],
                shippingCost: '0',
            }));
            expect(result).toBe('100,00');
        });

        it('multiplies unit_price by selected quantity', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                erpPayloadItems: [createErpPayloadItem({ sku: 'SKU-DEFAULT', unit_price: 50, quantity: 1, discount_value: 0 })],
                quantidadesReenviar: { 'prod-1': 2 },
                shippingCost: '0',
            }));
            expect(result).toBe('100,00');
        });

        it('prorates discount by original quantity and applies to selected quantity', () => {
            // ERP: 2 units at R$100 each, total discount R$10 → unitDiscount = R$5
            // Selected: 2 → totalDiscount = R$10; value = (100×2) − 10 = R$190
            const result = calculateResendValue(createCalculateResendValueInput({
                erpPayloadItems: [createErpPayloadItem({ sku: 'SKU-DEFAULT', unit_price: 100, quantity: 2, discount_value: 10 })],
                quantidadesReenviar: { 'prod-1': 2 },
                shippingCost: '0',
            }));
            expect(result).toBe('190,00');
        });
    });

    describe('gift products', () => {
        it('uses real ERP price for gifts', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{ id: 'prod-1', sku: 'BRINDE-01', isGift: true }],
                quantidadesReenviar: { 'prod-1': 1 },
                erpPayloadItems: [createErpPayloadItem({ sku: 'BRINDE-01', unit_price: 29.90, quantity: 1, discount_value: 0 })],
                shippingCost: '0',
            }));
            expect(result).toBe('29,90');
        });

        it('multiplies real price by quantity for gifts', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{ id: 'prod-1', sku: 'BRINDE-01', isGift: true }],
                quantidadesReenviar: { 'prod-1': 3 },
                erpPayloadItems: [createErpPayloadItem({ sku: 'BRINDE-01', unit_price: 29.90, quantity: 3, discount_value: 0 })],
                shippingCost: '0',
            }));
            // 29.90 * 3 = 89.70
            expect(result).toBe('89,70');
        });

        it('uses Shopify fallback price for gifts when no ERP data', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{ id: 'prod-1', sku: 'BRINDE-01', isGift: true }],
                quantidadesReenviar: { 'prod-1': 2 },
                erpPayloadItems: [],
                shippingCost: '0',
                produtos: [{ id: 'prod-1', sku: 'BRINDE-01', preco: '15.00', quantidade: 2, desconto: '0' }],
            }));
            // 15.00 * 2 = 30.00
            expect(result).toBe('30,00');
        });
    });

    describe('extra gifts', () => {
        it('charges R$ 0.02 per extra gift', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [],
                quantidadesReenviar: {},
                extraGiftsCount: 2,
                erpPayloadItems: [],
                shippingCost: '0',
            }));
            expect(result).toBe('0,04');
        });
    });

    describe('shipping cost', () => {
        it('adds shipping cost to the total', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                shippingCost: '15.50',
            }));
            expect(result).toBe('115,50');
        });

        it('treats non-numeric shippingCost as zero', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                shippingCost: 'abc',
            }));
            expect(result).toBe('100,00');
        });
    });

    describe('kit products', () => {
        it('sums component prices for a kit', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{
                    id: 'kit-1',
                    sku: 'KIT-SKU',
                    isGift: false,
                    kitComponentSkus: [
                        { sku: 'COMP-A', id: 'c1' },
                        { sku: 'COMP-B', id: 'c2' },
                    ],
                }],
                quantidadesReenviar: { c1: 1, c2: 1 },
                erpPayloadItems: [
                    createErpPayloadItem({ sku: 'COMP-A', unit_price: 50, quantity: 1, discount_value: 0 }),
                    createErpPayloadItem({ sku: 'COMP-B', unit_price: 30, quantity: 1, discount_value: 0 }),
                ],
                shippingCost: '0',
            }));
            expect(result).toBe('80,00');
        });
    });

    describe('kit Shopify fallback (no ERP data)', () => {
        it('uses kit own price when entire kit is selected and no ERP data', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{
                    id: 'kit-1',
                    sku: 'KIT-SKU',
                    isGift: false,
                    kitComponentSkus: [
                        { sku: 'COMP-A', id: 'c1' },
                        { sku: 'COMP-B', id: 'c2' },
                    ],
                }],
                quantidadesReenviar: { 'kit-1': 1 },
                erpPayloadItems: [],
                shippingCost: '10.58',
                produtos: [
                    { id: 'kit-1', sku: 'KIT-SKU', preco: '99.90', quantidade: 1, desconto: '15.83' },
                ],
            }));
            // (99.90 * 1) - (15.83/1 * 1) + 10.58 = 84.07 + 10.58 = 94.65
            expect(result).toBe('94,65');
        });

        it('multiplies kit price by selected quantity', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{
                    id: 'kit-1',
                    sku: 'KIT-SKU',
                    isGift: false,
                    kitComponentSkus: [
                        { sku: 'COMP-A', id: 'c1' },
                    ],
                }],
                quantidadesReenviar: { 'kit-1': 2 },
                erpPayloadItems: [],
                shippingCost: '0',
                produtos: [
                    { id: 'kit-1', sku: 'KIT-SKU', preco: '99.90', quantidade: 2, desconto: '20.00' },
                ],
            }));
            // (99.90 * 2) - (20/2 * 2) = 199.80 - 20 = 179.80
            expect(result).toBe('179,80');
        });
    });

    describe('SKU not found', () => {
        it('skips product when SKU is not in erpPayloadItems and no produtos fallback', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{ id: 'p1', sku: 'SKU-INEXISTENTE', isGift: false }],
                quantidadesReenviar: { p1: 1 },
                erpPayloadItems: [createErpPayloadItem({ sku: 'OUTRO-SKU' })],
                shippingCost: '0',
            }));
            expect(result).toBe('0,00');
        });
    });

    describe('Shopify fallback (no ERP data)', () => {
        it('uses produtos preco when erpPayloadItems is empty', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{ id: 'p1', sku: '50037', isGift: false }],
                quantidadesReenviar: { p1: 1 },
                erpPayloadItems: [],
                shippingCost: '6.97',
                produtos: [{ id: 'p1', sku: '50037', preco: '89.90', quantidade: 1, desconto: '0' }],
            }));
            // 89.90 + 6.97 = 96.87
            expect(result).toBe('96,87');
        });

        it('applies Shopify discount_allocations to regular products', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{ id: 'p1', sku: 'BB02022', isGift: false }],
                quantidadesReenviar: { p1: 1 },
                erpPayloadItems: [],
                shippingCost: '10.58',
                produtos: [{ id: 'p1', sku: 'BB02022', preco: '49.90', quantidade: 1, desconto: '7.90' }],
            }));
            // (49.90 * 1) - (7.90/1 * 1) + 10.58 = 42.00 + 10.58 = 52.58
            expect(result).toBe('52,58');
        });

        it('applies Shopify discount to kit price when entire kit selected', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{
                    id: 'kit-1',
                    sku: 'KIT-SKU',
                    isGift: false,
                    kitComponentSkus: [
                        { sku: 'COMP-A', id: 'c1' },
                        { sku: 'COMP-B', id: 'c2' },
                    ],
                }],
                quantidadesReenviar: { 'kit-1': 1 },
                erpPayloadItems: [],
                shippingCost: '0',
                produtos: [
                    { id: 'kit-1', sku: 'KIT-SKU', preco: '100.00', quantidade: 1, desconto: '10.00' },
                ],
            }));
            // (100 * 1) - (10/1 * 1) = 90
            expect(result).toBe('90,00');
        });

        it('prefers ERP data over produtos fallback', () => {
            const result = calculateResendValue(createCalculateResendValueInput({
                selectedProducts: [{ id: 'p1', sku: 'SKU01', isGift: false }],
                quantidadesReenviar: { p1: 1 },
                erpPayloadItems: [createErpPayloadItem({ sku: 'SKU01', unit_price: 40, quantity: 1, discount_value: 5 })],
                shippingCost: '0',
                produtos: [{ id: 'p1', sku: 'SKU01', preco: '50.00', quantidade: 1 }],
            }));
            // ERP: (40 * 1) - 5 = 35, NOT produtos preco 50
            expect(result).toBe('35,00');
        });
    });

    describe('mixed scenarios', () => {
        it('sums regular product + gift (real price) + extra gifts (R$0.02) + shipping', () => {
            const result = calculateResendValue({
                selectedProducts: [
                    { id: 'p1', sku: 'SKU-A', isGift: false },
                    { id: 'p2', sku: 'BRINDE-01', isGift: true },
                ],
                quantidadesReenviar: { p1: 1, p2: 1 },
                extraGiftsCount: 1,
                erpPayloadItems: [
                    createErpPayloadItem({ sku: 'SKU-A', unit_price: 100, quantity: 1, discount_value: 0 }),
                    createErpPayloadItem({ sku: 'BRINDE-01', unit_price: 25, quantity: 1, discount_value: 0 }),
                ],
                shippingCost: '10.00',
            });
            // Regular: 100 + Gift: 25 (real price) + Extra: 0.02 + Shipping: 10 = 135.02
            expect(result).toBe('135,02');
        });
    });
});
