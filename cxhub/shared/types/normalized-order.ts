// Normalized order types for the Adapter Pattern
// These types abstract away the differences between Cosmos and Shopify APIs

export interface NormalizedProduct {
    id: string;
    product_id: number;            // ID do produto no Cosmos (para API de reenvio)
    nome: string;
    sku: string;
    quantidade: number;
    preco: string;
    desconto?: string;             // Desconto total do item (soma de discount_allocations para Shopify, ou distribuído proporcionalmente para componentes de kit)
    isKit?: boolean;
    isGift?: boolean;
    kitComponents?: NormalizedProduct[];
}

export interface NormalizedAddress {
    logradouro: string;
    numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    estado: string;
    cep: string;
}

/**
 * ERP payload item for price calculation
 * Contains unit_price and discount_value from Cosmos erp_payload.items
 */
export interface ErpPayloadItem {
    sku: string;
    quantity: number;
    unit_price: number;
    discount_value: number;
}

export interface NormalizedOrder {
    source: 'cosmos' | 'shopify';
    // IDs
    cosmos_id: number | null;  // ID interno do Cosmos (null se veio direto da Shopify)
    shopify_id: string;         // Número do pedido só com dígitos (ex: "220183")
    order_name: string;         // Nome do pedido para exibição (ex: "#SHOPIFY220183" ou "SH220183BB")
    // Dados do pedido
    numeroPedido: string;
    numeroNF: string;
    invoiceAccessKey: string;   // Chave de acesso da NF (invoice_access_key do Cosmos)
    nomeCliente: string;
    telefoneCliente: string;
    enderecoCliente: string;    // Endereço formatado para exibição
    endereco: NormalizedAddress; // Campos separados para edição
    transportadora: string;
    carrierId?: number;             // ID da transportadora no Cosmos (para API de reenvio)
    carrierServiceName?: string;    // Nome do serviço da transportadora (service_name do Cosmos)
    shippingCost?: string;          // Custo de frete do pedido original
    discountAmount?: string;        // Valor de desconto do pedido original
    cdOrigem: string;               // Centro de distribuição de origem
    produtos: NormalizedProduct[];
    // Status financeiro do pedido (ex: "paid", "pending", "refunded") — only from Shopify
    financialStatus?: string;
    // ERP payload items for price calculation (only from Cosmos)
    erpPayloadItems?: ErpPayloadItem[];
    // Total do pedido (only from Shopify — current_total_price)
    orderTotal?: string;
    // Status do centro de distribuição (only from Cosmos — distribution_center_status)
    distributionCenterStatus?: string;
    // Data de criação do pedido (ISO 8601 — from created_at in Cosmos/Shopify)
    createdAt?: string;
}

