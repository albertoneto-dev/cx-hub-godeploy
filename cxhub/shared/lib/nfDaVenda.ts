import type { MarcaCxHub } from './constants';

/**
 * A NF de venda fora do Data Mart (2026-11-19): o que é comum à Shopify e à Intelipost ao vivo, puro. O Data Mart leva
 * cerca de 1 h para receber a NF da Intelipost, e nessa janela o pedido já faturado era recusado como "sem NF" (a
 * pergunta do Nai na thread dos reembolsos de cancelamento: "só puxa se tiver NF?"). Antes de dizer que não há NF, o
 * servidor procura nas outras fontes: o metacampo da Shopify e a Intelipost ao vivo, as duas pelo integrations-gateway.
 */

/** Onde a NF foi achada: no Data Mart (a Intelipost do gold ou, na Ápice, o Tiny), no metacampo da Shopify ou na Intelipost ao vivo. */
export type OrigemDaNf = 'datamart' | 'shopify' | 'intelipost';

/** O teto de cada consulta fora do Data Mart: a agente espera no formulário, e o Data Mart já respondeu antes. */
export const NF_FORA_DO_DATA_MART_TIMEOUT_MS = 4_000;

/** Abaixo disto a consulta nem sai, como no Data Mart (`pedidoServer.ts`): o timeout só gastaria o prazo. */
export const NF_FORA_DO_DATA_MART_MIN_PRAZO_MS = 500;

/**
 * As marcas cuja loja guarda a NF no metacampo `custom.nf_numero` (o XML fica em `custom.nf_xml`). Medido pelo
 * integrations-gateway em 19/11/2026, nos 50 pedidos de 05 a 15/11 de cada marca: o metacampo estava em 100% dos
 * despachados de Lescent, Kokeshi, BySamia, Auá, Barbours, Rituária e Yenzah, e em nenhum da Ápice (0 de 42), da
 * Denavita (0 de 46) e da Gobeaute (0 de 32). Nenhum dos 71 cancelados tinha. As outras nem consultam a Shopify: seria
 * uma espera à toa, e a falta dela não pode impedir a conclusão de que o pedido não tem NF.
 */
export const MARCAS_COM_NF_NA_SHOPIFY: ReadonlySet<MarcaCxHub> = new Set<MarcaCxHub>([
    'lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria', 'yenzah',
]);

export function temNfNaShopify(marca: string): boolean {
    return MARCAS_COM_NF_NA_SHOPIFY.has(marca as MarcaCxHub);
}

/**
 * A NF como as planilhas e o Cosmos a guardam: só dígitos, sem os zeros à esquerda, até 9 dígitos (o número da NF-e).
 * A Intelipost guarda 9 dígitos (`001834451`). Vazio, `-`, zero ou texto viram `null`.
 */
export function normalizarNf(valor: unknown): string | null {
    const texto = valor == null ? '' : String(valor).trim().replace(/^0+(?=\d)/, '');
    return /^\d{1,9}$/.test(texto) && texto !== '0' ? texto : null;
}
