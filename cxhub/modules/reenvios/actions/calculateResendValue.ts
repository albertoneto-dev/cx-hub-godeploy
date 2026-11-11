import { ErpPayloadItem } from '../../../shared/types/index';
import { resolveSelectedProducts } from '../../../shared/lib/productSelectionLogic';

// Re-export for backward compatibility
export { resolveSelectedProducts };
export const getSkusToResend = resolveSelectedProducts;

/**
 * Input for calculating resend value
 */
export interface CalculateResendValueInput {
    /** Products from the original order selected for resend (with SKU info) */
    selectedProducts: Array<{
        id: string; // Adicionado ID do produto ou componente selecionado
        sku: string;
        isGift: boolean;
        /** For kits, includes component SKUs and their specific IDs */
        kitComponentSkus?: Array<{ sku: string; id: string }>;
    }>;
    /** User-selected quantities mapped by product/component ID */
    quantidadesReenviar: Record<string, number>;
    /** Extra items added to the resend */
    extraGiftsCount: number;
    /** ERP payload items from the original order (for price lookup) */
    erpPayloadItems: ErpPayloadItem[];
    /** Shipping cost from the original order (e.g. "12.50") */
    shippingCost: string;
    /** Original order products — used as price fallback when erpPayloadItems is empty (Shopify orders) */
    produtos?: Array<{ id: string; sku: string; preco: string; quantidade: number; desconto?: string }>;
}

/**
 * Calculates the total resend value based on the selected products.
 *
 * Rules:
 * - For all products (including gifts): sum of (unit_price * quantity - discount_value) from erp_payload
 * - Shopify fallback: uses produto.preco when ERP data is unavailable
 * - Extra gifts: R$ 0.02 each (extra items added manually, no ERP/Shopify price reference)
 *
 * @param input - Products and ERP data for calculation
 * @returns Total resend value as a formatted string (e.g., "R$ 112,84")
 */
export function calculateResendValue(input: CalculateResendValueInput): string {
    const { selectedProducts, quantidadesReenviar, extraGiftsCount, erpPayloadItems, shippingCost, produtos } = input;

    // Build a SKU -> ERP Item map for quick lookup
    const erpItemsBySku = new Map<string, ErpPayloadItem>();
    for (const item of erpPayloadItems) {
        erpItemsBySku.set(item.sku, item);
    }

    // Fallback price map from produtos (used for Shopify orders without ERP data)
    const produtoPriceBySku = new Map<string, { preco: number; quantidade: number; desconto: number }>();
    if (produtos) {
        for (const p of produtos) {
            produtoPriceBySku.set(p.sku, { preco: parseFloat(p.preco) || 0, quantidade: p.quantidade, desconto: parseFloat(p.desconto || '0') || 0 });
        }
    }

    let totalValue = 0;

    // Calculate value for each selected product
    for (const product of selectedProducts) {
        if (product.kitComponentSkus && product.kitComponentSkus.length > 0) {
            // For kits: check if components have ERP data (Cosmos) or use kit price (Shopify)
            const hasErpData = product.kitComponentSkus.some(kc => erpItemsBySku.has(kc.sku));

            if (hasErpData) {
                // Cosmos path: sum component prices from ERP
                for (const kitComp of product.kitComponentSkus) {
                    const erpItem = erpItemsBySku.get(kitComp.sku);
                    if (erpItem) {
                        const totalCompQty = quantidadesReenviar[kitComp.id] || 1;
                        const unitDiscount = erpItem.quantity > 0 ? erpItem.discount_value / erpItem.quantity : 0;
                        const totalCompDiscount = unitDiscount * totalCompQty;
                        totalValue += (erpItem.unit_price * totalCompQty) - totalCompDiscount;
                    }
                }
            } else {
                // Shopify path: use kit's own price and discount
                const kitInfo = produtoPriceBySku.get(product.sku);
                if (kitInfo) {
                    const kitQty = quantidadesReenviar[product.id] || kitInfo.quantidade;
                    const unitDiscount = kitInfo.quantidade > 0 ? kitInfo.desconto / kitInfo.quantidade : 0;
                    totalValue += (kitInfo.preco * kitQty) - (unitDiscount * kitQty);
                }
            }
        } else {
            // Regular product / Component selected individually - look up in ERP payload
            const erpItem = erpItemsBySku.get(product.sku);
            if (erpItem) {
                const qtySelected = quantidadesReenviar[product.id] || erpItem.quantity;
                const unitDiscount = erpItem.quantity > 0 ? erpItem.discount_value / erpItem.quantity : 0;
                const totalDiscount = unitDiscount * qtySelected;
                totalValue += (erpItem.unit_price * qtySelected) - totalDiscount;
            } else {
                // Fallback: use preco from produtos (Shopify orders)
                const produtoInfo = produtoPriceBySku.get(product.sku);
                if (produtoInfo) {
                    const qtySelected = quantidadesReenviar[product.id] || produtoInfo.quantidade;
                    const unitDiscount = produtoInfo.quantidade > 0 ? produtoInfo.desconto / produtoInfo.quantidade : 0;
                    totalValue += (produtoInfo.preco * qtySelected) - (unitDiscount * qtySelected);
                }
            }
        }
    }

    // Add extra gifts (R$ 0.02 each)
    totalValue += extraGiftsCount * 0.02;

    // Add shipping cost (same as N8N-F formula)
    totalValue += parseFloat(shippingCost) || 0;

    // Format as Brazilian currency (without R$ prefix, matching N8N-F)
    return totalValue.toFixed(2).replace('.', ',');
}

