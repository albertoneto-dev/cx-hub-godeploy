import type { ShopifyOrder } from '../../types/index';
import {
    CONSULTA_DO_PEDIDO,
    URL_DO_GATEWAY,
    escolherPedido,
    pausaDepoisDoLimite,
    pedidoDoGatewayParaShopify,
    type MarcaNoGateway,
    type PedidoDoGateway,
} from './gateway';
import { nomesDoPedidoNaShopify } from './nomeDoPedido';

/**
 * A busca do pedido das marcas sem Cosmos (ADR-013) e da Rituária (`MarcaNoGateway`) no **integrations-gateway**, do
 * lado do servidor: a rota `/api/shopify/orders` (a tela) e a rota do bot (ADR-015, só as sem Cosmos) a chamam pelo
 * `buscarPedidoNoGatewayOuNoDataMart`, que tem o Data Mart de reserva (decisão deste app). Procura `SH{n}{sufixo}` e
 * depois só os dígitos (o `#n` antigo; na Rituária, só os dígitos), confere o nome do resultado (o filtro é tolerante) e
 * devolve o pedido no formato REST de sempre, que o `adaptShopifyOrder` lê. O gateway só enxerga os últimos 60 dias de
 * pedidos (falta o `read_all_orders` nas lojas).
 *
 * Nunca lança: a falha volta com o status HTTP que a rota da tela responde (`500` sem chave ou na rede, `502` quando o
 * gateway responde errado, `504` no prazo) e com a mensagem dela.
 *
 * ⚠️ Server-only (lê a `INTEGRATIONS_GATEWAY_READ_KEY`), fora do barrel. O pedido tem nome, telefone e endereço da
 * cliente: nunca vai ao log.
 */

export type ResultadoDaBuscaNoGateway =
    | { tipo: 'achado'; pedido: ShopifyOrder }
    | { tipo: 'nao_encontrado' }
    | { tipo: 'falha'; status: 500 | 502 | 504; erro: string };

interface RespostaDoGateway {
    data?: { orders?: { edges?: Array<{ node?: PedidoDoGateway | null }> | null } | null } | null;
    errors?: Array<{ message?: string }>;
}

const LOG = '[Shopify Gateway]';

class PrazoEsgotado extends Error {
    name = 'AbortError';
}

/** Uma consulta ao gateway, com o prazo dela. Estourou o prazo ⇒ lança `AbortError`. */
async function consultarGateway(
    marca: MarcaNoGateway,
    chave: string,
    nome: string,
    timeoutMs: number,
): Promise<{ res: Response; corpo: RespostaDoGateway | null }> {
    if (timeoutMs <= 0) throw new PrazoEsgotado('prazo esgotado antes da consulta');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${URL_DO_GATEWAY}/shopify/${marca}/graphql`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: CONSULTA_DO_PEDIDO, variables: { q: `name:${nome}` } }),
            signal: controller.signal,
        });
        const corpo = await res.json().catch(() => null) as RespostaDoGateway | null;
        return { res, corpo };
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * @param timeoutMs o prazo de **cada** consulta.
 * @param prazo instante-limite da busca inteira (opcional): nenhuma consulta passa dele, e a nova tentativa depois do
 *   `429` só acontece se a pausa couber. É o que a rota do bot usa para a busca caber no `maxDuration`.
 */
export async function buscarPedidoNoGateway(
    marca: MarcaNoGateway,
    orderId: string,
    timeoutMs: number,
    prazo?: number,
): Promise<ResultadoDaBuscaNoGateway> {
    const chave = process.env.INTEGRATIONS_GATEWAY_READ_KEY;
    if (!chave) {
        console.error(`${LOG} INTEGRATIONS_GATEWAY_READ_KEY ausente: a busca das marcas sem Cosmos e da Rituária é pelo integrations-gateway`);
        return { tipo: 'falha', status: 500, erro: 'Shopify gateway key not configured' };
    }

    const prazoDaConsulta = () => (prazo === undefined ? timeoutMs : Math.min(timeoutMs, prazo - Date.now()));

    try {
        for (const nome of nomesDoPedidoNaShopify(marca, orderId)) {
            console.log(`${LOG} ${marca}: buscando ${nome}`);
            let { res, corpo } = await consultarGateway(marca, chave, nome, prazoDaConsulta());
            // Limite de taxa da chave: uma nova tentativa só, depois da pausa. Se persistir, vira 502 como os outros
            // erros — e a tela, que não distingue erro de "não encontrado", diria que o pedido não existe.
            if (res.status === 429) {
                const pausa = pausaDepoisDoLimite(res.headers.get('retry-after'));
                if (prazo !== undefined && Date.now() + pausa >= prazo) {
                    throw new PrazoEsgotado('a pausa do 429 não cabe no prazo');
                }
                console.warn(`${LOG} ${marca}: 429, nova tentativa em ${pausa} ms`);
                await new Promise((resolve) => setTimeout(resolve, pausa));
                ({ res, corpo } = await consultarGateway(marca, chave, nome, prazoDaConsulta()));
            }

            if (!res.ok) {
                console.error(`${LOG} ${marca}: HTTP ${res.status}`);
                return { tipo: 'falha', status: 502, erro: `Shopify gateway error: ${res.status}` };
            }
            // 200 sem JSON não é "pedido não encontrado": a tela diria à agente que o pedido não existe.
            if (!corpo) {
                console.error(`${LOG} ${marca}: resposta 200 sem JSON`);
                return { tipo: 'falha', status: 502, erro: 'Shopify gateway invalid response' };
            }
            // O GraphQL responde 200 com `errors` (inclusive campo sem permissão): o status HTTP não basta.
            if (corpo.errors?.length) {
                console.error(`${LOG} ${marca}: ${corpo.errors.map((e) => e.message).join('; ')}`);
                return { tipo: 'falha', status: 502, erro: 'Shopify gateway query error' };
            }

            const pedidos = (corpo.data?.orders?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));
            const pedido = escolherPedido(pedidos, nome);
            if (pedido) return { tipo: 'achado', pedido: pedidoDoGatewayParaShopify(pedido) };
        }
        return { tipo: 'nao_encontrado' };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            console.warn(`${LOG} ${marca}: o gateway não respondeu no prazo`);
            return { tipo: 'falha', status: 504, erro: 'Request timeout' };
        }
        console.error(`${LOG} ${marca}: falha de rede:`, error instanceof Error ? error.message : error);
        return { tipo: 'falha', status: 500, erro: 'Failed to fetch from Shopify' };
    }
}
