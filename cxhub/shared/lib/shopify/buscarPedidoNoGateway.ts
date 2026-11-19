import type { ShopifyOrder } from '../../types/index';
import type { Leitura } from '../datamart/pedidoTipos';
import { NF_FORA_DO_DATA_MART_MIN_PRAZO_MS, NF_FORA_DO_DATA_MART_TIMEOUT_MS } from '../nfDaVenda';
import {
    CONSULTA_DA_NF,
    CONSULTA_DO_PEDIDO,
    escolherPedido,
    nfDoMetacampo,
    pausaDepoisDoLimite,
    pedidoDoGatewayParaShopify,
    urlDoGateway,
    type MarcaNoGateway,
    type PedidoDoGateway,
} from './gateway';
import { nomesDoPedidoNaShopify } from './nomeDoPedido';

/**
 * A busca do pedido de toda marca do CX Hub (`MarcaNoGateway`) no **integrations-gateway**, do lado do servidor, com o
 * nome da marca na URL: a rota `/api/shopify/orders` (a tela) e a rota do bot (ADR-015, só as sem Cosmos) a chamam pelo
 * `buscarPedidoNoGatewayOuNoDataMart`, que tem o Data Mart de reserva (decisão deste app). Nas sem Cosmos procura
 * `SH{n}{sufixo}` e depois só os dígitos (o `#n` antigo); nas 6 do Cosmos, só os dígitos. Confere o nome do resultado
 * (o filtro é tolerante) e devolve o pedido no formato REST de sempre, que o `adaptShopifyOrder` lê. O gateway só
 * enxerga os últimos 60 dias de pedidos (falta o `read_all_orders` nas lojas).
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
    consulta: string = CONSULTA_DO_PEDIDO,
): Promise<{ res: Response; corpo: RespostaDoGateway | null }> {
    if (timeoutMs <= 0) throw new PrazoEsgotado('prazo esgotado antes da consulta');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${urlDoGateway()}/shopify/${marca}/graphql`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: consulta, variables: { q: `name:${nome}` } }),
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
        console.error(`${LOG} INTEGRATIONS_GATEWAY_READ_KEY ausente: a busca do pedido na Shopify é pelo integrations-gateway, em toda marca`);
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

/**
 * A NF do metacampo `custom.nf_numero` do pedido, para a conferência da NF fora do Data Mart (2026-11-19): pede só o
 * nome e o metacampo (`CONSULTA_DA_NF`), sem dado da cliente, com o teto de 4 s (`NF_FORA_DO_DATA_MART_TIMEOUT_MS`).
 * Procura só o primeiro nome de `nomesDoPedidoNaShopify` (`SH{n}{sufixo}` nas sem Cosmos, os dígitos nas do Cosmos): o
 * `#n` antigo é de antes do metacampo e passa dos 60 dias que o gateway enxerga, e a segunda busca só gastaria o prazo.
 * O `escolherPedido` confere o nome, então o reenvio `SH…-R-1`, que vem junto no filtro com a NF dele, não vale.
 *
 * Nunca lança. `{ ok: true, dados: null }` só quando o gateway respondeu: o pedido não está lá, ou está sem o
 * metacampo. Sem a chave, sem prazo, com erro HTTP ou do GraphQL, ou sem resposta a tempo, volta `{ ok: false }` com o
 * motivo, e a conferência não conclui que o pedido não tem NF.
 */
export async function nfNoMetacampoDaShopify(
    marca: MarcaNoGateway,
    pedido: string,
    prazo: number,
    agora: () => number = Date.now,
): Promise<Leitura<string | null>> {
    const falhou = (motivo: string): Leitura<string | null> => {
        console.warn(`${LOG} ${marca}: a NF do metacampo do pedido ${pedido} ficou sem resposta (${motivo})`);
        return { ok: false, motivo };
    };
    const chave = process.env.INTEGRATIONS_GATEWAY_READ_KEY;
    if (!chave) return falhou('sem a INTEGRATIONS_GATEWAY_READ_KEY');
    const nome = nomesDoPedidoNaShopify(marca, pedido)[0];
    if (!nome) return falhou('número do pedido sem dígitos');
    const prazoDaConsulta = () => Math.min(NF_FORA_DO_DATA_MART_TIMEOUT_MS, prazo - agora());
    if (prazoDaConsulta() < NF_FORA_DO_DATA_MART_MIN_PRAZO_MS) return falhou('prazo esgotado antes da consulta');

    try {
        let { res, corpo } = await consultarGateway(marca, chave, nome, prazoDaConsulta(), CONSULTA_DA_NF);
        // O limite de taxa da chave: uma nova tentativa só, e só se a pausa e a consulta couberem no prazo.
        if (res.status === 429) {
            const pausa = pausaDepoisDoLimite(res.headers.get('retry-after'));
            if (agora() + pausa + NF_FORA_DO_DATA_MART_MIN_PRAZO_MS > prazo) return falhou('HTTP 429, sem prazo para a nova tentativa');
            await new Promise((resolve) => setTimeout(resolve, pausa));
            ({ res, corpo } = await consultarGateway(marca, chave, nome, prazoDaConsulta(), CONSULTA_DA_NF));
        }
        if (!res.ok) return falhou(`HTTP ${res.status}`);
        if (!corpo) return falhou('resposta 200 sem JSON');
        if (corpo.errors?.length) return falhou('erro do GraphQL');

        const pedidos = (corpo.data?.orders?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));
        const achado = escolherPedido(pedidos, nome);
        return { ok: true, dados: achado ? nfDoMetacampo(achado) : null };
    } catch (erro) {
        return falhou(erro instanceof Error && erro.name === 'AbortError' ? 'sem resposta no prazo' : 'falha de rede');
    }
}
