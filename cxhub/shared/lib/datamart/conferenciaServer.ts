import { ehMarcaSemCosmosComPlanilha } from '../constants';
import { lerNfForaDoDataMart } from './nfForaDoDataMartServer';
import { dataMartDeuANf, derivarContextoDoPedido, nfAchadaForaDoDataMart, numeroDasLeituras } from './pedido';
import { lerPedidoNoDataMart } from './pedidoServer';
import type { Conferencia, LeiturasDaNfForaDoDataMart } from './pedidoTipos';

/**
 * A conferência do pedido das marcas sem Cosmos no Data Mart (ADR-018): a leitura (`pedidoServer.ts`), a NF fora do
 * Data Mart quando ele não a tem (`nfForaDoDataMartServer.ts`, 2026-11-19) e as regras (`pedido.ts`) juntas, para os
 * `process*` e para a rota `GET /api/datamart/order-context`.
 *
 * ⚠️ **Server-only** (lê o Data Mart com a chave do Metabase, e o gateway com as dele): fora do barrel. Importe por
 * `@shared/lib/datamart/conferenciaServer`.
 */

/**
 * O teto da conferência. Ela corre junto do dedup (as duas só leem) e, no reenvio, dentro do prazo do Cosmos
 * (`TIMEOUT`), que essas marcas nunca chamam: por isso não alonga o pior caso das rotas (ADR-017). O caminho comum leva
 * ~1,5 s (três etapas de ~0,5 s pelo Metabase); a busca do Tiny por data (pedido sem o id na Intelipost) leva ~7,5 s
 * por CD e só cabe porque os dois CDs são lidos em paralelo. Sem a NF no Data Mart, o metacampo da Shopify e a
 * Intelipost ao vivo usam o que sobra, até 4 s cada; o que não couber fica sem resposta, e a NF, `desconhecida`.
 */
export const JANELA_CONFERENCIA_MS = 12_000;

/** O instante-limite de uma conferência que começa agora: a janela, ou o prazo de quem chama, se acabar antes. */
export function prazoDaConferencia(prazoDeQuemChama?: number): number {
    const janela = Date.now() + JANELA_CONFERENCIA_MS;
    return prazoDeQuemChama === undefined ? janela : Math.min(janela, prazoDeQuemChama);
}

/** O que as leituras de fora do Data Mart deram, para o log: a fonte da NF, "sem NF" ou os motivos da falta de resposta. */
function resumoDeFora(fora: LeiturasDaNfForaDoDataMart): string {
    const achada = nfAchadaForaDoDataMart(fora);
    if (achada) return `NF ${achada.nf} achada (${achada.origem})`;
    const falhas = (['shopify', 'intelipost'] as const).flatMap((fonte) => {
        const leitura = fora[fonte];
        return leitura && !leitura.ok ? [`${fonte}: ${leitura.motivo}`] : [];
    });
    return falhas.length > 0 ? `sem resposta (${falhas.join('; ')})` : 'sem NF';
}

/**
 * Lê o pedido no Data Mart e deriva o que o servidor grava (NF, CD, valor) e o que a tela mostra. Sem a NF no Data Mart,
 * procura no metacampo da Shopify e na Intelipost ao vivo antes de derivar: só elas respondendo sem NF a prova do Data
 * Mart vale como "ausente". **Nunca lança**: o que não pôde ser lido volta "não conferido", e quem grava usa o que veio
 * de quem chamou — o registro nunca depende do Data Mart.
 */
export async function conferirPedidoNoDataMart(
    marca: string,
    numeroPedido: string | null | undefined,
    prazo: number,
): Promise<Conferencia> {
    if (!ehMarcaSemCosmosComPlanilha(marca)) return { tipo: 'nao_se_aplica' };
    // Os dígitos no SH; o GC inteiro (`GC104306YE`), que as leituras buscam pelo nome (decisão de 2026-11-27).
    const numero = numeroDasLeituras(numeroPedido, marca);
    if (!numero) return { tipo: 'nao_conferido', motivo: 'o número do pedido não dá para consultar no Data Mart' };
    try {
        const leituras = await lerPedidoNoDataMart(marca, numero, prazo);
        if (!dataMartDeuANf(leituras)) {
            leituras.foraDoDataMart = await lerNfForaDoDataMart(marca, numero, prazo);
            console.log(`[Conferência] ${marca} ${numero}: sem NF no Data Mart; fora dele, ${resumoDeFora(leituras.foraDoDataMart)}`);
        }
        return { tipo: 'lido', contexto: derivarContextoDoPedido(leituras) };
    } catch (erro) {
        // A leitura não lança; este `catch` é para uma regra com defeito nunca derrubar o registro da solicitação.
        console.error(`[Conferência] Falha inesperada ao conferir o pedido ${numero} (${marca}):`, erro);
        return { tipo: 'nao_conferido', motivo: 'falha inesperada na conferência' };
    }
}
