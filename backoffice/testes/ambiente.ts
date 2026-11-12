// Ambiente de teste: o mesmo servidor/app.ts do Worker, com SQLite em memória no lugar do env.DB, relógio manual, rede
// falsa e três falsos atrás dela: o Metabase (que roda o SQL de verdade num Postgres em WASM, o PGlite, com a gold e a
// raw), o Airflow (que guarda os runs, o XCom e os clears) e o Slack. A DAG e o dbt são simulados pelo teste:
// `dag()` grava os eventos do conf na raw e devolve o XCom; `dbt()` aplica os eventos na gold.
//
// Adaptação do app cx-hub (fila única, backoffice/ORIGEM.md): a rodada é a da fila do app (servidor/ da raiz, no mesmo
// banco), com a etapa do backoffice ligada como no worker.ts; o CX Hub chega à fila pelo `fila()`.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { limparCacheAirflow } from "../../servidor/airflow";
import { tratar as tratarNaFila } from "../../servidor/app";
import { banco as bancoDaFila } from "../../servidor/banco";
import { lerConfig as lerConfigDaFila, type Segredos as SegredosDaFila } from "../../servidor/config";
import type { Dependencias as DependenciasDaFila } from "../../servidor/contexto";
import { CAMPO_POR_NOME } from "../shared/campos";
import { PREFIXO_DO_BACKOFFICE, tratar } from "../servidor/app";
import { banco, type BancoBruto } from "../servidor/banco";
import { rodadaDoBackoffice } from "../servidor/conferencia";
import { lerConfig, type Segredos } from "../servidor/config";
import { limparCacheDaRotaDados } from "../servidor/rotaDados";
import { limparCacheDoCatalogo } from "../servidor/catalogo";
import type { Dependencias } from "../servidor/contexto";
import type { Relogio } from "../servidor/tempo";

export const EMAIL = "ana.silva@gocase.com";
export const OUTRO_EMAIL = "bruno.costa@gocase.com";
export const TOKEN_FILA = "token-de-teste-da-fila";
export const CHAVE_CRON = "cron_chave_de_teste";
export const HOST_METABASE = "metabase.exemplo";
export const CHAVE_METABASE = "mb_chave_de_teste";
export const HOST_AIRFLOW = "airflow.exemplo:8080";
export const HOST_SLACK = "hooks.slack.exemplo";
export const URL_SLACK = `https://${HOST_SLACK}/services/T000/B000/segredo-de-teste`;
export const DAG = "gobeaute_reenvio_reembolso_etl";
export const URL_APP = "https://backoffice-reenvio-reembolso.devgogroup.com";
// 10/11/2026, 12h em São Paulo.
export const INICIO = Date.parse("2026-11-10T15:00:00Z");
export const MINUTOS_10 = 10 * 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

// node:sqlite pelo require do Node, como em testes/ambiente.ts da raiz: o @types/node deste repositório (20) ainda não
// tem os tipos dele.
type Sqlite = {
  prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): { changes: number | bigint } };
};
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (arquivo: string) => Sqlite };

export function bancoEmMemoria(): BancoBruto {
  const sqlite = new DatabaseSync(":memory:");
  return {
    async query(sql, params = []) {
      const rows = sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
      return { columns: rows.length ? Object.keys(rows[0]) : [], rows };
    },
    // O env.DB do GoDeploy conta também as linhas de índice no rowsWritten. Contar em dobro aqui faz falhar qualquer
    // regra que dependa do número exato, e não só do "gravou ou não".
    async exec(sql, params = []) {
      return { rowsWritten: 2 * Number(sqlite.prepare(sql).run(...(params as never[])).changes) };
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

// ─── O Data Mart (gold e raw) num Postgres em WASM, atrás de um /api/dataset falso ──────────────────────────────

const DDL = `
create schema if not exists gold;
create schema if not exists raw;
create table if not exists gold.fct_reenvio_reembolso_gobeaute (
  data_solicitacao timestamp, mes_ano text, tipo text, marca text, sigla text, grupo text, fonte text,
  sistema_origem text, chave_unica text primary key, numero_pedido text, cod_nf_original text, chave_nf text,
  valor_nf_tratado numeric, sku_produto_problema text, motivo text, area text, uf_origem text, uf_destino text,
  status_ocorrencia text, transportadora text, cod_nfd text, chave_nfd text, xml boolean, lote text, erp text,
  parcial_completo text, pedido_devolvido_operacao text, responsavel_atendimento text, origem_solicitacao text,
  id_atendimento text, status_execucao text, data_execucao date, responsavel_execucao text, prazo_execucao date,
  data_pedido_original_coorte date, pagamento_hexagon boolean, metodo_pagamento text, motivo_atraso text,
  responsavel_avaria text, produtos_reenvio text, transportadora_reenvio text, tipo_solicitacao text,
  escopo_reembolso text, excecao_politica boolean, ticket_transportadora text, tratativa text,
  created_at timestamp, updated_at timestamp, _loaded_at timestamptz
);
create table if not exists raw.cxhub_reenvio_reembolso_eventos (
  evento_id text primary key, id_solicitacao text not null, tipo_evento text not null, marca text, dag_run_id text,
  disparado_em timestamptz, payload jsonb, _loaded_at timestamptz not null
);
create unique index if not exists ux_raw_id_atualizacao on raw.cxhub_reenvio_reembolso_eventos ((payload ->> 'id_atualizacao'));
create table if not exists gold.fct_shopify_orders (
  order_id bigint primary key, order_number bigint, order_name text, brand text, created_at timestamptz,
  value_total numeric, value_shipment numeric, value_discount numeric
);
create table if not exists gold.fct_shopify_order_items (
  order_id bigint, line_item_id bigint, sku text, name text, title text, quantity int, price numeric
);
create table if not exists gold.fct_shopify_order_items_exploded_priced_mat (
  mat_id bigserial, order_id bigint, line_item_id bigint, brand text, effective_sku text, is_kit_component boolean,
  component_units numeric, allocated_revenue numeric
);
create schema if not exists silver;
create table if not exists silver.dim_shopify_products_individual (
  brand text, sku text, product_title text, variant_title text, price numeric, status text
);
`;

// Um Postgres por arquivo de teste (subir leva ~1 s); cada ambiente começa com as tabelas vazias.
let pglite: Promise<PGlite> | null = null;
async function postgres(): Promise<PGlite> {
  pglite ??= (async () => {
    const pg = new PGlite();
    await pg.exec(DDL);
    return pg;
  })();
  const pg = await pglite;
  await pg.exec("truncate gold.fct_reenvio_reembolso_gobeaute, raw.cxhub_reenvio_reembolso_eventos, gold.fct_shopify_orders, gold.fct_shopify_order_items, gold.fct_shopify_order_items_exploded_priced_mat, silver.dim_shopify_products_individual;");
  return pg;
}

// Uma linha da gold, como o dbt a montaria. O padrão é um reembolso da Lescent aberto pelo CX Hub hoje.
export type LinhaGold = Record<string, string | number | boolean | null>;

let seq = 0;
export function linhaGold(sobre: LinhaGold = {}): LinhaGold {
  seq++;
  const id = randomUUID();
  return {
    data_solicitacao: "2026-11-10 09:00:00",
    tipo: "REEMBOLSO",
    marca: "Lescent",
    sigla: "LE",
    grupo: "Gobeaute",
    fonte: "CX Hub",
    sistema_origem: "CX Hub",
    chave_unica: `cxhub|${id}`,
    numero_pedido: `SH${1000 + seq}LE`,
    valor_nf_tratado: 59.9,
    motivo: "Pedido não entregue",
    status_ocorrencia: "Pedido não entregue (em trânsito)",
    responsavel_atendimento: "Bruno",
    sku_produto_problema: "-",
    _loaded_at: "2026-11-10T12:20:00Z",
    ...sobre,
  };
}

const CODIGO_DA_SIGLA: Record<string, string> = {
  LE: "lescent", KO: "kokeshi", BS: "bysamia", AU: "aua", BB: "barbours", RT: "rituaria", AP: "apice", YE: "yenzah", DV: "denavita", GB: "gobeaute",
};

// A criação que o CX Hub teria mandado para uma linha da gold (a identidade igual à da linha). O reenvio com o
// responsável "Automação" é o que o CX Hub criou no Cosmos: a criação dele leva automacao = true (de onde o dbt tira o
// responsável).
export function criacaoDaLinha(l: LinhaGold): Record<string, unknown> {
  return {
    id_solicitacao: String(l.chave_unica).slice("cxhub|".length),
    tipo: l.tipo,
    marca: CODIGO_DA_SIGLA[String(l.sigla)],
    criado_em: `${String(l.data_solicitacao).replace(" ", "T")}-03:00`,
    numero_pedido: l.numero_pedido,
    motivo: l.motivo,
    valor: l.valor_nf_tratado,
    status_pedido: l.status_ocorrencia,
    responsavel: l.responsavel_atendimento,
    ...(l.tipo === "REENVIO" ? { automacao: l.responsavel_execucao === "Automação" } : {}),
  };
}

export type EventoFalso = {
  id: string;
  tipo: "caso" | "atualizacao";
  payload: Record<string, unknown>;
  carregadoEm: string;
  disparadoEm?: string;
  posicao?: number;
};

let eventos = 0;
let pedidos = 0;

// ─── A rota de dados (app rota-dados-cxhub), atrás de um gateway falso ───────

export const HOST_ROTA_DADOS = "rota-dados.exemplo";
export const TOKEN_ROTA_DADOS = "token-da-rota-de-dados";
export const CHAVE_GDK_ROTA_DADOS = "gdk_chave_de_teste";
export const MOTIVOS: Record<string, string[]> = {
  reembolso: ["Pedido não entregue", "Produto avariado/extraviado", "Arrependimento"],
  reenvio: ["Pedido não entregue", "Produto avariado", "Faltando item"],
};

export class RotaDadosFalsa {
  proximaFalha: number | null = null;
  chamadas = 0;
  manipular = (req: Request): Response => {
    this.chamadas++;
    // O gateway: sem a chave gdk_ do app, 302 para o login.
    if (req.headers.get("authorization") !== `Bearer ${CHAVE_GDK_ROTA_DADOS}`) return new Response(null, { status: 302, headers: { location: "https://login.exemplo" } });
    if (req.headers.get("x-form-data-token") !== TOKEN_ROTA_DADOS) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    const falha = this.proximaFalha;
    this.proximaFalha = null;
    if (falha) return Response.json({ code: "DB_UNAVAILABLE" }, { status: falha });
    const origem = new URL(req.url).searchParams.get("origin") || "";
    return Response.json({ marcas: ["lescent"], "responsáveis": ["Ana"], motivos: MOTIVOS[origem] ?? [], transportadoras_reenvio: [] });
  };
}

export class DataMartFalso {
  // Força um status HTTP (ou erro de SQL) no próximo /api/dataset.
  proximaFalha: { status: number; erro?: string } | null = null;
  readonly consultas: string[] = [];
  constructor(readonly pg: PGlite) {}

  static async criar() {
    return new DataMartFalso(await postgres());
  }

  // Linhas na gold. Como em produção, o caso do CX Hub ganha também a criação na raw, carregada no mesmo instante
  // que o dbt registrou na linha (a gold já a mostra).
  async inserir(...linhas: LinhaGold[]) {
    for (const l of linhas) {
      const cols = Object.keys(l);
      await this.pg.query(
        `insert into gold.fct_reenvio_reembolso_gobeaute (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
        cols.map(c => l[c]),
      );
      if (l.sistema_origem === "CX Hub" && String(l.chave_unica).startsWith("cxhub|"))
        await this.evento({ id: String(l.chave_unica).slice("cxhub|".length), tipo: "caso", payload: criacaoDaLinha(l), carregadoEm: String(l._loaded_at) });
    }
  }

  // Um evento na raw, como a DAG grava (evento_id = <run>:<lista>:<posição>; disparado_em = a hora do item).
  async evento(e: EventoFalso) {
    eventos++;
    await this.pg.query(
      `insert into raw.cxhub_reenvio_reembolso_eventos (evento_id, id_solicitacao, tipo_evento, marca, dag_run_id, disparado_em, payload, _loaded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [`run-${eventos}:${e.tipo === "caso" ? "casos" : "atualizacoes"}:${e.posicao ?? 0}`, e.id, e.tipo, e.payload.marca ?? null, `run-${eventos}`,
        e.disparadoEm ?? e.carregadoEm, JSON.stringify(e.payload), e.carregadoEm],
    );
  }

  // Um pedido da Shopify no Data Mart (a loja é o brand: "lescent", "barbours", ...). O kit leva os itens, que vão para
  // a tabela explodida como no dbt (a linha que não é kit entra lá como ela mesma); `semExplosao` é o pedido das últimas
  // horas, que o dbt ainda não explodiu.
  async pedidoShopify(p: {
    loja: string; numero: number; total: number; frete: number; desconto: number; semExplosao?: boolean;
    itens: Array<{
      id: number; sku: string; nome?: string; quantidade: number; preco: number;
      componentes?: Array<{ sku: string; quantidade: number; alocado?: number }>;
    }>;
  }) {
    pedidos++;
    await this.pg.query(
      "insert into gold.fct_shopify_orders values ($1, $2, $3, $4, now(), $5, $6, $7)",
      [pedidos, p.numero, `SH${p.numero}`, p.loja, p.total, p.frete, p.desconto],
    );
    for (const i of p.itens) {
      await this.pg.query("insert into gold.fct_shopify_order_items values ($1, $2, $3, $4, $5, $6, $7)", [pedidos, i.id, i.sku, i.nome ?? `Produto ${i.sku}`, null, i.quantidade, i.preco]);
      if (p.semExplosao) continue;
      const explodidos = i.componentes?.map(c => [c.sku, true, c.quantidade, c.alocado ?? null] as const) ?? [[i.sku, false, i.quantidade, null] as const];
      for (const [sku, componente, unidades, alocado] of explodidos)
        await this.pg.query(
          "insert into gold.fct_shopify_order_items_exploded_priced_mat (order_id, line_item_id, brand, effective_sku, is_kit_component, component_units, allocated_revenue) values ($1, $2, $3, $4, $5, $6, $7)",
          [pedidos, i.id, p.loja, sku, componente, unidades, alocado],
        );
    }
  }

  // Os produtos avulsos da Shopify de uma loja (o catálogo do mimo e o preço dos itens dos kits).
  async catalogo(loja: string, produtos: Array<{ sku: string; nome: string; preco: number; status?: string; variante?: string }>) {
    for (const p of produtos)
      await this.pg.query(
        "insert into silver.dim_shopify_products_individual (brand, sku, product_title, variant_title, price, status) values ($1, $2, $3, $4, $5, $6)",
        [loja, p.sku, p.nome, p.variante ?? "Default Title", p.preco, p.status ?? "active"],
      );
  }

  async gold(chave: string): Promise<Record<string, unknown> | undefined> {
    return (await this.pg.query<Record<string, unknown>>("select * from gold.fct_reenvio_reembolso_gobeaute where chave_unica = $1", [chave])).rows[0];
  }

  manipular = async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname !== "/api/dataset") return Response.json({ message: "não encontrado" }, { status: 404 });
    if (req.headers.get("x-api-key") !== CHAVE_METABASE) return new Response("Unauthenticated", { status: 401 });
    const corpo = (await req.json()) as { database: number; type: string; native: { query: string } };
    this.consultas.push(corpo.native.query);
    const falha = this.proximaFalha;
    this.proximaFalha = null;
    if (falha?.erro) return Response.json({ status: "failed", error: falha.erro }, { status: 202 });
    if (falha) return new Response("<html><title>Bad Gateway</title></html>", { status: falha.status });
    try {
      const r = await this.pg.query<unknown[]>(corpo.native.query, [], { rowMode: "array" });
      // Como o Metabase devolve: numeric e bigint como número.
      const rows = r.rows.map(linha => linha.map((v, i) => (typeof v === "bigint" || r.fields[i]?.dataTypeID === 1700 ? (v === null ? null : Number(v)) : v)));
      return Response.json({ status: "completed", row_count: rows.length, data: { rows, cols: r.fields.map(f => ({ name: f.name })) } }, { status: 202 });
    } catch (err) {
      return Response.json({ status: "failed", error: String((err as Error).message) }, { status: 202 });
    }
  };

  // A DAG: grava na raw um evento por caso e por atualização do conf (os casos antes, com o mesmo evento_id e o índice
  // único da DAG real) e devolve o XCom, com as posições recusadas pelo teste (`recusadas`: as das atualizações).
  async dag(runId: string, conf: Json, o: { recusadas?: Record<number, string>; carregadoEm?: string } = {}) {
    const carregado = o.carregadoEm ?? "2026-11-10T15:12:00Z";
    const casos: Json[] = [];
    for (const [posicao, item] of ((conf.casos ?? []) as Json[]).entries()) {
      await this.pg.query(
        `insert into raw.cxhub_reenvio_reembolso_eventos (evento_id, id_solicitacao, tipo_evento, marca, dag_run_id, disparado_em, payload, _loaded_at)
         values ($1, $2, 'caso', $3, $4, $5, $6, $7) on conflict do nothing`,
        [`${runId}:casos:${posicao}`, item.id_solicitacao, item.marca ?? null, runId, carregado, JSON.stringify(item), carregado],
      );
      casos.push({ posicao, id_solicitacao: item.id_solicitacao });
    }
    const gravados: Json[] = [];
    const recusados: Json[] = [];
    for (const [posicao, item] of ((conf.atualizacoes ?? []) as Json[]).entries()) {
      if (o.recusadas && posicao in o.recusadas) {
        recusados.push({ posicao, id_solicitacao: item.id_solicitacao, id_atualizacao: item.id_atualizacao, erro: o.recusadas[posicao] });
        continue;
      }
      const r = await this.pg.query(
        `insert into raw.cxhub_reenvio_reembolso_eventos (evento_id, id_solicitacao, tipo_evento, marca, dag_run_id, disparado_em, payload, _loaded_at)
         values ($1, $2, 'atualizacao', null, $3, $4, $5, $6) on conflict do nothing`,
        [`${runId}:atualizacoes:${posicao}`, item.id_solicitacao, runId, item.atualizado_em, JSON.stringify(item), carregado],
      );
      gravados.push({ posicao, id_solicitacao: item.id_solicitacao, id_atualizacao: item.id_atualizacao, repetida: r.affectedRows === 0 });
    }
    return { casos: { gravados: casos, recusados: [] }, atualizacoes: { gravados, recusados } };
  }

  // O dbt: aplica na gold cada evento de atualização, do mais antigo ao mais novo, e leva o _loaded_at da linha ao do
  // evento mais novo do caso (é o que o int_reenvio_reembolso_gobeaute faz).
  async dbt() {
    const eventos = (await this.pg.query<{ id_solicitacao: string; payload: Record<string, unknown>; carregado: string }>(
      "select id_solicitacao, payload, _loaded_at::text as carregado from raw.cxhub_reenvio_reembolso_eventos where tipo_evento = 'atualizacao' order by disparado_em, evento_id",
    )).rows;
    for (const e of eventos) {
      const sets: string[] = [];
      const valores: unknown[] = [];
      for (const [campo, valor] of Object.entries(e.payload)) {
        const def = CAMPO_POR_NOME.get(campo);
        if (!def) continue;
        valores.push(valor === "" ? null : valor);
        sets.push(`${def.coluna} = $${valores.length}`);
      }
      valores.push(e.carregado, `cxhub|${e.id_solicitacao}`);
      await this.pg.query(
        `update gold.fct_reenvio_reembolso_gobeaute set ${[...sets, `_loaded_at = greatest(_loaded_at, $${valores.length - 1}::timestamptz)`].join(", ")} where chave_unica = $${valores.length}`,
        valores,
      );
    }
  }
}

// ─── O Airflow 3 ─────────────────────────────────────────────────────────────

export type RunFalso = { conf: Json; estado: string; xcom?: unknown; clears: number };

// JWT com exp em 2100: o token fica no cache durante o teste inteiro.
const JWT = `x.${btoa(JSON.stringify({ exp: 4102444800 }))}.y`;

export class AirflowFalso {
  pausada = false;
  readonly runs = new Map<string, RunFalso>();
  proximoDisparo: number | "rede" | null = null;

  manipular = async (req: Request): Promise<Response> => {
    const p = new URL(req.url).pathname;
    if (p === "/auth/token") return Response.json({ access_token: JWT }, { status: 201 });
    const base = `/api/v2/dags/${DAG}`;
    if (p === base && req.method === "GET") return Response.json({ dag_id: DAG, is_paused: this.pausada });
    if (p === `${base}/dagRuns` && req.method === "POST") {
      const forcado = this.proximoDisparo;
      this.proximoDisparo = null;
      if (forcado === "rede") throw new TypeError("fetch failed");
      if (typeof forcado === "number") return Response.json({ detail: "forçado" }, { status: forcado });
      const corpo = (await req.json()) as { dag_run_id: string; conf: Json };
      if (this.runs.has(corpo.dag_run_id)) return Response.json({ detail: "already exists" }, { status: 409 });
      this.runs.set(corpo.dag_run_id, { conf: corpo.conf, estado: "queued", clears: 0 });
      return Response.json({ dag_run_id: corpo.dag_run_id, state: "queued" });
    }
    const m = p.match(/^\/api\/v2\/dags\/[^/]+\/dagRuns\/([^/]+)(\/clear|\/taskInstances\/gravar\/xcomEntries\/resultado)?$/);
    const run = m ? this.runs.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !run) return Response.json({ detail: "não encontrado" }, { status: 404 });
    if (!m[2]) return Response.json({ dag_run_id: m[1], state: run.estado });
    if (m[2] === "/clear") {
      if (((await req.json()) as { dry_run?: unknown }).dry_run !== false) return Response.json({ task_instances: [] });
      run.clears++;
      run.estado = "queued";
      run.xcom = undefined;
      return Response.json({ task_instances: [{ task_id: "gravar" }] });
    }
    if (run.xcom === undefined) return Response.json({ detail: "XCom entry not found" }, { status: 404 });
    return Response.json({ key: "resultado", value: run.xcom });
  };

  ultimo(): [string, RunFalso] {
    const todos = [...this.runs.entries()];
    return todos[todos.length - 1];
  }

  terminar(id: string, estado: "success" | "failed", xcom?: unknown) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`run ${id} não existe no falso`);
    run.estado = estado;
    run.xcom = xcom;
  }
}

// ─── O ambiente ─────────────────────────────────────────────────────────────

type Resposta = { status: number; cabecalhos: Headers; json: Json };
type Opcoes = { cabecalhos?: Record<string, string>; corpo?: unknown; usuario?: string | null; semProtecao?: boolean };

export async function criarAmbiente(op: { segredos?: Segredos & SegredosDaFila } = {}) {
  limparCacheAirflow();
  const segredos: Segredos & SegredosDaFila = {
    METABASE_URL: `https://${HOST_METABASE}/`,
    METABASE_API_KEY: CHAVE_METABASE,
    METABASE_DATABASE_ID: "43",
    FORM_DATA_API_URL: `https://${HOST_ROTA_DADOS}/`,
    FORM_DATA_API_TOKEN: TOKEN_ROTA_DADOS,
    FORM_DATA_GODEPLOY_KEY: CHAVE_GDK_ROTA_DADOS,
    // Os da fila do app, que leva as edições à DAG.
    CXHUB_FILA_TOKENS: TOKEN_FILA,
    GODEPLOY_CRON_KEY: CHAVE_CRON,
    // http de propósito: o Airflow de produção só responde em http.
    AIRFLOW_BASE_URL: `http://${HOST_AIRFLOW}/`,
    AIRFLOW_USER: "cxhub",
    AIRFLOW_PASSWORD: "senha-de-teste",
    SLACK_ALERT_WEBHOOK_URL: URL_SLACK,
    ...op.segredos,
  };
  limparCacheDaRotaDados();
  limparCacheDoCatalogo();
  const cfg = lerConfig(segredos);
  const relogio = new RelogioManual(INICIO);
  const rede = new RedeFalsa();
  const datamart = await DataMartFalso.criar();
  const airflow = new AirflowFalso();
  const rotaDados = new RotaDadosFalsa();
  rede.responder(HOST_METABASE, datamart.manipular);
  rede.responder(HOST_AIRFLOW, airflow.manipular);
  rede.responder(HOST_SLACK, () => new Response("ok"));
  rede.responder(HOST_ROTA_DADOS, rotaDados.manipular);
  let ids = 0;
  // Um banco só, como o env.DB: o backoffice e a fila leem e gravam nas mesmas tabelas.
  const bruto = bancoEmMemoria();
  const deps: Dependencias = {
    db: banco(bruto), cfg, relogio, fetch: rede.fetch,
    novoId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  };
  const depsDaFila: DependenciasDaFila = {
    db: bancoDaFila(bruto), cfg: lerConfigDaFila(segredos), relogio, fetch: rede.fetch,
    posRodada: (_c, prazo) => rodadaDoBackoffice(deps, prazo),
  };

  // Como o navegador chama: logado (o gateway põe o e-mail), e nas escritas com o cabeçalho e a origem do app.
  async function chamar(metodo: string, caminho: string, o: Opcoes = {}): Promise<Resposta> {
    const corpo = o.corpo === undefined ? undefined : typeof o.corpo === "string" ? o.corpo : JSON.stringify(o.corpo);
    const cabecalhos: Record<string, string> = {};
    const usuario = o.usuario === undefined ? EMAIL : o.usuario;
    if (usuario) cabecalhos["x-godeploy-user-email"] = usuario;
    if (metodo !== "GET" && !o.semProtecao) Object.assign(cabecalhos, { "x-backoffice": "1", origin: URL_APP });
    if (corpo !== undefined) cabecalhos["content-type"] = "application/json";
    // Adaptação do app cx-hub: os testes continuam escrevendo o caminho do app de origem (/api/...), e o helper o leva
    // para onde as rotas moram aqui (/api/backoffice/...).
    const publico = caminho.replace(/^\/api(?=\/|$)/, PREFIXO_DO_BACKOFFICE);
    const r = await tratar(new Request(URL_APP + publico, { method: metodo, headers: { ...cabecalhos, ...o.cabecalhos }, body: corpo }), deps);
    const texto = await r.text();
    let json: Json = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = texto;
    }
    return { status: r.status, cabecalhos: r.headers, json };
  }

  // A fila do app, como o CX Hub a chama (o token; a chave gdk_ é do gateway, fora do app).
  async function fila(metodo: string, caminho: string, corpo?: unknown): Promise<Resposta> {
    const cabecalhos: Record<string, string> = { "x-cxhub-fila-token": TOKEN_FILA };
    if (corpo !== undefined) cabecalhos["content-type"] = "application/json";
    const r = await tratarNaFila(new Request(URL_APP + caminho, { method: metodo, headers: cabecalhos, body: corpo === undefined ? undefined : JSON.stringify(corpo) }), depsDaFila);
    const texto = await r.text();
    return { status: r.status, cabecalhos: r.headers, json: texto ? JSON.parse(texto) : null };
  }

  // A rodada do cron: a da fila (com a etapa do backoffice), chamada à mão com o token. O cabeçalho do cron e a trava
  // dele são da fila (testes/fila.test.ts da raiz).
  const cron = () => fila("POST", "/api/v1/interno/lote");

  const editar = (chave: string, corpo: unknown) => chamar("POST", `/api/solicitacoes/${encodeURIComponent(chave)}/edicoes`, { corpo });
  const avisos = () => rede.para(HOST_SLACK).map(ch => String((JSON.parse(ch.corpo) as { text: string }).text));
  // As edições do backoffice como a fila as guarda, com quem as fez e a conferência na raw (todas, até a fila as apagar).
  const edicoes = () => deps.db.query(
    `SELECT a.id_atualizacao, a.id_solicitacao, b.chave_unica, b.tipo, b.sigla, a.campos, a.atualizado_em, b.autor, a.situacao, a.erro,
       a.lote_id, a.posicao, a.tentativas, b.conferida
     FROM bo_autoria b JOIN atualizacoes a ON a.id_atualizacao = b.id_atualizacao ORDER BY a.atualizado_em_utc, a.enfileirado_em, a.id_atualizacao`,
  );

  // Uma rodada inteira com o Airflow terminando o run com o resultado da DAG falsa.
  async function rodadaComDag(o: { recusadas?: Record<number, string>; carregadoEm?: string } = {}) {
    const disparo = await cron();
    const [runId, run] = airflow.ultimo() ?? [];
    if (runId && run && run.estado === "queued") airflow.terminar(runId, "success", await datamart.dag(runId, run.conf, o));
    return { disparo, runId, run };
  }

  return { deps, depsDaFila, cfg, relogio, rede, datamart, airflow, rotaDados, chamar, fila, cron, editar, avisos, edicoes, rodadaComDag };
}

export type Ambiente = Awaited<ReturnType<typeof criarAmbiente>>;
