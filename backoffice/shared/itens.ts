// Os campos que saem dos itens do pedido (decisões de 10 e 11/11/2026). Nenhum deles se digita: o backoffice marca, em
// checkbox, os itens do pedido (e, no escopo do reembolso, o frete), e o texto do campo sai da seleção.
//   - escopo do reembolso: "SKU - qtd;SKU - qtd;Frete" (buildRefundScope do CX Hub); a mesma seleção dá o valor, que
//     nunca passa do total do pedido;
//   - SKU do reenvio (produtos_reenvio): "SKU - qtd;SKU - qtd", e depois os mimos, "SKU - qtd" (os "itens adicionais"
//     do CX Hub: qualquer produto do catálogo da marca, de 1 a 10 unidades);
//   - SKU com problema (skus): "SKU;SKU", sem quantidade.
// O mesmo SKU marcado em mais de um lugar (o item que vem em dois kits) soma as quantidades numa parte só, como o CX Hub
// escreve ("KS03016 - 2"). A tela usa estas funções para mostrar o resultado na hora; o servidor, para recalcular e
// conferir tudo antes de guardar (a tela não é a guarda).
//
// O pedido é o da Shopify no Data Mart (gold.fct_shopify_orders e gold.fct_shopify_order_items). O desconto só existe
// no pedido (o total_discount dos itens vem zerado): ele é rateado entre as linhas proporcionalmente ao valor, em
// centavos, como o CX Hub faz no formato novo do erp_payload (extractErpPayloadItems).
//
// Kit: o que se registra é sempre o item do kit, nunca o SKU do kit, nos três campos (como o CX Hub já fazia; decisão de
// 11/11/2026). O kit aparece só como cabeçalho, com os itens dele embaixo (gold.fct_shopify_order_items_exploded_priced_mat,
// conferida contra o que o CX Hub registrou em pedidos reais). O valor da linha do kit se reparte entre os itens pelo
// peso de cada um (o preço de catálogo × as unidades; sem ele, o rateio do dbt), como o CX Hub reparte pelo preço de
// catálogo nos pedidos da Shopify.

export type CampoDeItens = "escopo_reembolso" | "produtos_reenvio" | "skus";

const REGRAS: Record<CampoDeItens, { quantidade: boolean; frete: boolean; mimo: boolean }> = {
  escopo_reembolso: { quantidade: true, frete: true, mimo: false },
  produtos_reenvio: { quantidade: true, frete: false, mimo: true },
  skus: { quantidade: false, frete: false, mimo: false },
};

export const temQuantidade = (campo: CampoDeItens) => REGRAS[campo].quantidade;
export const temFrete = (campo: CampoDeItens) => REGRAS[campo].frete;
export const temMimo = (campo: CampoDeItens) => REGRAS[campo].mimo;

// Como no CX Hub: cada mimo vai de 1 a 10 unidades.
export const MIMO_MAX = 10;

export interface ComponenteDoKit {
  sku: string;
  nome: string; // do catálogo; vazio quando o item não está lá
  quantidade: number; // as unidades na linha (por kit × kits comprados)
  peso: number; // em centavos: o preço de catálogo × as unidades (sem ele, o rateio do dbt)
}

export interface ItemDoPedido {
  id: string; // line_item_id
  sku: string;
  nome: string;
  quantidade: number;
  preco: number; // unitário, antes do desconto
  liquidoCentavos: number; // a linha inteira depois do desconto rateado
  componentes: ComponenteDoKit[]; // vazio quando a linha não é kit
}

export interface PedidoDoCaso {
  numero: string;
  total: number; // value_total: itens − desconto + frete
  frete: number;
  desconto: number;
  itens: ItemDoPedido[];
}

// Um produto do catálogo da marca, para o mimo. Brinde: o de R$ 0,02 ou com "brinde" no nome.
export interface ProdutoDoCatalogo {
  sku: string;
  nome: string;
  preco: number;
  brinde: boolean;
}

export interface Mimo {
  sku: string;
  quantidade: number;
}

// Os itens marcados (a quantidade só conta onde o campo tem quantidade), o frete (só no escopo do reembolso) e os
// mimos (só no SKU do reenvio).
export interface SelecaoDeItens {
  itens: Array<{ id: string; quantidade: number }>;
  frete: boolean;
  mimos?: Mimo[];
}

const centavos = (v: number) => Math.round(v * 100);

// Rateio de um valor em centavos proporcional aos pesos, pelo maior resto: a soma das partes é exatamente o total.
export function ratear(totalCentavos: number, pesos: number[]): number[] {
  const soma = pesos.reduce((a, b) => a + b, 0);
  if (soma <= 0 || totalCentavos <= 0) return pesos.map(() => 0);
  const exatos = pesos.map(p => (totalCentavos * p) / soma);
  const partes = exatos.map(Math.floor);
  let resto = totalCentavos - partes.reduce((a, b) => a + b, 0);
  const ordem = exatos.map((e, i) => ({ i, fracao: e - Math.floor(e) })).sort((a, b) => b.fracao - a.fracao || a.i - b.i);
  for (const { i } of ordem) {
    if (resto <= 0) break;
    partes[i]++;
    resto--;
  }
  return partes;
}

type LinhaDoPedido = { id: string; sku: string; nome: string; quantidade: number; preco: number; componentes?: ComponenteDoKit[] };

export function montarPedido(cabecalho: { numero: string; total: number; frete: number; desconto: number }, linhas: LinhaDoPedido[]): PedidoDoCaso {
  const bases = linhas.map(l => centavos(l.preco) * l.quantidade);
  const descontos = ratear(centavos(cabecalho.desconto), bases);
  return {
    ...cabecalho,
    itens: linhas.map((l, i) => ({ ...l, componentes: l.componentes ?? [], liquidoCentavos: Math.max(0, bases[i] - descontos[i]) })),
  };
}

// O que se marca: a linha que não é kit e, no lugar de cada kit, os itens dele (id "<linha>.<n>"), cada um com a sua
// parte no valor da linha. `kit` é o kit de onde o item vem.
export interface Marcavel {
  id: string;
  sku: string;
  nome: string;
  quantidade: number;
  liquidoCentavos: number;
  kit: { sku: string; nome: string } | null;
}

export function marcaveis(pedido: PedidoDoCaso): Marcavel[] {
  return pedido.itens.flatMap((l): Marcavel[] => {
    if (!l.componentes.length) return [{ id: l.id, sku: l.sku, nome: l.nome, quantidade: l.quantidade, liquidoCentavos: l.liquidoCentavos, kit: null }];
    const pesos = l.componentes.some(c => c.peso > 0) ? l.componentes.map(c => Math.max(c.peso, 0)) : l.componentes.map(c => c.quantidade);
    const partes = ratear(l.liquidoCentavos, pesos);
    return l.componentes.map((c, n) => ({
      id: `${l.id}.${n + 1}`, sku: c.sku, nome: c.nome, quantidade: c.quantidade, liquidoCentavos: partes[n], kit: { sku: l.sku, nome: l.nome },
    }));
  });
}

// O valor de parte do item (quantidade menor que a comprada), proporcional, em centavos.
export const valorDoItemCentavos = (item: { liquidoCentavos: number; quantidade: number }, quantidade: number) =>
  Math.round((item.liquidoCentavos * quantidade) / item.quantidade);

export type Texto = { ok: true; texto: string } | { ok: false; erro: string };

const mesmoSku = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

// O texto do campo a partir dos itens marcados, na ordem do pedido (não na dos cliques), e dos mimos, na ordem em que
// foram escolhidos. Confere a seleção: item do pedido, sem repetir, quantidade entre 1 e a comprada (onde há
// quantidade), frete só no escopo e só se o pedido o cobrou, mimo só no SKU do reenvio, e algo marcado.
export function textoDaSelecao(campo: CampoDeItens, pedido: PedidoDoCaso, selecao: SelecaoDeItens): Texto {
  const regra = REGRAS[campo];
  const lista = marcaveis(pedido);
  const porId = new Map(lista.map(m => [m.id, m]));
  const quantidades = new Map<string, number>();
  for (const s of selecao.itens) {
    const item = porId.get(s.id);
    if (!item) return { ok: false, erro: "Item que não é deste pedido (ou é o SKU do kit: marque os itens dele)." };
    if (quantidades.has(s.id)) return { ok: false, erro: `Item repetido na seleção: ${item.sku}.` };
    if (regra.quantidade && (!Number.isInteger(s.quantidade) || s.quantidade < 1 || s.quantidade > item.quantidade))
      return { ok: false, erro: `${item.sku}: a quantidade vai de 1 a ${item.quantidade}.` };
    quantidades.set(s.id, regra.quantidade ? s.quantidade : 1);
  }
  if (selecao.frete && !regra.frete) return { ok: false, erro: "O frete só entra no escopo do reembolso." };
  if (selecao.frete && pedido.frete <= 0) return { ok: false, erro: "O pedido não tem frete cobrado." };
  const mimos = selecao.mimos ?? [];
  if (mimos.length && !regra.mimo) return { ok: false, erro: "Mimo só entra no SKU do reenvio." };
  for (const [n, m] of mimos.entries()) {
    if (!m.sku.trim() || m.sku.includes(";") || m.sku.length > 80) return { ok: false, erro: `Mimo com SKU inválido: "${m.sku}".` };
    if (mimos.findIndex(o => mesmoSku(o.sku, m.sku)) !== n) return { ok: false, erro: `Mimo repetido: ${m.sku}.` };
    if (!Number.isInteger(m.quantidade) || m.quantidade < 1 || m.quantidade > MIMO_MAX)
      return { ok: false, erro: `${m.sku}: o mimo vai de 1 a ${MIMO_MAX} unidades.` };
  }
  if (!quantidades.size && !selecao.frete && !mimos.length)
    return { ok: false, erro: regra.frete ? "Marque ao menos um item ou o frete." : regra.mimo ? "Marque ao menos um item ou um mimo." : "Marque ao menos um item." };
  const marcados = lista.filter(m => quantidades.has(m.id));
  let partes: string[];
  if (!regra.quantidade) partes = [...new Set(marcados.map(m => m.sku))];
  else {
    const porSku = new Map<string, number>();
    for (const m of marcados) porSku.set(m.sku, (porSku.get(m.sku) ?? 0) + quantidades.get(m.id)!);
    partes = [...porSku].map(([sku, q]) => `${sku} - ${q}`);
  }
  partes.push(...mimos.map(m => `${m.sku.trim()} - ${m.quantidade}`));
  if (selecao.frete) partes.push("Frete");
  return { ok: true, texto: partes.join(";") };
}

export type Calculo = { ok: true; escopo: string; valor: number } | { ok: false; erro: string };

// O escopo e o valor do reembolso: os itens marcados (cada um com a sua parte no desconto e, no kit, no valor da linha)
// mais o frete, nunca acima do total do pedido.
export function calcularReembolso(pedido: PedidoDoCaso, selecao: SelecaoDeItens): Calculo {
  const escopo = textoDaSelecao("escopo_reembolso", pedido, selecao);
  if (!escopo.ok) return escopo;
  const porId = new Map(marcaveis(pedido).map(m => [m.id, m]));
  const soma = selecao.itens.reduce((t, s) => t + valorDoItemCentavos(porId.get(s.id)!, s.quantidade), 0)
    + (selecao.frete ? centavos(pedido.frete) : 0);
  return { ok: true, escopo: escopo.texto, valor: Math.min(soma, centavos(pedido.total)) / 100 };
}

// A seleção que o texto registrado representa, para marcar os checkboxes ao abrir o caso. Cada "SKU - qtd" (ou "SKU", no
// SKU com problema) marca o que ainda está livre com o mesmo SKU, na ordem da lista, e a quantidade se reparte entre os
// lugares do mesmo SKU (o item que vem em dois kits). No SKU do reenvio, o SKU ou a quantidade que o pedido real não
// tinha é mimo (o item adicional que o CX Hub ou a Central de Tickets registrou: decisão de 11/11/2026). Nos outros
// campos, volta em `foraDoPedido`, para a tela avisar (o SKU do kit cai aqui: o que se marca são os itens dele).
export function selecaoDoTexto(campo: CampoDeItens, pedido: PedidoDoCaso, registrado: unknown): { selecao: SelecaoDeItens; foraDoPedido: string[] } {
  const regra = REGRAS[campo];
  const lista = marcaveis(pedido);
  const selecao: SelecaoDeItens = { itens: [], frete: false, mimos: [] };
  const foraDoPedido: string[] = [];
  const usados = new Set<string>();
  const sobra = (sku: string, quantidade: number, parte: string) => {
    if (!regra.mimo) return foraDoPedido.push(parte);
    const ja = selecao.mimos!.find(m => mesmoSku(m.sku, sku));
    if (ja) ja.quantidade += quantidade;
    else selecao.mimos!.push({ sku, quantidade });
  };
  const texto = typeof registrado === "string" ? registrado : "";
  for (const bruto of texto.split(";")) {
    const parte = bruto.trim();
    if (!parte || parte === "-") continue;
    if (parte.toLowerCase() === "frete") {
      if (regra.frete && pedido.frete > 0) selecao.frete = true;
      else foraDoPedido.push(parte);
      continue;
    }
    const m = regra.quantidade ? /^(.+?)\s*-\s*(\d+)$/.exec(parte) : null;
    const sku = (m ? m[1] : parte).trim();
    const quantidade = Math.max(m ? Number(m[2]) : 1, 1);
    const livres = lista.filter(i => mesmoSku(i.sku, sku) && !usados.has(i.id));
    if (!livres.length) {
      sobra(sku, quantidade, parte);
      continue;
    }
    if (!regra.quantidade) {
      usados.add(livres[0].id);
      selecao.itens.push({ id: livres[0].id, quantidade: 1 });
      continue;
    }
    let falta = quantidade;
    for (const i of livres) {
      if (falta <= 0) break;
      const q = Math.min(falta, i.quantidade);
      usados.add(i.id);
      selecao.itens.push({ id: i.id, quantidade: q });
      falta -= q;
    }
    if (falta > 0) sobra(sku, falta, `${sku} - ${falta}`);
  }
  return { selecao, foraDoPedido };
}

// A mesma seleção, qualquer que seja a ordem dos cliques.
export const chaveDaSelecao = (s: SelecaoDeItens) => JSON.stringify([
  s.itens.map(i => `${i.id}:${i.quantidade}`).sort(),
  s.frete,
  (s.mimos ?? []).map(m => `${m.sku.trim().toUpperCase()}:${m.quantidade}`).sort(),
]);
