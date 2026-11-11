// A rodada do cron: POST /api/interno/lote, chamado pelo cron do GoDeploy (a cada 10 min) ou à mão. Mesmo desenho da
// fila do app cx-hub (servidor/lote.ts de lá), só com atualizações. Cada rodada:
// 1. acompanha o lote em andamento (um por vez): ainda rodando ⇒ termina ali; terminado ⇒ aplica o resultado por
//    item (o XCom da task gravar): gravado (a edição está na raw) ou recusado (com o motivo da DAG). Run que falhou
//    sem XCom é recolocado uma vez (clear); falhou de novo, as edições voltam a pendente (a segunda vez as recusa);
// 2. CONFERE no Metabase as edições gravadas: quando a raw que o Metabase lê já tem o evento, a lista já o mostra (ela
//    lê gold + raw, servidor/gold.ts) e a edição sai do env.DB. Gravada há mais de 6 h sem aparecer sai também, com
//    aviso (a DAG confirmou a gravação; a réplica atrasa minutos, não horas);
// 3. monta e dispara o próximo lote com as edições pendentes (até LOTE_MAX). Lote vazio nunca é disparado, nem com a
//    DAG pausada. dag_run_id = cxhub_backoffice__<aaaammddThhmmss> (no app de origem, backoffice_lote__: ver ORIGEM.md);
// 4. uma vez por hora, apaga as recusadas e os lotes terminados há mais de 7 dias;
// 5. manda um aviso no Slack com o que a rodada achou.
// Sem transação, o lote fica gravado a cada passo (montando → disparado → terminado) e as edições levam o lote_id e a
// posicao: uma rodada que cair no meio é retomada pela seguinte, com o mesmo dag_run_id (o 409 vale como disparado).

import { comoAirflowErro, dagPausada, dispararLote, estadoDoRun, limparRun, resultadoDoRun } from "./airflow";
import { avisar } from "./aviso";
import { pegarVez, soltarVez } from "./banco";
import type { ConfigAirflow } from "./config";
import type { Contexto } from "./contexto";
import { sqlDaConferencia, type ItemConferencia } from "./gold";
import { json } from "./http";
import { comoMetabaseErro, consultar } from "./metabase";
import { DIA, HORA, MINUTO, carimboDoLote, isoUtc } from "./tempo";

// Uma rodada leva segundos; a vez dela vale 2 min (se o Worker morrer no meio, a próxima não espera mais que isso).
const TRAVA_RODADA_MS = 2 * MINUTO;
// Depois deste prazo a rodada não começa etapa nova que chame fora (cada chamada leva até 10 s no Airflow).
const PRAZO_RODADA_MS = 25_000;
const RUN_RECENTE_MS = 5 * MINUTO;
const ESPERA_MAXIMA_NA_RAW_MS = 6 * HORA;
const CONFERIR_POR_RODADA = 200;
const MAX_ERRO = 500;
// A ordem do conf: a edição mais antiga primeiro (no empate de atualizado_em, a DAG dá a vez à que vem depois).
const ORDEM = "atualizado_em, criado_em, id_atualizacao";

type Rodada = { c: Contexto; avisos: string[]; prazo: number };
type Andamento = { lote: string | null; livre: boolean; estado: string; [detalhe: string]: unknown };
type Etapa = { estado: string; [detalhe: string]: unknown };
type Recusa = { id: string; caso: string; erro: string };

const ehObjeto = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const texto = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export async function rodada(c: Contexto): Promise<Response> {
  const inicio = c.relogio.agora();
  if (!(await pegarVez(c.db, "rodada", inicio, TRAVA_RODADA_MS)))
    return json({ code: "OUTRA_RODADA", message: "Outra rodada está em andamento: esta não fez nada." });
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
  let conferencia: Etapa = { estado: "erro" };
  let disparo: Etapa | null = null;
  let limpeza = false;
  try {
    andamento = await etapa("andamento", () => acompanhar(r), andamento);
    conferencia = await etapa("conferencia", () => conferir(r), conferencia);
    if (andamento.livre) disparo = await etapa("disparo", () => montar(r), { estado: "erro" });
    limpeza = await etapa("limpeza", () => limpar(c), false);
  } finally {
    await soltarVez(c.db, "rodada", inicio).catch(err => console.error("lote: a vez da rodada não foi devolvida:", (err as Error)?.message || err));
  }
  await avisar(c, r.avisos);
  const resumo = { em: isoUtc(inicio), andamento, conferencia, disparo, limpeza, avisos: r.avisos.length, ...(falhas.length ? { falhas } : {}) };
  console.log(`lote: ${JSON.stringify(resumo)}`);
  await c.db.exec(
    "INSERT INTO bo_controle (chave, valor) VALUES ('ultima_rodada', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
    [JSON.stringify(resumo)],
  ).catch(err => console.error("lote: o resumo da rodada não foi guardado:", (err as Error)?.message || err));
  return falhas.length
    ? json({ code: "INTERNAL_ERROR", message: `A rodada falhou em: ${falhas.join(", ")}.`, ...resumo }, 500)
    : json({ code: "OK", ...resumo });
}

// ─── 1. O lote em andamento ──────────────────────────────────────────────────

async function acompanhar(r: Rodada): Promise<Andamento> {
  const { c } = r;
  const lote = await c.db.um("SELECT id, situacao, clears, disparado_em FROM bo_lotes WHERE situacao IN ('montando', 'disparado') ORDER BY criado_em LIMIT 1");
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
      await c.db.exec("UPDATE bo_lotes SET clears = clears + 1 WHERE id = ?", [id]);
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

function itensDoResultado(v: unknown): ItemDoResultado[] | null {
  if (!Array.isArray(v)) return null;
  const itens: ItemDoResultado[] = [];
  for (const x of v) {
    if (!ehObjeto(x) || typeof x.posicao !== "number" || !Number.isInteger(x.posicao) || x.posicao < 0) continue;
    itens.push({ posicao: x.posicao, id_solicitacao: x.id_solicitacao, id_atualizacao: x.id_atualizacao, erro: x.erro });
  }
  return itens;
}

// O XCom da DAG: { casos: {...}, atualizacoes: { gravados, recusados } }. Este app só manda atualizações.
// null: fora da forma.
export function lerResultado(v: unknown): ListaDoResultado | null {
  if (!ehObjeto(v) || !("atualizacoes" in v)) return null;
  if (v.atualizacoes === undefined || v.atualizacoes === null) return { gravados: [], recusados: [] };
  if (!ehObjeto(v.atualizacoes)) return null;
  const gravados = itensDoResultado(v.atualizacoes.gravados ?? []);
  const recusados = itensDoResultado(v.atualizacoes.recusados ?? []);
  return gravados && recusados ? { gravados, recusados } : null;
}

type ItemDoLote = { id: string; posicao: number; caso: string };

async function itensEnviados(c: Contexto, lote: string): Promise<ItemDoLote[]> {
  const linhas = await c.db.query("SELECT id_atualizacao, id_solicitacao, posicao FROM bo_edicoes WHERE lote_id = ? AND situacao = 'enviado'", [lote]);
  return linhas.map(l => ({ id: String(l.id_atualizacao), posicao: Number(l.posicao), caso: String(l.id_solicitacao) }));
}

// Cada edição do lote pela posição: gravada (repetida também conta), recusada com o erro, e a que a DAG não citou,
// recusada com "sem resultado da DAG". O XCom traz os ids junto da posição: se não casam, o resultado não é dela.
function decidir(itens: ItemDoLote[], lista: ListaDoResultado): { gravados: string[]; recusados: Recusa[] } {
  const porPosicao = new Map(itens.map(i => [i.posicao, i]));
  const erros = new Map<string, string | null>();
  for (const g of lista.gravados) {
    const item = porPosicao.get(g.posicao);
    if (!item) continue;
    const veio = texto(g.id_atualizacao);
    const casoVeio = texto(g.id_solicitacao);
    erros.set(item.id, (veio && veio !== item.id) || (casoVeio && casoVeio !== item.caso)
      ? `o resultado da DAG na posição ${item.posicao} é de outro item (${veio || casoVeio})`
      : null);
  }
  for (const x of lista.recusados) {
    const item = porPosicao.get(x.posicao);
    if (item) erros.set(item.id, texto(x.erro) || "recusada pela DAG, sem motivo");
  }
  const d = { gravados: [] as string[], recusados: [] as Recusa[] };
  for (const item of itens) {
    const e = erros.get(item.id);
    if (e === null) d.gravados.push(item.id);
    else d.recusados.push({ id: item.id, caso: item.caso, erro: (e ?? "sem resultado da DAG").slice(0, MAX_ERRO) });
  }
  return d;
}

async function aplicar(r: Rodada, id: string, estado: string, resultado: ListaDoResultado): Promise<Andamento> {
  const { c } = r;
  const d = decidir(await itensEnviados(c, id), resultado);
  const agora = isoUtc(c.relogio.agora());
  if (d.gravados.length)
    await c.db.exec(
      `UPDATE bo_edicoes SET situacao = 'gravado', erro = NULL, gravado_em = ?, mudou_em = ?
       WHERE lote_id = ? AND situacao = 'enviado' AND id_atualizacao IN (SELECT value FROM json_each(?))`,
      [agora, agora, id, JSON.stringify(d.gravados)],
    );
  if (d.recusados.length) await recusar(c, d.recusados, "lote_id = ? AND situacao = 'enviado'", [id]);
  // failed com XCom: nenhum item passou, e o mesmo conf seria recusado de novo. Não há clear.
  await terminar(c, id, estado === "success" ? "concluido" : "falhou", { gravados: d.gravados.length, recusados: d.recusados.length });
  if (estado === "failed") r.avisos.push(`Lote ${id}: o run falhou (${d.gravados.length} gravada(s), ${d.recusados.length} recusada(s)).`);
  avisarRecusadas(r, `Lote ${id}`, d.recusados);
  return { lote: id, livre: true, estado, gravados: d.gravados.length, recusados: d.recusados.length };
}

// Recusa edições com o motivo de cada uma, numa instrução só (o motivo vem do JSON, casado pelo id).
async function recusar(c: Contexto, itens: Recusa[], condicao: string, params: unknown[]) {
  const agora = isoUtc(c.relogio.agora());
  const lista = JSON.stringify(itens.map(x => ({ id: x.id, erro: x.erro })));
  await c.db.exec(
    `UPDATE bo_edicoes SET situacao = 'recusado', terminado_em = ?, mudou_em = ?,
       erro = (SELECT json_extract(j.value, '$.erro') FROM json_each(?) j WHERE json_extract(j.value, '$.id') = bo_edicoes.id_atualizacao)
     WHERE ${condicao} AND id_atualizacao IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
    [agora, agora, lista, ...params, lista],
  );
}

// success sem XCom é anomalia (a DAG só termina success depois de gravar algum item): as edições viram gravadas, e a
// conferência na gold diz se chegaram. O Slack é avisado.
async function gravarSemResultado(r: Rodada, id: string, semXcom: string): Promise<Andamento> {
  const { c } = r;
  const agora = isoUtc(c.relogio.agora());
  const n = (await itensEnviados(c, id)).length;
  await c.db.exec("UPDATE bo_edicoes SET situacao = 'gravado', erro = NULL, gravado_em = ?, mudou_em = ? WHERE lote_id = ? AND situacao = 'enviado'", [agora, agora, id]);
  await terminar(c, id, "concluido_sem_resultado", { gravados: n, recusados: 0 });
  r.avisos.push(`Lote ${id}: o run terminou success ${semXcom} (anomalia). ${n} edição(ões) marcadas como gravadas sem o resultado por item.`);
  return { lote: id, livre: true, estado: "success", gravados: n, sem_resultado: true };
}

// O lote falhou sem resultado (depois do clear, ou o run sumiu): as edições voltam a pendente e vão no próximo lote,
// que é outro run. Na segunda vez de uma edição, ela vira recusada.
async function devolverSemResultado(r: Rodada, id: string, motivo: string): Promise<Andamento> {
  const { c } = r;
  const agora = isoUtc(c.relogio.agora());
  const itens = await c.db.query("SELECT id_atualizacao, id_solicitacao, tentativas FROM bo_edicoes WHERE lote_id = ? AND situacao = 'enviado'", [id]);
  const recusadas: Recusa[] = itens.filter(i => Number(i.tentativas) >= 1).map(i => ({
    id: String(i.id_atualizacao),
    caso: String(i.id_solicitacao),
    erro: `dois lotes falharam sem resultado da DAG (o último, ${id}: ${motivo})`,
  }));
  if (recusadas.length) await recusar(c, recusadas, "lote_id = ? AND situacao = 'enviado'", [id]);
  await c.db.exec(
    `UPDATE bo_edicoes SET situacao = 'pendente', lote_id = NULL, posicao = NULL, tentativas = tentativas + 1, mudou_em = ?
     WHERE lote_id = ? AND situacao = 'enviado'`,
    [agora, id],
  );
  const devolvidas = itens.length - recusadas.length;
  await terminar(c, id, "sem_resultado", { gravados: 0, recusados: recusadas.length, erro: motivo });
  r.avisos.push(`Lote ${id}: ${motivo}. ${devolvidas} edição(ões) voltaram para a fila.`);
  avisarRecusadas(r, `Lote ${id}, segunda falha sem resultado`, recusadas);
  return { lote: id, livre: true, estado: "sem_resultado", devolvidas, recusadas: recusadas.length };
}

async function terminar(c: Contexto, id: string, desfecho: string, o: { gravados?: number; recusados?: number; erro?: string } = {}) {
  await c.db.exec(
    "UPDATE bo_lotes SET situacao = 'terminado', desfecho = ?, gravados = ?, recusados = ?, erro = ?, terminado_em = ? WHERE id = ?",
    [desfecho, o.gravados ?? null, o.recusados ?? null, o.erro?.slice(0, MAX_ERRO) ?? null, isoUtc(c.relogio.agora()), id],
  );
}

function avisarRecusadas(r: Rodada, titulo: string, recusadas: Recusa[]) {
  if (!recusadas.length) return;
  r.avisos.push(`${titulo}: ${recusadas.length} edição(ões) recusada(s):`);
  for (const x of recusadas) r.avisos.push(`• edição ${x.id} (caso ${x.caso}): ${x.erro}`);
}

// ─── 2. A conferência no Metabase ────────────────────────────────────────────

async function conferir(r: Rodada): Promise<Etapa> {
  const { c } = r;
  const linhas = await c.db.query(
    "SELECT id_atualizacao, id_solicitacao, gravado_em FROM bo_edicoes WHERE situacao = 'gravado' ORDER BY gravado_em, id_atualizacao LIMIT ?",
    [CONFERIR_POR_RODADA],
  );
  if (!linhas.length) return { estado: "nada" };
  const m = c.cfg.metabase;
  if (!m) return { estado: "sem_metabase", gravadas: linhas.length };
  if (c.relogio.agora() > r.prazo) return { estado: "sem_tempo", gravadas: linhas.length };
  const itens: ItemConferencia[] = linhas.map(l => ({ idAtualizacao: String(l.id_atualizacao), idSolicitacao: String(l.id_solicitacao) }));
  let resposta: unknown[][];
  try {
    resposta = await consultar(m, c.fetch, sqlDaConferencia(itens), 15_000);
  } catch (err) {
    const e = comoMetabaseErro(err);
    // Rede ou 5xx: a próxima rodada confere. Erro de SQL ou de permissão não melhora sozinho: avisa.
    if (!e.transitorio) r.avisos.push(`A conferência no Metabase falhou (${e.message}): as edições gravadas ficam no app até ela voltar.`);
    return { estado: "sem_resposta", erro: e.message, gravadas: linhas.length };
  }
  const naRaw = new Set(resposta.map(l => String(l[0])));

  const agora = c.relogio.agora();
  const prontas: string[] = [];
  const atrasadas: string[] = [];
  for (const l of linhas) {
    const id = String(l.id_atualizacao);
    if (naRaw.has(id)) prontas.push(id);
    else if (agora - Date.parse(String(l.gravado_em)) > ESPERA_MAXIMA_NA_RAW_MS) atrasadas.push(id);
  }
  const apagar = [...prontas, ...atrasadas];
  if (apagar.length) await c.db.exec("DELETE FROM bo_edicoes WHERE situacao = 'gravado' AND id_atualizacao IN (SELECT value FROM json_each(?))", [JSON.stringify(apagar)]);
  if (atrasadas.length)
    r.avisos.push(`${atrasadas.length} edição(ões) que a DAG gravou não apareceram na raw do Metabase em 6 h e saíram da fila do app (a réplica do Data Mart está parada?): ${atrasadas.slice(0, 10).join(", ")}`);
  return { estado: "conferido", naRaw: prontas.length, atrasadas: atrasadas.length, esperando: linhas.length - apagar.length };
}

// ─── 3. Montar e disparar o próximo lote ─────────────────────────────────────

async function montar(r: Rodada): Promise<Etapa> {
  const { c } = r;
  const ids = (await c.db.query(`SELECT id_atualizacao FROM bo_edicoes WHERE situacao = 'pendente' ORDER BY ${ORDEM} LIMIT ?`, [c.cfg.loteMax]))
    .map(l => String(l.id_atualizacao));
  if (!ids.length) return { estado: "vazio" };
  const a = c.cfg.airflow;
  if (!a) return { estado: "sem_airflow", pendentes: ids.length };
  if (c.relogio.agora() > r.prazo) return { estado: "sem_tempo", pendentes: ids.length };
  try {
    if (await dagPausada(a, c.fetch, c.relogio.agora())) return { estado: "dag_pausada", pendentes: ids.length };
  } catch (err) {
    const e = comoAirflowErro(err);
    if (!e.transitorio) r.avisos.push(`Não deu para conferir se a DAG ${a.dagId} está pausada (${e.message}): o lote não foi disparado.`);
    return { estado: "sem_resposta", erro: e.message, pendentes: ids.length };
  }
  if (c.relogio.agora() > r.prazo) return { estado: "sem_tempo", pendentes: ids.length };

  const agora = c.relogio.agora();
  const id = `cxhub_backoffice__${carimboDoLote(agora)}`;
  // Outro lote com o mesmo segundo (só à mão): fica para a próxima rodada.
  if (!(await c.db.exec("INSERT INTO bo_lotes (id, situacao, criado_em) VALUES (?, 'montando', ?) ON CONFLICT(id) DO NOTHING", [id, isoUtc(agora)])))
    return { estado: "id_repetido", lote: id };
  // Só as que ainda estão pendentes: uma edição desfeita entre a leitura e aqui fica de fora.
  await c.db.exec(
    `UPDATE bo_edicoes SET situacao = 'enviado', lote_id = ?, mudou_em = ? WHERE situacao = 'pendente' AND id_atualizacao IN (SELECT value FROM json_each(?))`,
    [id, isoUtc(agora), JSON.stringify(ids)],
  );
  return disparar(r, a, id);
}

// O conf sai do banco (as edições com o lote_id, na ORDEM), e a posição de cada uma fica guardada antes do disparo: é
// por ela que o resultado é lido. Refazer dá o mesmo conf, então o disparo de um lote retomado é igual ao primeiro.
async function confDoLote(c: Contexto, lote: string) {
  const linhas = await c.db.query(
    `SELECT id_atualizacao, id_solicitacao, atualizado_em, campos FROM bo_edicoes WHERE lote_id = ? AND situacao = 'enviado' ORDER BY ${ORDEM}`,
    [lote],
  );
  if (linhas.length)
    await c.db.exec(
      `UPDATE bo_edicoes SET posicao = (SELECT j.key FROM json_each(?) j WHERE j.value = bo_edicoes.id_atualizacao) WHERE lote_id = ? AND situacao = 'enviado'`,
      [JSON.stringify(linhas.map(l => String(l.id_atualizacao))), lote],
    );
  // A identidade da atualização vem por último: nenhum campo a sobrescreve.
  return {
    atualizacoes: linhas.map(l => ({
      ...(JSON.parse(String(l.campos)) as Record<string, unknown>),
      id_solicitacao: String(l.id_solicitacao),
      id_atualizacao: String(l.id_atualizacao),
      atualizado_em: String(l.atualizado_em),
    })),
  };
}

// 409 (o run já existia) segue como disparado. 4xx: as edições voltam a pendente e o Slack é avisado. Rede ou 5xx:
// voltam a pendente, e a próxima rodada tenta.
async function disparar(r: Rodada, a: ConfigAirflow, id: string): Promise<Etapa> {
  const { c } = r;
  const conf = await confDoLote(c, id);
  const n = conf.atualizacoes.length;
  if (!n) {
    await terminar(c, id, "vazio");
    return { estado: "vazio", lote: id };
  }
  let criado: "criado" | "ja_existia";
  try {
    criado = await dispararLote(a, c.fetch, c.relogio.agora(), id, conf);
  } catch (err) {
    const e = comoAirflowErro(err);
    await c.db.exec(
      "UPDATE bo_edicoes SET situacao = 'pendente', lote_id = NULL, posicao = NULL, mudou_em = ? WHERE lote_id = ? AND situacao = 'enviado'",
      [isoUtc(c.relogio.agora()), id],
    );
    const desfecho = e.transitorio ? "falha_no_disparo" : "disparo_recusado";
    await terminar(c, id, desfecho, { erro: e.status ? `${e.message}: ${e.corpo}` : e.message });
    if (e.transitorio) console.warn(`lote ${id}: o disparo falhou (${e.message}); as edições voltaram para a fila`);
    else r.avisos.push(`Lote ${id}: o Airflow recusou o disparo (${e.message}); ${n} edição(ões) voltaram para a fila.`);
    return { estado: desfecho, lote: id, erro: e.message, edicoes: n };
  }
  // Fora do try: se esta escrita falhar, o lote fica "montando" e a próxima rodada o dispara de novo (409).
  await c.db.exec(
    "UPDATE bo_lotes SET situacao = 'disparado', itens = ?, disparado_em = ? WHERE id = ? AND situacao = 'montando'",
    [n, isoUtc(c.relogio.agora()), id],
  );
  return { estado: "disparado", lote: id, edicoes: n, ...(criado === "ja_existia" ? { ja_existia: true } : {}) };
}

// ─── 4. Limpeza (uma vez por hora) ───────────────────────────────────────────

async function limpar(c: Contexto): Promise<boolean> {
  if (!(await pegarVez(c.db, "limpeza", c.relogio.agora(), HORA))) return false;
  const limite = isoUtc(c.relogio.agora() - 7 * DIA);
  await c.db.exec("DELETE FROM bo_edicoes WHERE situacao = 'recusado' AND terminado_em < ?", [limite]);
  await c.db.exec("DELETE FROM bo_lotes WHERE situacao = 'terminado' AND terminado_em < ?", [limite]);
  return true;
}
