// Os campos que saem dos itens do pedido (shared/itens.ts): o escopo e o valor do reembolso e os SKUs do reenvio. Os
// números do reembolso são de pedidos reais conferidos no Data Mart em 10/11/2026, em que o CX Hub registrou o pedido
// inteiro.

import { describe, expect, it } from "vitest";
import {
  calcularReembolso, chaveDaSelecao, marcaveis, montarPedido, ratear, selecaoDoTexto, textoDaSelecao, valorDoItemCentavos,
} from "../shared/itens";

// SH1742171KS: um item de 34,57, desconto 1,73, frete 4,90; o CX Hub registrou 37,74 (o pedido inteiro).
const simples = () => montarPedido({ numero: "SH1742171KS", total: 37.74, frete: 4.9, desconto: 1.73 }, [
  { id: "1", sku: "KS03043", nome: "Produto", quantidade: 1, preco: 34.57 },
]);

// SH1402218RT: kit de 144,90 e mais três itens, desconto 6,37, frete 5,90, total 194,37.
const comKit = () => montarPedido({ numero: "SH1402218RT", total: 194.37, frete: 5.9, desconto: 6.37 }, [
  { id: "10", sku: "KRT99035", nome: "Kit", quantidade: 1, preco: 144.9 },
  { id: "11", sku: "RT01008", nome: "Sérum", quantidade: 1, preco: 49.9 },
  { id: "12", sku: "KRT99066", nome: "Brinde", quantidade: 1, preco: 0.02 },
  { id: "13", sku: "RT99005", nome: "Amostra", quantidade: 1, preco: 0.02 },
]);

// SH1446502RT: três unidades de 44,90 com desconto de 67,35 e frete 4,90 (total 72,25).
const tresUnidades = () => montarPedido({ numero: "SH1446502RT", total: 72.25, frete: 4.9, desconto: 67.35 }, [
  { id: "20", sku: "RT01021", nome: "Óleo", quantidade: 3, preco: 44.9 },
]);

describe("rateio do desconto", () => {
  it("soma exatamente o desconto, proporcional ao valor, em centavos", () => {
    expect(ratear(637, [14490, 4990, 2, 2])).toEqual([474, 163, 0, 0]);
    expect(ratear(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(ratear(100, [0, 0])).toEqual([0, 0]);
    expect(ratear(0, [5, 5])).toEqual([0, 0]);
  });

  it("o pedido inteiro com frete dá o total do pedido", () => {
    for (const p of [simples(), comKit(), tresUnidades()]) {
      const tudo = calcularReembolso(p, { itens: p.itens.map(i => ({ id: i.id, quantidade: i.quantidade })), frete: true });
      expect(tudo).toMatchObject({ ok: true, valor: p.total });
    }
    expect(calcularReembolso(simples(), { itens: [{ id: "1", quantidade: 1 }], frete: true })).toEqual({ ok: true, escopo: "KS03043 - 1;Frete", valor: 37.74 });
  });
});

describe("calcularReembolso (escopo e valor)", () => {
  it("um item só, sem frete, leva a parte dele no desconto", () => {
    // 49,90 − 1,63 do desconto rateado.
    expect(calcularReembolso(comKit(), { itens: [{ id: "11", quantidade: 1 }], frete: false })).toEqual({ ok: true, escopo: "RT01008 - 1", valor: 48.27 });
  });

  it("parte das unidades é proporcional à linha", () => {
    const p = tresUnidades();
    expect(valorDoItemCentavos(p.itens[0], 3)).toBe(6735);
    expect(calcularReembolso(p, { itens: [{ id: "20", quantidade: 1 }], frete: false })).toEqual({ ok: true, escopo: "RT01021 - 1", valor: 22.45 });
  });

  it("só o frete", () => {
    expect(calcularReembolso(simples(), { itens: [], frete: true })).toEqual({ ok: true, escopo: "Frete", valor: 4.9 });
  });

  it("o escopo segue a ordem do pedido, não a dos cliques", () => {
    const r = calcularReembolso(comKit(), { itens: [{ id: "13", quantidade: 1 }, { id: "10", quantidade: 1 }], frete: false });
    expect(r).toEqual({ ok: true, escopo: "KRT99035 - 1;RT99005 - 1", valor: 140.18 });
  });

  it("recusa item de outro pedido, quantidade fora, repetido, nada marcado e frete que não há", () => {
    const p = tresUnidades();
    expect(calcularReembolso(p, { itens: [{ id: "x", quantidade: 1 }], frete: false }).ok).toBe(false);
    expect(calcularReembolso(p, { itens: [{ id: "20", quantidade: 4 }], frete: false }).ok).toBe(false);
    expect(calcularReembolso(p, { itens: [{ id: "20", quantidade: 0 }], frete: false }).ok).toBe(false);
    expect(calcularReembolso(p, { itens: [{ id: "20", quantidade: 1.5 }], frete: false }).ok).toBe(false);
    expect(calcularReembolso(p, { itens: [{ id: "20", quantidade: 1 }, { id: "20", quantidade: 1 }], frete: false }).ok).toBe(false);
    expect(calcularReembolso(p, { itens: [], frete: false }).ok).toBe(false);
    const semFrete = montarPedido({ numero: "x", total: 10, frete: 0, desconto: 0 }, [{ id: "1", sku: "A", nome: "", quantidade: 1, preco: 10 }]);
    expect(calcularReembolso(semFrete, { itens: [], frete: true }).ok).toBe(false);
  });

  it("nunca passa do total do pedido", () => {
    // Um pedido cujo total (pago) ficou abaixo da soma dos itens: o valor é travado no total.
    const p = montarPedido({ numero: "x", total: 20, frete: 0, desconto: 0 }, [{ id: "1", sku: "A", nome: "", quantidade: 1, preco: 25 }]);
    expect(calcularReembolso(p, { itens: [{ id: "1", quantidade: 1 }], frete: false })).toMatchObject({ ok: true, valor: 20 });
  });
});

describe("SKUs do reenvio", () => {
  // Um pedido com o mesmo SKU em duas linhas (variantes), como acontece na Shopify.
  const pedido = () => montarPedido({ numero: "SH1580086KS", total: 120, frete: 10, desconto: 0 }, [
    { id: "1", sku: "KS03015", nome: "A", quantidade: 2, preco: 30 },
    { id: "2", sku: "KS03016", nome: "B", quantidade: 1, preco: 30 },
    { id: "3", sku: "KS03015", nome: "A (outra)", quantidade: 1, preco: 20 },
  ]);

  it("SKU com problema: só os SKUs, na ordem do pedido, sem quantidade e sem repetir", () => {
    expect(textoDaSelecao("skus", pedido(), { itens: [{ id: "3", quantidade: 1 }, { id: "2", quantidade: 1 }, { id: "1", quantidade: 5 }], frete: false }))
      .toEqual({ ok: true, texto: "KS03015;KS03016" });
  });

  it("SKU do reenvio: SKU e quantidade, que vai de 1 à comprada", () => {
    expect(textoDaSelecao("produtos_reenvio", pedido(), { itens: [{ id: "2", quantidade: 1 }, { id: "1", quantidade: 2 }], frete: false }))
      .toEqual({ ok: true, texto: "KS03015 - 2;KS03016 - 1" });
    expect(textoDaSelecao("produtos_reenvio", pedido(), { itens: [{ id: "1", quantidade: 3 }], frete: false }).ok).toBe(false);
  });

  it("recusa frete, item de outro pedido e nada marcado", () => {
    expect(textoDaSelecao("produtos_reenvio", pedido(), { itens: [{ id: "1", quantidade: 1 }], frete: true })).toMatchObject({ ok: false, erro: expect.stringContaining("frete") });
    expect(textoDaSelecao("skus", pedido(), { itens: [{ id: "9", quantidade: 1 }], frete: false }).ok).toBe(false);
    expect(textoDaSelecao("skus", pedido(), { itens: [], frete: false })).toEqual({ ok: false, erro: "Marque ao menos um item." });
  });
});

describe("kits: o que se marca é o item, nunca o SKU do kit (a tabela explodida)", () => {
  // SH1525762KS, real: dois kits com o KS03016 nos dois, e um brinde. Pesos: o preço de catálogo de cada item (11/11/2026).
  const pedido = () => montarPedido({ numero: "SH1525762KS", total: 132.83, frete: 0, desconto: 6.99 }, [
    { id: "10", sku: "KKS00104", nome: "Ritual Olhar Descansado", quantidade: 1, preco: 49.9, componentes: [
      { sku: "KS03041", nome: "Sérum Roll-on", quantidade: 1, peso: 2490 }, { sku: "KS03016", nome: "Olhos de Gueixa", quantidade: 1, peso: 1917 },
    ] },
    { id: "20", sku: "KKS00107", nome: "Ritual Pele Firme", quantidade: 1, preco: 89.9, componentes: [
      { sku: "KS03016", nome: "Olhos de Gueixa", quantidade: 1, peso: 1917 }, { sku: "KS03043", nome: "Gota de Colágeno", quantidade: 1, peso: 3457 },
      { sku: "KS03041", nome: "Sérum Roll-on", quantidade: 1, peso: 2490 }, { sku: "KS03015", nome: "Pele de Porcelana", quantidade: 1, peso: 2687 },
    ] },
    { id: "30", sku: "KS99040", nome: "Brinde Surpresa", quantidade: 1, preco: 0.02 },
  ]);

  it("no lugar de cada kit, os itens dele; o SKU do kit não se marca", () => {
    expect(marcaveis(pedido()).map(m => `${m.id}:${m.sku}${m.kit ? `<${m.kit.sku}` : ""}`)).toEqual([
      "10.1:KS03041<KKS00104", "10.2:KS03016<KKS00104",
      "20.1:KS03016<KKS00107", "20.2:KS03043<KKS00107", "20.3:KS03041<KKS00107", "20.4:KS03015<KKS00107",
      "30:KS99040",
    ]);
    for (const campo of ["escopo_reembolso", "produtos_reenvio", "skus"] as const)
      expect(textoDaSelecao(campo, pedido(), { itens: [{ id: "10", quantidade: 1 }], frete: false })).toMatchObject({ ok: false, erro: expect.stringContaining("SKU do kit") });
  });

  it("o valor da linha do kit se reparte entre os itens pelo peso, e o pedido inteiro dá o total", () => {
    // KKS00104: 49,90 − 2,50 do desconto = 47,40, repartidos 2490:1917 → 26,78 e 20,62.
    const porId = new Map(marcaveis(pedido()).map(m => [m.id, m.liquidoCentavos]));
    expect([porId.get("10.1"), porId.get("10.2")]).toEqual([2678, 2062]);
    expect(calcularReembolso(pedido(), { itens: [{ id: "10.2", quantidade: 1 }], frete: false })).toEqual({ ok: true, escopo: "KS03016 - 1", valor: 20.62 });
    const tudo = marcaveis(pedido()).map(m => ({ id: m.id, quantidade: m.quantidade }));
    expect(calcularReembolso(pedido(), { itens: tudo, frete: false })).toEqual({
      ok: true, escopo: "KS03041 - 2;KS03016 - 2;KS03043 - 1;KS03015 - 1;KS99040 - 1", valor: 132.83,
    });
  });

  it("sem peso (item fora do catálogo e sem rateio do dbt), a linha se reparte pelas unidades", () => {
    const p = montarPedido({ numero: "x", total: 30, frete: 0, desconto: 0 }, [
      { id: "1", sku: "K1", nome: "Kit", quantidade: 1, preco: 30, componentes: [{ sku: "A", nome: "", quantidade: 1, peso: 0 }, { sku: "B", nome: "", quantidade: 2, peso: 0 }] },
    ]);
    expect(marcaveis(p).map(m => m.liquidoCentavos)).toEqual([1000, 2000]);
  });

  it("o registro real do CX Hub marca os itens dos dois kits, e o texto volta com as mesmas quantidades", () => {
    const registrado = "KS03016 - 2;KS03041 - 2;KS03015 - 1;KS03043 - 1;KS99040 - 1";
    const r = selecaoDoTexto("produtos_reenvio", pedido(), registrado);
    expect(r.foraDoPedido).toEqual([]);
    expect(r.selecao.mimos).toEqual([]);
    expect(r.selecao.itens.map(i => i.id).sort()).toEqual(["10.1", "10.2", "20.1", "20.2", "20.3", "20.4", "30"]);
    expect(textoDaSelecao("produtos_reenvio", pedido(), r.selecao)).toEqual({ ok: true, texto: "KS03041 - 2;KS03016 - 2;KS03043 - 1;KS03015 - 1;KS99040 - 1" });
  });

  it("SKU com problema: o SKU do kit registrado fica de fora, com aviso; o item se marca", () => {
    expect(selecaoDoTexto("skus", pedido(), "KKS00107")).toEqual({ selecao: { itens: [], frete: false, mimos: [] }, foraDoPedido: ["KKS00107"] });
    expect(textoDaSelecao("skus", pedido(), { itens: [{ id: "20.4", quantidade: 1 }, { id: "10.2", quantidade: 1 }, { id: "20.1", quantidade: 1 }], frete: false }))
      .toEqual({ ok: true, texto: "KS03016;KS03015" });
  });
});

describe("mimo (o item adicional do reenvio, do catálogo da marca)", () => {
  it("entra depois dos itens do pedido, como \"SKU - qtd\", e pode ir sozinho", () => {
    expect(textoDaSelecao("produtos_reenvio", comKit(), { itens: [{ id: "11", quantidade: 1 }], frete: false, mimos: [{ sku: "BB99040", quantidade: 2 }] }))
      .toEqual({ ok: true, texto: "RT01008 - 1;BB99040 - 2" });
    expect(textoDaSelecao("produtos_reenvio", comKit(), { itens: [], frete: false, mimos: [{ sku: "RT99005", quantidade: 1 }] }))
      .toEqual({ ok: true, texto: "RT99005 - 1" });
  });

  it("recusa mimo fora do SKU do reenvio, repetido, com mais de 10 unidades ou com SKU inválido", () => {
    const m = (mimos: Array<{ sku: string; quantidade: number }>) => ({ itens: [{ id: "11", quantidade: 1 }], frete: false, mimos });
    expect(textoDaSelecao("skus", comKit(), m([{ sku: "BB99040", quantidade: 1 }])).ok).toBe(false);
    expect(textoDaSelecao("escopo_reembolso", comKit(), m([{ sku: "BB99040", quantidade: 1 }])).ok).toBe(false);
    expect(textoDaSelecao("produtos_reenvio", comKit(), m([{ sku: "BB99040", quantidade: 1 }, { sku: "bb99040", quantidade: 2 }])).ok).toBe(false);
    expect(textoDaSelecao("produtos_reenvio", comKit(), m([{ sku: "BB99040", quantidade: 11 }])).ok).toBe(false);
    expect(textoDaSelecao("produtos_reenvio", comKit(), m([{ sku: "A;B", quantidade: 1 }])).ok).toBe(false);
    expect(textoDaSelecao("produtos_reenvio", comKit(), { itens: [], frete: false, mimos: [] })).toEqual({ ok: false, erro: "Marque ao menos um item ou um mimo." });
  });

  it("no registrado, o SKU que o pedido real não tinha é mimo (do CX Hub ou da Central de Tickets)", () => {
    expect(selecaoDoTexto("produtos_reenvio", comKit(), "RT01008 - 1;BB99040 - 1;KS99053 - 2;BB99040 - 1"))
      .toEqual({ selecao: { itens: [{ id: "11", quantidade: 1 }], frete: false, mimos: [{ sku: "BB99040", quantidade: 2 }, { sku: "KS99053", quantidade: 2 }] }, foraDoPedido: [] });
  });

  it("a quantidade além da que o pedido real tinha também é mimo", () => {
    // O pedido tem uma unidade do RT01008; o registro reenviou três.
    expect(selecaoDoTexto("produtos_reenvio", comKit(), "RT01008 - 3"))
      .toEqual({ selecao: { itens: [{ id: "11", quantidade: 1 }], frete: false, mimos: [{ sku: "RT01008", quantidade: 2 }] }, foraDoPedido: [] });
  });
});

describe("selecaoDoTexto (marcar os checkboxes ao abrir o caso)", () => {
  it("escopo: casa SKU e quantidade com os itens, e o Frete", () => {
    expect(selecaoDoTexto("escopo_reembolso", tresUnidades(), "RT01021 - 2;Frete")).toEqual({ selecao: { itens: [{ id: "20", quantidade: 2 }], frete: true, mimos: [] }, foraDoPedido: [] });
    expect(selecaoDoTexto("escopo_reembolso", simples(), "ks03043 - 1")).toEqual({ selecao: { itens: [{ id: "1", quantidade: 1 }], frete: false, mimos: [] }, foraDoPedido: [] });
  });

  it("no escopo, o que não é item do pedido fica de fora, com aviso", () => {
    const r = selecaoDoTexto("escopo_reembolso", comKit(), "RT01012 - 1;RT02008 - 1;RT01008 - 1;Frete");
    expect(r.selecao).toEqual({ itens: [{ id: "11", quantidade: 1 }], frete: true, mimos: [] });
    expect(r.foraDoPedido).toEqual(["RT01012 - 1", "RT02008 - 1"]);
  });

  it("a quantidade acima da comprada fica de fora, com aviso; texto vazio ou nulo não marca nada", () => {
    expect(selecaoDoTexto("escopo_reembolso", tresUnidades(), "RT01021 - 9"))
      .toEqual({ selecao: { itens: [{ id: "20", quantidade: 3 }], frete: false, mimos: [] }, foraDoPedido: ["RT01021 - 6"] });
    expect(selecaoDoTexto("escopo_reembolso", tresUnidades(), null)).toEqual({ selecao: { itens: [], frete: false, mimos: [] }, foraDoPedido: [] });
    expect(selecaoDoTexto("skus", tresUnidades(), "-")).toEqual({ selecao: { itens: [], frete: false, mimos: [] }, foraDoPedido: [] });
  });

  it("reenvio: SKU com problema sem quantidade; no SKU do reenvio, o Frete fica de fora", () => {
    const p = comKit();
    expect(selecaoDoTexto("skus", p, "RT01008;KRT99035")).toEqual({ selecao: { itens: [{ id: "11", quantidade: 1 }, { id: "10", quantidade: 1 }], frete: false, mimos: [] }, foraDoPedido: [] });
    expect(selecaoDoTexto("produtos_reenvio", p, "RT01008 - 1;Frete"))
      .toEqual({ selecao: { itens: [{ id: "11", quantidade: 1 }], frete: false, mimos: [] }, foraDoPedido: ["Frete"] });
  });

  it("a seleção tem a mesma chave, qualquer que seja a ordem dos cliques e dos mimos", () => {
    const a = { itens: [{ id: "1", quantidade: 1 }, { id: "2", quantidade: 2 }], frete: true, mimos: [{ sku: "X1", quantidade: 1 }, { sku: "Y2", quantidade: 3 }] };
    const b = { itens: [{ id: "2", quantidade: 2 }, { id: "1", quantidade: 1 }], frete: true, mimos: [{ sku: "y2", quantidade: 3 }, { sku: "X1", quantidade: 1 }] };
    expect(chaveDaSelecao(a)).toBe(chaveDaSelecao(b));
    expect(chaveDaSelecao(a)).not.toBe(chaveDaSelecao({ ...b, frete: false }));
    expect(chaveDaSelecao(a)).not.toBe(chaveDaSelecao({ ...a, mimos: [] }));
  });
});
