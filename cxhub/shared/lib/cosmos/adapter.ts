// Cosmos Order Adapter
// Converts CosmosDetailedOrder to NormalizedOrder

import { CosmosDetailedOrder } from '../../types/index';
import { NormalizedOrder, NormalizedAddress, ErpPayloadItem } from '../../types/index';
import { parseAddressStringExtended } from './address-utils';

/**
 * Extrai apenas os dígitos de um external_id
 * Ex: "#SHOPIFY220183" -> "220183", "SH220183BB" -> "220183"
 */
function extractShopifyId(externalId: string): string {
    return externalId.replace(/\D/g, '');
}

/**
 * Itens do erp_payload com preço e desconto por item, nos dois formatos que o Cosmos manda:
 * - Protheus: `items`, já com `discount_value` por item;
 * - ERP "Shopify": `lineItems`, sem desconto por item. O desconto do pedido (`discount_amount`) é
 *   distribuído proporcionalmente ao valor de cada item, em centavos, com o resíduo do arredondamento
 *   no último item para a soma bater exatamente.
 * Formato desconhecido ⇒ lista vazia e erro no log (o teto continua certo via `orderTotal`).
 */
function extractErpPayloadItems(order: CosmosDetailedOrder): ErpPayloadItem[] {
    const payload = order.erp_payload;
    if (!payload) return [];

    if (payload.items) {
        return payload.items.map(item => ({
            sku: item.sku,
            quantity: item.quantity,
            unit_price: item.unit_price,
            discount_value: item.discount_value,
        }));
    }

    if (payload.lineItems) {
        const gross = payload.lineItems.map(item => item.priceSet.shopMoney.amount * item.quantity);
        const grossTotal = gross.reduce((acc, value) => acc + value, 0);
        const discountCents = Math.round((parseFloat(order.discount_amount) || 0) * 100);

        let distributedCents = 0;
        return payload.lineItems.map((item, index) => {
            const isLast = index === payload.lineItems!.length - 1;
            const cents = isLast || grossTotal === 0
                ? discountCents - distributedCents
                : Math.round((discountCents * gross[index]) / grossTotal);
            distributedCents += cents;
            return {
                sku: item.sku,
                quantity: item.quantity,
                unit_price: item.priceSet.shopMoney.amount,
                discount_value: cents / 100,
            };
        });
    }

    console.error('[Cosmos adapter] erp_payload em formato desconhecido:', order.external_id, Object.keys(payload));
    return [];
}

export function adaptCosmosOrder(order: CosmosDetailedOrder): NormalizedOrder {
    const addr = order.shipping.address;

    // Parseia endereço para corrigir casos onde número/complemento estão concatenados no logradouro
    const parsedAddr = parseAddressStringExtended(addr.street, addr.number, addr.complement);

    // Monta o objeto de endereço normalizado
    const endereco: NormalizedAddress = {
        logradouro: parsedAddr.logradouro,
        numero: parsedAddr.numero,
        complemento: parsedAddr.complemento,
        bairro: addr.neighborhood || '',
        cidade: addr.city || '',
        estado: addr.state || '',
        cep: addr.postal_code || '',
    };

    const erpPayloadItems = extractErpPayloadItems(order);

    return {
        source: 'cosmos',
        // IDs
        cosmos_id: order.id,
        shopify_id: extractShopifyId(order.external_id),
        order_name: order.external_id,
        // Dados do pedido
        numeroPedido: order.external_id,
        numeroNF: order.invoice_number || '-',
        invoiceAccessKey: order.invoice_access_key || '',
        nomeCliente: order.customer?.name || order.shipping?.name || '-',
        telefoneCliente: order.shipping?.phone || order.customer?.phone || '-',
        enderecoCliente: `${addr.street}, ${addr.number}${addr.complement ? ', ' + addr.complement : ''}, ${addr.neighborhood}, ${addr.city}, ${addr.postal_code} - ${addr.state}`,
        endereco,
        transportadora: order.carrier?.name || '-',
        carrierId: order.carrier?.id,
        carrierServiceName: order.shipping?.service_name || '',
        shippingCost: order.shipping_cost || '0',
        discountAmount: order.discount_amount || '0',
        cdOrigem: order.distribution_center?.state_code || '',
        produtos: order.line_items?.map(item => ({
            id: item.id.toString(),
            product_id: item.product_id,
            nome: item.name,
            sku: item.sku,
            quantidade: item.quantity,
            preco: item.unit_price,
        })) || [],
        erpPayloadItems,
        // Valor pago pela cliente — teto do reembolso. Vem do Cosmos já normalizado, então não depende
        // do formato do erp_payload (que muda conforme o ERP do pedido).
        orderTotal: order.total_amount || undefined,
        distributionCenterStatus: order.distribution_center_status || '',
        createdAt: order.created_at || undefined,
    };
}
