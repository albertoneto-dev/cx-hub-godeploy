import { buscarPedidoDaShopifyNoDataMart } from '../datamart/pedidoDaShopifyServer';
import { METABASE_TIMEOUT_MS } from '../metabase/index';
import { buscarPedidoNoGateway, type ResultadoDaBuscaNoGateway } from './buscarPedidoNoGateway';
import type { MarcaNoGateway } from './gateway';

/**
 * O pedido das marcas que este app lê pelo integrations-gateway (as sem Cosmos e a Rituária, `MarcaNoGateway`): o
 * gateway primeiro — o pedido ao vivo, sem o atraso de carga do Data Mart — e, quando ele não o acha ou falha, o Data
 * Mart (`pedidoDaShopifyServer.ts`). O gateway só enxerga os últimos 60 dias de pedidos; o Data Mart, todos. É o que a
 * rota `/api/shopify/orders` (a tela) e a rota do bot chamam. Decisão deste app (`cxhub/ORIGEM.md`, 2026-11-12).
 *
 * Não achou em nenhum dos dois ⇒ vale o desfecho do gateway: o "não encontrado", ou a falha dele com o status que a
 * rota da tela responde. Com `prazo` (o bot), o Data Mart só é lido se a consulta dele (até 5 s) ainda cabe.
 *
 * ⚠️ Server-only. O pedido tem nome, telefone e endereço da cliente: nunca vai ao log.
 */
export async function buscarPedidoNoGatewayOuNoDataMart(
    marca: MarcaNoGateway,
    orderId: string,
    timeoutMs: number,
    prazo?: number,
): Promise<ResultadoDaBuscaNoGateway> {
    const noGateway = await buscarPedidoNoGateway(marca, orderId, timeoutMs, prazo);
    if (noGateway.tipo === 'achado') return noGateway;
    if (prazo !== undefined && prazo - Date.now() < METABASE_TIMEOUT_MS) return noGateway;

    const noDataMart = await buscarPedidoDaShopifyNoDataMart(marca, orderId);
    if (noDataMart.tipo !== 'achado') return noGateway;
    console.log(`[Pedido no gateway] ${marca}: ${noGateway.tipo === 'falha' ? `gateway com falha (${noGateway.status})` : 'fora da janela de 60 dias do gateway'}; o pedido veio do Data Mart`);
    return { tipo: 'achado', pedido: noDataMart.pedido };
}
