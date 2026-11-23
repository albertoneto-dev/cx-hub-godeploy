import { BRAND_TO_ORG_ID, type SupportedBrand } from '../../../shared/lib/constants';
import { sanitizeOrderId } from '../../../shared/lib/cosmos/index';
import { BRAND_CODE_NA_INTELIPOST } from '../../../shared/lib/datamart/nfDaIntelipostServer';
import { pedidoNaIntelipost } from '../../../shared/lib/intelipost/gateway';
import { consultarDataMart, literalSql, METABASE_TIMEOUT_MS } from '../../../shared/lib/metabase/index';
import { matchResendsOfOrder } from './resendManagement';

/**
 * O pedido já tem reenvio no Cosmos? Perguntado antes do `POST /resend` (2026-11-22).
 *
 * Em 19/11 o Cosmos levou de 10 a 50 s para criar reenvios, e o `processResend` desiste do `POST /resend` no `TIMEOUT`
 * (12 s, contados do início da requisição): respondia "o reenvio PODE ter sido criado" e não registrava nada. O Cosmos
 * criava o reenvio mesmo assim, o agente repetia, e 8 pedidos ficaram com dois reenvios ativos (um com três). O dedup de
 * 24 h não via o primeiro porque ele não tinha sido registrado: a verdade estava só no Cosmos. Esta consulta é o que
 * torna a repetição segura.
 *
 * A régua:
 * - **reenvio do pedido criado nas últimas 24 h e não cancelado** (a mesma janela do dedup) ⇒ `existe`. Quem chama
 *   registra a solicitação com ele, sem criar outro (decisão do usuário em 2026-11-22);
 * - o Cosmos respondeu sem um ⇒ `nenhum`, e o reenvio é criado como antes;
 * - o Cosmos não respondeu (duas tentativas) ⇒ o Data Mart (`gold.fct_intelipost_orders`). Ele só vê o reenvio quando a
 *   Intelipost recebe a remessa (15 min depois da criação, no SH1585904KS-R-1) e o Data Mart a copia (cerca de 1 h): acha
 *   o reenvio antigo, mas não o de minutos atrás, que é justamente o da repetição. Por isso, sem o reenvio no Data Mart,
 *   a resposta é `indefinido`, nunca `nenhum`: quem chama não cria nada, e repetir é seguro.
 *
 * **Nunca lança.** ⚠️ Server-only (usa o token do Cosmos e a chave do Metabase): fora do barrel.
 */

export interface ReenvioNoCosmos {
    /** O `external_id` do reenvio, como `SH1585904KS-R-1`. */
    externalId: string;
    /** Quando foi criado: o `created_at` do Cosmos, ou o `created_iso` da remessa na Intelipost. */
    criadoEm: string;
    fonte: 'cosmos' | 'datamart';
}

export type ReenvioRecente =
    | { tipo: 'nenhum' }
    | ({ tipo: 'existe' } & ReenvioNoCosmos)
    | { tipo: 'indefinido'; motivo: string };

export interface DepsDoReenvioRecente {
    fetch?: typeof fetch;
    consultar?: (sql: string, opcoes?: { timeoutMs?: number }) => Promise<unknown[][]>;
    agora?: () => number;
}

/** A mesma janela do dedup da fila e da raw (`solicitacaoRecenteNoRegistro`). */
export const JANELA_DO_REENVIO_RECENTE_MS = 24 * 60 * 60_000;
/** Teto de cada consulta ao Cosmos. A busca por `external_id` levou de 45 ms a 8,5 s em 19/11, com o Cosmos lento. */
export const TETO_DA_CONSULTA_AO_COSMOS_MS = 5_000;
const TENTATIVAS_NO_COSMOS = 2;
/** Abaixo disto a consulta nem sai, como na conferência (`pedidoServer.ts`). */
const MIN_PRAZO_MS = 500;
const LOG = '[Reenvio no Cosmos]';

/** A nota que vai na frente das observações da linha quando o reenvio já existia, como as notas da conferência. */
export function notaDoReenvioExistente(externalId: string): string {
    return `[REENVIO JÁ EXISTIA NO COSMOS: ${externalId}]`;
}

/** Até quantos reenvios por pedido a busca no Data Mart enxerga (`-R-1` a `-R-10`). O SH716185LC chegou a 3. */
const REENVIOS_PROCURADOS_NO_DATA_MART = 10;

/**
 * As remessas de reenvio do pedido na Intelipost, desde `desde`. Os reenvios não têm o `shopify_order_number` do original
 * (só o pedido de venda o tem), e o `sales_order_number` é o `external_id` do Cosmos (`SH1585904KS-R-1`). A busca é por
 * igualdade, com a lista dos candidatos, porque é o que usa o índice da coluna: o `LIKE 'SH1585904%'` não o usa (o
 * collation não é `C`) e levou de 4,4 s a mais de 5 s pelo Metabase em 22/11.
 */
export function sqlDoReenvioNaIntelipost(brand: SupportedBrand, numero: string, desde: Date): string {
    const sh = pedidoNaIntelipost(brand, numero);
    const candidatos = Array.from({ length: REENVIOS_PROCURADOS_NO_DATA_MART }, (_, i) => i + 1)
        .flatMap((k) => [`${sh}-R-${k}`, `#SHOPIFY${numero}-R-${k}`])
        .map(literalSql)
        .join(', ');
    return `select sales_order_number, created_iso from gold.fct_intelipost_orders
where sales_order_number in (${candidatos})
  and brand_code = ${literalSql(BRAND_CODE_NA_INTELIPOST[brand])} and created_iso >= ${literalSql(desde.toISOString())}
order by created_iso desc limit 20`;
}

export async function reenvioRecenteNoCosmos(
    brand: SupportedBrand,
    numeroPedido: string | null | undefined,
    token: string | undefined,
    prazo: number,
    agora: Date,
    deps: DepsDoReenvioRecente = {},
): Promise<ReenvioRecente> {
    try {
        return await procurar(brand, numeroPedido, token, prazo, agora, deps);
    } catch (erro) {
        // Rede de segurança: as etapas já tratam as próprias falhas.
        return { tipo: 'indefinido', motivo: `falha inesperada (${erro instanceof Error ? erro.message : String(erro)})`.slice(0, 200) };
    }
}

async function procurar(
    brand: SupportedBrand,
    numeroPedido: string | null | undefined,
    token: string | undefined,
    prazo: number,
    agora: Date,
    deps: DepsDoReenvioRecente,
): Promise<ReenvioRecente> {
    const id = sanitizeOrderId(numeroPedido ?? '');
    const baseUrl = process.env.COSMOS_API_URL;
    // Sem pedido não há o que procurar, e sem token ou URL o `executarNoCosmos` recusa sozinho ("dados incompletos"),
    // sem chamar o Cosmos: nos dois casos, fica tudo como antes desta consulta.
    if (!id || !token || !baseUrl) return { tipo: 'nenhum' };

    const relogio = deps.agora ?? Date.now;
    const desde = agora.getTime() - JANELA_DO_REENVIO_RECENTE_MS;
    const url = `${baseUrl}/organizations/${BRAND_TO_ORG_ID[brand]}/orders`
        + `?external_id=${encodeURIComponent(id)}&origin=resend&per_page=100`;

    let motivo = 'o prazo acabou antes da consulta ao Cosmos';
    for (let tentativa = 1; tentativa <= TENTATIVAS_NO_COSMOS; tentativa++) {
        const restante = prazo - relogio();
        if (restante < MIN_PRAZO_MS) break;
        const resposta = await consultarCosmos(url, token, Math.min(TETO_DA_CONSULTA_AO_COSMOS_MS, restante), deps.fetch ?? fetch);
        if (resposta.ok) {
            const achado = maisRecente(matchResendsOfOrder(resposta.pedidos, id), desde);
            return achado ? { tipo: 'existe', externalId: achado.external_id, criadoEm: achado.created_at, fonte: 'cosmos' } : { tipo: 'nenhum' };
        }
        motivo = resposta.motivo;
        console.warn(`${LOG} pedido ${id} (${brand}): tentativa ${tentativa} sem resposta útil — ${motivo}`);
        if (!resposta.repetir) break;
    }

    const noDataMart = await reenvioNoDataMart(brand, id, new Date(desde), prazo - relogio(), deps.consultar ?? consultarDataMart);
    if (noDataMart.achado) {
        console.log(`${LOG} pedido ${id} (${brand}): o Cosmos não respondeu, e o Data Mart tem o reenvio ${noDataMart.achado.externalId}`);
        return { tipo: 'existe', ...noDataMart.achado, fonte: 'datamart' };
    }
    console.warn(`${LOG} pedido ${id} (${brand}): sem conferir — ${motivo}; Data Mart: ${noDataMart.motivo}`);
    return { tipo: 'indefinido', motivo };
}

interface PedidoListado {
    external_id: string;
    origin: string;
    status?: unknown;
    canceled_at?: unknown;
    created_at: string;
}

type RespostaDoCosmos =
    | { ok: true; pedidos: PedidoListado[] }
    | { ok: false; motivo: string; repetir: boolean };

async function consultarCosmos(url: string, token: string, tetoMs: number, f: typeof fetch): Promise<RespostaDoCosmos> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tetoMs);
    try {
        const res = await f(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
            signal: controller.signal,
        });
        if (res.status !== 200) {
            await res.body?.cancel().catch(() => { });
            // 5xx e 429 passam; 401, 403 e 404 se repetiriam iguais.
            return { ok: false, motivo: `o Cosmos respondeu HTTP ${res.status}`, repetir: res.status >= 500 || res.status === 429 };
        }
        // Lido com o timer ainda armado: o corpo também pode demorar.
        const corpo: unknown = await res.json().catch(() => null);
        if (!Array.isArray(corpo)) return { ok: false, motivo: 'o Cosmos respondeu num formato inesperado', repetir: false };
        return { ok: true, pedidos: corpo.filter(ehPedidoListado) };
    } catch (erro) {
        const abortado = erro instanceof Error && erro.name === 'AbortError';
        return { ok: false, motivo: abortado ? `o Cosmos não respondeu em ${tetoMs} ms` : 'o Cosmos ficou inalcançável', repetir: true };
    } finally {
        clearTimeout(timer);
    }
}

function ehPedidoListado(valor: unknown): valor is PedidoListado {
    if (!valor || typeof valor !== 'object') return false;
    const o = valor as Record<string, unknown>;
    return typeof o.external_id === 'string' && typeof o.origin === 'string' && typeof o.created_at === 'string';
}

/** O reenvio não cancelado mais recente criado desde `desde`, ou `null`. */
function maisRecente(reenvios: PedidoListado[], desde: number): PedidoListado | null {
    const vivos = reenvios
        .filter((o) => o.status !== 'cancelled' && !o.canceled_at)
        .map((o) => ({ o, criado: Date.parse(o.created_at) }))
        .filter(({ criado }) => Number.isFinite(criado) && criado >= desde)
        .sort((a, b) => b.criado - a.criado);
    return vivos[0]?.o ?? null;
}

async function reenvioNoDataMart(
    brand: SupportedBrand,
    numero: string,
    desde: Date,
    restante: number,
    consultar: NonNullable<DepsDoReenvioRecente['consultar']>,
): Promise<{ achado: Omit<ReenvioNoCosmos, 'fonte'> | null; motivo: string }> {
    if (restante < MIN_PRAZO_MS) return { achado: null, motivo: 'sem prazo para consultar' };
    try {
        const linhas = await consultar(sqlDoReenvioNaIntelipost(brand, numero, desde), {
            timeoutMs: Math.min(METABASE_TIMEOUT_MS, restante),
        });
        const remessas = linhas
            .filter((l) => typeof l[0] === 'string' && typeof l[1] === 'string')
            .map((l) => ({ external_id: String(l[0]), origin: 'resend', created_at: String(l[1]) }));
        // O mesmo filtro do Cosmos, por garantia: a lista de candidatos já é só do pedido.
        const achado = maisRecente(matchResendsOfOrder(remessas, numero), desde.getTime());
        return achado
            ? { achado: { externalId: achado.external_id, criadoEm: achado.created_at }, motivo: 'achou' }
            : { achado: null, motivo: 'sem reenvio do pedido (ele só recebe os novos com cerca de 1 h de atraso)' };
    } catch (erro) {
        return { achado: null, motivo: `sem resposta (${(erro instanceof Error ? erro.message : String(erro)).slice(0, 120)})` };
    }
}
