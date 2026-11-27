import { ShopifyOrder } from '../../types/index';
import { lerNumeroDaLoja, nomeDoGc } from '../pedido/numeroDaLoja';

/**
 * Busca pedido na Shopify via API Route (evita CORS)
 * Chama: /api/shopify/orders?brand={brandId}&orderId={orderId}
 */
export async function getShopifyOrderData(brandId: string, orderId: string): Promise<ShopifyOrder | null> {
    // Sanitiza o ID do pedido removendo caracteres não numéricos; o pedido da Gocreators vai inteiro (GC104306BB), porque
    // os dígitos dele são os de outro pedido (decisão deste app em 2026-11-27). GC fora do formato: nada a buscar.
    const numero = lerNumeroDaLoja(orderId, brandId);
    if (!numero) return null;
    const sanitizedOrderId = numero.prefixo === 'GC' ? nomeDoGc(numero) : numero.digitos;

    try {
        const url = `/api/shopify/orders?brand=${encodeURIComponent(brandId)}&orderId=${encodeURIComponent(sanitizedOrderId)}`;
        console.log('[getShopifyOrderData] Fetching via API route:', url);

        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
            cache: 'no-store',
        });

        console.log('[getShopifyOrderData] Response status:', res.status);

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            console.error(`[getShopifyOrderData] API error: ${res.status}`, errorData);
            return null;
        }

        const data = await res.json();
        const orders: ShopifyOrder[] = data.orders || [];

        console.log('[getShopifyOrderData] Orders found:', orders.length);

        if (orders.length === 0) {
            return null;
        }

        // Return the first matching order
        return orders[0];
    } catch (error) {
        console.error('[getShopifyOrderData] Failed to fetch:', error);
        return null;
    }
}
