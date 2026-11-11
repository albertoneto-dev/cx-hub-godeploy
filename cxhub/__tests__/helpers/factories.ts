/**
 * Factories para criar dados de teste de forma flexível.
 * Use spread operator para sobrescrever apenas os campos necessários.
 */

import type { ErpPayloadItem, NormalizedProduct, NormalizedOrder, NormalizedAddress } from '@shared/types';
import type { CalculateResendValueInput } from '@modules/reenvios/actions/calculateResendValue';
import type { ShouldSendToAPIInput } from '@modules/reenvios/actions/shouldSendToAPI';

// ─── ERP Payload Item ────────────────────────────────────────────────

export function createErpPayloadItem(overrides: Partial<ErpPayloadItem> = {}): ErpPayloadItem {
    return {
        sku: 'SKU-DEFAULT',
        quantity: 1,
        unit_price: 100.00,
        discount_value: 0,
        ...overrides,
    };
}

// ─── Normalized Product ──────────────────────────────────────────────

export function createNormalizedProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
    return {
        id: 'prod-1',
        product_id: 1001,
        nome: 'Produto Teste',
        sku: 'SKU-DEFAULT',
        quantidade: 1,
        preco: '100.00',
        ...overrides,
    };
}

// ─── Normalized Address ──────────────────────────────────────────────

export function createNormalizedAddress(overrides: Partial<NormalizedAddress> = {}): NormalizedAddress {
    return {
        logradouro: 'Rua Teste',
        numero: '123',
        complemento: '',
        bairro: 'Centro',
        cidade: 'São Paulo',
        estado: 'SP',
        cep: '01001-000',
        ...overrides,
    };
}

// ─── Normalized Order ────────────────────────────────────────────────

export function createNormalizedOrder(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
    return {
        source: 'cosmos',
        cosmos_id: 12345,
        shopify_id: '220183',
        order_name: '#SHOPIFY220183',
        numeroPedido: '#SHOPIFY220183',
        numeroNF: '123456',
        invoiceAccessKey: 'chave-acesso-teste',
        nomeCliente: 'Cliente Teste',
        telefoneCliente: '11999999999',
        enderecoCliente: 'Rua Teste, 123, Centro, São Paulo, 01001-000 - SP',
        endereco: createNormalizedAddress(),
        transportadora: 'PAC',
        cdOrigem: 'SP',
        produtos: [createNormalizedProduct()],
        erpPayloadItems: [createErpPayloadItem()],
        shippingCost: '15.00',
        discountAmount: '0',
        ...overrides,
    };
}

// ─── Calculate Resend Value Input ────────────────────────────────────

export function createCalculateResendValueInput(
    overrides: Partial<CalculateResendValueInput> = {}
): CalculateResendValueInput {
    return {
        selectedProducts: [
            { id: 'prod-1', sku: 'SKU-DEFAULT', isGift: false },
        ],
        quantidadesReenviar: { 'prod-1': 1 },
        extraGiftsCount: 0,
        erpPayloadItems: [createErpPayloadItem()],
        shippingCost: '0',
        ...overrides,
    };
}

// ─── Should Send To API Input ────────────────────────────────────────

export function createShouldSendToAPIInput(
    overrides: Partial<ShouldSendToAPIInput> = {}
): ShouldSendToAPIInput {
    return {
        tipoSolicitacao: 'Reenvio',
        isShopify: false,
        orderProducts: [{ is_gift: false }],
        extraProducts: [],
        ...overrides,
    };
}
