import { ehMarcaSemCosmosComPlanilha } from '../constants';
import { derivarContextoDoPedido, digitosDoPedido } from './pedido';
import { lerPedidoNoDataMart } from './pedidoServer';
import type { Conferencia } from './pedidoTipos';

/**
 * A conferência do pedido das marcas sem Cosmos no Data Mart (ADR-018): a leitura (`pedidoServer.ts`) e as regras
 * (`pedido.ts`) juntas, para os `process*` e para a rota `GET /api/datamart/order-context`.
 *
 * ⚠️ **Server-only** (lê o Data Mart com a chave do Metabase): fora do barrel. Importe por
 * `@shared/lib/datamart/conferenciaServer`.
 */

/**
 * O teto da conferência. Ela corre junto do dedup (as duas só leem) e, no reenvio, dentro do prazo do Cosmos
 * (`TIMEOUT`), que essas marcas nunca chamam: por isso não alonga o pior caso das rotas (ADR-017). O caminho comum leva
 * ~1,5 s (três etapas de ~0,5 s pelo Metabase); a busca do Tiny por data (pedido sem o id na Intelipost) leva ~7,5 s
 * por CD e só cabe porque os dois CDs são lidos em paralelo.
 */
export const JANELA_CONFERENCIA_MS = 12_000;

/** O instante-limite de uma conferência que começa agora: a janela, ou o prazo de quem chama, se acabar antes. */
export function prazoDaConferencia(prazoDeQuemChama?: number): number {
    const janela = Date.now() + JANELA_CONFERENCIA_MS;
    return prazoDeQuemChama === undefined ? janela : Math.min(janela, prazoDeQuemChama);
}

/**
 * Lê o pedido no Data Mart e deriva o que o servidor grava (NF, CD, valor) e o que a tela mostra. **Nunca lança**: o que
 * não pôde ser lido volta "não conferido", e quem grava usa o que veio de quem chamou — o registro nunca depende do
 * Data Mart.
 */
export async function conferirPedidoNoDataMart(
    marca: string,
    numeroPedido: string | null | undefined,
    prazo: number,
): Promise<Conferencia> {
    if (!ehMarcaSemCosmosComPlanilha(marca)) return { tipo: 'nao_se_aplica' };
    const numero = digitosDoPedido(numeroPedido);
    if (!numero) return { tipo: 'nao_conferido', motivo: 'o número do pedido não dá para consultar no Data Mart' };
    try {
        return { tipo: 'lido', contexto: derivarContextoDoPedido(await lerPedidoNoDataMart(marca, numero, prazo)) };
    } catch (erro) {
        // A leitura não lança; este `catch` é para uma regra com defeito nunca derrubar o registro da solicitação.
        console.error(`[Conferência] Falha inesperada ao conferir o pedido ${numero} (${marca}):`, erro);
        return { tipo: 'nao_conferido', motivo: 'falha inesperada na conferência' };
    }
}
