// Shopify Order types

export interface ShopifyMoneySet {
    shop_money: {
        amount: string;
        currency_code: string;
    };
    presentment_money: {
        amount: string;
        currency_code: string;
    };
}

export interface ShopifyNoteAttribute {
    name: string;
    value: string;
}

export interface ShopifyAddress {
    first_name: string;
    last_name: string;
    address1: string;
    address2: string | null;
    phone: string | null;
    city: string;
    zip: string;
    province: string;
    country: string;
    company: string | null;
    latitude: number | null;
    longitude: number | null;
    name: string;
    country_code: string;
    province_code: string;
}

export interface ShopifyCustomerAddress extends ShopifyAddress {
    id: number;
    customer_id: number;
    country_name: string;
    default: boolean;
}

export interface ShopifyEmailMarketingConsent {
    state: string;
    opt_in_level: string;
    consent_updated_at: string | null;
}

export interface ShopifySmsMarketingConsent {
    state: string;
    opt_in_level: string;
    consent_updated_at: string | null;
    consent_collected_from: string;
}

export interface ShopifyCustomer {
    id: number;
    created_at: string;
    updated_at: string;
    first_name: string;
    last_name: string;
    state: string;
    note: string | null;
    verified_email: boolean;
    multipass_identifier: string | null;
    tax_exempt: boolean;
    email_marketing_consent: ShopifyEmailMarketingConsent | null;
    sms_marketing_consent: ShopifySmsMarketingConsent | null;
    tags: string;
    email: string;
    phone: string | null;
    currency: string;
    tax_exemptions: string[];
    admin_graphql_api_id: string;
    default_address: ShopifyCustomerAddress | null;
}

export interface ShopifyLineItem {
    id: number;
    admin_graphql_api_id: string;
    attributed_staffs: unknown[];
    current_quantity: number;
    fulfillable_quantity: number;
    fulfillment_service: string;
    fulfillment_status: string | null;
    gift_card: boolean;
    grams: number;
    name: string;
    price: string;
    price_set: ShopifyMoneySet;
    product_exists: boolean;
    product_id: number;
    properties: unknown[];
    quantity: number;
    requires_shipping: boolean;
    sku: string;
    taxable: boolean;
    title: string;
    total_discount: string;
    total_discount_set: ShopifyMoneySet;
    variant_id: number;
    variant_inventory_management: string | null;
    variant_title: string | null;
    vendor: string;
    tax_lines: unknown[];
    duties: unknown[];
    discount_allocations: Array<{
        amount: string;
        amount_set?: ShopifyMoneySet;
        discount_application_index: number;
    }>;
}

export interface ShopifyFulfillment {
    id: number;
    admin_graphql_api_id: string;
    created_at: string;
    location_id: number;
    name: string;
    order_id: number;
    origin_address: Record<string, unknown>;
    receipt: Record<string, unknown>;
    service: string;
    shipment_status: string | null;
    status: string;
    tracking_company: string | null;
    tracking_number: string | null;
    tracking_numbers: string[];
    tracking_url: string | null;
    tracking_urls: string[];
    updated_at: string;
    line_items: ShopifyLineItem[];
}

export interface ShopifyShippingLine {
    id: number;
    carrier_identifier: string | null;
    code: string;
    discounted_price: string;
    discounted_price_set: ShopifyMoneySet;
    is_removed: boolean;
    phone: string | null;
    price: string;
    price_set: ShopifyMoneySet;
    requested_fulfillment_service_id: string | null;
    source: string | null;
    title: string;
    tax_lines: unknown[];
    discount_allocations: unknown[];
}

export interface ShopifyOrder {
    id: number;
    admin_graphql_api_id: string;
    app_id: number;
    browser_ip: string | null;
    buyer_accepts_marketing: boolean;
    cancel_reason: string | null;
    cancelled_at: string | null;
    cart_token: string | null;
    checkout_id: number | null;
    checkout_token: string | null;
    client_details: unknown | null;
    closed_at: string | null;
    confirmation_number: string;
    confirmed: boolean;
    contact_email: string;
    created_at: string;
    currency: string;
    current_subtotal_price: string;
    current_subtotal_price_set: ShopifyMoneySet;
    current_total_additional_fees_set: ShopifyMoneySet | null;
    current_total_discounts: string;
    current_total_discounts_set: ShopifyMoneySet;
    current_total_duties_set: ShopifyMoneySet | null;
    current_total_price: string;
    current_total_price_set: ShopifyMoneySet;
    current_total_tax: string;
    current_total_tax_set: ShopifyMoneySet;
    customer_locale: string | null;
    device_id: string | null;
    discount_codes: unknown[];
    duties_included: boolean;
    email: string;
    estimated_taxes: boolean;
    financial_status: string;
    fulfillment_status: string | null;
    landing_site: string | null;
    landing_site_ref: string | null;
    location_id: number | null;
    merchant_business_entity_id: string;
    merchant_of_record_app_id: number | null;
    name: string;
    note: string | null;
    note_attributes: ShopifyNoteAttribute[];
    number: number;
    order_number: number;
    order_status_url: string;
    original_total_additional_fees_set: ShopifyMoneySet | null;
    original_total_duties_set: ShopifyMoneySet | null;
    payment_gateway_names: string[];
    phone: string | null;
    po_number: string | null;
    presentment_currency: string;
    processed_at: string;
    reference: string | null;
    referring_site: string | null;
    source_identifier: string | null;
    source_name: string;
    source_url: string | null;
    subtotal_price: string;
    subtotal_price_set: ShopifyMoneySet;
    tags: string;
    tax_exempt: boolean;
    tax_lines: unknown[];
    taxes_included: boolean;
    test: boolean;
    token: string;
    total_cash_rounding_payment_adjustment_set: ShopifyMoneySet;
    total_cash_rounding_refund_adjustment_set: ShopifyMoneySet;
    total_discounts: string;
    total_discounts_set: ShopifyMoneySet;
    total_line_items_price: string;
    total_line_items_price_set: ShopifyMoneySet;
    total_outstanding: string;
    total_price: string;
    total_price_set: ShopifyMoneySet;
    total_shipping_price_set: ShopifyMoneySet;
    total_tax: string;
    total_tax_set: ShopifyMoneySet;
    total_tip_received: string;
    total_weight: number;
    updated_at: string;
    user_id: number | null;
    billing_address: ShopifyAddress | null;
    customer: ShopifyCustomer;
    discount_applications: unknown[];
    fulfillments: ShopifyFulfillment[];
    line_items: ShopifyLineItem[];
    payment_terms: unknown | null;
    refunds: unknown[];
    shipping_address: ShopifyAddress | null;
    shipping_lines: ShopifyShippingLine[];
}

export type ShopifyOrdersResponse = ShopifyOrder[];
