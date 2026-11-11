// Cosmos/Order-related types

// ============================================
// Tipos compartilhados entre Order e DetailedOrder
// ============================================

export interface CosmosCustomer {
    name: string;
    email: string;
    phone?: string;
    document: string;
    document_type?: string;
    type?: string;
}

export interface CosmosAddress {
    street: string;
    number: string;
    complement: string;
    neighborhood: string;
    city: string;
    state: string;
    postal_code: string;
}

export interface CosmosShippingSimple {
    state?: string;
    postal_code?: string;
}

export interface CosmosShippingDetailed {
    name: string;
    phone: string;
    address: CosmosAddress;
    service_name: string;
    cost: string;
}

export interface CosmosBilling {
    name: string;
    phone: string;
    address: CosmosAddress;
}

export interface CosmosLineItem {
    id: number;
    product_id: number;
    sku: string;
    name: string;
    quantity: number;
    unit_price: string;
    created_at: string;
    updated_at: string;
}

export interface CosmosDistributionCenter {
    id: number;
    name: string;
    code: string;
    postal_code: string;
    state_code: string;
    active: boolean;
    distribution_center_type: string;
}

export interface CosmosErp {
    id: number;
    name: string;
    erp_type: string;
    active: boolean;
    created_at: string;
    updated_at: string;
    products_synchronization_enabled: boolean;
    distribution_center_id: number;
    state_code: string;
    distribution_center: CosmosDistributionCenter;
}

export interface CosmosCarrier {
    id: number;
    name: string;
    document: string;
    shopify_name: string;
    intelipost_id: string;
    express: boolean;
    active: boolean;
    send_track_code_to_intelipost: boolean;
    created_at: string;
    updated_at: string;
    document_for_dc?: string;
}

export interface CosmosRoutingRule {
    id: number;
    erp_id: number;
    distribution_center_id: number;
    start_postal_code: string | null;
    end_postal_code: string | null;
    priority: number;
    active: boolean;
    description: string;
    distribution_center_name: string;
    erp_name: string;
}

export interface CosmosShopify {
    id: number;
    shopify_id: string;
    order_number: string;
    fulfillment_id: string;
    fulfillment_status: string;
    tracking_number: string;
    tracking_url: string;
    shipping_carrier: string;
    fulfillment_created_at: string;
    fulfillment_updated_at: string;
    processed_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface CosmosErpPayloadItem {
    sku: string;
    quantity: number;
    unit_price: number;
    total_price: number;
    discount_value: number;
    operation: string;
    warehouse: string;
}

export interface CosmosErpPayloadInstallment {
    nsu: string;
    installment: number;
    value: number;
    due_date: string;
    authorization: string;
}

export interface CosmosErpPayloadCustomer {
    name: string;
    trade_name: string;
    type: string;
    zip_code: string;
    city: string;
    state: string;
    city_code: string;
    country: string;
    country_code: string;
    address: string;
    district: string;
    tax_id: string;
    state_registration: string;
    email: string;
    area_code: string;
    phone: string;
    simple_national: boolean;
    icms_taxpayer: boolean;
}

/** Item do `erp_payload` quando o ERP do pedido é o "Shopify" do Cosmos (formato da Admin API do Shopify). */
export interface CosmosErpPayloadLineItem {
    sku: string;
    quantity: number;
    priceSet: { shopMoney: { amount: number; currencyCode: string } };
}

/**
 * O formato do `erp_payload` depende do ERP do pedido: Protheus manda `items` (com desconto por item);
 * o ERP "Shopify" (desde 07/10/2026 para parte das marcas) manda `lineItems`, sem desconto por item.
 */
export interface CosmosErpPayload {
    ecommerce_number: string;
    seller_code: string;
    payment_condition: string;
    freight: number;
    transporter_tax_id: string;
    nature: string;
    payment_method: string;
    buyer_tax_id: string;
    items?: CosmosErpPayloadItem[];
    lineItems?: CosmosErpPayloadLineItem[];
    installments: CosmosErpPayloadInstallment[];
    customer: CosmosErpPayloadCustomer;
    delivery: CosmosErpPayloadCustomer;
    volumes: number;
    volumes_type: string;
    liquid_weight: number;
    gross_weight: number;
}

// ============================================
// CosmosOrder - Retorno da listagem de pedidos
// Endpoint: /organizations/{org_id}/orders?external_id={id}
// ============================================

export interface CosmosOrder {
    id: number;
    external_id: string;
    status: string;
    origin: string;
    total_amount: string;
    shipping_cost: string;
    paid_at: string;
    payment_gateway: string | null;
    payment_method: string | null;
    installments: number | null;
    installment_value: string | null;
    nsu: string | null;
    tms_unique_id: string | null;
    external_erp_id: string | null;
    invoice_order_number: string | null;
    invoice_number: string | null;
    invoice_series: string | null;
    invoice_access_key: string | null;
    distribution_center_status: string;
    distribution_center_message: string | null;
    logistic_status: string;
    erp_status: string;
    ecommerce_status: string;
    created_at: string;
    updated_at: string;
    canceled_at: string | null;
    delivered_at: string | null;
    sent_at: string | null;
    customer: CosmosCustomer;
    shipping: CosmosShippingSimple;
    erp: CosmosErp;
    distribution_center: CosmosDistributionCenter;
    carrier: CosmosCarrier;
    origin_link: string | null;
}

// ============================================
// CosmosDetailedOrder - Retorno detalhado de um pedido
// Endpoint: /organizations/{org_id}/orders/{id}
// ============================================

export interface CosmosDetailedOrder {
    id: number;
    external_id: string;
    status: string;
    origin: string;
    total_amount: string;
    items_amount: string;
    discount_amount: string;
    discount_code: string | null;
    shipping_cost: string;
    paid_at: string;
    payment_gateway: string | null;
    payment_method: string | null;
    installments: number | null;
    installment_value: string | null;
    nsu: string | null;
    external_erp_id: string | null;
    invoice_order_number: string | null;
    invoice_number: string | null;
    invoice_series: string | null;
    invoice_access_key: string | null;
    invoice_error: string | null;
    distribution_center_status: string;
    distribution_center_message: string | null;
    logistic_status: string;
    erp_status: string;
    ecommerce_status: string;
    tracking_url: string | null;
    tracking_code: string | null;
    distribution_center_unique_id: string | null;
    tms_unique_id: string | null;
    sent_tms_at: string | null;
    sent_to_erp_at: string | null;
    sent_to_distribution_center_at: string | null;
    invoiced_returned_at: string | null;
    delivery_deadline_at: string | null;
    canceled_at: string | null;
    delivered_at: string | null;
    sent_at: string | null;
    created_at: string;
    updated_at: string;
    customer: CosmosCustomer;
    shipping: CosmosShippingDetailed;
    billing: CosmosBilling;
    line_items: CosmosLineItem[];
    origin_link: string | null;
    erp: CosmosErp;
    distribution_center: CosmosDistributionCenter;
    carrier: CosmosCarrier;
    routing_rule?: CosmosRoutingRule;
    shopify?: CosmosShopify;
    invoice_xml_attached: boolean;
    invoice_xml_url: string | null;
    label_zpl_attached: boolean;
    label_zpl_url: string | null;
    logistic_history: unknown[];
    erp_payload?: CosmosErpPayload;
}

// ============================================
// CosmosProduct - Retorno da listagem de produtos
// Endpoint: /organizations/{org_id}/products
// ============================================

export interface CosmosProduct {
    id: number;
    name: string;
    price: string;
    sku: string;
    gtin: string;
    ncm: string;
    active: boolean;
    is_kit: boolean;
    isGift: boolean; // Computed: true se nome contém "brinde" (case insensitive)
    created_at: string;
    updated_at: string;
}

export type CosmosProductsResponse = CosmosProduct[];

export type CosmosOrdersResponse = CosmosOrder[];
export type CosmosDetailedOrderResponse = CosmosDetailedOrder[];

