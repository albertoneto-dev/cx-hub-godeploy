/**
 * Uma chamada ao Cosmos a partir do SERVIDOR, para as rotas que ALTERAM pedido (gestão de reenvio).
 *
 * Por que não reaproveitar o `fetchWithTimeout` do `server.ts`: aquele é do caminho do bot — retenta 5xx
 * e mede orçamento agregado. Aqui não se retenta de propósito: repetir um POST de cancelamento ou um PUT
 * depois de um 5xx pode aplicar a mesma ação duas vezes. E o token é o de quem chamou a rota, repassado
 * como veio no header `Authorization` (igual às outras rotas `/api/cosmos/**`).
 *
 * Nunca lança. Falha de rede vira `status: 0`; estouro do `TIMEOUT` vira `timedOut: true`. Quem chama
 * traduz isso para a resposta da rota.
 *
 * Server-only: não está no barrel `shared/lib/cosmos/index.ts`. Importe por `@shared/lib/cosmos/http`.
 */

const DEFAULT_TIMEOUT_MS = 10000;

export interface CosmosFetchOptions {
    method: 'GET' | 'POST' | 'PUT';
    authorization: string;
    body?: unknown;
}

export interface CosmosFetchResult {
    status: number;
    data: unknown;
    timedOut: boolean;
}

export async function cosmosFetch(url: string, options: CosmosFetchOptions): Promise<CosmosFetchResult> {
    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            method: options.method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': options.authorization,
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
        });

        // O corpo é lido com o relógio ainda armado (ADR-005 §1): headers rápidos seguidos de um corpo
        // que trava não podem escapar do timeout.
        const text = await res.text();
        return { status: res.status, data: parseJson(text), timedOut: false };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            console.warn(`[Cosmos HTTP] Timeout after ${timeoutMs}ms: ${options.method} ${url}`);
            return { status: 0, data: null, timedOut: true };
        }
        console.error(`[Cosmos HTTP] Network error: ${options.method} ${url}`, error);
        return { status: 0, data: null, timedOut: false };
    } finally {
        clearTimeout(timeoutId);
    }
}

/** Desfecho de `conferirTokenNoCosmos`. */
export type ConferenciaDoToken = 'ok' | 'sem_url' | 'recusado' | 'sem_acesso' | 'timeout' | 'erro';

/**
 * Confere o token de quem chamou contra o Cosmos, na organização dada, lendo as transportadoras (que não têm
 * dado de cliente). É o que fecha as rotas que não passam pelo Cosmos — o reembolso e a lista de
 * solicitações — com o mesmo token das rotas de reenvio: o que o login do CX Hub devolve.
 */
export async function conferirTokenNoCosmos(orgId: string, authorization: string): Promise<ConferenciaDoToken> {
    const baseUrl = process.env.COSMOS_API_URL;
    if (!baseUrl) return 'sem_url';

    const res = await cosmosFetch(`${baseUrl}/organizations/${orgId}/carriers?per_page=1`, { method: 'GET', authorization });
    if (res.status === 200) return 'ok';
    if (res.timedOut) return 'timeout';
    if (res.status === 401) return 'recusado';
    if (res.status === 403) return 'sem_acesso';
    console.error(`[Cosmos HTTP] Resposta inesperada ao conferir o token (HTTP ${res.status})`);
    return 'erro';
}

function parseJson(text: string): unknown {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
