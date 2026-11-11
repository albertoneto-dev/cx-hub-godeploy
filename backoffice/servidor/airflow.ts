// Cliente da API v2 do Airflow 3 (JWT), no molde do api-procon-processos e do chargeback-panel: POST /auth/token
// com o usuário de serviço, token guardado até perto do exp, e um 401/403 renova o token uma vez. Sem exigência de
// https: o Airflow de produção só responde em http (decisão de 18/09/2026, a mesma do CX Hub).
// Copiado do app cx-hub (a fila do CX Hub), que dispara a mesma DAG gobeaute_reenvio_reembolso_etl com os casos e as
// atualizações do CX Hub. Este app dispara a mesma DAG só com as atualizações do backoffice: a DAG aceita runs em
// paralelo (o índice único da raw barra a mesma id_atualizacao duas vezes, e a ordem é o atualizado_em).

import type { ConfigAirflow } from "./config";
import type { Busca } from "./contexto";

// status 0 = rede ou tempo esgotado.
export class AirflowErro extends Error {
  constructor(public readonly status: number, public readonly corpo = "") {
    super(status ? `Airflow HTTP ${status}` : `Airflow inalcançável (${corpo})`);
  }

  // Rede, tempo esgotado ou 5xx: a próxima rodada tenta de novo. 4xx é configuração (permissão, DAG, contrato).
  get transitorio(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export const comoAirflowErro = (err: unknown): AirflowErro =>
  err instanceof AirflowErro ? err : new AirflowErro(0, String((err as Error)?.message || err).slice(0, 200));

// Cada chamada. A rodada inteira tem de caber bem antes do corte do gateway (ver PRAZO_RODADA_MS em lote.ts).
const TEMPO_LIMITE_MS = 10_000;

// Cache do JWT por isolate: renovar a cada chamada seria um login por consulta.
const tokens = new Map<string, { token: string; expiraEm: number }>();

export const limparCacheAirflow = () => tokens.clear();

function expDoJwt(token: string): number | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const dados = JSON.parse(atob(payload)) as { exp?: number };
    return typeof dados.exp === "number" ? dados.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Rede e tempo esgotado viram AirflowErro(0): quem chama decide só pelo transitorio.
async function buscar(f: Busca, url: string, init: RequestInit): Promise<{ status: number; texto: string }> {
  try {
    const r = await f(url, { ...init, signal: AbortSignal.timeout(TEMPO_LIMITE_MS) });
    return { status: r.status, texto: await r.text() };
  } catch (err) {
    throw comoAirflowErro(err);
  }
}

async function obterToken(cfg: ConfigAirflow, f: Busca, agora: number): Promise<string> {
  const chave = `${cfg.baseUrl}|${cfg.usuario}`;
  const guardado = tokens.get(chave);
  if (guardado && guardado.expiraEm - 30_000 > agora) return guardado.token;
  const r = await buscar(f, `${cfg.baseUrl}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: cfg.usuario, password: cfg.senha }),
  });
  if (r.status < 200 || r.status >= 300) throw new AirflowErro(r.status, r.texto.slice(0, 300));
  let token: unknown;
  try {
    token = (JSON.parse(r.texto) as { access_token?: unknown }).access_token;
  } catch {
    token = null;
  }
  if (typeof token !== "string" || !token) throw new AirflowErro(502, "resposta do /auth/token sem access_token");
  tokens.set(chave, { token, expiraEm: expDoJwt(token) ?? agora + 5 * 60_000 });
  return token;
}

// O Airflow 3 responde 401 sem token e 403 para token expirado ou assinado com segredo antigo: renova uma vez.
async function chamar(cfg: ConfigAirflow, f: Busca, agora: number, caminho: string, init: RequestInit = {}) {
  const executar = async (token: string) =>
    buscar(f, `${cfg.baseUrl}/api/v2${caminho}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    });
  let r = await executar(await obterToken(cfg, f, agora));
  if (r.status === 401 || r.status === 403) {
    tokens.delete(`${cfg.baseUrl}|${cfg.usuario}`);
    r = await executar(await obterToken(cfg, f, agora));
  }
  return r;
}

const ok = (status: number) => status >= 200 && status < 300;

function lerJson(r: { status: number; texto: string }): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(r.texto);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // cai no erro abaixo
  }
  throw new AirflowErro(502, "resposta ilegível");
}

const caminhoDaDag = (cfg: ConfigAirflow) => `/dags/${encodeURIComponent(cfg.dagId)}`;
const caminhoDoRun = (cfg: ConfigAirflow, runId: string) => `${caminhoDaDag(cfg)}/dagRuns/${encodeURIComponent(runId)}`;

// 409: o dag_run_id já existia (o disparo de uma rodada que caiu no meio): segue como disparado.
export async function dispararLote(cfg: ConfigAirflow, f: Busca, agora: number, runId: string, conf: unknown): Promise<"criado" | "ja_existia"> {
  const r = await chamar(cfg, f, agora, `${caminhoDaDag(cfg)}/dagRuns`, {
    method: "POST",
    body: JSON.stringify({ dag_run_id: runId, logical_date: null, conf }),
  });
  if (r.status === 409) return "ja_existia";
  if (!ok(r.status)) throw new AirflowErro(r.status, r.texto.slice(0, 300));
  return "criado";
}

// queued, running, success, failed; null quando o run não existe.
export async function estadoDoRun(cfg: ConfigAirflow, f: Busca, agora: number, runId: string): Promise<string | null> {
  const r = await chamar(cfg, f, agora, caminhoDoRun(cfg, runId));
  if (r.status === 404) return null;
  if (!ok(r.status)) throw new AirflowErro(r.status, r.texto.slice(0, 300));
  const estado = lerJson(r).state;
  return typeof estado === "string" ? estado : null;
}

// O XCom como objeto: o Airflow 3.0 devolve o valor como objeto ou como JSON em texto (às vezes duas vezes), como
// o chargeback-panel já viu. O que não for objeto volta como está, e quem lê confere a forma.
function valorDoXcom(v: unknown, voltas = 2): unknown {
  if (typeof v === "string" && voltas > 0) {
    try {
      return valorDoXcom(JSON.parse(v), voltas - 1);
    } catch {
      return v;
    }
  }
  return v;
}

// O resultado por item que a DAG grava no XCom (task gravar, key resultado). undefined: não há XCom (404).
export async function resultadoDoRun(cfg: ConfigAirflow, f: Busca, agora: number, runId: string): Promise<unknown> {
  const caminho = `${caminhoDoRun(cfg, runId)}/taskInstances/${encodeURIComponent(cfg.taskResultado)}/xcomEntries/${encodeURIComponent(cfg.chaveResultado)}`;
  const r = await chamar(cfg, f, agora, caminho);
  if (r.status === 404) return undefined;
  if (!ok(r.status)) throw new AirflowErro(r.status, r.texto.slice(0, 300));
  return valorDoXcom(lerJson(r).value);
}

// Recoloca o run para rodar (todas as tasks). dry_run é true por padrão no Airflow 3: sem o false, nada acontece.
export async function limparRun(cfg: ConfigAirflow, f: Busca, agora: number, runId: string): Promise<void> {
  const r = await chamar(cfg, f, agora, `${caminhoDoRun(cfg, runId)}/clear`, {
    method: "POST",
    body: JSON.stringify({ dry_run: false }),
  });
  if (!ok(r.status)) throw new AirflowErro(r.status, r.texto.slice(0, 300));
}

// Pausada, o run ficaria na fila do Airflow sem erro nenhum: o lote não é disparado.
export async function dagPausada(cfg: ConfigAirflow, f: Busca, agora: number): Promise<boolean> {
  const r = await chamar(cfg, f, agora, caminhoDaDag(cfg));
  if (!ok(r.status)) throw new AirflowErro(r.status, r.texto.slice(0, 300));
  return lerJson(r).is_paused === true;
}
