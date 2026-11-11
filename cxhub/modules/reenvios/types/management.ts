import type { CosmosDetailedOrder, CosmosOrder } from '../../../shared/types/index';

/**
 * Códigos das rotas de gestão de reenvio (`/api/cosmos/resends/**`). Legíveis por máquina: quem consome é
 * bot, n8n ou uma tela futura, e decidir pelo texto da mensagem é frágil.
 */
export type ResendManagementCode =
    | 'SUCCESS'
    | 'INVALID_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'NOT_A_RESEND'
    | 'RESEND_CANCELLED'
    | 'RESEND_LOCKED'
    | 'CARRIER_NOT_FOUND'
    | 'COSMOS_REJECTED'
    | 'API_TIMEOUT'
    | 'UNKNOWN_ERROR';

export interface ResendManagementResponse {
    code: ResendManagementCode;
    message: string;
    /** Pedido como o Cosmos devolveu depois do cancelamento/edição. */
    order?: CosmosDetailedOrder;
    /** Só na listagem (`GET /api/cosmos/resends`). */
    resends?: CosmosOrder[];
}

export interface ResendCancelRequest {
    /** Agente que pediu. O Cosmos registra o usuário de serviço do CX Hub; o agente só fica no motivo. */
    handledBy: string;
    reason: string;
}

export interface ResendAddressChanges {
    name?: string;
    phone?: string;
    street?: string;
    number?: string;
    complement?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
    postalCode?: string;
}

export interface ResendCustomerChanges {
    name?: string;
    email?: string;
    phone?: string;
    document?: string;
}

export interface ResendUpdateRequest {
    handledBy: string;
    shippingAddress?: ResendAddressChanges;
    carrierId?: number;
    customer?: ResendCustomerChanges;
}

/** Endereço de cobrança no formato do `PUT` do Cosmos (`Order::BillingAddress`). */
export interface CosmosBillingAddressInput {
    name: string | null;
    phone: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
}

/** Endereço de entrega no formato do `PUT` do Cosmos (`Order::ShippingAddress`): inclui serviço e frete. */
export interface CosmosShippingAddressInput extends CosmosBillingAddressInput {
    service_name: string | null;
    cost: string | null;
}

export interface CosmosCustomerInput {
    name: string | null;
    email: string | null;
    phone: string | null;
    document: string | null;
    type: string | null;
}

/** Corpo do `PUT /organizations/{org}/orders/{id}` do Cosmos. */
export interface CosmosOrderUpdateBody {
    order: {
        shipping_address?: CosmosShippingAddressInput;
        billing_address?: CosmosBillingAddressInput;
        carrier_id?: number;
        customer?: CosmosCustomerInput;
    };
}
