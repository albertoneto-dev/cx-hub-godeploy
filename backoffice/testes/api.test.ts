// As rotas da tela pelo mesmo tratar() do Worker: acesso, lista, caso, edição, dados do cliente e descarte.

import { describe, expect, it } from "vitest";
import { EMAIL, MOTIVOS, OUTRO_EMAIL, URL_APP, criarAmbiente, linhaGold, type Ambiente } from "./ambiente";

const lista = (a: Ambiente, q: string) => a.chamar("GET", `/api/solicitacoes?${q}`);
const caso = (a: Ambiente, chave: string) => a.chamar("GET", `/api/solicitacoes/${encodeURIComponent(chave)}`);

describe("acesso", () => {
  it("sem o e-mail do gateway ⇒ 401; com ele, entra (quem pode entrar é o app restrito do GoDeploy que decide)", async () => {
    const a = await criarAmbiente();
    const sem = await a.chamar("GET", "/api/eu", { usuario: null });
    expect(sem.status).toBe(401);
    expect(sem.json.code).toBe("UNAUTHORIZED");
    const eu = await a.chamar("GET", "/api/eu", { usuario: EMAIL.toUpperCase() });
    expect(eu.status).toBe(200);
    expect(eu.json).toEqual({ email: EMAIL, nome: "Ana Silva", janelaDias: 30, tamanhoPagina: 50 });
    const outro = await a.chamar("GET", "/api/eu", { usuario: OUTRO_EMAIL });
    expect(outro.json).toMatchObject({ email: OUTRO_EMAIL, nome: "Bruno Costa" });
  });

  it("a edição leva o e-mail de quem está logado como autor", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold();
    await a.datamart.inserir(linha);
    await a.chamar("POST", `/api/solicitacoes/${encodeURIComponent(String(linha.chave_unica))}/edicoes`, { usuario: OUTRO_EMAIL, corpo: { campos: { cod_nfd: "1" } } });
    expect((await a.edicoes())[0]).toMatchObject({ autor: OUTRO_EMAIL });
  });

  // Adaptação do app cx-hub: aqui não há tela (só o backend), e o que não é /api/backoffice nem chega a este roteador.
  it("o que não é rota do backoffice é 404, mesmo com assets: este app não serve a tela", async () => {
    const a = await criarAmbiente();
    a.deps.ativos = { fetch: async () => new Response("<html>tela</html>", { headers: { "content-type": "text/html" } }) };
    const r = await a.chamar("GET", "/", { usuario: null });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("NOT_FOUND");
  });

  it("sem a configuração do Metabase, a lista responde 503", async () => {
    const a = await criarAmbiente({ segredos: { METABASE_API_KEY: "" } });
    const r = await lista(a, "tipo=REEMBOLSO");
    expect(r.status).toBe(503);
    expect(r.json.message).toContain("METABASE_API_KEY");
  });
});

describe("lista", () => {
  it("a primeira página traz o total e o cursor; a seguinte continua dele", async () => {
    const a = await criarAmbiente();
    for (let i = 0; i < 55; i++)
      await a.datamart.inserir(linhaGold({ data_solicitacao: `2026-11-${String(1 + (i % 9)).padStart(2, "0")} 08:${String(i).padStart(2, "0")}:00` }));
    await a.datamart.inserir(linhaGold({ tipo: "REENVIO" }));

    const p1 = await lista(a, "tipo=REEMBOLSO&contar=1");
    expect(p1.status).toBe(200);
    expect(p1.json.total).toBe(55);
    expect(p1.json.itens).toHaveLength(50);
    expect(p1.json.proximo).toEqual(expect.any(String));
    const p2 = await lista(a, `tipo=REEMBOLSO&cursor=${p1.json.proximo}`);
    expect(p2.json.total).toBeNull();
    expect(p2.json.itens).toHaveLength(5);
    expect(p2.json.proximo).toBeNull();
    const todas = [...p1.json.itens, ...p2.json.itens].map((x: { chave_unica: string }) => x.chave_unica);
    expect(new Set(todas).size).toBe(55);
  });

  it("recusa parâmetro fora do esperado", async () => {
    const a = await criarAmbiente();
    expect((await lista(a, "tipo=CANCELAMENTO")).status).toBe(400);
    expect((await lista(a, "tipo=REENVIO&marca=XX")).status).toBe(400);
    expect((await lista(a, "tipo=REENVIO&status=Feito")).status).toBe(400);
    expect((await lista(a, "tipo=REENVIO&cursor=lixo")).status).toBe(400);
    expect((await lista(a, `tipo=REENVIO&busca=${"x".repeat(101)}`)).status).toBe(400);
  });

  it("só se edita caso do CX Hub de até 30 dias; o histórico e o antigo são só leitura", async () => {
    const a = await criarAmbiente();
    await a.datamart.inserir(
      linhaGold({ chave_unica: "cxhub|recente", data_solicitacao: "2026-10-12 08:00:00" }),
      linhaGold({ chave_unica: "cxhub|antigo", data_solicitacao: "2026-10-11 08:00:00" }),
      linhaGold({ chave_unica: "Fonte_Lescent_Reembolso|1", sistema_origem: "Supabase", fonte: "Fonte_Lescent_Reembolso", data_solicitacao: "2026-10-20 08:00:00" }),
    );
    const itens = new Map((await lista(a, "tipo=REEMBOLSO")).json.itens.map((x: { chave_unica: string }) => [x.chave_unica, x]));
    expect(itens.get("cxhub|recente")).toMatchObject({ editavel: true, bloqueio: null });
    expect(itens.get("cxhub|antigo")).toMatchObject({ editavel: false, bloqueio: expect.stringContaining("30 dias") });
    expect(itens.get("Fonte_Lescent_Reembolso|1")).toMatchObject({ editavel: false, bloqueio: expect.stringContaining("histórico") });
  });

  it("erro de SQL do Metabase vira 502 com a mensagem; fora do ar, 503", async () => {
    const a = await criarAmbiente();
    a.datamart.proximaFalha = { status: 202, erro: 'relation "gold.x" does not exist' };
    const r = await lista(a, "tipo=REEMBOLSO");
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("METABASE_ERROR");
    a.datamart.proximaFalha = { status: 502 };
    expect((await lista(a, "tipo=REEMBOLSO")).status).toBe(503);
  });
});

describe("edição", () => {
  async function comUmReembolso() {
    const a = await criarAmbiente();
    const linha = linhaGold({ status_execucao: null, valor_nf_tratado: 59.9 });
    await a.datamart.inserir(linha);
    return { a, chave: String(linha.chave_unica) };
  }

  it("guarda só o que mudou, como pendente, e a lista mostra a edição por cima da gold", async () => {
    const { a, chave } = await comUmReembolso();
    const r = await a.editar(chave, { campos: { status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva", motivo: "Pedido não entregue" } });
    expect(r.status).toBe(200);
    expect(r.json.code).toBe("OK");
    const [e] = await a.edicoes();
    expect(e).toMatchObject({ situacao: "pendente", autor: EMAIL, chave_unica: chave, id_solicitacao: chave.slice(6), tipo: "REEMBOLSO", sigla: "LE" });
    // O motivo não mudou (o da gold já é esse): não vai.
    expect(JSON.parse(String(e.campos))).toEqual({ status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva" });
    expect(e.atualizado_em).toBe("2026-11-10T15:00:00.000Z");

    const [item] = (await lista(a, "tipo=REEMBOLSO")).json.itens;
    expect(item).toMatchObject({
      status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva",
      aguardando: { situacao: "pendente", autor: EMAIL, campos: ["status_execucao", "data_execucao", "responsavel_execucao"] },
      recusada: null,
    });
    // A gold não muda: quem escreve nela é a DAG, no lote.
    expect((await a.datamart.gold(chave))?.status_execucao).toBeNull();
  });

  it("nada mudou ⇒ SEM_MUDANCA, sem edição nova", async () => {
    const { a, chave } = await comUmReembolso();
    const r = await a.editar(chave, { campos: { cod_nfd: "", motivo: "Pedido não entregue" } });
    expect(r.json.code).toBe("SEM_MUDANCA");
    expect(await a.edicoes()).toHaveLength(0);
  });

  it("valores e campos inválidos ⇒ 400, sem guardar nada", async () => {
    const { a, chave } = await comUmReembolso();
    for (const campos of [{ skus: "SKU1" }, { uf: "SP" }, { status_execucao: "Feito" }, { data_execucao: "2026-11-11" }, { valor: "59.90" }]) {
      const r = await a.editar(chave, { campos });
      expect(r.status, JSON.stringify(campos)).toBe(400);
    }
    expect((await a.editar(chave, { campos: [] })).status).toBe(400);
    expect((await a.editar(chave, { cliente: { nome: "Maria" } })).status).toBe(400);
    expect(await a.edicoes()).toHaveLength(0);
  });

  it("linha que não se edita ⇒ 422; linha que não existe ⇒ 404", async () => {
    const a = await criarAmbiente();
    await a.datamart.inserir(linhaGold({ chave_unica: "cxhub|velho", data_solicitacao: "2026-09-01 10:00:00" }));
    const r = await a.editar("cxhub|velho", { campos: { cod_nfd: "1" } });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("NOT_EDITABLE");
    expect((await a.editar("cxhub|nao-existe", { campos: { cod_nfd: "1" } })).status).toBe(404);
  });

  // Adaptação do app cx-hub: a proteção vale para a chamada do navegador (com Origin); a de servidor (sem Origin, a
  // Central de Tickets) passa sem ela.
  it("do navegador, sem o cabeçalho x-backoffice ou de outra origem ⇒ 403; de servidor (sem Origin) passa", async () => {
    const { a, chave } = await comUmReembolso();
    const caminho = `/api/solicitacoes/${encodeURIComponent(chave)}/edicoes`;
    const corpo = { campos: { cod_nfd: "1" } };
    expect((await a.chamar("POST", caminho, { corpo, semProtecao: true, cabecalhos: { origin: URL_APP } })).status).toBe(403);
    expect((await a.chamar("POST", caminho, { corpo, semProtecao: true, cabecalhos: { "x-backoffice": "1", origin: "https://outro.site" } })).status).toBe(403);
    expect((await a.chamar("POST", caminho, { corpo, semProtecao: true, cabecalhos: { "x-backoffice": "1", origin: URL_APP } })).status).toBe(200);
    const doServidor = await a.chamar("POST", caminho, { corpo: { campos: { cod_nfd: "2" } }, semProtecao: true });
    expect(doServidor.status).toBe(200);
    expect(doServidor.json.code).toBe("OK");
  });

  it("reenvio: os SKUs (pelos itens do pedido) e a UF vão para a DAG; os dados do cliente ficam no app", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ tipo: "REENVIO", sku_produto_problema: "LC01002", produtos_reenvio: "LC01002 - 1", uf_destino: "SP" });
    await a.datamart.inserir(linha);
    await a.datamart.pedidoShopify({
      loja: "lescent", numero: Number(String(linha.numero_pedido).replace(/\D/g, "")), total: 69.9, frete: 0, desconto: 0,
      itens: [{ id: 501, sku: "LC01002", quantidade: 1, preco: 49.9 }, { id: 502, sku: "LC02002", quantidade: 2, preco: 10 }],
    });
    const chave = String(linha.chave_unica);
    const r = await a.editar(chave, {
      campos: { uf: "rj" },
      itens: { skus: { itens: [{ id: "502" }, { id: "501" }] }, produtos_reenvio: { itens: [{ id: "502", quantidade: 1 }] } },
      cliente: { nome: "Maria", cep: "20040-020", logradouro: "Rua A", numero: "10", cidade: "Rio de Janeiro" },
    });
    expect(r.status).toBe(200);
    expect(r.json.cliente).toMatchObject({ nome: "Maria", cep: "20040-020", cidade: "Rio de Janeiro", autor: EMAIL });
    expect(r.json.caso).toMatchObject({ sku_produto_problema: "LC01002;LC02002", produtos_reenvio: "LC02002 - 1", uf_destino: "RJ" });
    const [e] = await a.edicoes();
    // Nenhum dado pessoal na edição que vai à DAG.
    expect(JSON.parse(String(e.campos))).toEqual({ skus: "LC01002;LC02002", produtos_reenvio: "LC02002 - 1", uf: "RJ" });

    // Só o cliente mudou: nenhuma edição nova.
    const r2 = await a.editar(chave, { cliente: { nome: "Maria Souza", cep: "20040020" } });
    expect(r2.json.code).toBe("OK");
    expect(await a.edicoes()).toHaveLength(1);
    expect((await caso(a, chave)).json.cliente).toMatchObject({ nome: "Maria Souza", cep: "20040-020", logradouro: "" });
  });

  it("o caso mostra as edições guardadas e a gold com elas por cima", async () => {
    const { a, chave } = await comUmReembolso();
    await a.editar(chave, { campos: { cod_nfd: "NFD-1", data_execucao: "2026-11-09" } });
    a.relogio.avancar(60_000);
    await a.editar(chave, { campos: { status_execucao: "Cancelado" } });
    const r = await caso(a, chave);
    expect(r.status).toBe(200);
    expect(r.json.edicoes.map((e: { campos: object }) => e.campos)).toEqual([{ cod_nfd: "NFD-1", data_execucao: "2026-11-09" }, { status_execucao: "Cancelado" }]);
    // Cancelado não tem data de execução (a gold a deixa vazia), e o caso cancelado não se edita mais.
    expect(r.json.caso).toMatchObject({ status_execucao: "Cancelado", data_execucao: null, cod_nfd: "NFD-1", editavel: false });
    expect(r.json.cliente).toBeNull();
  });
});

describe("descartar", () => {
  it("desfaz a pendente; a enviada não volta (409)", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold();
    await a.datamart.inserir(linha);
    await a.editar(String(linha.chave_unica), { campos: { cod_nfd: "1" } });
    const [e] = await a.edicoes();
    expect((await a.chamar("DELETE", `/api/edicoes/${e.id_atualizacao}`)).status).toBe(200);
    expect(await a.edicoes()).toHaveLength(0);

    await a.editar(String(linha.chave_unica), { campos: { cod_nfd: "2" } });
    await a.cron();
    const [enviada] = await a.edicoes();
    expect(enviada.situacao).toBe("enviado");
    expect((await a.chamar("DELETE", `/api/edicoes/${enviada.id_atualizacao}`)).status).toBe(409);
    expect((await a.chamar("DELETE", "/api/edicoes/nao-existe")).status).toBe(404);
  });
});

describe("motivo da rota de dados", () => {
  it("o detalhe traz os motivos do tipo do caso (reembolso e reenvio têm listas próprias)", async () => {
    const a = await criarAmbiente();
    const reembolso = linhaGold();
    const reenvio = linhaGold({ tipo: "REENVIO" });
    await a.datamart.inserir(reembolso, reenvio);
    expect((await caso(a, String(reembolso.chave_unica))).json).toMatchObject({ motivos: MOTIVOS.reembolso, motivosErro: null });
    expect((await caso(a, String(reenvio.chave_unica))).json).toMatchObject({ motivos: MOTIVOS.reenvio, motivosErro: null });
  });

  it("motivo da lista vai à DAG; fora dela, 400; a lista é lida uma vez e guardada", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold();
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    expect((await a.editar(chave, { campos: { motivo: "Motivo inventado" } })).status).toBe(400);
    const r = await a.editar(chave, { campos: { motivo: "Arrependimento" } });
    expect(r.status).toBe(200);
    expect(JSON.parse(String((await a.edicoes())[0].campos))).toEqual({ motivo: "Arrependimento" });
    expect(a.rotaDados.chamadas).toBe(1);
  });

  it("rota de dados fora ou com credencial recusada: o drawer abre, avisa, e o motivo não muda (503)", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold();
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    a.rotaDados.proximaFalha = 503;
    expect((await caso(a, chave)).json).toMatchObject({ motivos: null, motivosErro: expect.stringContaining("HTTP 503") });
    a.rotaDados.proximaFalha = 503;
    expect((await a.editar(chave, { campos: { motivo: "Arrependimento" } })).status).toBe(503);

    const b = await criarAmbiente({ segredos: { FORM_DATA_GODEPLOY_KEY: "gdk_errada" } });
    const outra = linhaGold();
    await b.datamart.inserir(outra);
    expect((await caso(b, String(outra.chave_unica))).json.motivosErro).toContain("credencial");
  });
});

describe("itens do reembolso (o pedido da Shopify no Data Mart)", () => {
  // Dois itens (49,90 e 2 × 10,00), desconto de 6,99 rateado (4,99 e 2,00) e frete 2,90: total 65,81.
  async function comPedido(sobre: Record<string, string | number | boolean | null> = {}) {
    const a = await criarAmbiente();
    const linha = linhaGold({ status_execucao: null, valor_nf_tratado: 52.8, escopo_reembolso: "LC01002 - 1;Frete", ...sobre });
    await a.datamart.inserir(linha);
    await a.datamart.pedidoShopify({
      loja: "lescent", numero: Number(String(linha.numero_pedido).replace(/\D/g, "")), total: 65.81, frete: 2.9, desconto: 6.99,
      itens: [{ id: 501, sku: "LC01002", quantidade: 1, preco: 49.9 }, { id: 502, sku: "LC02002", quantidade: 2, preco: 10 }],
    });
    return { a, chave: String(linha.chave_unica) };
  }

  it("o detalhe traz os itens, o frete e o total do pedido", async () => {
    const { a, chave } = await comPedido();
    const d = (await caso(a, chave)).json;
    expect(d.pedidoErro).toBeNull();
    expect(d.pedido).toMatchObject({
      total: 65.81, frete: 2.9, desconto: 6.99,
      itens: [{ id: "501", sku: "LC01002", quantidade: 1, liquidoCentavos: 4491 }, { id: "502", sku: "LC02002", quantidade: 2, liquidoCentavos: 1800 }],
    });
  });

  const escopo = (itens: unknown, frete = false) => ({ itens: { escopo_reembolso: { itens, frete } } });

  it("marcar itens grava o escopo e o valor que o servidor calcula", async () => {
    const { a, chave } = await comPedido();
    const r = await a.editar(chave, escopo([{ id: "502", quantidade: 1 }], true));
    expect(r.status).toBe(200);
    expect(JSON.parse(String((await a.edicoes())[0].campos))).toEqual({ escopo_reembolso: "LC02002 - 1;Frete", valor: 11.9 });
    expect(r.json.caso).toMatchObject({ escopo_reembolso: "LC02002 - 1;Frete", valor_nf_tratado: 11.9 });
  });

  it("kit: o escopo leva os itens do kit, e o valor do item é a parte dele na linha, pelo preço de catálogo", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ status_execucao: null, valor_nf_tratado: 49.9, escopo_reembolso: "KS03041 - 1;KS03016 - 1" });
    await a.datamart.inserir(linha);
    await a.datamart.catalogo("lescent", [{ sku: "KS03041", nome: "Sérum Roll-on", preco: 24.9 }, { sku: "KS03016", nome: "Olhos de Gueixa", preco: 19.17 }]);
    await a.datamart.pedidoShopify({
      loja: "lescent", numero: Number(String(linha.numero_pedido).replace(/\D/g, "")), total: 49.9, frete: 0, desconto: 0,
      itens: [{ id: 800, sku: "KKS00104", quantidade: 1, preco: 49.9, componentes: [{ sku: "KS03041", quantidade: 1 }, { sku: "KS03016", quantidade: 1 }] }],
    });
    const chave = String(linha.chave_unica);
    // O registrado (os dois itens) é a mesma seleção: nada muda. Só o segundo: 49,90 × 1917/4407 = 21,71.
    expect((await a.editar(chave, escopo([{ id: "800.1", quantidade: 1 }, { id: "800.2", quantidade: 1 }]))).json.code).toBe("SEM_MUDANCA");
    expect((await a.editar(chave, escopo([{ id: "800", quantidade: 1 }]))).status).toBe(400);
    await a.editar(chave, escopo([{ id: "800.2", quantidade: 1 }]));
    expect(JSON.parse(String((await a.edicoes())[0].campos))).toEqual({ escopo_reembolso: "KS03016 - 1", valor: 21.71 });
  });

  it("a seleção do escopo registrado não muda nada (nem recalcula o valor registrado)", async () => {
    // O CX Hub registrou 52,80 (o preço cheio); pelos itens do Data Mart seriam 47,81, mas o escopo é o mesmo.
    const { a, chave } = await comPedido();
    const r = await a.editar(chave, escopo([{ id: "501", quantidade: 1 }], true));
    expect(r.json.code).toBe("SEM_MUDANCA");
    expect(await a.edicoes()).toHaveLength(0);
  });

  it("recusa escopo ou valor digitados, item de outro pedido, quantidade a mais, nada marcado e SKU de reenvio", async () => {
    const { a, chave } = await comPedido();
    for (const corpo of [
      { campos: { escopo_reembolso: "LC02002 - 2" } },
      { campos: { valor: "10,00" } },
      escopo([{ id: "999", quantidade: 1 }]),
      escopo([{ id: "502", quantidade: 3 }]),
      escopo([]),
      escopo("502"),
      { itens: { skus: { itens: [{ id: "501" }] } } },
      { itens: { outro: { itens: [] } } },
    ]) expect((await a.editar(chave, corpo)).status, JSON.stringify(corpo).slice(0, 80)).toBe(400);
    const reenvio = linhaGold({ tipo: "REENVIO" });
    await a.datamart.inserir(reenvio);
    expect((await a.editar(String(reenvio.chave_unica), escopo([], true))).status).toBe(400);
    expect(await a.edicoes()).toHaveLength(0);
  });

  it("exceção à política: o valor é digitado, até o total do pedido; os itens mudam só o escopo", async () => {
    const { a, chave } = await comPedido({ excecao_politica: true });
    const acima = await a.editar(chave, { campos: { valor: "65,82" } });
    expect(acima.status).toBe(400);
    expect(acima.json.message).toContain("65,81");
    expect((await a.editar(chave, { campos: { valor: "30,00" } })).status).toBe(200);
    a.relogio.avancar(1_000);
    await a.editar(chave, escopo([{ id: "502", quantidade: 2 }]));
    expect((await a.edicoes()).map(e => JSON.parse(String(e.campos)))).toEqual([{ valor: 30 }, { escopo_reembolso: "LC02002 - 2" }]);
  });

  it("pedido que o Data Mart não tem: o detalhe diz por quê, e escopo e valor não se editam (422)", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold();
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    expect((await caso(a, chave)).json).toMatchObject({ pedido: null, pedidoErro: expect.stringContaining("não encontrado") });
    expect((await a.editar(chave, escopo([], true))).status).toBe(422);
    const comExcecao = linhaGold({ excecao_politica: true });
    await a.datamart.inserir(comExcecao);
    expect((await a.editar(String(comExcecao.chave_unica), { campos: { valor: "10,00" } })).status).toBe(422);
    const gobeaute = linhaGold({ sigla: "GB", marca: "Gobeaute" });
    await a.datamart.inserir(gobeaute);
    expect((await caso(a, String(gobeaute.chave_unica))).json.pedidoErro).toContain("não está no Data Mart");
  });
});

describe("SKUs do reenvio (os itens do pedido da Shopify no Data Mart)", () => {
  // O CX Hub registrou um brinde que não é item do pedido (BB99040) no SKU do reenvio.
  async function comPedido() {
    const a = await criarAmbiente();
    const linha = linhaGold({ tipo: "REENVIO", sku_produto_problema: "LC01002", produtos_reenvio: "LC01002 - 1;BB99040 - 1" });
    await a.datamart.inserir(linha);
    await a.datamart.pedidoShopify({
      loja: "lescent", numero: Number(String(linha.numero_pedido).replace(/\D/g, "")), total: 69.9, frete: 0, desconto: 0,
      itens: [{ id: 501, sku: "LC01002", quantidade: 1, preco: 49.9 }, { id: 502, sku: "LC02002", quantidade: 2, preco: 10 }],
    });
    return { a, chave: String(linha.chave_unica) };
  }

  it("o detalhe do reenvio traz os itens do pedido", async () => {
    const { a, chave } = await comPedido();
    expect((await caso(a, chave)).json.pedido).toMatchObject({ itens: [{ id: "501", sku: "LC01002" }, { id: "502", sku: "LC02002", quantidade: 2 }] });
  });

  it("a seleção que o registrado já representa (com o brinde como mimo) não muda nada; outra seleção troca o texto", async () => {
    const { a, chave } = await comPedido();
    const mesma = {
      itens: { skus: { itens: [{ id: "501" }] }, produtos_reenvio: { itens: [{ id: "501", quantidade: 1 }], mimos: [{ sku: "BB99040", quantidade: 1 }] } },
    };
    expect((await a.editar(chave, mesma)).json.code).toBe("SEM_MUDANCA");
    const r = await a.editar(chave, { itens: { produtos_reenvio: { itens: [{ id: "501", quantidade: 1 }, { id: "502", quantidade: 2 }] } } });
    expect(r.status).toBe(200);
    expect(JSON.parse(String((await a.edicoes())[0].campos))).toEqual({ produtos_reenvio: "LC01002 - 1;LC02002 - 2" });
    expect(r.json.caso).toMatchObject({ sku_produto_problema: "LC01002", produtos_reenvio: "LC01002 - 1;LC02002 - 2" });
  });

  it("mimo: o detalhe traz o catálogo da marca (brindes primeiro); o novo tem de estar nele, o já registrado fica", async () => {
    const { a, chave } = await comPedido();
    await a.datamart.catalogo("lescent", [
      { sku: "LC01003", nome: "Perfume Ônix", preco: 129.9 },
      { sku: "LC99001", nome: "Necessaire Brinde", preco: 0.02, status: "unlisted" },
      { sku: "LC00000", nome: "Antigo", preco: 10, status: "archived" },
      { sku: "LC01001-OLD", nome: "Perfume antigo", preco: 99 },
    ]);
    const d = (await caso(a, chave)).json;
    expect(d.catalogoErro).toBeNull();
    expect(d.catalogo).toEqual([
      { sku: "LC99001", nome: "Necessaire Brinde", preco: 0.02, brinde: true },
      { sku: "LC01003", nome: "Perfume Ônix", preco: 129.9, brinde: false },
    ]);
    const r = await a.editar(chave, {
      itens: { produtos_reenvio: { itens: [{ id: "501", quantidade: 1 }], mimos: [{ sku: "BB99040", quantidade: 1 }, { sku: "LC99001", quantidade: 2 }] } },
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(String((await a.edicoes())[0].campos))).toEqual({ produtos_reenvio: "LC01002 - 1;BB99040 - 1;LC99001 - 2" });
    for (const mimos of [[{ sku: "LC77777", quantidade: 1 }], [{ sku: "LC00000", quantidade: 1 }]]) {
      const recusado = await a.editar(chave, { itens: { produtos_reenvio: { itens: [{ id: "501", quantidade: 1 }], mimos } } });
      expect(recusado.status).toBe(400);
      expect(recusado.json.message).toContain("fora do catálogo");
    }
    expect((await a.editar(chave, { itens: { skus: { itens: [{ id: "501" }], mimos: [{ sku: "LC99001", quantidade: 1 }] } } })).status).toBe(400);
  });

  it("o reenvio não traz o catálogo quando o pedido não se edita, e o reembolso nunca o traz", async () => {
    const a = await criarAmbiente();
    const reembolso = linhaGold();
    await a.datamart.inserir(reembolso);
    expect((await caso(a, String(reembolso.chave_unica))).json).toMatchObject({ catalogo: null, catalogoErro: null });
  });

  it("recusa SKU digitado, frete, quantidade a mais, nada marcado, item de outro pedido e escopo no reenvio", async () => {
    const { a, chave } = await comPedido();
    for (const corpo of [
      { campos: { skus: "LC02002" } },
      { campos: { produtos_reenvio: "LC02002 - 1" } },
      { itens: { produtos_reenvio: { itens: [{ id: "502", quantidade: 1 }], frete: true } } },
      { itens: { produtos_reenvio: { itens: [{ id: "502", quantidade: 3 }] } } },
      { itens: { produtos_reenvio: { itens: [{ id: "502" }] } } },
      { itens: { skus: { itens: [] } } },
      { itens: { skus: { itens: [{ id: "999" }] } } },
      { itens: { escopo_reembolso: { itens: [{ id: "501", quantidade: 1 }] } } },
    ]) expect((await a.editar(chave, corpo)).status, JSON.stringify(corpo).slice(0, 90)).toBe(400);
    expect(await a.edicoes()).toHaveLength(0);
  });

  it("kit: o detalhe traz os itens (nome e peso pelo catálogo); o SKU do kit não se marca, o item sim", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ tipo: "REENVIO", sku_produto_problema: "KKS00107", produtos_reenvio: "KS03016 - 1;KS03043 - 1" });
    await a.datamart.inserir(linha);
    await a.datamart.catalogo("lescent", [{ sku: "KS03016", nome: "Olhos de Gueixa", preco: 19.17 }]);
    await a.datamart.pedidoShopify({
      loja: "lescent", numero: Number(String(linha.numero_pedido).replace(/\D/g, "")), total: 89.9, frete: 0, desconto: 0,
      itens: [{ id: 700, sku: "KKS00107", quantidade: 1, preco: 89.9, componentes: [{ sku: "KS03016", quantidade: 1 }, { sku: "KS03043", quantidade: 1, alocado: 34.57 }] }],
    });
    const chave = String(linha.chave_unica);
    expect((await caso(a, chave)).json.pedido.itens).toEqual([
      expect.objectContaining({ id: "700", sku: "KKS00107", componentes: [
        { sku: "KS03016", nome: "Olhos de Gueixa", quantidade: 1, peso: 1917 },
        { sku: "KS03043", nome: "", quantidade: 1, peso: 3457 },
      ] }),
    ]);
    const mesma = { itens: { produtos_reenvio: { itens: [{ id: "700.1", quantidade: 1 }, { id: "700.2", quantidade: 1 }] } } };
    expect((await a.editar(chave, mesma)).json.code).toBe("SEM_MUDANCA");
    expect((await a.editar(chave, { itens: { skus: { itens: [{ id: "700" }] } } })).status).toBe(400);
    await a.editar(chave, { itens: { skus: { itens: [{ id: "700.2" }] }, produtos_reenvio: { itens: [{ id: "700.2", quantidade: 1 }] } } });
    expect(JSON.parse(String((await a.edicoes())[0].campos))).toEqual({ skus: "KS03043", produtos_reenvio: "KS03043 - 1" });
  });

  it("pedido que o dbt ainda não explodiu (as últimas horas): os itens não se marcam (422)", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ tipo: "REENVIO", sku_produto_problema: "LC01002" });
    await a.datamart.inserir(linha);
    await a.datamart.pedidoShopify({
      loja: "lescent", numero: Number(String(linha.numero_pedido).replace(/\D/g, "")), total: 49.9, frete: 0, desconto: 0, semExplosao: true,
      itens: [{ id: 501, sku: "LC01002", quantidade: 1, preco: 49.9 }],
    });
    const chave = String(linha.chave_unica);
    expect((await caso(a, chave)).json).toMatchObject({ pedido: null, pedidoErro: expect.stringContaining("ainda não chegaram") });
    expect((await a.editar(chave, { itens: { skus: { itens: [{ id: "501" }] } } })).status).toBe(422);
  });

  it("sem o pedido no Data Mart, os SKUs não se marcam (422)", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ tipo: "REENVIO", sku_produto_problema: "LC01002" });
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    expect((await caso(a, chave)).json.pedidoErro).toContain("não encontrado");
    expect((await a.editar(chave, { itens: { skus: { itens: [{ id: "501" }] } } })).status).toBe(422);
  });
});

describe("o que não se edita mais (decisão de 11/11/2026)", () => {
  it("reembolso já efetuado (Realizado no Metabase): só leitura, e a edição é recusada (422)", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ status_execucao: "Realizado", data_execucao: "2026-11-09" });
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    const [item] = (await lista(a, "tipo=REEMBOLSO")).json.itens;
    expect(item).toMatchObject({ editavel: false, bloqueio: expect.stringContaining("Reembolso já efetuado") });
    expect((await caso(a, chave)).json).toMatchObject({ caso: { editavel: false }, motivos: null, pedido: null });
    const r = await a.editar(chave, { campos: { cod_nfd: "123" } });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ code: "NOT_EDITABLE", message: expect.stringContaining("Reembolso já efetuado") });
    expect(await a.edicoes()).toHaveLength(0);
  });

  it("marcar o reembolso como Realizado aqui já trava; desfazer a edição pendente destrava", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ status_execucao: null });
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    expect((await a.editar(chave, { campos: { status_execucao: "Realizado" } })).json.caso).toMatchObject({ editavel: false });
    expect((await a.editar(chave, { campos: { cod_nfd: "123" } })).status).toBe(422);
    const [e] = await a.edicoes();
    expect((await a.chamar("DELETE", `/api/edicoes/${e.id_atualizacao}`)).status).toBe(200);
    expect((await caso(a, chave)).json.caso).toMatchObject({ editavel: true, bloqueio: null });
  });

  it("caso cancelado (no Metabase), reenvio ou reembolso: só leitura, e a edição é recusada (422)", async () => {
    const a = await criarAmbiente();
    const reembolso = linhaGold({ status_execucao: "Cancelado" });
    const reenvio = linhaGold({ tipo: "REENVIO", status_execucao: "Cancelado" });
    await a.datamart.inserir(reembolso, reenvio);
    for (const linha of [reembolso, reenvio]) {
      const chave = String(linha.chave_unica);
      expect((await caso(a, chave)).json.caso).toMatchObject({ editavel: false, bloqueio: expect.stringContaining("cancelada") });
      expect((await a.editar(chave, { campos: { status_execucao: "Pendente" } })).status).toBe(422);
    }
    expect(await a.edicoes()).toHaveLength(0);
  });

  it("marcar o reenvio como Cancelado aqui já trava; desfazer a edição pendente destrava", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ tipo: "REENVIO" });
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    expect((await a.editar(chave, { campos: { status_execucao: "Cancelado" } })).json.caso).toMatchObject({ editavel: false });
    expect((await a.editar(chave, { campos: { cod_nfd: "1" } })).status).toBe(422);
    const [e] = await a.edicoes();
    expect((await a.chamar("DELETE", `/api/edicoes/${e.id_atualizacao}`)).status).toBe(200);
    expect((await caso(a, chave)).json.caso).toMatchObject({ editavel: true });
  });

  it("reenvio que o Cosmos já registrou (criado pela automação do CX Hub): só leitura; o outro reenvio se edita", async () => {
    const a = await criarAmbiente();
    const noCosmos = linhaGold({ tipo: "REENVIO", responsavel_execucao: "Automação" });
    const manual = linhaGold({ tipo: "REENVIO" });
    await a.datamart.inserir(noCosmos, manual);
    const itens = (await lista(a, "tipo=REENVIO")).json.itens as Array<Record<string, unknown>>;
    expect(itens.find(i => i.chave_unica === noCosmos.chave_unica))
      .toMatchObject({ reenvio_no_cosmos: true, editavel: false, bloqueio: expect.stringContaining("Cosmos já registrou") });
    expect(itens.find(i => i.chave_unica === manual.chave_unica)).toMatchObject({ reenvio_no_cosmos: false, editavel: true });
    expect((await a.editar(String(noCosmos.chave_unica), { campos: { cod_nfd: "1" } })).status).toBe(422);
    expect((await a.editar(String(manual.chave_unica), { campos: { cod_nfd: "1" } })).status).toBe(200);
  });

  it("a trava do Cosmos vem da criação na raw: uma atualização que troca o responsável não destrava", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ tipo: "REENVIO", responsavel_execucao: "Automação" });
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    await a.datamart.evento({
      id: chave.slice("cxhub|".length), tipo: "atualizacao", carregadoEm: "2026-11-10T13:00:00Z",
      payload: { id_atualizacao: "u1", status_execucao: "Cancelado", responsavel_execucao: "Ana Souza" },
    });
    expect((await caso(a, chave)).json.caso).toMatchObject({ responsavel_execucao: "Ana Souza", reenvio_no_cosmos: true, editavel: false });
  });
});
