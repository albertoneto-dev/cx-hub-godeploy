import type { CosmosCarrier, CosmosDetailedOrder, CosmosOrder } from '../../../shared/types/index';
import { BRAND_TO_ORG_ID, type SupportedBrand } from '../../../shared/lib/constants';
import { sanitizeOrderId } from '../../../shared/lib/cosmos/index';
import { cosmosFetch, type CosmosFetchResult } from '../../../shared/lib/cosmos/http';
import type {
    ResendCancelRequest,
    ResendManagementCode,
    ResendManagementResponse,
    ResendUpdateRequest,
} from '../types/management';
import {
    buildCancelReason,
    buildResendUpdateBody,
    checkResendActionable,
    matchResendsOfOrder,
} from './resendManagement';

/**
 * Gestão de reenvio no Cosmos a partir do SERVIDOR: listar, cancelar e editar.
 *
 * As rotas `/api/cosmos/resends/**` não têm tela na frente (decisão de 2026-10-23: só API), então a guarda
 * roda aqui e não no navegador: antes de cancelar ou editar, o pedido é relido no Cosmos e passa pelo
 * `checkResendActionable`. As regras ficam em `resendManagement.ts` (puras, testadas); este arquivo só
 * encadeia as chamadas.
 *
 * Server-only: não está no barrel de `actions`. Importe por `@modules/reenvios/actions/resendCosmos`.
 */

const LOG = '[Resend Management]';

export interface ResendManagementResult {
    status: number;
    body: ResendManagementResponse;
}

export interface CosmosContext {
    /** Já validada contra o `BRAND_TO_ORG_ID`. */
    brand: SupportedBrand;
    baseUrl: string;
    orgId: string;
    authorization: string;
}

export type CosmosContextResult = { ok: true; ctx: CosmosContext } | { ok: false; result: ResendManagementResult };

function failure(status: number, code: ResendManagementCode, message: string): ResendManagementResult {
    return { status, body: { code, message } };
}

/** Marca → organização, token de quem chamou e URL do Cosmos. Marca fora do mapa é recusada, sem fallback. */
export function resolveCosmosContext(brand: string | null, authorization: string | null): CosmosContextResult {
    const key = (brand ?? '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(BRAND_TO_ORG_ID, key)) {
        return { ok: false, result: failure(400, 'INVALID_REQUEST', `Marca inválida: ${brand ?? '(vazia)'}.`) };
    }
    if (!authorization) {
        return { ok: false, result: failure(401, 'UNAUTHORIZED', 'Header Authorization ausente.') };
    }
    const baseUrl = process.env.COSMOS_API_URL;
    if (!baseUrl) {
        console.error(`${LOG} Missing COSMOS_API_URL env variable`);
        return { ok: false, result: failure(500, 'UNKNOWN_ERROR', 'Cosmos API URL não configurada.') };
    }
    const marca = key as SupportedBrand;
    return { ok: true, ctx: { brand: marca, baseUrl, orgId: BRAND_TO_ORG_ID[marca], authorization } };
}

/** Resposta não-ok do Cosmos ⇒ contrato da rota. A mensagem do Cosmos (já em português) é repassada. */
export function mapCosmosFailure(result: CosmosFetchResult): ResendManagementResult {
    if (result.timedOut) {
        return failure(504, 'API_TIMEOUT', 'O Cosmos demorou para responder.');
    }

    const data = result.data as { error?: unknown } | null;
    const cosmosMessage = typeof data?.error === 'string' ? data.error : '';

    switch (result.status) {
        case 401:
            return failure(401, 'UNAUTHORIZED', cosmosMessage || 'Token do Cosmos inválido ou expirado.');
        case 403:
            return failure(403, 'FORBIDDEN', cosmosMessage || 'O usuário do CX Hub não tem permissão para esta ação no Cosmos.');
        case 404:
            return failure(404, 'NOT_FOUND', cosmosMessage || 'Pedido não encontrado nesta marca.');
        case 422:
            return failure(422, 'COSMOS_REJECTED', cosmosMessage || 'O Cosmos recusou a operação.');
        default:
            console.error(`${LOG} Resposta inesperada do Cosmos (HTTP ${result.status})`);
            return failure(502, 'UNKNOWN_ERROR', 'Não foi possível concluir a operação no Cosmos.');
    }
}

export async function listResendsOfOrder(ctx: CosmosContext, orderId: string): Promise<ResendManagementResult> {
    const id = sanitizeOrderId(orderId);
    const url = `${ctx.baseUrl}/organizations/${ctx.orgId}/orders`
        + `?external_id=${encodeURIComponent(id)}&origin=resend&per_page=100`;

    const res = await cosmosFetch(url, { method: 'GET', authorization: ctx.authorization });
    if (res.status !== 200 || !Array.isArray(res.data)) {
        return mapCosmosFailure(res);
    }

    const resends = matchResendsOfOrder(res.data as CosmosOrder[], id);
    return {
        status: 200,
        body: {
            code: 'SUCCESS',
            message: resends.length > 0 ? '' : 'Nenhum reenvio encontrado para este pedido.',
            resends,
        },
    };
}

export async function cancelResend(
    ctx: CosmosContext,
    orderId: string,
    request: ResendCancelRequest,
): Promise<ResendManagementResult> {
    const loaded = await loadActionableResend(ctx, orderId);
    if (!loaded.ok) return loaded.result;

    const res = await cosmosFetch(`${ctx.baseUrl}/organizations/${ctx.orgId}/orders/${orderId}/cancel`, {
        method: 'POST',
        authorization: ctx.authorization,
        body: { order: { reason: buildCancelReason(request) } },
    });
    if (res.status === 403) {
        // O acesso à organização já passou na releitura do pedido, então este 403 é o `authorize!` do
        // cancelamento. O Cosmos responde genérico; nomear a permissão poupa a investigação.
        return failure(
            403,
            'FORBIDDEN',
            `O usuário de serviço do CX Hub não tem a permissão cancel_order no Cosmos para esta marca (org ${ctx.orgId}).`,
        );
    }
    if (res.status !== 200 || !isOrder(res.data)) {
        return mapCosmosFailure(res);
    }

    console.log(`${LOG} Reenvio ${orderId} cancelado (org ${ctx.orgId}) por ${request.handledBy}`);
    return { status: 200, body: { code: 'SUCCESS', message: 'Reenvio cancelado no Cosmos.', order: res.data } };
}

export async function updateResend(
    ctx: CosmosContext,
    orderId: string,
    request: ResendUpdateRequest,
): Promise<ResendManagementResult> {
    const loaded = await loadActionableResend(ctx, orderId);
    if (!loaded.ok) return loaded.result;

    let carrier: CosmosCarrier | undefined;
    if (request.carrierId !== undefined) {
        // O `PUT` do Cosmos aceita qualquer `carrier_id`, inclusive de outra marca. A busca por id é
        // escopada pela organização, então um 404 aqui é exatamente "não é desta marca".
        const carrierRes = await cosmosFetch(`${ctx.baseUrl}/organizations/${ctx.orgId}/carriers/${request.carrierId}`, {
            method: 'GET',
            authorization: ctx.authorization,
        });
        if (carrierRes.status === 404) {
            return failure(422, 'CARRIER_NOT_FOUND', 'Transportadora não encontrada nesta marca.');
        }
        if (carrierRes.status !== 200 || !isCarrier(carrierRes.data)) {
            return mapCosmosFailure(carrierRes);
        }
        if (!carrierRes.data.active) {
            return failure(422, 'CARRIER_NOT_FOUND', 'Transportadora inativa nesta marca.');
        }
        carrier = carrierRes.data;
    }

    const built = buildResendUpdateBody(loaded.order, request, carrier);
    if (!built.ok) {
        return failure(400, 'INVALID_REQUEST', built.message);
    }

    const res = await cosmosFetch(`${ctx.baseUrl}/organizations/${ctx.orgId}/orders/${orderId}`, {
        method: 'PUT',
        authorization: ctx.authorization,
        body: built.value,
    });
    if (res.status !== 200 || !isOrder(res.data)) {
        return mapCosmosFailure(res);
    }

    const changed = Object.keys(built.value.order).join(', ');
    console.log(`${LOG} Reenvio ${orderId} editado (org ${ctx.orgId}) por ${request.handledBy}: ${changed}`);
    return { status: 200, body: { code: 'SUCCESS', message: 'Reenvio atualizado no Cosmos.', order: res.data } };
}

type LoadResult = { ok: true; order: CosmosDetailedOrder } | { ok: false; result: ResendManagementResult };

/** Relê o pedido no Cosmos e aplica a janela de gestão antes de qualquer alteração. */
async function loadActionableResend(ctx: CosmosContext, orderId: string): Promise<LoadResult> {
    const res = await cosmosFetch(`${ctx.baseUrl}/organizations/${ctx.orgId}/orders/${orderId}`, {
        method: 'GET',
        authorization: ctx.authorization,
    });
    if (res.status !== 200 || !isOrder(res.data)) {
        return { ok: false, result: mapCosmosFailure(res) };
    }

    const guard = checkResendActionable(res.data);
    if (!guard.ok) {
        console.warn(`${LOG} Pedido ${orderId} (org ${ctx.orgId}) fora da janela de gestão: ${guard.code}`);
        return { ok: false, result: failure(422, guard.code, guard.message) };
    }

    return { ok: true, order: res.data };
}

function isOrder(data: unknown): data is CosmosDetailedOrder {
    return typeof data === 'object' && data !== null && typeof (data as { id?: unknown }).id === 'number';
}

function isCarrier(data: unknown): data is CosmosCarrier {
    if (typeof data !== 'object' || data === null) return false;
    const carrier = data as { id?: unknown; shopify_name?: unknown };
    return typeof carrier.id === 'number' && typeof carrier.shopify_name === 'string';
}
