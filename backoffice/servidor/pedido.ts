// O pedido do caso no Data Mart: gold.fct_shopify_orders (total, frete, desconto) e gold.fct_shopify_order_items (as
// linhas), com os itens de cada kit (gold.fct_shopify_order_items_exploded_priced_mat). É de onde saem os checkboxes do
// drawer (escopo e valor do reembolso; SKUs do reenvio) e o teto do valor.
//
// O de-para é o mesmo que o dbt usa para a coorte (rr_brand_shopify e o número SH<n>XX → n): a loja pela sigla da marca
// e o order_number pelos dígitos do pedido. A Gobeaute não está na tabela (a loja dela não é ingerida): sem pedido.

import type { CasoGold } from "../shared/tipos";
import { montarPedido, type PedidoDoCaso } from "../shared/itens";
import type { ConfigMetabase } from "./config";
import type { Busca } from "./contexto";
import { consultar, literalSql } from "./metabase";

export const LOJA_DA_SIGLA: Readonly<Record<string, string>> = {
  LE: "lescent", KO: "kokeshi", BS: "by_samia", AU: "aua", BB: "barbours", RT: "rituaria", AP: "apice", YE: "yenzah", DV: "denavita",
};

// "SH2779726BB" → 2779726; "#1234" → 1234 (o número antigo). Fora disso, null.
export function numeroDaLoja(numeroPedido: unknown): string | null {
  const limpo = String(numeroPedido ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const n = limpo.replace(/^SH([0-9]+)[A-Z]{2}$/, "$1");
  return /^[0-9]{1,18}$/.test(n) ? n : null;
}

// Os itens de cada kit vêm num texto só: um item por registro (separador chr(30)), e em cada um o SKU, as unidades, o
// peso e o nome (separador chr(31), que nome nenhum tem). O peso, em centavos, é o preço de catálogo (os produtos avulsos
// da Shopify) × as unidades; sem ele, o rateio do dbt (allocated_revenue). `explodido` diz se o dbt já explodiu o
// pedido: sem isso, não dá para saber o que é kit (só os pedidos das últimas horas).
export const SEP_ITEM = String.fromCharCode(30);
export const SEP_CAMPO = String.fromCharCode(31);

export function sqlDoPedido(loja: string, numero: string): string {
  const doCatalogo = (coluna: string) =>
    `(select min(p.${coluna}) from silver.dim_shopify_products_individual p where p.brand = e.brand and p.sku = e.effective_sku)`;
  const peso = `round(coalesce(nullif(${doCatalogo("price")}, 0) * e.component_units, nullif(e.allocated_revenue, 0), 0) * 100)::bigint::text`;
  const item = `e.effective_sku || chr(31) || round(e.component_units)::int::text || chr(31) || ${peso} || chr(31) || coalesce(${doCatalogo("product_title")}, '')`;
  return "select o.order_name, o.value_total, o.value_shipment, o.value_discount, "
    // O id vai como texto: os da Shopify já passam de 10^13, e o JSON do Metabase não guarda inteiro acima de 2^53.
    + "i.line_item_id::text as line_item_id, i.sku, coalesce(nullif(i.name, ''), i.title) as nome, i.quantity, i.price, "
    + `(select string_agg(${item}, chr(30) order by e.mat_id) `
    + "from gold.fct_shopify_order_items_exploded_priced_mat e "
    + "where e.order_id = o.order_id and e.line_item_id = i.line_item_id and e.is_kit_component) as componentes, "
    + "exists (select 1 from gold.fct_shopify_order_items_exploded_priced_mat e where e.order_id = o.order_id) as explodido "
    + "from gold.fct_shopify_orders o "
    + "left join gold.fct_shopify_order_items i on i.order_id = o.order_id "
    + `where o.order_id = (select order_id from gold.fct_shopify_orders where brand = ${literalSql(loja)} and order_number = ${numero} `
    + "order by created_at desc limit 1) "
    + "order by i.line_item_id";
}

export type PedidoNoDataMart = { pedido: PedidoDoCaso | null; erro: string | null };

const numero = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

export async function pedidoDoCaso(m: ConfigMetabase, f: Busca, caso: CasoGold): Promise<PedidoNoDataMart> {
  const loja = LOJA_DA_SIGLA[String(caso.sigla ?? "")];
  if (!loja) return { pedido: null, erro: "A loja desta marca não está no Data Mart: os itens do pedido não se marcam." };
  const n = numeroDaLoja(caso.numero_pedido);
  if (!n) return { pedido: null, erro: "Número do pedido fora do formato da loja: os itens do pedido não se marcam." };
  const linhas = await consultar(m, f, sqlDoPedido(loja, n));
  if (!linhas.length) return { pedido: null, erro: "Pedido não encontrado no Data Mart: os itens do pedido não se marcam." };
  const [primeira] = linhas;
  if (primeira[10] !== true && primeira[10] !== "true")
    return { pedido: null, erro: "Os itens dos kits deste pedido ainda não chegaram ao Data Mart (chegam ao longo do dia): por ora, os itens do pedido não se marcam." };
  const itens = linhas
    .filter(l => l[4] !== null && l[4] !== undefined && Number(l[7]) > 0)
    .map(l => ({
      id: String(l[4]), sku: String(l[5] ?? "").trim(), nome: String(l[6] ?? "").trim(), quantidade: Math.trunc(numero(l[7])), preco: numero(l[8]),
      componentes: String(l[9] ?? "").split(SEP_ITEM).filter(Boolean).map(c => {
        const [sku, unidades, peso, nome] = c.split(SEP_CAMPO);
        return {
          sku: sku.trim(), quantidade: Math.max(1, Math.trunc(Number(unidades) || 1)), peso: Math.max(0, Math.trunc(Number(peso) || 0)),
          nome: (nome ?? "").trim(),
        };
      }),
    }));
  return {
    pedido: montarPedido({ numero: String(primeira[0] ?? ""), total: numero(primeira[1]), frete: numero(primeira[2]), desconto: numero(primeira[3]) }, itens),
    erro: null,
  };
}
