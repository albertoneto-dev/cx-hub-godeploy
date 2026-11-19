import type { SupportedBrand } from '../constants';
import { consultarDataMart, literalSql, METABASE_TIMEOUT_MS } from '../metabase/index';
import { normalizarNf, type OrigemDaNf } from '../nfDaVenda';
import { lerNfForaDoDataMart, type DepsDaNfForaDoDataMart } from './nfForaDoDataMartServer';
import { digitosDoPedido, nfAchadaForaDoDataMart } from './pedido';
import type { DepsDaLeitura } from './pedidoServer';

/**
 * A NF de venda das marcas do Cosmos pela Intelipost, quando quem chama não a manda (2026-11-17).
 *
 * Desde a virada do Cosmos para o V3 (21/10/2026), o pedido criado depois dela vem do Cosmos sem `invoice_number`. A
 * tela (e a Central de Tickets) mandava `numeroNF`/`invoiceNumber` `"-"` ou vazio, e a NF ficou fora da planilha e da
 * gold em 88 a 97% dos reenvios e reembolsos das 6 marcas do Cosmos com pedido de 26/10 em diante. A Intelipost tinha a
 * NF em 92% deles. Vale a da primeira remessa (a venda original; as seguintes são reenvios), a mesma regra da ADR-018.
 *
 * Sem a NF no Data Mart, que leva cerca de 1 h para receber a da Intelipost, ela sai do metacampo da Shopify e, depois,
 * da Intelipost ao vivo (`nfDoPedidoDoCosmos`, 2026-11-19).
 *
 * ⚠️ **Server-only** (lê o Data Mart com a chave do Metabase, e o gateway com as dele): fora do barrel. Importe por
 * `@shared/lib/datamart/nfDaIntelipostServer`.
 */

/** O `brand_code` da Intelipost de cada marca do Cosmos: só a BySamia é diferente do id do CX Hub. */
export const BRAND_CODE_NA_INTELIPOST: Record<SupportedBrand, string> = {
    lescent: 'lescent',
    kokeshi: 'kokeshi',
    bysamia: 'by_samia',
    aua: 'aua',
    barbours: 'barbours',
    rituaria: 'rituaria',
};

/** A NF que não é NF: o que a tela manda quando o Cosmos não a tem (`-`, vazio) e o que já apareceu digitado (`na`). */
export function nfAusente(nf: string | null | undefined): boolean {
    const texto = (nf ?? '').trim().toLowerCase();
    return texto === '' || texto === '-' || texto === 'na' || texto === 'n/a' || /^0+$/.test(texto);
}

/** As remessas do pedido, da primeira à última, pelo índice `(shopify_order_number, brand_code)`. Medida: 0,03 s. */
export function sqlDaNfNaIntelipost(brandCode: string, numero: string): string {
    return `select invoice_number from gold.fct_intelipost_orders
where shopify_order_number = ${literalSql(numero)} and brand_code = ${literalSql(brandCode)}
order by created_iso limit 10`;
}

/** Abaixo disto a consulta nem sai, como na conferência (`pedidoServer.ts`). */
const MIN_PRAZO_MS = 500;

/**
 * A NF da primeira remessa, sem os zeros à esquerda (a Intelipost guarda 9 dígitos, `001834451`; a planilha e o Cosmos
 * usam `1834451`). **Nunca lança**: sem remessa, sem NF, sem prazo ou com o Data Mart fora, devolve `null`, e quem grava
 * fica com o que veio — o registro nunca depende do Data Mart.
 */
export async function nfDaIntelipost(
    marca: SupportedBrand,
    numeroPedido: string | null | undefined,
    prazo: number,
    deps: DepsDaLeitura = {},
): Promise<string | null> {
    const numero = digitosDoPedido(numeroPedido);
    const brandCode = BRAND_CODE_NA_INTELIPOST[marca];
    if (!numero || !brandCode) return null;
    const agora = deps.agora ?? Date.now;
    const restante = prazo - agora();
    if (restante < MIN_PRAZO_MS) return null;
    try {
        const linhas = await (deps.consultar ?? consultarDataMart)(sqlDaNfNaIntelipost(brandCode, numero), {
            timeoutMs: Math.min(METABASE_TIMEOUT_MS, restante),
        });
        return normalizarNf(linhas[0]?.[0]);
    } catch (erro) {
        console.warn(`[NF da Intelipost] Sem resposta para o pedido ${numero} (${marca}): `
            + (erro instanceof Error ? erro.message : String(erro)).slice(0, 200));
        return null;
    }
}

export interface DepsDaNfDoCosmos extends DepsDaLeitura, DepsDaNfForaDoDataMart {}

/**
 * A NF de venda do pedido de uma marca do Cosmos, em todas as fontes, nesta ordem: o Data Mart (`nfDaIntelipost`), o
 * metacampo `custom.nf_numero` da Shopify (as 6 o preenchem) e a Intelipost ao vivo — cada uma só quando a anterior não
 * deu a NF, e todas dentro do `prazo`. **Nunca lança**: sem NF em nenhuma, ou sem resposta, devolve `null`, e quem grava
 * fica com a NF que veio.
 */
export async function nfDoPedidoDoCosmos(
    marca: SupportedBrand,
    numeroPedido: string | null | undefined,
    prazo: number,
    deps: DepsDaNfDoCosmos = {},
): Promise<{ nf: string; origem: OrigemDaNf } | null> {
    const doDataMart = await nfDaIntelipost(marca, numeroPedido, prazo, deps);
    if (doDataMart) return { nf: doDataMart, origem: 'datamart' };
    const numero = digitosDoPedido(numeroPedido);
    if (!numero) return null;
    return nfAchadaForaDoDataMart(await lerNfForaDoDataMart(marca, numero, prazo, deps));
}
