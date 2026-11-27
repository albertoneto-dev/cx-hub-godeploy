import { SUFIXO_DO_PEDIDO, ehMarcaSemCosmos } from '../constants';
import { lerNumeroDaLoja, nomeDoGc } from '../pedido/numeroDaLoja';
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
 * O pedido da Gocreators (`GC{n}{sigla}`, decisão deste app em 2026-11-27) é procurado só pelo nome inteiro, em toda
 * marca: os dígitos dele colidem com o `#n` antigo da mesma loja. Sem a sigla, vale a da marca. O GC fora do formato
 * (`lerNumeroDaLoja` devolve `null`) não é procurado.
 *
 * ⚠️ Na Denavita, o número que a Intelipost mostra é o do **Bling**, não o da loja: digitado aqui, ele pode casar com
 * outro pedido `#n`. A tela mostra o nome do pedido achado para a agente conferir.
 */
export function nomesDoPedidoNaShopify(marca: MarcaNoGateway, pedido: string): string[] {
    const numero = lerNumeroDaLoja(pedido, marca);
    if (!numero) return [];
    if (numero.prefixo === 'GC') return [nomeDoGc(numero)];
    const { digitos } = numero;
    if (!ehMarcaSemCosmos(marca)) return [digitos];
    return [`SH${digitos}${SUFIXO_DO_PEDIDO[marca]}`, digitos];
}
