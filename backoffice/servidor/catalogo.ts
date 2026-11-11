// O catálogo da marca para o mimo do reenvio: os produtos avulsos da Shopify no Data Mart
// (silver.dim_shopify_products_individual, que o dbt atualiza todo dia), sem os arquivados. É o equivalente aos "itens
// adicionais" do CX Hub, que lá vêm do catálogo do Cosmos (este app não fala com o Cosmos). Kit não entra: o que se
// registra é sempre o item (decisão de 11/11/2026).
//
// A lista fica 10 min em memória por isolate, por marca (muda uma vez por dia). Erro nunca é guardado.

import type { ProdutoDoCatalogo } from "../shared/itens";
import type { ConfigMetabase } from "./config";
import type { Busca } from "./contexto";
import { consultar, literalSql } from "./metabase";
import { LOJA_DA_SIGLA } from "./pedido";

const VALIDADE_MS = 10 * 60_000;
const guardados = new Map<string, { produtos: ProdutoDoCatalogo[]; ate: number }>();

export const limparCacheDoCatalogo = () => guardados.clear();

// Fora o que não é item de estoque: produto de teste (no SKU ou no nome), antigo ("-OLD"), só da Shopify ("_SHOP",
// "-shop") e o pacote de vários SKUs ("A;B"), que nem caberia no texto "SKU - qtd" (conferido no catálogo de 11/11/2026).
export function sqlDoCatalogo(loja: string): string {
  return "select sku, min(case when coalesce(variant_title, '') in ('', 'Default Title') then product_title "
    + "else product_title || ' - ' || variant_title end) as nome, min(price) as preco "
    + "from silver.dim_shopify_products_individual "
    + `where brand = ${literalSql(loja)} and coalesce(trim(sku), '') <> '' and coalesce(status, '') <> 'archived' `
    + "and sku !~* '(shop|test|-old$)' and sku !~ '[; ]' and coalesce(product_title, '') !~* 'teste' "
    + "group by sku order by sku";
}

export class CatalogoErro extends Error {}

// Brinde primeiro (o mimo de costume), depois o resto, pelo nome.
export async function catalogoDaMarca(m: ConfigMetabase, f: Busca, sigla: string, agora: number): Promise<ProdutoDoCatalogo[]> {
  const loja = LOJA_DA_SIGLA[sigla];
  if (!loja) throw new CatalogoErro("o catálogo desta marca não está no Data Mart");
  const guardado = guardados.get(loja);
  if (guardado && guardado.ate > agora) return guardado.produtos;
  const linhas = await consultar(m, f, sqlDoCatalogo(loja));
  const produtos = linhas
    .map(l => ({ sku: String(l[0] ?? "").trim(), nome: String(l[1] ?? "").trim(), preco: Number(l[2]) || 0 }))
    .filter(p => p.sku)
    .map(p => ({ ...p, brinde: p.preco <= 0.02 || /brinde/i.test(p.nome) }))
    .sort((a, b) => Number(b.brinde) - Number(a.brinde) || a.nome.localeCompare(b.nome, "pt-BR"));
  guardados.set(loja, { produtos, ate: agora + VALIDADE_MS });
  return produtos;
}
