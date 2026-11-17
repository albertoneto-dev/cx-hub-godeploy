import { SUFIXO_DO_PEDIDO, ehMarcaSemCosmos } from '../constants';
import type { MarcaNoGateway } from './gateway';

/**
 * Os nomes a procurar na Shopify, em ordem, para o número de pedido de uma marca sem Cosmos (ADR-013), em que a
 * Shopify é a única fonte: `SH{n}{sufixo}` (o formato atual: `SH1629891AP`, `SH3287YE`, `SH416884DN`) e, se não achar,
 * só os dígitos, que é como o filtro `name:` acha o pedido antigo `#n` (`#1475900` na Ápice antes de 16/09/2026; o
 * histórico da Denavita). A agente pode digitar `SH…AP`, `#n` ou só o número: os dígitos decidem. Sem dígito nenhum,
 * não há o que buscar.
 *
 * Nas 6 marcas do Cosmos (que também passam pelo gateway, `MarcaNoGateway`), só os dígitos: é o que a tela manda (o
 * `sanitizeOrderId` tira o resto), a mesma busca que o `name=` do REST da loja fazia, e o `escolherPedido` confere os
 * dígitos do nome achado. Assim o reenvio do Cosmos (`SH1452727RT-R-1`, um pedido da loja desde 01/11), que o filtro
 * também devolve, não é escolhido no lugar do original: os dígitos dele são outros.
 *
 * ⚠️ Na Denavita, o número que a Intelipost mostra é o do **Bling**, não o da loja: digitado aqui, ele pode casar com
 * outro pedido `#n`. A tela mostra o nome do pedido achado para a agente conferir.
 */
export function nomesDoPedidoNaShopify(marca: MarcaNoGateway, pedido: string): string[] {
    const digitos = pedido.replace(/\D/g, '');
    if (!digitos) return [];
    if (!ehMarcaSemCosmos(marca)) return [digitos];
    return [`SH${digitos}${SUFIXO_DO_PEDIDO[marca]}`, digitos];
}
