import { CosmosOrder, CosmosDetailedOrder, CosmosProduct } from '../../types/index';
import { NormalizedOrder, NormalizedProduct } from '../../types/index';
import { handleUnauthorized } from '../auth/auth-utils';

/**
 * Sanitiza o ID do pedido, removendo caracteres não numéricos
 * Exemplos: "#12345" -> "12345", "12-345" -> "12345", "SH12345BB" -> "12345"
 */
export function sanitizeOrderId(orderId: string): string {
    return orderId.replace(/\D/g, '');
}

/**
 * Busca pedidos no Cosmos pela external_id (listagem) via API Route
 * Chama: /api/cosmos/orders?brand={brandId}&orderId={orderId}
 */
export async function getCosmosOrder(brandId: string, orderId: string, token: string): Promise<CosmosOrder | null> {
    // Sanitiza o ID do pedido removendo caracteres não numéricos
    const sanitizedOrderId = sanitizeOrderId(orderId);

    try {
        const url = `/api/cosmos/orders?brand=${encodeURIComponent(brandId)}&orderId=${encodeURIComponent(sanitizedOrderId)}`;
        console.log('[getCosmosOrder] Fetching via API route:', url);

        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            cache: 'no-store',
        });

        console.log('[getCosmosOrder] Response status:', res.status);

        // Handle 401 - logout if token expired
        if (handleUnauthorized(res.status)) {
            return null;
        }

        // Handle 404 gracefully - return null to allow Shopify fallback
        if (res.status === 404) {
            console.warn(`Cosmos API returned 404 for order ${orderId}, trying Shopify fallback...`);
            return null;
        }

        if (res.ok) {
            const data: CosmosOrder[] = await res.json();
            console.log('[getCosmosOrder] Data received:', data?.length, 'orders');

            if (!data || data.length === 0) {
                console.log('[getCosmosOrder] No orders found');
                return null;
            }

            // Filter: external_id validation using regex (based on n8n logic)
            // Rule 1: Regex match - ^SH{orderId}[a-zA-Z]{2}\d*$ (e.g., SH12345BB, SH12345BB1)
            // Rule 2: Exact match - #SHOPIFY{orderId}
            const sanitizedId = sanitizeOrderId(orderId);
            const regexPattern = new RegExp(`^SH${sanitizedId}[a-zA-Z]{2}\\d*$`);
            const exactMatch = `#SHOPIFY${sanitizedId}`;

            console.log('[getCosmosOrder] Looking for external_id matching:', {
                regexPattern: regexPattern.toString(),
                exactMatch,
            });

            const filteredOrder = data.find(order => {
                const matchesRegex = regexPattern.test(order.external_id);
                const matchesExact = order.external_id === exactMatch;
                return matchesRegex || matchesExact;
            });

            if (filteredOrder) {
                console.log('[getCosmosOrder] Found order with id:', filteredOrder.id, 'external_id:', filteredOrder.external_id);
            } else {
                console.log('[getCosmosOrder] Order not found, available external_ids:', data.map(o => o.external_id));
            }

            return filteredOrder || null;
        }

        const errorData = await res.json().catch(() => ({}));
        console.error(`[getCosmosOrder] API error: ${res.status}`, errorData);
        return null;
    } catch (error) {
        console.error('[getCosmosOrder] Failed to fetch:', error);
        return null;
    }
}

/**
 * Busca os detalhes completos de um pedido no Cosmos pelo ID interno via API Route
 * Chama: /api/cosmos/orders/{id}?brand={brandId}
 */
export async function getCosmosOrderData(brandId: string, cosmosOrderId: number, token: string): Promise<CosmosDetailedOrder | null> {
    try {
        const url = `/api/cosmos/orders/${cosmosOrderId}?brand=${encodeURIComponent(brandId)}`;
        console.log('[getCosmosOrderData] Fetching via API route:', url);

        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            cache: 'no-store',
        });

        console.log('[getCosmosOrderData] Response status:', res.status);

        // Handle 401 - logout if token expired
        if (handleUnauthorized(res.status)) {
            return null;
        }

        if (res.status === 404) {
            console.warn(`Cosmos API returned 404 for order ID ${cosmosOrderId}`);
            return null;
        }

        if (res.ok) {
            const data: CosmosDetailedOrder = await res.json();
            console.log('[getCosmosOrderData] Data received:', data?.id);

            if (!data) {
                console.log('[getCosmosOrderData] No order found');
                return null;
            }

            console.log('[getCosmosOrderData] Returning order:', data.id);
            return data;
        }

        const errorData = await res.json().catch(() => ({}));
        console.error(`[getCosmosOrderData] API error: ${res.status}`, errorData);
        return null;
    } catch (error) {
        console.error('[getCosmosOrderData] Failed to fetch:', error);
        return null;
    }
}

/**
 * Busca todos os produtos ativos de uma marca no Cosmos via API Route
 * Chama: /api/cosmos/products?brand={brandId}
 */
export async function getCosmosProducts(brandId: string, token: string): Promise<CosmosProduct[]> {
    try {
        const url = `/api/cosmos/products?brand=${encodeURIComponent(brandId)}`;
        console.log('[getCosmosProducts] Fetching via API route:', url);

        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            cache: 'no-store',
        });

        console.log('[getCosmosProducts] Response status:', res.status);

        // Handle 401 - logout if token expired
        if (handleUnauthorized(res.status)) {
            return [];
        }

        if (res.ok) {
            const data = await res.json();
            console.log('[getCosmosProducts] Products received:', data?.length);

            // Filtra apenas produtos ativos e adiciona campo isGift computado
            // SKUs hardcoded de brindes da marca Kokeshi
            const KOKESHI_GIFT_SKUS = ['KS99043', 'KS03012'];
            const activeProducts: CosmosProduct[] = data
                .filter((p: { active: boolean }) => p.active)
                .map((p: { name: string; is_kit: boolean; id: number; price: string; sku: string; gtin: string; ncm: string; active: boolean; created_at: string; updated_at: string }) => ({
                    ...p,
                    isGift: p.name.toLowerCase().includes('brinde') || KOKESHI_GIFT_SKUS.includes(p.sku.toUpperCase()),
                }));
            console.log(`[getCosmosProducts] Total fetched: ${data.length}, Active active: ${activeProducts.length}`);

            return activeProducts;
        }

        const errorData = await res.json().catch(() => ({}));
        console.error(`[getCosmosProducts] API error: ${res.status}`, errorData);
        return [];
    } catch (error) {
        console.error('[getCosmosProducts] Failed to fetch:', error);
        return [];
    }
}

interface CosmosCarrierSearchResponse {
    id: number;
    name: string;
    shopify_name: string;
}

/**
 * Busca a transportadora no Cosmos pelo nome da Shopify
 * Retorna o nome da transportadora no Cosmos se encontrada, ou null
 */
export async function getCosmosCarrier(brandId: string, shopifyName: string, token: string): Promise<string | null> {
    try {
        if (!shopifyName) return null;

        const encodedBrand = encodeURIComponent(brandId);
        const encodedShopifyName = encodeURIComponent(shopifyName);

        const res = await fetch(`/api/cosmos/carriers?brand=${encodedBrand}&shopify_name=${encodedShopifyName}`, {
            method: 'GET',
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
            },
        });

        if (res.ok) {
            const data: CosmosCarrierSearchResponse[] = await res.json();

            // A API retorna um array, pegamos o primeiro match se existir
            if (data && data.length > 0) {
                console.log(`[getCosmosCarrier] Mapped '${shopifyName}' to '${data[0].name}'`);
                return data[0].name;
            }
        }

        console.log(`[getCosmosCarrier] No mapping found for '${shopifyName}'`);
        return null;
    } catch (error) {
        console.error('[getCosmosCarrier] Error:', error);
        return null;
    }
}

/**
 * Busca detalhes de um produto específico (necessário para ver componentes de kit)
 */
export async function getProductDetails(brandId: string, productId: string | number, token: string): Promise<unknown | null> {
    try {
        const url = `/api/cosmos/products/${productId}?brand=${encodeURIComponent(brandId)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            cache: 'no-store',
        });

        if (res.ok) {
            return await res.json();
        }
        return null;
    } catch (error) {
        console.error('[getProductDetails] Failed:', error);
        return null;
    }
}

/**
 * Busca produto por SKU usando filtro da API
 */
export async function getCosmosProductBySku(brandId: string, sku: string, token: string): Promise<CosmosProduct[]> {
    try {
        const url = `/api/cosmos/products?brand=${encodeURIComponent(brandId)}&sku=${encodeURIComponent(sku)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            cache: 'no-store',
        });

        if (res.ok) {
            return await res.json();
        }
        return [];
    } catch (error) {
        console.error('[getCosmosProductBySku] Failed:', error);
        return [];
    }
}

/**
 * Acessos ao catálogo de que o enriquecimento depende. Existe para o caminho SERVER-SIDE poder
 * injetar as versões que falam direto com o Cosmos: as funções deste módulo montam URL RELATIVA
 * (`/api/cosmos/...`) e só funcionam no navegador. Default = as do módulo, então os callers de
 * página não mudam.
 */
export interface EnrichDeps {
    getProducts: (brandId: string, token: string) => Promise<CosmosProduct[]>;
    getProductDetails: (brandId: string, productId: string | number, token: string) => Promise<unknown | null>;
    getProductBySku: (brandId: string, sku: string, token: string) => Promise<CosmosProduct[]>;
}

const DEFAULT_ENRICH_DEPS: EnrichDeps = {
    getProducts: getCosmosProducts,
    getProductDetails,
    getProductBySku: getCosmosProductBySku,
};

/**
 * Enriquece o pedido com informações de Kits (componentes) e Brindes
 * Os preços dos componentes do kit são extraídos do erp_payload.items (preços reais da venda)
 */
export async function enrichOrderWithProductDetails(
    order: NormalizedOrder,
    brandId: string,
    token: string,
    existingProducts?: CosmosProduct[], // Opcional: passar se já tiver buscado
    deps: EnrichDeps = DEFAULT_ENRICH_DEPS
): Promise<NormalizedOrder> {

    // 1. Busca todos os produtos da marca para ter o "de-para" de SKU -> Detalhes
    // Isso é necessário porque o detalhe do kit retorna apenas uma lista de SKUs (strings)
    const allProducts = existingProducts || await deps.getProducts(brandId, token);

    // Mapa para busca rápida por SKU
    const productsMap = new Map<string, CosmosProduct>();
    allProducts.forEach(p => productsMap.set(p.sku, p));

    // Mapa de SKU -> unit_price do ERP (preços reais da venda)
    const erpPriceMap = new Map<string, number>();
    if (order.erpPayloadItems) {
        order.erpPayloadItems.forEach(item => {
            erpPriceMap.set(item.sku, item.unit_price);
        });
    }

    // 2. Processa cada item do pedido
    const enrichedProducts: NormalizedProduct[] = [];


    for (const item of order.produtos) {
        // Tenta encontrar o produto no mapa geral
        // Nota: O ID do item no pedido pode não bater direto com o ID do produto no catálogo se for Shopify vs Cosmos
        // Mas geralmente tentamos casar pelo SKU se disponível
        let productInfo = productsMap.get(item.sku);

        // Se não encontrou (ex: pedido Shopify com produto que não veio na lista inicial), tenta buscar especificamente por SKU
        if (!productInfo && item.sku) {
            // Só faz isso se tiver SKU válido
            const skuResults = await deps.getProductBySku(brandId, item.sku, token);
            if (skuResults && skuResults.length > 0) {
                productInfo = skuResults[0];
            }
        }

        let isKit = false;
        // SKUs hardcoded de brindes da marca Kokeshi
        const KOKESHI_GIFT_SKUS = ['KS99043', 'KS03012'];
        const isGiftByName = !!(item.nome && item.nome.toLowerCase().includes('brinde'));
        const isGiftBySku = !!(item.sku && KOKESHI_GIFT_SKUS.includes(item.sku.toUpperCase()));
        let isGift = isGiftByName || isGiftBySku;
        let kitComponents: NormalizedProduct[] = [];

        // Se encontramos o produto no catálogo, usamos as infos oficias
        if (productInfo) {
            isKit = productInfo.is_kit;
            const productIsGiftByName = productInfo.name.toLowerCase().includes('brinde');
            const productIsGiftBySku = KOKESHI_GIFT_SKUS.includes(productInfo.sku.toUpperCase());
            if (productIsGiftByName || productIsGiftBySku) {
                isGift = true;
            }
        }

        // Se for Kit, precisamos buscar os componentes
        if (isKit && productInfo) {
            console.log(`[enrichOrder] Found Kit: ${item.sku}. Fetching components...`);
            const rawDetails = await deps.getProductDetails(brandId, productInfo.id, token);
            const details = rawDetails as { kit_skus?: string[] } | null;

            if (details && details.kit_skus && Array.isArray(details.kit_skus)) {
                // Agrega SKUs duplicados: conta ocorrências de cada SKU no array
                // Ex: ["KS03015", "KS03015"] -> Map { "KS03015" => 2 }
                const skuCountMap = new Map<string, number>();
                for (const sku of details.kit_skus as string[]) {
                    skuCountMap.set(sku, (skuCountMap.get(sku) || 0) + 1);
                }

                // Mapeia os SKUs únicos para objetos de produto, usando a contagem como quantidade
                // IMPORTANTE: Os preços são extraídos do erp_payload.items, não do catálogo
                // Primeiro passo: calcular os preços dos componentes para poder distribuir o desconto
                const componentEntries = Array.from(skuCountMap.entries()).map(([componentSku, count]) => {
                    const compInfo = productsMap.get(componentSku);
                    const erpPrice = erpPriceMap.get(componentSku);
                    const catalogPrice = compInfo ? parseFloat(compInfo.price) || 0 : 0;
                    const componentPrice = erpPrice ?? catalogPrice;
                    return { componentSku, count, compInfo, componentPrice };
                });

                // Soma dos preços dos componentes (para distribuição proporcional do desconto)
                const totalComponentPrice = componentEntries.reduce((sum, e) => sum + (e.componentPrice * e.count), 0);

                // Desconto do item pai (vindo do Shopify discount_allocations)
                const parentDiscount = parseFloat(item.desconto || '0') || 0;

                kitComponents = componentEntries.map(({ componentSku, count, compInfo, componentPrice }) => {
                    // Distribui desconto do kit proporcionalmente ao preço de cada componente
                    const componentDiscount = totalComponentPrice > 0
                        ? parentDiscount * (componentPrice * count) / totalComponentPrice
                        : 0;

                    if (compInfo) {
                        const compIsGiftByName = compInfo.name.toLowerCase().includes('brinde');
                        const compIsGiftBySku = KOKESHI_GIFT_SKUS.includes(compInfo.sku.toUpperCase());
                        return {
                            id: `${item.id}_comp_${compInfo.id}`,
                            product_id: compInfo.id,
                            nome: compInfo.name,
                            sku: compInfo.sku,
                            quantidade: count,
                            preco: String(componentPrice),
                            desconto: String(componentDiscount),
                            isGift: compIsGiftByName || compIsGiftBySku
                        } as NormalizedProduct;
                    }
                    const fallbackIsGift = KOKESHI_GIFT_SKUS.includes(componentSku.toUpperCase());
                    return {
                        id: `${item.id}_comp_0_${componentSku}`,
                        product_id: 0,
                        nome: `Item do Kit (${componentSku})`,
                        sku: componentSku,
                        quantidade: count,
                        preco: String(componentPrice),
                        desconto: String(componentDiscount),
                        isGift: fallbackIsGift
                    } as NormalizedProduct;
                });
            }
        }

        enrichedProducts.push({
            ...item,
            isKit,
            isGift,
            kitComponents: kitComponents.length > 0 ? kitComponents : undefined
        });
    }

    return {
        ...order,
        produtos: enrichedProducts
    };
}
