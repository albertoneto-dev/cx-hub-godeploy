import { BRAND_TO_ORG_ID, type SupportedBrand } from '../../../shared/lib/constants';
import { isUuid } from '../../../shared/lib/format';
import type {
    RefundCancelRequest,
    RefundChanges,
    RefundExecutionRequest,
    RefundUpdateRequest,
} from '../types/management';

export type RefundParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** O número do pedido como a solicitação gravou (`SH9000106BB`, `#9000106`): letras, dígitos, `#` e `-`, com algum dígito. */
const PEDIDO = /^(?=.*\d)[A-Za-z0-9#-]{1,40}$/;

const CANCEL_FIELDS = ['brand', 'ecommerceOrderId', 'handledBy', 'reason'];
const UPDATE_FIELDS = ['brand', 'ecommerceOrderId', 'handledBy', 'changes'];
const EXECUTION_FIELDS = ['brand', 'idSolicitacao', 'handledBy'];
const CHANGE_FIELDS: readonly (keyof RefundChanges)[] = ['refundAmount', 'refundReason', 'notes'];

type RefundTarget = Pick<RefundCancelRequest, 'brand' | 'ecommerceOrderId' | 'handledBy'>;

/** Marca, pedido e agente: o que cancelar e editar têm em comum. Campo fora de `allowed` é recusado. */
function parseTarget(body: Record<string, unknown>, allowed: readonly string[]): RefundParseResult<RefundTarget> {
    const unknownKeys = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknownKeys.length > 0) {
        return { ok: false, message: `Campo desconhecido: ${unknownKeys.join(', ')}.` };
    }

    const brand = parseBrand(body.brand);
    if (!brand.ok) return brand;

    const ecommerceOrderId = typeof body.ecommerceOrderId === 'string' ? body.ecommerceOrderId.trim() : '';
    if (!PEDIDO.test(ecommerceOrderId)) {
        return { ok: false, message: 'Informe ecommerceOrderId (número do pedido da solicitação).' };
    }

    if (!isNonEmptyString(body.handledBy)) {
        return { ok: false, message: 'Informe handledBy (agente responsável).' };
    }

    return { ok: true, value: { brand: brand.value, ecommerceOrderId, handledBy: body.handledBy.trim() } };
}

function parseBrand(value: unknown): RefundParseResult<SupportedBrand> {
    const brand = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!Object.prototype.hasOwnProperty.call(BRAND_TO_ORG_ID, brand)) {
        return { ok: false, message: `Marca inválida: ${brand || '(vazia)'}.` };
    }
    return { ok: true, value: brand as SupportedBrand };
}

/**
 * Valida o corpo de "marcar como concluído" e de "atualizar acompanhamento": `{ brand, idSolicitacao, handledBy }`.
 * Estrito como os outros: campo desconhecido é recusado. O `idSolicitacao` tem de ser um **UUID**, o formato que o
 * CX Hub gera na criação do caso (o id vai ao SQL, escapado, e ao `dag_run_id`); quem confere que é de um reembolso
 * da marca do corpo é a raw, depois.
 */
export function parseRefundExecutionRequest(body: unknown): RefundParseResult<RefundExecutionRequest> {
    if (!isPlainObject(body)) return { ok: false, message: 'Corpo da requisição inválido.' };

    const unknownKeys = Object.keys(body).filter((key) => !EXECUTION_FIELDS.includes(key));
    if (unknownKeys.length > 0) {
        return { ok: false, message: `Campo desconhecido: ${unknownKeys.join(', ')}.` };
    }

    const brand = parseBrand(body.brand);
    if (!brand.ok) return brand;

    const idSolicitacao = typeof body.idSolicitacao === 'string' ? body.idSolicitacao.trim() : '';
    if (!isUuid(idSolicitacao)) {
        return { ok: false, message: 'Informe idSolicitacao (o id da solicitação, um UUID, como a lista devolve).' };
    }

    if (!isNonEmptyString(body.handledBy)) {
        return { ok: false, message: 'Informe handledBy (agente responsável).' };
    }

    return { ok: true, value: { brand: brand.value, idSolicitacao, handledBy: body.handledBy.trim() } };
}

export function parseRefundCancelRequest(body: unknown): RefundParseResult<RefundCancelRequest> {
    if (!isPlainObject(body)) return { ok: false, message: 'Corpo da requisição inválido.' };

    const target = parseTarget(body, CANCEL_FIELDS);
    if (!target.ok) return target;

    if (!isNonEmptyString(body.reason)) {
        return { ok: false, message: 'Informe reason (motivo do cancelamento).' };
    }
    return { ok: true, value: { ...target.value, reason: body.reason.trim() } };
}

/**
 * Valida o pedido de edição. Estrito como o do reenvio: campo desconhecido é recusado em vez de ignorado,
 * para um `amount` digitado errado não virar "sucesso" sem mudar nada.
 */
export function parseRefundUpdateRequest(body: unknown): RefundParseResult<RefundUpdateRequest> {
    if (!isPlainObject(body)) return { ok: false, message: 'Corpo da requisição inválido.' };

    const target = parseTarget(body, UPDATE_FIELDS);
    if (!target.ok) return target;

    const changesBody = body.changes;
    if (!isPlainObject(changesBody)) {
        return { ok: false, message: 'Informe changes com refundAmount, refundReason ou notes.' };
    }
    const unknownKeys = Object.keys(changesBody).filter((key) => !(CHANGE_FIELDS as readonly string[]).includes(key));
    if (unknownKeys.length > 0) {
        return {
            ok: false,
            message: `Campo não editável: ${unknownKeys.join(', ')}. Só refundAmount, refundReason e notes podem ser editados.`,
        };
    }

    const changes: RefundChanges = {};
    const { refundAmount, refundReason, notes } = changesBody;
    if (refundAmount !== undefined) {
        if (typeof refundAmount !== 'number' || !Number.isFinite(refundAmount) || refundAmount <= 0) {
            return { ok: false, message: 'refundAmount deve ser um número maior que zero.' };
        }
        changes.refundAmount = refundAmount;
    }
    if (refundReason !== undefined) {
        if (!isNonEmptyString(refundReason)) return { ok: false, message: 'refundReason deve ser texto não vazio.' };
        changes.refundReason = refundReason.trim();
    }
    if (notes !== undefined) {
        if (typeof notes !== 'string') return { ok: false, message: 'notes deve ser texto.' };
        changes.notes = notes.trim();
    }

    if (Object.keys(changes).length === 0) {
        return { ok: false, message: 'Nada para editar: informe refundAmount, refundReason ou notes.' };
    }
    return { ok: true, value: { ...target.value, changes } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}
