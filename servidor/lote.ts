// A rodada do lote (docs/fila-cxhub.md, "O lote"): POST /api/v1/interno/lote, chamado pelo cron do GoDeploy a cada
// 20 min ou à mão. Cada rodada:
// 1. acompanha o lote em andamento (um por vez): ainda rodando ⇒ termina ali; terminado ⇒ aplica o resultado por
//    item (o XCom da task gravar), ou recoloca o run uma vez (clear) quando ele falhou sem XCom;
// 2. monta o próximo: os casos pendentes primeiro, depois as atualizações cujo caso não está pendente fora do lote.
//    Lote vazio nunca é disparado (a DAG falha sem XCom com o conf vazio), nem com a DAG pausada;
// 3. dispara um run com tudo (dag_run_id = cxhub_lote__<aaaammddThhmmss>);
// 4. uma vez por hora, apaga gravado e recusado com mais de 7 dias;
// 5. manda um aviso no Slack com o que a rodada achou.
// Sem transação, o lote fica gravado a cada passo (montando → disparado → terminado) e os itens levam o lote_id e a
// posicao: uma rodada que cair no meio é retomada pela seguinte, com o mesmo dag_run_id (o 409 vale como disparado).

import { comoAirflowErro, dagPausada, dispararLote, estadoDoRun, limparRun, resultadoDoRun } from "./airflow";
import { avisar } from "./aviso";
import { pegarVez, soltarVez, type Linha } from "./banco";
import type { ConfigAirflow } from "./config";
import type { Contexto } from "./contexto";
import { json } from "./http";
import { carimboDoLote, isoUtc } from "./tempo";

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIAS_7 = 7 * 24 * HORA;
// Uma rodada leva segundos; a vez dela vale 2 min (se o Worker morrer no meio, a próxima não espera mais que isso).
const TRAVA_RODADA_MS = 2 * MINUTO;
// Depois deste prazo a rodada não começa a montar nem a disparar (cada chamada ao Airflow leva até 10 s): a chamada
// do cron não chega perto do corte do gateway.
const PRAZO_RODADA_MS = 25_000;
const RUN_RECENTE_MS = 5 * MINUTO;
const MAX_ERRO = 500;

type Tabela = "casos" | "atualizacoes";
const COLUNA_ID: Record<Tabela, string> = { casos: "id_solicitacao", atualizacoes: "id_atualizacao" };
// A ordem dos arrays do conf: casos mais antigos primeiro; atualizações por atualizado_em (no empate, a que entrou
// depois na fila vem depois no array, e a DAG dá a vez à que vem depois).
const ORDEM: Record<Tabela, string> = {
  casos: "enfileirado_em, criado_em_utc, id_solicitacao",
  atualizacoes: "atualizado_em_utc, enfileirado_em, id_atualizacao",
};

type Rodada = { c: Contexto; avisos: string[]; prazo: number };
type Andamento = { lote: string | null; livre: boolean; estado: string; [detalhe: string]: unknown };
type Disparo = { estado: string; [detalhe: string]: unknown };
type Recusa = { id: string; erro: string; caso?: string };

const ehObjeto = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const texto = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export async function rodada(c: Contexto): Promise<Response> {
  const inicio = c.relogio.agora();
  if (!(await pegarVez(c.db, "rodada", inicio, TRAVA_RODADA_MS)))
    return json({ code: "OUTRA_RODADA", message: "Outra rodada do lote está em andamento: esta não fez nada." });
  const r: Rodada = { c, avisos: [], prazo: inicio + PRAZO_RODADA_MS };
  const falhas: string[] = [];
  // Cada etapa por conta própria: a falha de uma fica no log e em "falhas" (com status 500), e a vez é devolvida.
  async function etapa<T>(nome: string, f: () => Promise<T>, vazio: T): Promise<T> {
    try {
      return await f();
    } catch (err) {
      console.error(`lote: a etapa ${nome} falhou:`, (err as Error)?.stack || err);
      falhas.push(nome);
      return vazio;
    }
  }
  let andamento: Andamento = { lote: null, livre: false, estado: "erro" };
  let disparo: Disparo | null = null;
  let limpeza = false;
  try {
    andamento = await etapa("andamento", () => acompanhar(r), andamento);
    if (andamento.livre) disparo = await etapa("disparo", () => montar(r), { estado: "erro" });
    limpeza = await etapa("limpeza", () => limpar(c), false);
  } finally {
    await soltarVez(c.db, "rodada", inicio).catch(err => console.error("lote: a vez da rodada não foi devolvida:", (err as Error)?.message || err));
  }
  await avisar(c, r.avisos);
  const resumo = { em: isoUtc(inicio), andamento, disparo, limpeza, avisos: r.avisos.length, ...(falhas.length ? { falhas } : {}) };
  console.log(`lote: ${JSON.stringify(resumo)}`);
  await c.db.exec(
    "INSERT INTO controle (chave, valor) VALUES ('ultima_rodada', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
    [JSON.stringify(resumo)],
  ).catch(err => console.error("lote: o resumo da rodada não foi guardado:", (err as Error)?.message || err));
  return falhas.length
    ? json({ code: "INTERNAL_ERROR", message: `A rodada falhou em: ${falhas.join(", ")}.`, ...resumo }, 500)
    : json({ code: "OK", ...resumo });
}

// ─── 1. O lote em andamento ──────────────────────────────────────────────────

async function acompanhar(r: Rodada): Promise<Andamento> {
  const { c } = r;
  const lote = await c.db.um("SELECT id, situacao, clears, disparado_em FROM lotes WHERE situacao IN ('montando', 'disparado') ORDER BY criado_em LIMIT 1");
  if (!lote) return { lote: null, livre: true, estado: "nenhum" };
  const id = String(lote.id);
  const a = c.cfg.airflow;
  if (!a) return { lote: id, livre: false, estado: "sem_airflow" };

  // A rodada que montou este lote caiu antes de gravar o disparo: dispara de novo, com o mesmo id.
  if (lote.situacao === "montando") {
    const d = await disparar(r, a, id);
    return { lote: id, livre: d.estado !== "disparado", estado: "retomado", disparo: d };
  }

  let estado: string | null;
  try {
    estado = await estadoDoRun(a, c.fetch, c.relogio.agora(), id);
  } catch (err) {
    return consultaFalhou(r, id, "consultar o run", err);
  }
  if (estado === null) {
    // Logo depois do disparo, a ausência pode ser só o Airflow ainda sem o run na lista: espera.
    if (c.relogio.agora() - Date.parse(String(lote.disparado_em)) < RUN_RECENTE_MS) return { lote: id, livre: false, estado: "nao_listado" };
    return devolverSemResultado(r, id, "o run não existe mais no Airflow");
  }
  if (estado !== "success" && estado !== "failed") return { lote: id, livre: false, estado };

  let valor: unknown;
  try {
    valor = await resultadoDoRun(a, c.fetch, c.relogio.agora(), id);
  } catch (err) {
    return consultaFalhou(r, id, "ler o resultado (XCom)", err);
  }
  const resultado = valor === undefined ? null : lerResultado(valor);
  if (resultado) return aplicar(r, id, estado, resultado);

  const semXcom = valor === undefined ? "sem XCom" : "com o XCom fora da forma";
  if (estado === "success") return gravarSemResultado(r, id, semXcom);
  // failed sem XCom é infraestrutura (o banco, a imagem): recoloca o run uma vez e espera a próxima rodada.
  if (Number(lote.clears) < 1) {
    let recolocado = false;
    try {
      await limparRun(a, c.fetch, c.relogio.agora(), id);
      recolocado = true;
    } catch (err) {
      const e = comoAirflowErro(err);
      if (e.transitorio) return { lote: id, livre: false, estado, acao: "clear adiado", erro: e.message };
      r.avisos.push(`Lote ${id}: o run falhou ${semXcom} e o Airflow recusou recolocá-lo (${e.message}).`);
    }
    if (recolocado) {
      await c.db.exec("UPDATE lotes SET clears = clears + 1 WHERE id = ?", [id]);
      return { lote: id, livre: false, estado, acao: "clear" };
    }
  }
  return devolverSemResultado(r, id, `o run falhou ${semXcom}`);
}

// Rede ou 5xx: a próxima rodada tenta de novo, sem aviso. 4xx é configuração (a permissão do AIRFLOW_USER): avisa.
function consultaFalhou(r: Rodada, id: string, acao: string, err: unknown): Andamento {
  const e = comoAirflowErro(err);
  if (e.transitorio) console.warn(`lote ${id}: não deu para ${acao} (${e.message}); a próxima rodada tenta de novo`);
  else r.avisos.push(`Lote ${id}: não deu para ${acao} no Airflow (${e.message}). Confira a permissão do AIRFLOW_USER; o lote espera.`);
  return { lote: id, livre: false, estado: "sem_resposta", erro: e.message };
}

type ItemDoResultado = { posicao: number; id_solicitacao: unknown; id_atualizacao: unknown; erro: unknown };
type ListaDoResultado = { gravados: ItemDoResultado[]; recusados: ItemDoResultado[] };
export type ResultadoDaDag = { casos: ListaDoResultado; atualizacoes: ListaDoResultado };

function itensDoResultado(v: unknown): ItemDoResultado[] | null {
  if (!Array.isArray(v)) return null;
  const itens: ItemDoResultado[] = [];
  for (const x of v) {
    if (!ehObjeto(x) || typeof x.posicao !== "number" || !Number.isInteger(x.posicao) || x.posicao < 0) continue;
    itens.push({ posicao: x.posicao, id_solicitacao: x.id_solicitacao, id_atualizacao: x.id_atualizacao, erro: x.erro });
  }
  return itens;
}

function listaDoResultado(v: unknown): ListaDoResultado | null {
  if (v === undefined || v === null) return { gravados: [], recusados: [] };
  if (!ehObjeto(v)) return null;
  const gravados = itensDoResultado(v.gravados ?? []);
  const recusados = itensDoResultado(v.recusados ?? []);
  return gravados && recusados ? { gravados, recusados } : null;
}

// O XCom da DAG: { casos: { gravados, recusados }, atualizacoes: { gravados, recusados } }. null: fora da forma.
export function lerResultado(v: unknown): ResultadoDaDag | null {
  if (!ehObjeto(v) || (!("casos" in v) && !("atualizacoes" in v))) return null;
  const casos = listaDoResultado(v.casos);
  const atualizacoes = listaDoResultado(v.atualizacoes);
  return casos && atualizacoes ? { casos, atualizacoes } : null;
}

type ItemDoLote = { id: string; posicao: number; caso?: string };
type Decisao = { gravados: string[]; recusados: Recusa[] };

async function itensEnviados(c: Contexto, tabela: Tabela, lote: string): Promise<ItemDoLote[]> {
  const caso = tabela === "atualizacoes" ? ", id_solicitacao" : "";
  const linhas = await c.db.query(`SELECT ${COLUNA_ID[tabela]} AS id, posicao${caso} FROM ${tabela} WHERE lote_id = ? AND situacao = 'enviado'`, [lote]);
  return linhas.map(l => ({ id: String(l.id), posicao: Number(l.posicao), ...(caso ? { caso: String(l.id_solicitacao) } : {}) }));
}

// O XCom traz os ids junto da posição: se não casam com o item guardado nela, o resultado não é deste item.
function divergencia(item: ItemDoLote, g: ItemDoResultado, tabela: Tabela): string | null {
  const veio = texto(tabela === "casos" ? g.id_solicitacao : g.id_atualizacao);
  const casoVeio = tabela === "atualizacoes" ? texto(g.id_solicitacao) : "";
  if ((veio && veio !== item.id) || (casoVeio && item.caso && casoVeio !== item.caso))
    return `o resultado da DAG na posição ${item.posicao} é de outro item (${veio || casoVeio})`;
  return null;
}

// Cada item do lote pela posição: gravado (repetida também conta), recusado com o erro, e o que a DAG não citou,
// recusado com "sem resultado da DAG".
function decidir(itens: ItemDoLote[], lista: ListaDoResultado, tabela: Tabela): Decisao {
  const porPosicao = new Map(itens.map(i => [i.posicao, i]));
  const erros = new Map<string, string | null>();
  for (const g of lista.gravados) {
    const item = porPosicao.get(g.posicao);
    if (item) erros.set(item.id, divergencia(item, g, tabela));
  }
  for (const x of lista.recusados) {
    const item = porPosicao.get(x.posicao);
    if (item) erros.set(item.id, texto(x.erro) || "recusado pela DAG, sem motivo");
  }
  const d: Decisao = { gravados: [], recusados: [] };
  for (const item of itens) {
    const erro = erros.get(item.id);
    if (erro === null) d.gravados.push(item.id);
    else d.recusados.push({ id: item.id, caso: item.caso, erro: (erro ?? "sem resultado da DAG").slice(0, MAX_ERRO) });
  }
  return d;
}

async function aplicar(r: Rodada, id: string, estado: string, resultado: ResultadoDaDag): Promise<Andamento> {
  const { c } = r;
  const casos = decidir(await itensEnviados(c, "casos", id), resultado.casos, "casos");
  const atualizacoes = decidir(await itensEnviados(c, "atualizacoes", id), resultado.atualizacoes, "atualizacoes");
  await gravarDecisao(c, "casos", id, casos);
  await gravarDecisao(c, "atualizacoes", id, atualizacoes);
  const gravados = casos.gravados.length + atualizacoes.gravados.length;
  const recusados = casos.recusados.length + atualizacoes.recusados.length;
  // failed com XCom: nenhum item passou, e o mesmo conf seria recusado de novo. Não há clear.
  await terminar(c, id, estado === "success" ? "concluido" : "falhou", { gravados, recusados });
  if (estado === "failed") r.avisos.push(`Lote ${id}: o run falhou (${gravados} gravado(s), ${recusados} recusado(s)).`);
  avisarRecusados(r, `Lote ${id}`, casos.recusados, atualizacoes.recusados);
  return { lote: id, livre: true, estado, gravados, recusados };
}

async function gravarDecisao(c: Contexto, tabela: Tabela, lote: string, d: Decisao) {
  const agora = isoUtc(c.relogio.agora());
  if (d.gravados.length)
    await c.db.exec(
      `UPDATE ${tabela} SET situacao = 'gravado', erro = NULL, terminado_em = ?, mudou_em = ?
       WHERE lote_id = ? AND situacao = 'enviado' AND ${COLUNA_ID[tabela]} IN (SELECT value FROM json_each(?))`,
      [agora, agora, lote, JSON.stringify(d.gravados)],
    );
  if (d.recusados.length) await recusar(c, tabela, d.recusados, "lote_id = ? AND situacao = 'enviado'", [lote]);
}

// Recusa itens com o motivo de cada um, numa instrução só (o motivo vem do JSON, casado pelo id).
async function recusar(c: Contexto, tabela: Tabela, itens: Recusa[], condicao: string, params: unknown[]) {
  const agora = isoUtc(c.relogio.agora());
  const col = COLUNA_ID[tabela];
  const lista = JSON.stringify(itens.map(x => ({ id: x.id, erro: x.erro })));
  await c.db.exec(
    `UPDATE ${tabela} SET situacao = 'recusado', terminado_em = ?, mudou_em = ?,
       erro = (SELECT json_extract(j.value, '$.erro') FROM json_each(?) j WHERE json_extract(j.value, '$.id') = ${tabela}.${col})
     WHERE ${condicao} AND ${col} IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
    [agora, agora, lista, ...params, lista],
  );
}

// success sem XCom é anomalia: a DAG só termina success depois de gravar algum item, então os itens viram gravado,
// e o Slack é avisado.
async function gravarSemResultado(r: Rodada, id: string, semXcom: string): Promise<Andamento> {
  const { c } = r;
  const agora = isoUtc(c.relogio.agora());
  let gravados = 0;
  for (const tabela of ["casos", "atualizacoes"] as const) {
    gravados += (await itensEnviados(c, tabela, id)).length;
    await c.db.exec(
      `UPDATE ${tabela} SET situacao = 'gravado', erro = NULL, terminado_em = ?, mudou_em = ? WHERE lote_id = ? AND situacao = 'enviado'`,
      [agora, agora, id],
    );
  }
  await terminar(c, id, "concluido_sem_resultado", { gravados, recusados: 0 });
  r.avisos.push(`Lote ${id}: o run terminou success ${semXcom} (anomalia). ${gravados} item(ns) marcados como gravados sem o resultado por item.`);
  return { lote: id, livre: true, estado: "success", gravados, sem_resultado: true };
}

// O lote falhou sem resultado (depois do clear, ou o run sumiu): os itens voltam a pendente e vão no próximo lote,
// que é outro run. Na segunda vez de um item, ele vira recusado.
async function devolverSemResultado(r: Rodada, id: string, motivo: string): Promise<Andamento> {
  const { c } = r;
  const agora = isoUtc(c.relogio.agora());
  let devolvidos = 0;
  const recusados: Record<Tabela, Recusa[]> = { casos: [], atualizacoes: [] };
  for (const tabela of ["casos", "atualizacoes"] as const) {
    const caso = tabela === "atualizacoes" ? ", id_solicitacao" : "";
    const itens = await c.db.query(`SELECT ${COLUNA_ID[tabela]} AS id, tentativas${caso} FROM ${tabela} WHERE lote_id = ? AND situacao = 'enviado'`, [id]);
    recusados[tabela] = itens.filter(i => Number(i.tentativas) >= 1).map(i => ({
      id: String(i.id),
      ...(caso ? { caso: String(i.id_solicitacao) } : {}),
      erro: `dois lotes falharam sem resultado da DAG (o último, ${id}: ${motivo})`,
    }));
    if (recusados[tabela].length) await recusar(c, tabela, recusados[tabela], "lote_id = ? AND situacao = 'enviado'", [id]);
    await c.db.exec(
      `UPDATE ${tabela} SET situacao = 'pendente', lote_id = NULL, posicao = NULL, tentativas = tentativas + 1, mudou_em = ?
       WHERE lote_id = ? AND situacao = 'enviado'`,
      [agora, id],
    );
    devolvidos += itens.length - recusados[tabela].length;
  }
  const n = recusados.casos.length + recusados.atualizacoes.length;
  await terminar(c, id, "sem_resultado", { gravados: 0, recusados: n, erro: motivo });
  r.avisos.push(`Lote ${id}: ${motivo}. ${devolvidos} item(ns) voltaram para a fila.`);
  avisarRecusados(r, `Lote ${id}, segunda falha sem resultado`, recusados.casos, recusados.atualizacoes);
  return { lote: id, livre: true, estado: "sem_resultado", devolvidos, recusados: n };
}

async function terminar(c: Contexto, id: string, desfecho: string, o: { gravados?: number; recusados?: number; erro?: string } = {}) {
  await c.db.exec(
    "UPDATE lotes SET situacao = 'terminado', desfecho = ?, gravados = ?, recusados = ?, erro = ?, terminado_em = ? WHERE id = ?",
    [desfecho, o.gravados ?? null, o.recusados ?? null, o.erro?.slice(0, MAX_ERRO) ?? null, isoUtc(c.relogio.agora()), id],
  );
}

function avisarRecusados(r: Rodada, titulo: string, casos: Recusa[], atualizacoes: Recusa[]) {
  const n = casos.length + atualizacoes.length;
  if (!n) return;
  r.avisos.push(`${titulo}: ${n} item(ns) recusado(s):`);
  for (const x of casos) r.avisos.push(`• caso ${x.id}: ${x.erro}`);
  for (const x of atualizacoes) r.avisos.push(`• atualização ${x.id} (caso ${x.caso}): ${x.erro}`);
}

// ─── 2 e 3. Montar e disparar o próximo lote ─────────────────────────────────

async function montar(r: Rodada): Promise<Disparo> {
  const { c } = r;
  const max = c.cfg.loteMax;
  const casos = (await c.db.query(`SELECT id_solicitacao FROM casos WHERE situacao = 'pendente' ORDER BY ${ORDEM.casos} LIMIT ?`, [max]))
    .map(l => String(l.id_solicitacao));
  const noLote = new Set(casos);
  const pendentes = await c.db.query(
    `SELECT id_atualizacao, id_solicitacao FROM atualizacoes WHERE situacao = 'pendente' ORDER BY ${ORDEM.atualizacoes} LIMIT ?`,
    [max],
  );
  const naFila = new Map<string, Linha>();
  const idsDosCasos = [...new Set(pendentes.map(a => String(a.id_solicitacao)))];
  if (idsDosCasos.length)
    for (const l of await c.db.query("SELECT id_solicitacao, situacao, erro FROM casos WHERE id_solicitacao IN (SELECT value FROM json_each(?))", [JSON.stringify(idsDosCasos)]))
      naFila.set(String(l.id_solicitacao), l);

  // A criação vai antes da alteração: caso recusado recusa a atualização; caso ainda na fila fora deste lote (ou num
  // lote em andamento), a atualização espera. Caso que não está na fila (já na raw) ou já gravado: ela entra.
  const atualizacoes: string[] = [];
  const recusadas: Recusa[] = [];
  let esperando = 0;
  for (const a of pendentes) {
    const id = String(a.id_atualizacao);
    const idCaso = String(a.id_solicitacao);
    const caso = naFila.get(idCaso);
    if (caso?.situacao === "recusado") recusadas.push({ id, caso: idCaso, erro: `o caso foi recusado: ${texto(caso.erro) || "sem motivo"}`.slice(0, MAX_ERRO) });
    else if (caso && caso.situacao !== "gravado" && !noLote.has(idCaso)) esperando++;
    else if (casos.length + atualizacoes.length < max) atualizacoes.push(id);
    else esperando++;
  }
  if (recusadas.length) {
    await recusar(c, "atualizacoes", recusadas, "situacao = 'pendente'", []);
    avisarRecusados(r, "Atualizações de caso recusado", [], recusadas);
  }

  const total = { casos: casos.length, atualizacoes: atualizacoes.length, esperando };
  if (!casos.length && !atualizacoes.length) return { estado: "vazio", ...total };
  const a = c.cfg.airflow;
  if (!a) return { estado: "sem_airflow", ...total };
  if (c.relogio.agora() > r.prazo) return { estado: "sem_tempo", ...total };
  try {
    if (await dagPausada(a, c.fetch, c.relogio.agora())) return { estado: "dag_pausada", ...total };
  } catch (err) {
    const e = comoAirflowErro(err);
    if (!e.transitorio) r.avisos.push(`Não deu para conferir se a DAG ${a.dagId} está pausada (${e.message}): o lote não foi disparado.`);
    return { estado: "sem_resposta", erro: e.message, ...total };
  }
  if (c.relogio.agora() > r.prazo) return { estado: "sem_tempo", ...total };

  const agora = c.relogio.agora();
  const id = `cxhub_lote__${carimboDoLote(agora)}`;
  // Outro lote com o mesmo segundo (só à mão): fica para a próxima rodada.
  if (!(await c.db.exec("INSERT INTO lotes (id, situacao, criado_em) VALUES (?, 'montando', ?) ON CONFLICT(id) DO NOTHING", [id, isoUtc(agora)])))
    return { estado: "id_repetido", lote: id, ...total };
  await marcar(c, "casos", id, casos);
  await marcar(c, "atualizacoes", id, atualizacoes);
  return disparar(r, a, id);
}

async function marcar(c: Contexto, tabela: Tabela, lote: string, ids: string[]) {
  if (!ids.length) return;
  await c.db.exec(
    `UPDATE ${tabela} SET situacao = 'enviado', lote_id = ?, mudou_em = ?
     WHERE situacao = 'pendente' AND ${COLUNA_ID[tabela]} IN (SELECT value FROM json_each(?))`,
    [lote, isoUtc(c.relogio.agora()), JSON.stringify(ids)],
  );
}

// O conf sai do banco (os itens com o lote_id, na ORDEM), e a posição de cada um fica guardada antes do disparo: é
// por ela que o resultado é lido. Refazer dá o mesmo conf, então o disparo de um lote retomado é igual ao primeiro.
async function confDoLote(c: Contexto, lote: string) {
  const casos = await c.db.query(`SELECT id_solicitacao, dados FROM casos WHERE lote_id = ? AND situacao = 'enviado' ORDER BY ${ORDEM.casos}`, [lote]);
  const atualizacoes = await c.db.query(
    `SELECT id_atualizacao, id_solicitacao, atualizado_em, campos FROM atualizacoes WHERE lote_id = ? AND situacao = 'enviado' ORDER BY ${ORDEM.atualizacoes}`,
    [lote],
  );
  await guardarPosicoes(c, "casos", lote, casos.map(l => String(l.id_solicitacao)));
  await guardarPosicoes(c, "atualizacoes", lote, atualizacoes.map(l => String(l.id_atualizacao)));
  return {
    casos: casos.map(l => JSON.parse(String(l.dados)) as unknown),
    // A identidade da atualização vem primeiro e é sempre a da fila.
    atualizacoes: atualizacoes.map(l => {
      const identidade = { id_solicitacao: String(l.id_solicitacao), id_atualizacao: String(l.id_atualizacao), atualizado_em: String(l.atualizado_em) };
      return { ...identidade, ...(JSON.parse(String(l.campos)) as Record<string, unknown>), ...identidade };
    }),
  };
}

async function guardarPosicoes(c: Contexto, tabela: Tabela, lote: string, ids: string[]) {
  if (!ids.length) return;
  const col = COLUNA_ID[tabela];
  await c.db.exec(
    `UPDATE ${tabela} SET posicao = (SELECT j.key FROM json_each(?) j WHERE j.value = ${tabela}.${col})
     WHERE lote_id = ? AND situacao = 'enviado'`,
    [JSON.stringify(ids), lote],
  );
}

// 409 (o run já existia) segue como disparado. 4xx: os itens voltam a pendente e o Slack é avisado. Rede ou 5xx:
// voltam a pendente, e a próxima rodada tenta.
async function disparar(r: Rodada, a: ConfigAirflow, id: string): Promise<Disparo> {
  const { c } = r;
  const conf = await confDoLote(c, id);
  const n = { casos: conf.casos.length, atualizacoes: conf.atualizacoes.length };
  if (!n.casos && !n.atualizacoes) {
    await terminar(c, id, "vazio");
    return { estado: "vazio", lote: id };
  }
  let criado: "criado" | "ja_existia";
  try {
    criado = await dispararLote(a, c.fetch, c.relogio.agora(), id, conf);
  } catch (err) {
    const e = comoAirflowErro(err);
    await voltarParaFila(c, id);
    const desfecho = e.transitorio ? "falha_no_disparo" : "disparo_recusado";
    await terminar(c, id, desfecho, { erro: e.status ? `${e.message}: ${e.corpo}` : e.message });
    if (e.transitorio) console.warn(`lote ${id}: o disparo falhou (${e.message}); os itens voltaram para a fila`);
    else r.avisos.push(`Lote ${id}: o Airflow recusou o disparo (${e.message}); ${n.casos + n.atualizacoes} item(ns) voltaram para a fila.`);
    return { estado: desfecho, lote: id, erro: e.message, ...n };
  }
  // Fora do try: se esta escrita falhar, o lote fica "montando" e a próxima rodada o dispara de novo (409).
  await c.db.exec(
    "UPDATE lotes SET situacao = 'disparado', casos = ?, atualizacoes = ?, disparado_em = ? WHERE id = ? AND situacao = 'montando'",
    [n.casos, n.atualizacoes, isoUtc(c.relogio.agora()), id],
  );
  return { estado: "disparado", lote: id, ...n, ...(criado === "ja_existia" ? { ja_existia: true } : {}) };
}

async function voltarParaFila(c: Contexto, lote: string) {
  const agora = isoUtc(c.relogio.agora());
  for (const tabela of ["casos", "atualizacoes"] as const)
    await c.db.exec(
      `UPDATE ${tabela} SET situacao = 'pendente', lote_id = NULL, posicao = NULL, mudou_em = ? WHERE lote_id = ? AND situacao = 'enviado'`,
      [agora, lote],
    );
}

// ─── 4. Limpeza (uma vez por hora) ───────────────────────────────────────────

// gravado e recusado ficam 7 dias (o dedup do CX Hub olha 24 h e a réplica do Data Mart atrasa minutos).
async function limpar(c: Contexto): Promise<boolean> {
  if (!(await pegarVez(c.db, "limpeza", c.relogio.agora(), HORA))) return false;
  const limite = isoUtc(c.relogio.agora() - DIAS_7);
  await c.db.exec("DELETE FROM casos WHERE situacao IN ('gravado', 'recusado') AND terminado_em < ?", [limite]);
  await c.db.exec("DELETE FROM atualizacoes WHERE situacao IN ('gravado', 'recusado') AND terminado_em < ?", [limite]);
  await c.db.exec("DELETE FROM lotes WHERE situacao = 'terminado' AND terminado_em < ?", [limite]);
  return true;
}
