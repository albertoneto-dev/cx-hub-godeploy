import type { ResendSubmissionData, WebhookResponseCode } from '../types/index';

/**
 * As duas metades puras da chamada `POST /organizations/{org}/orders/{id}/resend` que o node
 * "Resend Kokeshi Cosmos order" fazia (o nome é histórico — o node servia às seis marcas).
 */

export interface CosmosResendBody {
    order: {
        reason: string;
        carrier_id: number;
        products: Array<{ id: number; quantity: number; unit_price: string }>;
        shipping_address: {
            name: string;
            phone: string;
            street: string;
            number: string;
            complement: string;
            neighborhood: string;
            city: string;
            state: string;
            postal_code: string;
            service_name: string;
        };
        shipping_cost: string;
        discount_amount: string;
    };
}

/** Corpo do reenvio no Cosmos, campo a campo como o `jsonBody` do node. `null` sem `apiData`. */
export function buildCosmosResendBody(data: ResendSubmissionData): CosmosResendBody | null {
    const api = data.apiData;
    if (!api) return null;

    return {
        order: {
            reason: data.problemaProduto,
            carrier_id: api.carrierId,
            products: api.resendProducts.map((item) => ({
                id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
            })),
            shipping_address: {
                name: data.nomeCliente,
                phone: (data.telefoneCliente ?? '').replace(/[^0-9+]/g, ''),
                street: api.shippingAddress.street,
                number: api.shippingAddress.number,
                complement: api.shippingAddress.complement,
                neighborhood: api.shippingAddress.neighborhood,
                city: api.shippingAddress.city,
                state: api.shippingAddress.state,
                postal_code: api.shippingAddress.postal_code,
                service_name: api.carrierServiceName,
            },
            shipping_cost: api.shippingCost,
            discount_amount: api.discountAmount,
        },
    };
}

export interface FalhaCosmos {
    code: Extract<WebhookResponseCode, 'API_ERROR' | 'OUT_OF_STOCK'>;
    message: string;
}

/**
 * Tradução da recusa do Cosmos para o código que a tela e o bot já conhecem — a regra do code node
 * "Code in JavaScript1". No n8n o corpo chegava embrulhado na mensagem de erro (`422 - "{...}"`) e precisava
 * ser desescapado; aqui ele chega cru.
 */
export function interpretarErroCosmos(status: number, corpo: unknown): FalhaCosmos {
    const bruto = (corpo as { error?: unknown } | null)?.error;
    const erro = typeof bruto === 'string' ? bruto : (bruto ? JSON.stringify(bruto) : null);

    if (status === 422 && erro && /sem saldo/i.test(erro)) {
        const sku = erro.match(/SKU sem saldo:\s*(.+)/i)?.[1]?.trim() || 'produto selecionado';
        return {
            code: 'OUT_OF_STOCK',
            message: `Não foi possível reenviar: o SKU ${sku} está sem saldo no Cosmos. Verifique o estoque ou solicite reenvio manual.`,
        };
    }
    if (erro) {
        return { code: 'API_ERROR', message: `O Cosmos recusou o reenvio: ${erro}` };
    }
    return { code: 'API_ERROR', message: 'Ocorreu um erro ao se conectar ao servidor do Cosmos.' };
}
