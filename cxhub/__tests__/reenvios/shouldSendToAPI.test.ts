import { describe, it, expect } from 'vitest';
import { shouldSendToAPI } from '@modules/reenvios/actions/shouldSendToAPI';
import { createShouldSendToAPIInput } from '../helpers/factories';

describe('shouldSendToAPI', () => {
    describe('happy path', () => {
        it('returns true when all conditions are met', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput());
            expect(result.shouldSendToAPI).toBe(true);
            expect(result.motivo).toBeUndefined();
        });

        it('is case-insensitive for tipoSolicitacao', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({ tipoSolicitacao: 'REENVIO' }));
            expect(result.shouldSendToAPI).toBe(true);
        });

        it('returns true when all extra products are gifts', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({
                extraProducts: [{ is_gift: true }, { is_gift: true }],
            }));
            expect(result.shouldSendToAPI).toBe(true);
        });

        it('returns true with multiple non-gift order products', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({
                orderProducts: [{ is_gift: false }, { is_gift: false }],
            }));
            expect(result.shouldSendToAPI).toBe(true);
        });
    });

    describe('blocked: Shopify', () => {
        it('returns false with Shopify motivo when isShopify is true', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({ isShopify: true }));
            expect(result.shouldSendToAPI).toBe(false);
            expect(result.motivo).toBe('Pedidos originados da Shopify são processados manualmente');
        });

        it('Shopify check takes priority over wrong type', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({
                tipoSolicitacao: 'cashback',
                isShopify: true,
            }));
            expect(result.shouldSendToAPI).toBe(false);
            expect(result.motivo).toBe('Pedidos originados da Shopify são processados manualmente');
        });
    });

    describe('blocked: wrong tipoSolicitacao', () => {
        it('returns false when tipo is "cashback"', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({ tipoSolicitacao: 'cashback' }));
            expect(result.shouldSendToAPI).toBe(false);
            expect(result.motivo).toBe('Tipo de solicitação não é "Reenvio"');
        });

        it('returns false when tipo is empty string', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({ tipoSolicitacao: '' }));
            expect(result.shouldSendToAPI).toBe(false);
            expect(result.motivo).toBe('Tipo de solicitação não é "Reenvio"');
        });
    });

    describe('blocked: all order products are gifts', () => {
        it('returns false with brinde motivo when every order product is a gift', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({
                orderProducts: [{ is_gift: true }, { is_gift: true }],
            }));
            expect(result.shouldSendToAPI).toBe(false);
            expect(result.motivo).toBe('Todos os produtos de reenvio são brindes - é necessário ao menos um produto que não seja brinde');
        });
    });

    describe('blocked: extra non-gift products', () => {
        it('returns false with count of 1 non-gift extra', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({
                extraProducts: [{ is_gift: false }],
            }));
            expect(result.shouldSendToAPI).toBe(false);
            expect(result.motivo).toBe('Existem 1 produto(s) extra(s) que não são brindes');
        });

        it('returns false and counts 2 non-gift extras', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({
                extraProducts: [{ is_gift: false }, { is_gift: false }],
            }));
            expect(result.shouldSendToAPI).toBe(false);
            expect(result.motivo).toBe('Existem 2 produto(s) extra(s) que não são brindes');
        });
    });

    describe('blocked: empty orderProducts', () => {
        it('returns false when orderProducts is empty', () => {
            const result = shouldSendToAPI(createShouldSendToAPIInput({ orderProducts: [] }));
            expect(result.shouldSendToAPI).toBe(false);
        });
    });
});
