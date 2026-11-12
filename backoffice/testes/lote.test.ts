// A edição na fila do app (fila única, backoffice/ORIGEM.md): a rodada do cron é a da fila (servidor/lote.ts da raiz),
// contra o Airflow falso e o Data Mart falso, com a etapa do backoffice (servidor/conferencia.ts) ligada como no
// worker.ts. O ciclo de uma edição, as recusas, as falhas do run, a DAG pausada, a conferência na raw, o caso que ainda
// está na fila e as atualizações do CX Hub por cima.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MINUTOS_10, criarAmbiente, linhaGold, type Ambiente } from "./ambiente";

async function comEdicao(campos: Record<string, unknown> = { status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva" }) {
  const a = await criarAmbiente();
  const linha = linhaGold({ status_execucao: null });
  await a.datamart.inserir(linha);
  const chave = String(linha.chave_unica);
  const r = await a.editar(chave, { campos });
  expect(r.status).toBe(200);
  return { a, chave };
}

const lista = async (a: Ambiente, q = "tipo=REEMBOLSO") => (await a.chamar("GET", `/api/solicitacoes?${q}`)).json;
const detalhe = async (a: Ambiente, chave: string) => (await a.chamar("GET", `/api/solicitacoes/${encodeURIComponent(chave)}`)).json;

describe("o ciclo de uma edição", () => {
  it("pendente → enviado (no lote da fila) → gravado (XCom) → conferida na raw; a lista não espera o dbt", async () => {
    const { a, chave } = await comEdicao();

    // 1ª rodada: a fila dispara o lote com a edição (uma atualização como as do CX Hub).
    const { disparo, runId, run } = await a.rodadaComDag();
    expect(disparo.status).toBe(200);
    expect(disparo.json.disparo).toMatchObject({ estado: "disparado", casos: 0, atualizacoes: 1 });
    expect(disparo.json.backoffice).toMatchObject({ conferencia: { estado: "nada" } });
    expect(runId).toBe("cxhub_lote__20261110T150000");
    expect(run!.conf).toEqual({
      casos: [],
      atualizacoes: [{
        status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva",
        id_solicitacao: chave.slice("cxhub|".length), id_atualizacao: "00000000-0000-4000-8000-000000000001",
        atualizado_em: "2026-11-10T15:00:00.000Z",
      }],
    });
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "enviado", lote_id: runId, posicao: 0, conferida: null });

    // Antes da 2ª rodada, a lista mostra a edição por cima do Metabase.
    const [antes] = (await lista(a)).itens;
    expect(antes).toMatchObject({ status_execucao: "Realizado", aguardando: { situacao: "enviado" } });

    // 2ª rodada: lê o XCom (gravado), e a raw já tem o evento: a conferência o vê na mesma rodada.
    a.relogio.avancar(MINUTOS_10);
    const r2 = await a.cron();
    expect(r2.json.andamento).toMatchObject({ lote: runId, estado: "success", gravados: 1, recusados: 0 });
    expect(r2.json.backoffice.conferencia).toMatchObject({ estado: "conferido", naRaw: 1, esperando: 0 });
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "gravado", conferida: "na_raw" });
    // O dbt ainda não rodou (a gold não mudou), e a lista já mostra a edição, lida da raw, sem nada por cima.
    expect((await a.datamart.gold(chave))?.status_execucao).toBeNull();
    const [daRaw] = (await lista(a)).itens;
    expect(daRaw).toMatchObject({
      status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva", aguardando: null,
      carregado_em: "2026-11-10T15:12:00Z",
    });
    expect((await detalhe(a, chave)).edicoes).toEqual([]);
    expect((await lista(a, "tipo=REEMBOLSO&status=sem_status")).itens).toHaveLength(0);

    // O dbt roda: a gold mostra o mesmo.
    await a.datamart.dbt();
    const [daGold] = (await lista(a)).itens;
    expect(daGold).toMatchObject({ status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva", aguardando: null });
    expect(a.avisos()).toEqual([]);
  });

  it("várias edições do mesmo caso vão no mesmo lote, na ordem em que foram feitas", async () => {
    const { a, chave } = await comEdicao({ status_execucao: "Pendente" });
    a.relogio.avancar(1_000);
    await a.editar(chave, { campos: { status_execucao: "Realizado" } });
    const { run } = await a.rodadaComDag();
    expect(run!.conf.atualizacoes.map((x: { status_execucao: string }) => x.status_execucao)).toEqual(["Pendente", "Realizado"]);
    a.relogio.avancar(MINUTOS_10);
    await a.cron();
    await a.datamart.dbt();
    expect((await a.datamart.gold(chave))?.status_execucao).toBe("Realizado");
  });

  it("sem nada na fila, nada é disparado", async () => {
    const a = await criarAmbiente();
    const r = await a.cron();
    expect(r.json).toMatchObject({ code: "OK", disparo: { estado: "vazio" }, backoffice: { conferencia: { estado: "nada" } } });
    expect(a.airflow.runs.size).toBe(0);
  });
});

describe("o caso que ainda está na fila (a raw ainda não o tem)", () => {
  // Um reembolso como o CX Hub o manda à fila: aberto hoje, 11h30 em São Paulo.
  const novoCaso = () => ({
    id_solicitacao: randomUUID(), tipo: "REEMBOLSO", marca: "lescent", criado_em: "2026-11-10T11:30:00-03:00",
    numero_pedido: "SH7001LE", valor: 79.9, motivo: "Produto avariado/extraviado", responsavel: "Bruno",
  });

  it("aparece na lista e no drawer, se edita, e a edição sobe no mesmo lote, depois do caso", async () => {
    const a = await criarAmbiente();
    await a.datamart.inserir(linhaGold());
    const novo = novoCaso();
    expect((await a.fila("POST", "/api/v1/casos", { casos: [novo] })).json.code).toBe("ENFILEIRADO");
    const chave = `cxhub|${novo.id_solicitacao}`;

    // A lista o mostra montado pelas regras do dbt, como se já estivesse na raw (o filtro e a contagem valem para ele),
    // no topo: é o mais recente.
    const p = await lista(a, "tipo=REEMBOLSO&contar=1");
    expect(p.total).toBe(2);
    expect(p.itens[0]).toMatchObject({
      chave_unica: chave, sistema_origem: "CX Hub", marca: "Lescent", sigla: "LE", numero_pedido: "SH7001LE",
      valor_nf_tratado: 79.9, motivo: "Produto avariado/extraviado", responsavel_atendimento: "Bruno",
      data_solicitacao: "2026-11-10T11:30:00.000000", editavel: true, aguardando: null,
    });
    expect((await lista(a, "tipo=REEMBOLSO&busca=SH7001")).itens.map((x: { chave_unica: string }) => x.chave_unica)).toEqual([chave]);
    expect((await lista(a, "tipo=REENVIO&contar=1")).total).toBe(0);
    expect((await detalhe(a, chave)).caso).toMatchObject({ chave_unica: chave, editavel: true });

    // A edição entra na fila ao lado do caso, e o lote leva os dois: a criação antes da alteração.
    const r = await a.editar(chave, { campos: { status_execucao: "Realizado", data_execucao: "2026-11-10" } });
    expect(r.status).toBe(200);
    expect(r.json.caso).toMatchObject({ status_execucao: "Realizado", aguardando: { situacao: "pendente" } });
    const { disparo, run } = await a.rodadaComDag();
    expect(disparo.json.disparo).toMatchObject({ estado: "disparado", casos: 1, atualizacoes: 1 });
    expect(run!.conf.casos.map((x: { id_solicitacao: string }) => x.id_solicitacao)).toEqual([novo.id_solicitacao]);
    expect(run!.conf.atualizacoes).toEqual([expect.objectContaining({ id_solicitacao: novo.id_solicitacao, status_execucao: "Realizado" })]);

    // A DAG gravou o caso e a edição: a lista os lê da raw de verdade (uma linha só), sem nada por cima.
    a.relogio.avancar(MINUTOS_10);
    expect((await a.cron()).json.backoffice.conferencia).toMatchObject({ naRaw: 1 });
    const depois = await lista(a, "tipo=REEMBOLSO&contar=1");
    expect(depois.total).toBe(2);
    expect(depois.itens[0]).toMatchObject({ chave_unica: chave, status_execucao: "Realizado", data_execucao: "2026-11-10", aguardando: null });
  });

  it("o caso que a DAG recusou sai da lista, e a edição dele é recusada pela fila", async () => {
    const a = await criarAmbiente();
    const novo = novoCaso();
    await a.fila("POST", "/api/v1/casos", { casos: [novo] });
    const chave = `cxhub|${novo.id_solicitacao}`;
    await a.cron();
    const [runId] = a.airflow.ultimo();
    // A edição chega com o caso já num lote em andamento: espera o resultado dele.
    await a.editar(chave, { campos: { status_execucao: "Realizado" } });
    a.airflow.terminar(runId, "success", { casos: { gravados: [], recusados: [{ posicao: 0, id_solicitacao: novo.id_solicitacao, erro: "marca sem Cosmos" }] }, atualizacoes: { gravados: [], recusados: [] } });
    a.relogio.avancar(MINUTOS_10);
    await a.cron();
    expect((await lista(a, "tipo=REEMBOLSO&contar=1")).total).toBe(0);
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "recusado", erro: expect.stringContaining("o caso foi recusado") });
  });
});

describe("as atualizações do CX Hub na mesma fila", () => {
  it("a atualização ainda na fila aparece por cima, com o autor CX Hub, e não se desfaz aqui (403)", async () => {
    const a = await criarAmbiente();
    const linha = linhaGold({ status_execucao: null });
    await a.datamart.inserir(linha);
    const chave = String(linha.chave_unica);
    const id = randomUUID();
    const r = await a.fila("POST", "/api/v1/atualizacoes", {
      atualizacoes: [{ id_atualizacao: id, id_solicitacao: chave.slice("cxhub|".length), atualizado_em: "2026-11-10T11:50:00-03:00", campos: { status_execucao: "Cancelado" } }],
    });
    expect(r.json.code).toBe("ENFILEIRADO");

    const d = await detalhe(a, chave);
    expect(d.edicoes).toEqual([expect.objectContaining({
      id, autor: "CX Hub", doBackoffice: false, situacao: "pendente", campos: { status_execucao: "Cancelado" }, atualizadoEm: "2026-11-10T14:50:00.000Z",
    })]);
    // O caso que o CX Hub está cancelando já trava aqui.
    expect(d.caso).toMatchObject({ status_execucao: "Cancelado", editavel: false, aguardando: { situacao: "pendente", autor: "CX Hub" } });
    expect((await a.editar(chave, { campos: { cod_nfd: "1" } })).status).toBe(422);
    const apagar = await a.chamar("DELETE", `/api/edicoes/${id}`);
    expect(apagar.status).toBe(403);
    expect(apagar.json.message).toContain("CX Hub");
    expect(await a.deps.db.um("SELECT situacao FROM atualizacoes WHERE id_atualizacao = ?", [id])).toMatchObject({ situacao: "pendente" });
  });

  it("a edição do backoffice e a do CX Hub sobem no mesmo lote, na ordem do atualizado_em", async () => {
    const { a, chave } = await comEdicao({ cod_nfd: "NFD-1" });
    await a.fila("POST", "/api/v1/atualizacoes", {
      atualizacoes: [{ id_atualizacao: randomUUID(), id_solicitacao: chave.slice("cxhub|".length), atualizado_em: "2026-11-10T11:59:00-03:00", campos: { responsavel_execucao: "Carla" } }],
    });
    const { run } = await a.rodadaComDag();
    expect(run!.conf.atualizacoes.map((x: Record<string, unknown>) => x.cod_nfd ?? x.responsavel_execucao)).toEqual(["Carla", "NFD-1"]);
  });
});

describe("recusas e falhas", () => {
  it("a DAG recusa ⇒ recusada com o motivo, sem efeito na lista, com aviso; some depois de 7 dias", async () => {
    const { a, chave } = await comEdicao({ cod_nfd: "NFD-1" });
    await a.rodadaComDag({ recusadas: { 0: "caso inexistente: nenhuma criação com esse id_solicitacao" } });
    a.relogio.avancar(MINUTOS_10);
    const r = await a.cron();
    expect(r.json.andamento).toMatchObject({ gravados: 0, recusados: 1 });
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "recusado", erro: "caso inexistente: nenhuma criação com esse id_solicitacao" });
    const d = await detalhe(a, chave);
    expect(d.caso).toMatchObject({ cod_nfd: null, aguardando: null, recusada: { erro: expect.stringContaining("caso inexistente") } });
    expect(d.edicoes).toEqual([expect.objectContaining({ situacao: "recusado", doBackoffice: true })]);
    expect(a.avisos().join("\n")).toContain("caso inexistente");

    // 8 dias depois, a limpeza da fila a apaga, e a do backoffice apaga a autoria.
    const [e] = await a.edicoes();
    a.relogio.avancar(8 * 24 * 60 * 60_000);
    await a.cron();
    expect(await a.edicoes()).toHaveLength(0);
    expect(await a.deps.db.query("SELECT * FROM bo_autoria")).toHaveLength(0);
    expect((await a.chamar("DELETE", `/api/edicoes/${e.id_atualizacao}`)).status).toBe(404);
  });

  it("dispensar a recusada a tira da fila e da tela", async () => {
    const { a, chave } = await comEdicao({ cod_nfd: "NFD-1" });
    await a.rodadaComDag({ recusadas: { 0: "valor acima do pedido" } });
    a.relogio.avancar(MINUTOS_10);
    await a.cron();
    const [e] = await a.edicoes();
    expect((await a.chamar("DELETE", `/api/edicoes/${e.id_atualizacao}`)).status).toBe(200);
    expect(await a.edicoes()).toHaveLength(0);
    expect((await detalhe(a, chave)).caso).toMatchObject({ recusada: null });
  });

  it("run que falhou sem XCom: clear uma vez; falhou de novo, a edição volta à fila e, na segunda vez, é recusada", async () => {
    const { a } = await comEdicao();
    await a.cron();
    const [runId] = a.airflow.ultimo();
    a.airflow.terminar(runId, "failed");
    a.relogio.avancar(MINUTOS_10);
    expect((await a.cron()).json.andamento).toMatchObject({ estado: "failed", acao: "clear" });
    expect(a.airflow.runs.get(runId)!.clears).toBe(1);

    a.airflow.terminar(runId, "failed");
    a.relogio.avancar(MINUTOS_10);
    const r = await a.cron();
    expect(r.json.andamento).toMatchObject({ estado: "sem_resultado", devolvidos: 1 });
    // Na mesma rodada, a edição devolvida já vai num lote novo.
    expect(r.json.disparo).toMatchObject({ estado: "disparado" });
    const [segundo] = a.airflow.ultimo();
    expect(segundo).not.toBe(runId);
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "enviado", tentativas: 1 });

    a.airflow.terminar(segundo, "failed");
    a.relogio.avancar(MINUTOS_10);
    await a.cron();
    a.airflow.terminar(segundo, "failed");
    a.relogio.avancar(MINUTOS_10);
    await a.cron();
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "recusado", erro: expect.stringContaining("dois lotes falharam") });
  });

  it("DAG pausada ou Airflow sem configuração ⇒ a edição espera pendente", async () => {
    const { a } = await comEdicao();
    a.airflow.pausada = true;
    expect((await a.cron()).json.disparo).toMatchObject({ estado: "dag_pausada", atualizacoes: 1 });
    expect((await a.edicoes())[0].situacao).toBe("pendente");

    const b = await criarAmbiente({ segredos: { AIRFLOW_BASE_URL: "" } });
    const linha = linhaGold();
    await b.datamart.inserir(linha);
    await b.editar(String(linha.chave_unica), { campos: { cod_nfd: "1" } });
    expect((await b.cron()).json.disparo).toMatchObject({ estado: "sem_airflow", atualizacoes: 1 });
  });

  it("disparo recusado pelo Airflow (4xx) ⇒ a edição volta à fila, com aviso", async () => {
    const { a } = await comEdicao();
    a.airflow.proximoDisparo = 400;
    const r = await a.cron();
    expect(r.json.disparo).toMatchObject({ estado: "disparo_recusado" });
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "pendente", lote_id: null });
    expect(a.avisos().join("\n")).toContain("recusou o disparo");
  });

  it("gravada pela DAG mas ainda fora da réplica: segue na tela; 6 h depois sai, com aviso", async () => {
    const { a, chave } = await comEdicao();
    await a.rodadaComDag();
    // A réplica que o Metabase lê ainda não tem o evento.
    await a.datamart.pg.exec("delete from raw.cxhub_reenvio_reembolso_eventos where tipo_evento = 'atualizacao'");
    a.relogio.avancar(MINUTOS_10);
    expect((await a.cron()).json.backoffice.conferencia).toMatchObject({ estado: "conferido", naRaw: 0, esperando: 1 });
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "gravado", conferida: null });
    expect((await detalhe(a, chave)).caso).toMatchObject({ status_execucao: "Realizado", aguardando: { situacao: "gravado" } });
    a.relogio.avancar(7 * 60 * 60_000);
    const r = await a.cron();
    expect(r.json.backoffice.conferencia).toMatchObject({ atrasadas: 1 });
    expect((await a.edicoes())[0]).toMatchObject({ conferida: "atrasada" });
    expect((await detalhe(a, chave)).caso).toMatchObject({ status_execucao: null, aguardando: null });
    expect(a.avisos().join("\n")).toContain("6 h");
  });

  it("a conferência com o Metabase fora não perde nada", async () => {
    const { a } = await comEdicao();
    await a.rodadaComDag();
    a.relogio.avancar(MINUTOS_10);
    a.datamart.proximaFalha = { status: 502 };
    const r = await a.cron();
    expect(r.json.backoffice.conferencia).toMatchObject({ estado: "sem_resposta" });
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "gravado", conferida: null });
    a.relogio.avancar(MINUTOS_10);
    expect((await a.cron()).json.backoffice.conferencia).toMatchObject({ naRaw: 1 });
    expect((await a.edicoes())[0]).toMatchObject({ conferida: "na_raw" });
  });
});

describe("a rodada e o diagnóstico", () => {
  it("o backoffice não tem rodada própria: /api/backoffice/interno/lote não existe (404)", async () => {
    const a = await criarAmbiente();
    expect((await a.chamar("POST", "/api/interno/lote")).status).toBe(404);
  });

  it("o diagnóstico mostra as edições, a fila e a última rodada", async () => {
    const { a } = await comEdicao();
    await a.cron();
    const r = await a.chamar("GET", "/api/estado");
    expect(r.status).toBe(200);
    expect(r.json.edicoes).toMatchObject({ pendente: 0, enviado: 1, conferencia: { esperando: 0 } });
    expect(r.json.fila).toMatchObject({ casos: { pendente: 0 }, atualizacoes: { enviado: 1 } });
    expect(r.json.loteEmAndamento).toMatchObject({ situacao: "disparado", atualizacoes: 1 });
    expect(r.json.ultimaRodada.disparo).toMatchObject({ estado: "disparado" });
    expect(r.json.configuracao).toMatchObject({ metabase: true, rotaDados: true });
  });
});
