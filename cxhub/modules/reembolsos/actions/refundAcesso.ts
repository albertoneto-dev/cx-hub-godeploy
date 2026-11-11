import { BRAND_TO_ORG_ID, type SupportedBrand } from '../../../shared/lib/constants';
import { conferirTokenNoCosmos } from '../../../shared/lib/cosmos/http';
import type { RefundManagementCode, RefundManagementResponse } from '../types/management';

/**
 * A conferência de acesso das rotas de gestão de reembolso. O reembolso não passa pelo Cosmos, mas a rota mexe
 * em dinheiro devolvido à cliente e não pode ficar aberta: o token de quem chamou é conferido na organização da
 * marca.
 *
 * Server-only: não está no barrel de `actions`. Importe por `@modules/reembolsos/actions/refundAcesso`.
 */

const LOG = '[Refund Management]';

export interface RefundManagementResult {
    status: number;
    body: RefundManagementResponse;
}

function failure(status: number, code: RefundManagementCode, message: string): RefundManagementResult {
    return { status, body: { code, message } };
}

/** `null` = acesso conferido. */
export async function verificarAcessoCosmos(
    brand: SupportedBrand,
    authorization: string,
): Promise<RefundManagementResult | null> {
    switch (await conferirTokenNoCosmos(BRAND_TO_ORG_ID[brand], authorization)) {
        case 'ok':
            return null;
        case 'sem_url':
            console.error(`${LOG} Missing COSMOS_API_URL env variable`);
            return failure(500, 'UNKNOWN_ERROR', 'Cosmos API URL não configurada.');
        case 'timeout':
            return failure(504, 'API_TIMEOUT', 'O Cosmos demorou para conferir o token.');
        case 'recusado':
            return failure(401, 'UNAUTHORIZED', 'Token do Cosmos inválido ou expirado.');
        case 'sem_acesso':
            return failure(403, 'FORBIDDEN', 'O token não tem acesso a esta marca no Cosmos.');
        default:
            return failure(502, 'UNKNOWN_ERROR', 'Não foi possível conferir o token no Cosmos.');
    }
}
