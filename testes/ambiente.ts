// Ambiente de teste: o mesmo servidor/app.ts do Worker, com SQLite em memória no lugar do env.DB, relógio manual,
// rede falsa (o Airflow e o Slack) e um Airflow falso que guarda os runs, o XCom e os clears.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { limparCacheAirflow } from "../servidor/airflow";
import { tratar } from "../servidor/app";
import { banco, type BancoBruto } from "../servidor/banco";
import { lerConfig, type Segredos } from "../servidor/config";
import type { Dependencias } from "../servidor/contexto";
import type { Relogio } from "../servidor/tempo";

// node:sqlite pelo require do Node: o tsc da raiz do CX Hub também passa por esta pasta, e o @types/node de lá (20)
// ainda não tem os tipos dele.
type Sqlite = {
  prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): { changes: number | bigint } };
};
const carregar = createRequire(import.meta.url);
const { DatabaseSync } = carregar("node:sqlite") as { DatabaseSync: new (arquivo: string) => Sqlite };

export const TOKEN = "token-de-teste-da-fila";
export const TOKEN_NOVO = "token-novo-durante-a-troca";
export const CHAVE_CRON = "cron_chave_de_teste";
export const HOST_AIRFLOW = "airflow.exemplo:8080";
export const HOST_SLACK = "hooks.slack.exemplo";
export const URL_SLACK = `https://${HOST_SLACK}/services/T000/B000/segredo-de-teste`;
export const DAG = "gobeaute_reenvio_reembolso_etl";
export const URL_APP = "https://cx-hub.devgogroup.com";
// 04/11/2026, 10h em Brasília.
export const INICIO = Date.parse("2026-11-04T13:00:00Z");
export const MINUTOS_20 = 20 * 60_000;

// O corpo das respostas nos testes: a forma é conferida pelos expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export function bancoEmMemoria(): BancoBruto {
  const sqlite = new DatabaseSync(":memory:");
  return {
    async query(sql, params = []) {
      const rows = sqlite.prepare(sql).all(...params);
      return { columns: rows.length ? Object.keys(rows[0]) : [], rows };
    },
    // O env.DB do GoDeploy conta também as linhas de índice no rowsWritten. Contar em dobro aqui faz falhar qualquer
    // regra que dependa do número exato, e não só do "gravou ou não".
    async exec(sql, params = []) {
      return { rowsWritten: 2 * Number(sqlite.prepare(sql).run(...params).changes) };
    },
  };
}

export class RelogioManual implements Relogio {
  constructor(public ms: number) {}
  agora() {
    return this.ms;
  }
  avancar(ms: number) {
    this.ms += ms;
  }
}

type Manipulador = (req: Request) => Response | Promise<Response>;
export type Chamada = { url: string; metodo: string; cabecalhos: Headers; corpo: string };

// Rede falsa: um manipulador por host, e toda chamada fica registrada para os testes conferirem.
export class RedeFalsa {
  readonly chamadas: Chamada[] = [];
  private readonly hosts = new Map<string, Manipulador>();
  responder(host: string, m: Manipulador) {
    this.hosts.set(host, m);
  }
  para(host: string) {
    return this.chamadas.filter(x => new URL(x.url).host === host);
  }
  fetch = async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(entrada, init);
    this.chamadas.push({ url: req.url, metodo: req.method, cabecalhos: req.headers, corpo: await req.clone().text() });
    const m = this.hosts.get(new URL(req.url).host);
    if (!m) throw new TypeError("fetch failed");
    return m(req);
  };
}

export type Conf = { casos: Json[]; atualizacoes: Json[] };
export type RunFalso = { conf: Conf; estado: string; xcom?: unknown; clears: number };

// JWT com exp em 2100: o token fica no cache durante o teste inteiro.
const JWT = `x.${btoa(JSON.stringify({ exp: 4102444800 }))}.y`;

// O Airflow 3 do lado da fila: token, DAG (pausada ou não), disparo (409 no id repetido), estado do run, XCom e clear.
export class AirflowFalso {
  pausada = false;
  readonly runs = new Map<string, RunFalso>();
  // Status forçado (ou falha de rede) no próximo disparo.
  proximoDisparo: number | "rede" | null = null;
  // Status forçado nas próximas consultas a um caminho que termina com o trecho (ex.: "/xcomEntries/resultado").
  readonly forcar = new Map<string, number>();

  manipular = async (req: Request): Promise<Response> => {
    const p = new URL(req.url).pathname;
    if (p === "/auth/token") return Response.json({ access_token: JWT }, { status: 201 });
    for (const [trecho, status] of this.forcar) if (p.endsWith(trecho)) return Response.json({ detail: "forçado" }, { status });
    const base = `/api/v2/dags/${DAG}`;
    if (p === base && req.method === "GET") return Response.json({ dag_id: DAG, is_paused: this.pausada });
    if (p === `${base}/dagRuns` && req.method === "POST") {
      const forcado = this.proximoDisparo;
      this.proximoDisparo = null;
      if (forcado === "rede") throw new TypeError("fetch failed");
      if (typeof forcado === "number") return Response.json({ detail: "forçado" }, { status: forcado });
      const corpo = (await req.json()) as { dag_run_id: string; conf: Conf };
      if (this.runs.has(corpo.dag_run_id)) return Response.json({ detail: "already exists" }, { status: 409 });
      this.runs.set(corpo.dag_run_id, { conf: corpo.conf, estado: "queued", clears: 0 });
      return Response.json({ dag_run_id: corpo.dag_run_id, state: "queued" });
    }
    const m = p.match(/^\/api\/v2\/dags\/[^/]+\/dagRuns\/([^/]+)(\/clear|\/taskInstances\/gravar\/xcomEntries\/resultado)?$/);
    const run = m ? this.runs.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !run) return Response.json({ detail: "não encontrado" }, { status: 404 });
    if (!m[2]) return Response.json({ dag_run_id: m[1], state: run.estado });
    if (m[2] === "/clear") {
      // dry_run é true por padrão no Airflow 3: sem o false, nada acontece.
      if (((await req.json()) as { dry_run?: unknown }).dry_run !== false) return Response.json({ task_instances: [] });
      run.clears++;
      run.estado = "queued";
      run.xcom = undefined;
      return Response.json({ task_instances: [{ task_id: "gravar" }] });
    }
    if (run.xcom === undefined) return Response.json({ detail: "XCom entry not found" }, { status: 404 });
    return Response.json({ key: "resultado", value: run.xcom });
  };

  // O último run disparado.
  ultimo(): [string, RunFalso] {
    const todos = [...this.runs.entries()];
    return todos[todos.length - 1];
  }

  // A DAG terminou o run, com ou sem XCom.
  terminar(id: string, estado: "success" | "failed", xcom?: unknown) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`run ${id} não existe no falso`);
    run.estado = estado;
    run.xcom = xcom;
  }
}

// O XCom que a DAG gravaria para o conf: tudo gravado, menos o que o teste mandar recusar, repetir ou omitir.
export function resultadoDaDag(conf: Conf, o: {
  casosRecusados?: Record<number, string>;
  atualizacoesRecusadas?: Record<number, string>;
  repetidas?: number[];
  omitir?: { casos?: number[]; atualizacoes?: number[] };
} = {}) {
  const lista = (itens: Json[], recusadas: Record<number, string> = {}, omitir: number[] = [], atualizacao = false) => ({
    gravados: itens.flatMap((x, posicao) => (posicao in recusadas || omitir.includes(posicao) ? [] : [{
      posicao, id_solicitacao: x.id_solicitacao,
      ...(atualizacao ? { id_atualizacao: x.id_atualizacao, repetida: Boolean(o.repetidas?.includes(posicao)) } : {}),
    }])),
    recusados: Object.entries(recusadas).map(([p, erro]) => ({
      posicao: Number(p), id_solicitacao: itens[Number(p)].id_solicitacao,
      ...(atualizacao ? { id_atualizacao: itens[Number(p)].id_atualizacao } : {}), erro,
    })),
  });
  return {
    casos: lista(conf.casos, o.casosRecusados, o.omitir?.casos),
    atualizacoes: lista(conf.atualizacoes, o.atualizacoesRecusadas, o.omitir?.atualizacoes, true),
  };
}

type Resposta = { status: number; cabecalhos: Headers; json: Json };

export async function criarAmbiente(op: { segredos?: Segredos; semSlack?: boolean } = {}) {
  limparCacheAirflow();
  const segredos: Segredos = {
    CXHUB_FILA_TOKENS: `${TOKEN}, ${TOKEN_NOVO}`,
    GODEPLOY_CRON_KEY: CHAVE_CRON,
    // http de propósito: o Airflow de produção só responde em http.
    AIRFLOW_BASE_URL: `http://${HOST_AIRFLOW}/`,
    AIRFLOW_USER: "cxhub",
    AIRFLOW_PASSWORD: "senha-de-teste",
    ...(op.semSlack ? {} : { SLACK_ALERT_WEBHOOK_URL: URL_SLACK }),
    ...op.segredos,
  };
  const cfg = lerConfig(segredos);
  const relogio = new RelogioManual(INICIO);
  const rede = new RedeFalsa();
  const airflow = new AirflowFalso();
  rede.responder(HOST_AIRFLOW, airflow.manipular);
  // O Incoming Webhook do Slack responde 200 com "ok" em texto.
  rede.responder(HOST_SLACK, () => new Response("ok"));
  const deps: Dependencias = { db: banco(bancoEmMemoria()), cfg, relogio, fetch: rede.fetch };

  async function chamar(metodo: string, caminho: string, o: { cabecalhos?: Record<string, string>; corpo?: unknown } = {}): Promise<Resposta> {
    const corpo = o.corpo === undefined ? undefined : typeof o.corpo === "string" ? o.corpo : JSON.stringify(o.corpo);
    const r = await tratar(new Request(URL_APP + caminho, { method: metodo, headers: o.cabecalhos, body: corpo }), deps);
    const texto = await r.text();
    let json: Json = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = texto;
    }
    return { status: r.status, cabecalhos: r.headers, json };
  }

  // Chamada do CX Hub, com o token (a chave gdk_ é conferida pelo gateway, fora do app).
  const fila = (metodo: string, caminho: string, corpo?: unknown) =>
    chamar(metodo, caminho, { corpo, cabecalhos: { "x-cxhub-fila-token": TOKEN, ...(corpo !== undefined ? { "content-type": "application/json" } : {}) } });

  const lote = () => fila("POST", "/api/v1/interno/lote");
  const avisos = () => rede.para(HOST_SLACK).map(ch => String((JSON.parse(ch.corpo) as { text: string }).text));
  const situacao = async (tabela: "casos" | "atualizacoes", id: string) => {
    const col = tabela === "casos" ? "id_solicitacao" : "id_atualizacao";
    return deps.db.um(`SELECT situacao, erro, tentativas, lote_id, posicao FROM ${tabela} WHERE ${col} = ?`, [id]);
  };

  return { deps, cfg, relogio, rede, airflow, chamar, fila, lote, avisos, situacao };
}

export type Ambiente = Awaited<ReturnType<typeof criarAmbiente>>;

// Simula uma falha do env.DB na primeira instrução que contém o trecho.
export function falharUmaVez(a: Ambiente, trecho: string, metodo: "exec" | "query" = "exec") {
  const original = a.deps.db[metodo] as (sql: string, params?: unknown[]) => Promise<unknown>;
  let falhou = false;
  (a.deps.db as Record<typeof metodo, unknown>)[metodo] = async (sql: string, params?: unknown[]) => {
    if (!falhou && sql.includes(trecho)) {
      falhou = true;
      throw new Error("D1_ERROR: falha simulada");
    }
    return original(sql, params);
  };
}

// ─── Exemplos (fictícios, sem dado pessoal, como o conf da DAG) ──────────────

let seq = 0;

export function caso(sobre: Record<string, unknown> = {}) {
  seq++;
  return {
    id_solicitacao: `caso-${String(seq).padStart(4, "0")}-${randomUUID().slice(0, 8)}`,
    tipo: "REEMBOLSO",
    marca: "lescent",
    criado_em: "2026-11-04T10:00:00-03:00",
    numero_pedido: "SH1001",
    valor: 59.9,
    motivo: "Produto avariado",
    responsavel: "Ana",
    ...sobre,
  };
}

export function atualizacao(idSolicitacao: string, sobre: Record<string, unknown> = {}) {
  return {
    id_atualizacao: randomUUID(),
    id_solicitacao: idSolicitacao,
    atualizado_em: "2026-11-04T13:05:00.000Z",
    campos: { status_execucao: "Cancelado", responsavel_execucao: "Ana" },
    ...sobre,
  };
}
