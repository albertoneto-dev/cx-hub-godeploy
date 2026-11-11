// A lista e o caso lendo gold + raw (servidor/raw.ts): o caso que a gold ainda não tem, a atualização que ela ainda não
// mostra, e as regras do dbt que a remontagem tem de repetir para o valor de agora ser o que a gold vai mostrar.

import { describe, expect, it } from "vitest";
import { sqlDaContagem, sqlDaPagina, sqlDoCaso } from "../servidor/gold";
import { criarAmbiente, linhaGold, type Ambiente } from "./ambiente";

const lista = async (a: Ambiente, q: string) => (await a.chamar("GET", `/api/solicitacoes?${q}`)).json;
const caso = async (a: Ambiente, chave: string) => (await a.chamar("GET", `/api/solicitacoes/${encodeURIComponent(chave)}`)).json;

describe("caso que só a raw tem (o dbt ainda não rodou)", () => {
  it("aparece na lista, na contagem e no caso, com as colunas como o dbt as monta", async () => {
    const a = await criarAmbiente();
    await a.datamart.inserir(linhaGold({ data_solicitacao: "2026-11-10 08:00:00" }));
    await a.datamart.evento({
      id: "novo-1",
      tipo: "caso",
      carregadoEm: "2026-11-10T14:40:00Z",
      payload: {
        id_solicitacao: "novo-1", tipo: "reembolso", marca: "barbours", criado_em: "2026-11-10T14:05:03.120Z",
        numero_pedido: " SH9001BB ", valor: "R$ 1.234,56", motivo: "  Produto avariado ", pedido_completo: true,
        devolucao: false, responsavel: "ana   silva", origem: "Chat Atendimento", id_atendimento: "https://app/conversations/123",
        data_pedido: "31/10/2026", status_pedido: "-", transportadora: "J&T", escopo_reembolso: "BB01 - 1;Frete",
        excecao_politica: false, skus: "SKU1", produtos_reenvio: "SKU1 - 1",
      },
    });
    const p = await lista(a, "tipo=REEMBOLSO&contar=1");
    expect(p.total).toBe(2);
    expect(p.itens[0]).toMatchObject({
      chave_unica: "cxhub|novo-1", sistema_origem: "CX Hub", tipo: "REEMBOLSO", marca: "Barbour's", sigla: "BB",
      // 14:05:03Z em Fortaleza, no segundo.
      data_solicitacao: "2026-11-10T11:05:03.000000",
      numero_pedido: "SH9001BB", valor_nf_tratado: 1234.56, motivo: "Produto avariado", parcial_completo: "Sim",
      pedido_devolvido_operacao: "Não", responsavel_atendimento: "Ana Silva", origem_solicitacao: "Chat Atendimento",
      id_atendimento: "123", data_pedido: "2026-10-31", status_ocorrencia: "", transportadora: "J&T",
      escopo_reembolso: "BB01 - 1;Frete", excecao_politica: false,
      // Fora do reenvio, o SKU é '-' e os campos do reenvio ficam nulos (regra do int).
      sku_produto_problema: "-", produtos_reenvio: null, status_execucao: null, area: null,
      carregado_em: "2026-11-10T14:40:00Z", editavel: true,
    });
    expect((await caso(a, "cxhub|novo-1")).caso).toMatchObject({ marca: "Barbour's", valor_nf_tratado: 1234.56 });
    expect((await lista(a, "tipo=REEMBOLSO&marca=BB")).itens.map((x: { chave_unica: string }) => x.chave_unica)).toEqual(["cxhub|novo-1"]);
    expect((await lista(a, "tipo=REEMBOLSO&busca=sh9001")).itens).toHaveLength(1);
  });

  it("reenvio da automação nasce com o responsável 'Automação'; marca sem Cosmos ganha o ERP fixo", async () => {
    const a = await criarAmbiente();
    await a.datamart.evento({
      id: "novo-2", tipo: "caso", carregadoEm: "2026-11-10T14:40:00Z",
      payload: { tipo: "REENVIO", marca: "apice", criado_em: "2026-11-10T10:00:00-03:00", numero_pedido: "SH10AP", automacao: true, erp: "", skus: "A , B / C" },
    });
    const [x] = (await lista(a, "tipo=REENVIO")).itens;
    expect(x).toMatchObject({ marca: "Ápice", sigla: "AP", responsavel_execucao: "Automação", erp: "Tiny", sku_produto_problema: "A;B;C", escopo_reembolso: null });
  });

  it("origem Vendah não entra (como no dbt)", async () => {
    const a = await criarAmbiente();
    await a.datamart.evento({
      id: "vendah-1", tipo: "caso", carregadoEm: "2026-11-10T14:40:00Z",
      payload: { tipo: "REEMBOLSO", marca: "lescent", criado_em: "2026-11-10T10:00:00-03:00", numero_pedido: "SH1LE", origem: "Vendah" },
    });
    expect((await lista(a, "tipo=REEMBOLSO&contar=1")).total).toBe(0);
  });
});

describe("caso da gold que a raw já mudou", () => {
  async function comCaso(sobre: Record<string, string | number | null> = {}) {
    const a = await criarAmbiente();
    const linha = linhaGold({ status_execucao: null, transportadora: "Loggi", area: "Logística", _loaded_at: "2026-11-10T13:20:00Z", ...sobre });
    await a.datamart.inserir(linha);
    return { a, chave: String(linha.chave_unica), id: String(linha.chave_unica).slice("cxhub|".length) };
  }

  it("a atualização nova vale na lista e no filtro; o que ela não trouxe fica como na gold", async () => {
    const { a, chave, id } = await comCaso();
    await a.datamart.evento({ id, tipo: "atualizacao", carregadoEm: "2026-11-10T14:40:00Z", disparadoEm: "2026-11-10T14:30:00Z", payload: { id_solicitacao: id, status_execucao: "realizado", responsavel_execucao: "joana", data_execucao: "10/11/2026" } });
    const [x] = (await lista(a, "tipo=REEMBOLSO&status=Realizado")).itens;
    expect(x).toMatchObject({ chave_unica: chave, status_execucao: "Realizado", responsavel_execucao: "Joana", data_execucao: "2026-11-10", transportadora: "Loggi", area: "Logística" });
    expect((await lista(a, "tipo=REEMBOLSO&status=sem_status")).itens).toHaveLength(0);
    expect((await caso(a, chave)).caso).toMatchObject({ status_execucao: "Realizado" });
  });

  it("evento que a gold já mostra não muda nada (o status da gold, vindo do Cosmos, vale)", async () => {
    const { a, id } = await comCaso({ status_execucao: "Pendente" });
    await a.datamart.evento({ id, tipo: "atualizacao", carregadoEm: "2026-11-10T13:00:00Z", payload: { status_execucao: "Realizado" } });
    const [x] = (await lista(a, "tipo=REEMBOLSO")).itens;
    expect(x).toMatchObject({ status_execucao: "Pendente", carregado_em: "2026-11-10T13:20:00Z" });
  });

  it("atualização vence criação: a criação reenviada não desfaz a atualização, mas muda o que só ela trouxe", async () => {
    const { a, id } = await comCaso({ status_execucao: "Cancelado", motivo: "Antigo" });
    await a.datamart.evento({ id, tipo: "atualizacao", carregadoEm: "2026-11-10T13:00:00Z", payload: { status_execucao: "Cancelado" } });
    // O CX Hub redispara a criação depois (motivo novo, sem status).
    await a.datamart.evento({
      id, tipo: "caso", carregadoEm: "2026-11-10T14:40:00Z",
      payload: { tipo: "REEMBOLSO", marca: "lescent", criado_em: "2026-11-10T09:00:00-03:00", numero_pedido: "SH1LE", motivo: "Novo" },
    });
    const [x] = (await lista(a, "tipo=REEMBOLSO")).itens;
    expect(x).toMatchObject({ status_execucao: "Cancelado", motivo: "Novo" });
  });

  it("sem data do pedido no payload, a coorte é a da gold (a criação do pedido na Shopify)", async () => {
    const { a, id } = await comCaso({ data_pedido_original_coorte: "2026-10-28" });
    await a.datamart.evento({ id, tipo: "atualizacao", carregadoEm: "2026-11-10T14:40:00Z", payload: { cod_nfd: "9" } });
    const [x] = (await lista(a, "tipo=REEMBOLSO")).itens;
    expect(x).toMatchObject({ cod_nfd: "9", data_pedido: "2026-10-28" });
  });

  it("Cancelado não tem data de execução", async () => {
    const { a, id } = await comCaso({ status_execucao: "Realizado", data_execucao: "2026-11-09" });
    await a.datamart.evento({ id, tipo: "atualizacao", carregadoEm: "2026-11-10T14:40:00Z", payload: { status_execucao: "Cancelado" } });
    const [x] = (await lista(a, "tipo=REEMBOLSO")).itens;
    expect(x).toMatchObject({ status_execucao: "Cancelado", data_execucao: null });
  });

  it("no mesmo disparo, a posição maior no conf vence", async () => {
    const { a, id } = await comCaso();
    await a.datamart.evento({ id, tipo: "atualizacao", carregadoEm: "2026-11-10T14:40:00Z", disparadoEm: "2026-11-10T14:30:00Z", posicao: 1, payload: { cod_nfd: "B" } });
    await a.datamart.evento({ id, tipo: "atualizacao", carregadoEm: "2026-11-10T14:40:00Z", disparadoEm: "2026-11-10T14:30:00Z", posicao: 0, payload: { cod_nfd: "A" } });
    expect((await lista(a, "tipo=REEMBOLSO")).itens[0].cod_nfd).toBe("B");
  });

  it("caso sem criação na raw (não deveria existir) fica como na gold, em vez de sumir", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ status_execucao: null });
    await a.datamart.inserir(linha);
    const id = String(linha.chave_unica).slice("cxhub|".length);
    await a.datamart.pg.exec("delete from raw.cxhub_reenvio_reembolso_eventos");
    await a.datamart.evento({ id, tipo: "atualizacao", carregadoEm: "2026-11-10T14:40:00Z", payload: { status_execucao: "Realizado" } });
    const [x] = (await lista(a, "tipo=REEMBOLSO")).itens;
    expect(x).toMatchObject({ chave_unica: linha.chave_unica, status_execucao: null });
  });
});

describe("paginação com gold e raw juntas", () => {
  it("nenhuma linha pula nem se repete, e a contagem soma as duas", async () => {
    const a = await criarAmbiente();
    for (let i = 0; i < 60; i++)
      await a.datamart.inserir(linhaGold({ data_solicitacao: `2026-11-0${1 + (i % 9)} 08:${String(i).padStart(2, "0")}:00` }));
    for (let i = 0; i < 15; i++)
      await a.datamart.evento({
        id: `fresco-${i}`, tipo: "caso", carregadoEm: "2026-11-10T14:40:00Z",
        payload: { tipo: "REEMBOLSO", marca: "kokeshi", criado_em: `2026-11-0${1 + (i % 9)}T08:${String(i).padStart(2, "0")}:00-03:00`, numero_pedido: `SH${i}KO` },
      });
    const p1 = await lista(a, "tipo=REEMBOLSO&contar=1");
    expect(p1.total).toBe(75);
    const p2 = await lista(a, `tipo=REEMBOLSO&cursor=${p1.proximo}`);
    const chaves = [...p1.itens, ...p2.itens].map((x: { chave_unica: string }) => x.chave_unica);
    expect(chaves).toHaveLength(75);
    expect(new Set(chaves).size).toBe(75);
    expect(chaves.filter(c => c.startsWith("cxhub|fresco-"))).toHaveLength(15);
  });
});

it("o SQL não tem '?' fora de literal (o JDBC do Metabase o leria como parâmetro)", () => {
  const filtro = { tipo: "REEMBOLSO" as const, sigla: "BB", status: "sem_status" as const, busca: "a?b" };
  for (const sql of [sqlDaPagina(filtro, { d: "2026-11-10T10:00:00.000000", c: "cxhub|x" }, 50), sqlDaContagem(filtro), sqlDoCaso("cxhub|x")]) {
    const semLiterais = sql.replace(/'(?:[^']|'')*'/g, "''");
    expect(semLiterais).not.toContain("?");
  }
});
