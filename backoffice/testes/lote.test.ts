// A rodada do cron (servidor/lote.ts) contra o Airflow falso e o Data Mart falso: o ciclo inteiro de uma edição, as
// recusas, as falhas do run, a DAG pausada e a conferência na gold.

import { describe, expect, it } from "vitest";
import { MINUTOS_10, URL_APP, criarAmbiente, linhaGold } from "./ambiente";

async function comEdicao(campos: Record<string, unknown> = { status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva" }) {
  const a = await criarAmbiente();
  const linha = linhaGold({ status_execucao: null });
  await a.datamart.inserir(linha);
  const chave = String(linha.chave_unica);
  const r = await a.editar(chave, { campos });
  expect(r.status).toBe(200);
  return { a, chave };
}

describe("o ciclo de uma edição", () => {
  it("pendente → enviado (conf da DAG) → gravado (XCom) → sai do env.DB quando a raw mostra; a lista não espera o dbt", async () => {
    const { a, chave } = await comEdicao();

    // 1ª rodada: dispara o lote com a edição.
    const { disparo, runId, run } = await a.rodadaComDag();
    expect(disparo.status).toBe(200);
    expect(disparo.json.disparo).toMatchObject({ estado: "disparado", edicoes: 1 });
    expect(runId).toBe("cxhub_backoffice__20261110T150000");
    expect(run!.conf).toEqual({
      atualizacoes: [{
        status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva",
        id_solicitacao: chave.slice("cxhub|".length), id_atualizacao: "00000000-0000-4000-8000-000000000001",
        atualizado_em: "2026-11-10T15:00:00.000Z",
      }],
    });
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "enviado", lote_id: runId, posicao: 0 });

    // Antes da 2ª rodada, a lista mostra a edição por cima do Metabase.
    const [antes] = (await a.chamar("GET", "/api/solicitacoes?tipo=REEMBOLSO")).json.itens;
    expect(antes).toMatchObject({ status_execucao: "Realizado", aguardando: { situacao: "enviado" } });

    // 2ª rodada: lê o XCom (gravado), e a raw já tem o evento: a edição sai do env.DB na mesma rodada.
    a.relogio.avancar(MINUTOS_10);
    const r2 = await a.cron();
    expect(r2.json.andamento).toMatchObject({ lote: runId, estado: "success", gravados: 1, recusados: 0 });
    expect(r2.json.conferencia).toMatchObject({ estado: "conferido", naRaw: 1, esperando: 0 });
    expect(await a.edicoes()).toHaveLength(0);
    // O dbt ainda não rodou (a gold não mudou), e a lista já mostra a edição, lida da raw.
    expect((await a.datamart.gold(chave))?.status_execucao).toBeNull();
    const [daRaw] = (await a.chamar("GET", "/api/solicitacoes?tipo=REEMBOLSO")).json.itens;
    expect(daRaw).toMatchObject({
      status_execucao: "Realizado", data_execucao: "2026-11-10", responsavel_execucao: "Ana Silva", aguardando: null,
      carregado_em: "2026-11-10T15:12:00Z",
    });
    expect((await a.chamar("GET", "/api/solicitacoes?tipo=REEMBOLSO&status=sem_status")).json.itens).toHaveLength(0);

    // O dbt roda: a gold mostra o mesmo.
    await a.datamart.dbt();
    const [daGold] = (await a.chamar("GET", "/api/solicitacoes?tipo=REEMBOLSO")).json.itens;
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

  it("sem edição pendente, nada é disparado", async () => {
    const a = await criarAmbiente();
    const r = await a.cron();
    expect(r.json).toMatchObject({ code: "OK", disparo: { estado: "vazio" }, conferencia: { estado: "nada" } });
    expect(a.airflow.runs.size).toBe(0);
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
    const detalhe = (await a.chamar("GET", `/api/solicitacoes/${encodeURIComponent(chave)}`)).json;
    expect(detalhe.caso).toMatchObject({ cod_nfd: null, aguardando: null, recusada: { erro: expect.stringContaining("caso inexistente") } });
    expect(a.avisos().join("\n")).toContain("caso inexistente");

    // Dispensar a recusada é permitido.
    const [e] = await a.edicoes();
    a.relogio.avancar(8 * 24 * 60 * 60_000);
    await a.cron();
    expect(await a.edicoes()).toHaveLength(0);
    expect((await a.chamar("DELETE", `/api/edicoes/${e.id_atualizacao}`)).status).toBe(404);
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
    expect(r.json.andamento).toMatchObject({ estado: "sem_resultado", devolvidas: 1 });
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
    expect((await a.cron()).json.disparo).toMatchObject({ estado: "dag_pausada", pendentes: 1 });
    expect((await a.edicoes())[0].situacao).toBe("pendente");

    const b = await criarAmbiente({ segredos: { AIRFLOW_BASE_URL: "" } });
    const linha = linhaGold();
    await b.datamart.inserir(linha);
    await b.editar(String(linha.chave_unica), { campos: { cod_nfd: "1" } });
    expect((await b.cron()).json.disparo).toMatchObject({ estado: "sem_airflow", pendentes: 1 });
  });

  it("disparo recusado pelo Airflow (4xx) ⇒ a edição volta à fila, com aviso", async () => {
    const { a } = await comEdicao();
    a.airflow.proximoDisparo = 400;
    const r = await a.cron();
    expect(r.json.disparo).toMatchObject({ estado: "disparo_recusado" });
    expect((await a.edicoes())[0]).toMatchObject({ situacao: "pendente", lote_id: null });
    expect(a.avisos().join("\n")).toContain("recusou o disparo");
  });

  it("gravada pela DAG mas ainda fora da réplica: espera; 6 h depois sai do env.DB, com aviso", async () => {
    const { a } = await comEdicao();
    await a.rodadaComDag();
    // A réplica que o Metabase lê ainda não tem o evento.
    await a.datamart.pg.exec("delete from raw.cxhub_reenvio_reembolso_eventos where tipo_evento = 'atualizacao'");
    a.relogio.avancar(MINUTOS_10);
    expect((await a.cron()).json.conferencia).toMatchObject({ estado: "conferido", naRaw: 0, esperando: 1 });
    expect((await a.edicoes())[0].situacao).toBe("gravado");
    a.relogio.avancar(7 * 60 * 60_000);
    const r = await a.cron();
    expect(r.json.conferencia).toMatchObject({ atrasadas: 1 });
    expect(await a.edicoes()).toHaveLength(0);
    expect(a.avisos().join("\n")).toContain("6 h");
  });

  it("a conferência com o Metabase fora não perde nada", async () => {
    const { a } = await comEdicao();
    await a.rodadaComDag();
    a.relogio.avancar(MINUTOS_10);
    a.datamart.proximaFalha = { status: 502 };
    const r = await a.cron();
    expect(r.json.conferencia).toMatchObject({ estado: "sem_resposta" });
    expect((await a.edicoes())[0].situacao).toBe("gravado");
    a.relogio.avancar(MINUTOS_10);
    expect((await a.cron()).json.conferencia).toMatchObject({ naRaw: 1 });
    expect(await a.edicoes()).toHaveLength(0);
  });
});

describe("quem chama a rodada", () => {
  it("o cron com o cabeçalho no formato da plataforma; fora do formato ⇒ 401; sem nada ⇒ 401", async () => {
    const a = await criarAmbiente();
    expect((await a.cron()).status).toBe(200);
    const torto = await a.chamar("POST", "/api/interno/lote", { usuario: null, semProtecao: true, cabecalhos: { "x-godeploy-cron": "t=1;sig=x" } });
    expect(torto.status).toBe(401);
    expect((await a.chamar("POST", "/api/interno/lote", { usuario: null, semProtecao: true })).status).toBe(401);
  });

  // Adaptação do app cx-hub: do navegador (com Origin), a proteção de escrita vale; de servidor (sem Origin), passa.
  it("alguém identificado, à mão: do navegador com a proteção de escrita, de servidor sem ela", async () => {
    const a = await criarAmbiente();
    expect((await a.chamar("POST", "/api/interno/lote")).status).toBe(200);
    expect((await a.chamar("POST", "/api/interno/lote", { semProtecao: true, cabecalhos: { origin: URL_APP } })).status).toBe(403);
    expect((await a.chamar("POST", "/api/interno/lote", { semProtecao: true })).status).toBe(200);
  });

  it("o diagnóstico mostra a fila e a última rodada", async () => {
    const { a } = await comEdicao();
    await a.cron();
    const r = await a.chamar("GET", "/api/estado");
    expect(r.status).toBe(200);
    expect(r.json.edicoes).toMatchObject({ pendente: 0, enviado: 1 });
    expect(r.json.loteEmAndamento).toMatchObject({ situacao: "disparado", itens: 1 });
    expect(r.json.ultimaRodada.disparo).toMatchObject({ estado: "disparado" });
  });
});
