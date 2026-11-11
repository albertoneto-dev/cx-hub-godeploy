/** Campos que o node "Validate Body" do workflow `[PROD] - Webhook Refund CXHub` exigia presentes e não nulos. */
export const REFUND_REQUIRED_FIELDS = [
    'brand',
    'handledBy',
    'sourceChannel',
    'supportTicketId',
    'originWarehouse',
    'customerName',
    'invoiceNumber',
    'ecommerceOrderId',
    'refundAmount',
    'refundReason',
    'refundScope',
    'requiresReturn',
    'carrierName',
    'orderStatus',
    'isFullRefund',
    'nfeAccessKey',
] as const;

/** Campos obrigatórios ausentes ou `null` (string vazia passa, como no n8n). */
export function camposFaltandoNoReembolso(data: Partial<Record<string, unknown>>): string[] {
    return REFUND_REQUIRED_FIELDS.filter((campo) => data[campo] === null || data[campo] === undefined);
}
