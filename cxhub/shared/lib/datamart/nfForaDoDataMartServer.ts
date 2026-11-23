import { nfNaIntelipostAoVivo } from '../intelipost/nfNaIntelipostServer';
import type { MarcaComIntelipost } from '../intelipost/gateway';
import { temNfNaShopify } from '../nfDaVenda';
import { nfNoMetacampoDaShopify } from '../shopify/buscarPedidoNoGateway';
import type { LeiturasDaNfForaDoDataMart } from './pedidoTipos';

/**
 * A NF de venda fora do Data Mart (2026-11-19), para quando ele não a tem: o Data Mart leva cerca de 1 h para receber
 * a NF da Intelipost, e nessa janela o pedido já faturado era recusado como "sem NF". Em ordem, cada uma só quando a
 * anterior não deu a NF:
 * 1. o metacampo `custom.nf_numero` da Shopify, só nas marcas que o preenchem (`MARCAS_COM_NF_NA_SHOPIFY`): responde em
 *    menos de 1 s;
 * 2. a Intelipost ao vivo.
 *
 * As duas pelo gateway, com até 4 s cada e nunca além do `prazo`. Quem decide o que as leituras querem
 * dizer é `derivarContextoDoPedido` (marcas sem Cosmos) ou `nfDoPedidoDoCosmos`.
 *
 * ⚠️ **Server-only** (lê as chaves do gateway): fora do barrel. Nunca lança.
 */

export interface DepsDaNfForaDoDataMart {
    metacampo?: typeof nfNoMetacampoDaShopify;
    intelipost?: typeof nfNaIntelipostAoVivo;
}

export async function lerNfForaDoDataMart(
    marca: MarcaComIntelipost,
    numeroDoPedido: string,
    prazo: number,
    deps: DepsDaNfForaDoDataMart = {},
): Promise<LeiturasDaNfForaDoDataMart> {
    const leituras: LeiturasDaNfForaDoDataMart = {};
    try {
        if (temNfNaShopify(marca)) {
            leituras.shopify = await (deps.metacampo ?? nfNoMetacampoDaShopify)(marca, numeroDoPedido, prazo);
            if (leituras.shopify.ok && leituras.shopify.dados) return leituras;
        }
        leituras.intelipost = await (deps.intelipost ?? nfNaIntelipostAoVivo)(marca, numeroDoPedido, prazo);
    } catch (erro) {
        // As leituras não lançam; este `catch` é para um defeito nunca derrubar o registro. O que faltou fica sem
        // resposta, e a conferência não conclui que o pedido não tem NF.
        console.error(`[NF fora do Data Mart] Falha inesperada no pedido ${numeroDoPedido} (${marca}):`, erro);
        if (temNfNaShopify(marca) && !leituras.shopify) leituras.shopify = { ok: false, motivo: 'falha inesperada' };
        if (!leituras.intelipost) leituras.intelipost = { ok: false, motivo: 'falha inesperada' };
    }
    return leituras;
}
