/**
 * Input for the shouldSendToAPI function
 */
export interface ShouldSendToAPIInput {
    /** The type of request, e.g., "reenvio", "cashback" */
    tipoSolicitacao: string;
    /** Whether the order originated from Shopify */
    isShopify: boolean;
    /** Products from the original order selected for resend */
    orderProducts: Array<{
        is_gift: boolean;
    }>;
    /** Additional/extra items added to the resend */
    extraProducts: Array<{
        is_gift: boolean;
    }>;
}

/**
 * Result from the shouldSendToAPI function
 */
export interface ShouldSendToAPIResult {
    /** Whether the order should be sent to the API */
    shouldSendToAPI: boolean;
    /** Justification message when shouldSendToAPI is false */
    motivo?: string;
}

/**
 * Determines if a resend order should be sent to the API and provides
 * a justification if it should not.
 * 
 * Business Rules:
 * 1. Request type must be "Reenvio" (case-insensitive)
 * 2. Order must NOT originate from Shopify
 * 3. There must be at least one non-gift product from the original order
 * 4. If there are extra products, they must ALL be gifts
 * 
 * @param input - The order and product data to evaluate
 * @returns Object with shouldSendToAPI boolean and optional motivo string
 */
export function shouldSendToAPI(input: ShouldSendToAPIInput): ShouldSendToAPIResult {
    const { tipoSolicitacao, isShopify, orderProducts, extraProducts } = input;

    // Check if request type is "reenvio"
    const isReenvio = tipoSolicitacao.toLowerCase() === 'reenvio';

    // Check extras conditions
    const hasExtras = extraProducts.length > 0;
    const allExtrasAreGifts = extraProducts.every(item => item.is_gift === true);
    const hasOrderNonGiftProduct = orderProducts.some(item => item.is_gift === false);

    // Main condition: must be reenvio, have at least one non-gift product from order,
    // and either no extras or all extras are gifts, and not from Shopify
    const extraConditionMet = hasOrderNonGiftProduct && (!hasExtras || allExtrasAreGifts);
    const canSendToAPI = isReenvio && extraConditionMet && !isShopify;

    // Determine justification if not sending to API
    let motivo: string | undefined = undefined;

    if (!canSendToAPI) {
        if (isShopify) {
            motivo = 'Pedidos originados da Shopify são processados manualmente';
        } else if (!isReenvio) {
            motivo = 'Tipo de solicitação não é "Reenvio"';
        } else if (hasExtras && !allExtrasAreGifts) {
            const extrasNonGiftCount = extraProducts.filter(item => item.is_gift === false).length;
            motivo = `Existem ${extrasNonGiftCount} produto(s) extra(s) que não são brindes`;
        } else if (hasExtras && orderProducts.length === 0) {
            motivo = 'Não é possível enviar apenas produtos extras - é necessário ao menos um produto do pedido original';
        } else if (!hasOrderNonGiftProduct) {
            motivo = 'Todos os produtos de reenvio são brindes - é necessário ao menos um produto que não seja brinde';
        }
    }

    return {
        shouldSendToAPI: canSendToAPI,
        motivo,
    };
}
