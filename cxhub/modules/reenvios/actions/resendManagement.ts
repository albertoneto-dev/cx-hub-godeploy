import type { CosmosCarrier, CosmosDetailedOrder, CosmosOrder } from '../../../shared/types/index';
import { sanitizeOrderId } from '../../../shared/lib/cosmos/index';
import { isCepValido } from '../../../shared/lib/format';
import type {
    CosmosBillingAddressInput,
    CosmosCustomerInput,
    CosmosOrderUpdateBody,
    CosmosShippingAddressInput,
    ResendAddressChanges,
    ResendCancelRequest,
    ResendCustomerChanges,
    ResendUpdateRequest,
} from '../types/management';

export type ResendParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** `erp_status` em que o faturamento do reenvio já começou: daqui em diante não se cancela nem se edita. */
export const RESEND_LOCKED_ERP_STATUSES: readonly string[] = ['invoicing', 'invoiced'];

export type ResendGuardCode = 'NOT_A_RESEND' | 'RESEND_CANCELLED' | 'RESEND_LOCKED';

export type ResendGuardResult = { ok: true } | { ok: false; code: ResendGuardCode; message: string };

/**
 * Janela em que o CX Hub cancela ou edita um reenvio: o pedido é reenvio, não está cancelado e o
 * faturamento não começou.
 *
 * É a régua que o próprio Cosmos aplica ao CANCELAR reenvio (`erp_status` fora de `invoicing`/`invoiced`).
 * Na edição ela é só nossa: o `PUT` do Cosmos não tem trava de status, e um endereço trocado depois do
 * faturamento não chega nem à NF nem à transportadora.
 */
export function checkResendActionable(
    order: Pick<CosmosDetailedOrder, 'origin' | 'status' | 'erp_status'>,
): ResendGuardResult {
    if (order.origin !== 'resend') {
        return { ok: false, code: 'NOT_A_RESEND', message: 'Este pedido não é um reenvio.' };
    }
    if (order.status === 'cancelled') {
        return { ok: false, code: 'RESEND_CANCELLED', message: 'Este reenvio já está cancelado.' };
    }
    if (RESEND_LOCKED_ERP_STATUSES.includes(order.erp_status)) {
        return {
            ok: false,
            code: 'RESEND_LOCKED',
            message: 'O faturamento deste reenvio já começou: ele não pode mais ser cancelado nem editado.',
        };
    }
    return { ok: true };
}

/** O Cosmos grava como autor o usuário de serviço do CX Hub; o agente só fica registrado no motivo. */
export function buildCancelReason(request: ResendCancelRequest): string {
    return `Cancelado via CX Hub por ${request.handledBy}: ${request.reason}`;
}

/**
 * Reenvios de um pedido original. O Cosmos numera como `{external_id do original}-R-{n}`, e o original tem
 * os dois formatos que o `getCosmosOrder` já casa (`SH<id><sigla><n?>` e `#SHOPIFY<id>`). A busca no Cosmos
 * é `ILIKE`, então a lista vem com pedidos de número parecido: é este filtro que separa.
 */
export function matchResendsOfOrder<T extends Pick<CosmosOrder, 'external_id' | 'origin'>>(
    orders: T[],
    orderId: string,
): T[] {
    const id = sanitizeOrderId(orderId);
    if (!id) return [];
    const pattern = new RegExp(`^(SH${id}[a-zA-Z]{2}\\d*|#SHOPIFY${id})-R-\\d+$`);
    return orders.filter((order) => order.origin === 'resend' && pattern.test(order.external_id));
}

/** `id` interno do Cosmos (só dígitos), ou `null`. */
export function parseCosmosOrderId(id: string): string | null {
    return /^\d+$/.test(id) ? id : null;
}

export function parseResendCancelRequest(body: unknown): ResendParseResult<ResendCancelRequest> {
    if (!isPlainObject(body)) return { ok: false, message: 'Corpo da requisição inválido.' };
    if (!isNonEmptyString(body.handledBy)) {
        return { ok: false, message: 'Informe handledBy (agente responsável).' };
    }
    if (!isNonEmptyString(body.reason)) {
        return { ok: false, message: 'Informe reason (motivo do cancelamento).' };
    }
    return { ok: true, value: { handledBy: body.handledBy.trim(), reason: body.reason.trim() } };
}

const UPDATE_FIELDS = ['handledBy', 'shippingAddress', 'carrierId', 'customer'];
const ADDRESS_FIELDS: readonly (keyof ResendAddressChanges)[] = [
    'name', 'phone', 'street', 'number', 'complement', 'neighborhood', 'city', 'state', 'postalCode',
];
const CUSTOMER_FIELDS: readonly (keyof ResendCustomerChanges)[] = ['name', 'email', 'phone', 'document'];

/**
 * Valida o pedido de edição. É estrito de propósito: campo desconhecido é recusado em vez de ignorado, para
 * um `zipcode` digitado errado não virar "sucesso" sem mudar nada. Produtos e frete ficam de fora porque o
 * `PUT` do Cosmos não os edita — o caminho é cancelar e abrir outro reenvio.
 */
export function parseResendUpdateRequest(body: unknown): ResendParseResult<ResendUpdateRequest> {
    if (!isPlainObject(body)) return { ok: false, message: 'Corpo da requisição inválido.' };

    const unknownKeys = Object.keys(body).filter((key) => !UPDATE_FIELDS.includes(key));
    if (unknownKeys.length > 0) {
        return {
            ok: false,
            message: `Campo não editável: ${unknownKeys.join(', ')}. Só shippingAddress, carrierId e customer `
                + 'podem ser editados; para trocar produtos ou frete, cancele e abra outro reenvio.',
        };
    }

    if (!isNonEmptyString(body.handledBy)) {
        return { ok: false, message: 'Informe handledBy (agente responsável).' };
    }

    const request: ResendUpdateRequest = { handledBy: body.handledBy.trim() };

    if (body.shippingAddress !== undefined) {
        const parsed = parseStringFields(body.shippingAddress, ADDRESS_FIELDS, 'shippingAddress');
        if (!parsed.ok) return parsed;
        request.shippingAddress = parsed.value;
    }

    if (body.carrierId !== undefined) {
        const { carrierId } = body;
        if (typeof carrierId !== 'number' || !Number.isInteger(carrierId) || carrierId <= 0) {
            return { ok: false, message: 'carrierId deve ser o id numérico da transportadora no Cosmos.' };
        }
        request.carrierId = carrierId;
    }

    if (body.customer !== undefined) {
        const parsed = parseStringFields(body.customer, CUSTOMER_FIELDS, 'customer');
        if (!parsed.ok) return parsed;
        request.customer = parsed.value;
    }

    if (!request.shippingAddress && request.carrierId === undefined && !request.customer) {
        return { ok: false, message: 'Nada para editar: informe shippingAddress, carrierId ou customer.' };
    }

    return { ok: true, value: request };
}

/** Campos que precisam existir no endereço final: a mesma régua do formulário e do bot (G5b). */
const REQUIRED_ADDRESS_FIELDS: readonly (keyof CosmosBillingAddressInput)[] = [
    'street', 'number', 'neighborhood', 'city', 'state', 'postal_code',
];

/**
 * Monta o corpo do `PUT` do Cosmos com os objetos INTEIROS.
 *
 * O Cosmos reconstrói endereço e cliente só com o que chega no corpo (`Order::ShippingAddress.new(...)`):
 * campo omitido vira `nil`. E o endereço de entrega carrega o `shipping_cost` e o `shipping_service_name`
 * do pedido, então um `PUT` só com a rua zeraria o frete. Por isso tudo é mesclado sobre o pedido atual.
 *
 * - Endereço trocado ⇒ cobrança igual à entrega, a mesma regra que o Cosmos usa ao criar reenvio com
 *   endereço novo.
 * - Transportadora trocada ⇒ `service_name` passa a ser o `shopify_name` dela, como no reprocessamento.
 * - `metadata` nunca vai: o Cosmos substitui o objeto inteiro e o reenvio perderia o vínculo com o pedido
 *   original (`original_order_id`).
 */
export function buildResendUpdateBody(
    order: Pick<CosmosDetailedOrder, 'shipping' | 'customer'>,
    request: ResendUpdateRequest,
    carrier?: Pick<CosmosCarrier, 'id' | 'shopify_name'>,
): ResendParseResult<CosmosOrderUpdateBody> {
    const body: CosmosOrderUpdateBody = { order: {} };

    if (request.shippingAddress || carrier) {
        const shipping = mergeShippingAddress(order, request.shippingAddress ?? {}, carrier);

        if (request.shippingAddress) {
            const missing = REQUIRED_ADDRESS_FIELDS.filter((field) => !shipping[field]?.trim());
            if (missing.length > 0) {
                return { ok: false, message: `Endereço incompleto depois da edição: falta ${missing.join(', ')}.` };
            }
            if (!isCepValido(shipping.postal_code)) {
                return { ok: false, message: 'CEP inválido: precisa ter 8 dígitos.' };
            }
            body.order.billing_address = toBillingAddress(shipping);
        }

        body.order.shipping_address = shipping;
    }

    if (carrier) {
        body.order.carrier_id = carrier.id;
    }

    if (request.customer) {
        body.order.customer = mergeCustomer(order, request.customer);
    }

    return { ok: true, value: body };
}

function mergeShippingAddress(
    order: Pick<CosmosDetailedOrder, 'shipping'>,
    changes: ResendAddressChanges,
    carrier?: Pick<CosmosCarrier, 'shopify_name'>,
): CosmosShippingAddressInput {
    const current = order.shipping;
    const address = current?.address;
    return {
        name: changes.name ?? current?.name ?? null,
        phone: changes.phone ?? current?.phone ?? null,
        street: changes.street ?? address?.street ?? null,
        number: changes.number ?? address?.number ?? null,
        complement: changes.complement ?? address?.complement ?? null,
        neighborhood: changes.neighborhood ?? address?.neighborhood ?? null,
        city: changes.city ?? address?.city ?? null,
        state: changes.state ?? address?.state ?? null,
        postal_code: changes.postalCode ?? address?.postal_code ?? null,
        service_name: carrier ? carrier.shopify_name : current?.service_name ?? null,
        cost: current?.cost ?? null,
    };
}

function toBillingAddress(shipping: CosmosShippingAddressInput): CosmosBillingAddressInput {
    return {
        name: shipping.name,
        phone: shipping.phone,
        street: shipping.street,
        number: shipping.number,
        complement: shipping.complement,
        neighborhood: shipping.neighborhood,
        city: shipping.city,
        state: shipping.state,
        postal_code: shipping.postal_code,
    };
}

function mergeCustomer(
    order: Pick<CosmosDetailedOrder, 'customer'>,
    changes: ResendCustomerChanges,
): CosmosCustomerInput {
    const current = order.customer;
    return {
        name: changes.name ?? current?.name ?? null,
        email: changes.email ?? current?.email ?? null,
        phone: changes.phone ?? current?.phone ?? null,
        document: changes.document ?? current?.document ?? null,
        // O tipo (CPF/CNPJ) não é editável, mas precisa ir: o Cosmos zeraria o campo.
        type: current?.type ?? null,
    };
}

function parseStringFields<K extends string>(
    value: unknown,
    fields: readonly K[],
    label: string,
): ResendParseResult<Partial<Record<K, string>>> {
    if (!isPlainObject(value)) return { ok: false, message: `${label} deve ser um objeto.` };

    const result: Partial<Record<K, string>> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
        if (!(fields as readonly string[]).includes(key)) {
            return { ok: false, message: `Campo desconhecido em ${label}: ${key}.` };
        }
        if (typeof fieldValue !== 'string') {
            return { ok: false, message: `${label}.${key} deve ser texto.` };
        }
        result[key as K] = fieldValue.trim();
    }

    if (Object.keys(result).length === 0) return { ok: false, message: `${label} está vazio.` };
    return { ok: true, value: result };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}
