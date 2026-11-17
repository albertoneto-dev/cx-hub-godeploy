// O GET /api/saude pelo worker.fetch, como o GoDeploy o chama: o contrato do Monitor da Black, o 503 só com crítico
// em erro, cada ponto de registro (a rodada do lote, os envios, a busca e as dependências pelo fetch medido), as
// sondas, o banco fora e o registro que falha sem mudar a função. Nenhum serviço real: a rede é falsa, e o que não
// estiver nela é "fetch failed".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { garantirTabelasSaude, anotarSaude, retirarPendentes } from "../api/saude/registro";
import { CATALOGO } from "../api/saude/regras";
import { limparCacheAirflow } from "../servidor/airflow";
import { banco, type BancoBruto } from "../servidor/banco";
import worker from "../worker";
import { AirflowFalso, bancoEmMemoria, caso, DAG, HOST_AIRFLOW, type Json, TOKEN, URL_APP } from "./ambiente";

const COSMOS = "https://api.cosmos.test";
const METABASE = "https://metabase.test";
const CAMPOS = ["critico", "detalhe", "erros_ultima_hora", "id", "nivel", "nome", "pendentes", "tipo", "ultima_tentativa", "ultimo_sucesso"];

type Manipulador = (req: Request) => Response | Promise<Response>;

// O process.env é do processo inteiro: cada teste devolve o que achou.
let envAntes: Record<string, string | undefined>;
beforeEach(() => {
  envAntes = { ...process.env };
  retirarPendentes();
  limparCacheAirflow();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const chave of Object.keys(process.env)) if (!(chave in envAntes)) delete process.env[chave];
  Object.assign(process.env, envAntes);
  vi.restoreAllMocks();
});

// Rede falsa por host; o resto é "fetch failed", como um host que não existe.
function rede(hosts: Record<string, Manipulador> = {}): Array<{ metodo: string; url: string }> {
  const chamadas: Array<{ metodo: string; url: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (entrada, init) => {
    const req = new Request(entrada as RequestInfo, init);
    chamadas.push({ metodo: req.method, url: req.url });
    const m = hosts[new URL(req.url).host];
    if (!m) throw new TypeError("fetch failed");
    return m(req);
  });
  return chamadas;
}

const envDoApp = (extra: Record<string, string> = {}, DB: BancoBruto = bancoEmMemoria()) => ({ DB, CXHUB_FILA_TOKENS: TOKEN, COSMOS_API_URL: COSMOS, ...extra });
type Env = ReturnType<typeof envDoApp>;

// O ctx do Worker guarda o que foi para o segundo plano, para o teste esperar a gravação.
const segundoPlano: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void segundoPlano.push(p) };
const esperar = async () => {
  while (segundoPlano.length) await Promise.allSettled(segundoPlano.splice(0));
};

const pedir = (env: Env, caminho: string, init?: RequestInit) => worker.fetch(new Request(URL_APP + caminho, init), env as never, ctx);
const saude = async (env: Env): Promise<Json> => (await pedir(env, "/api/saude")).json();
const porId = (corpo: Json, id: string) => (corpo.componentes as Json[]).find(c => c.id === id);
const comToken = (corpo?: unknown): RequestInit => ({
  method: "POST",
  headers: { "x-cxhub-fila-token": TOKEN, ...(corpo !== undefined ? { "content-type": "application/json" } : {}) },
  ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
});
const postJson = (corpo: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
const duasHorasAtras = () => new Date(Date.now() - 2 * 60 * 60_000).toISOString();

describe("GET /api/saude: o contrato", () => {
  it("os 16 componentes do catálogo, cada um com os 10 campos; o app recém-medido responde 200", async () => {
    rede();
    const r = await pedir(envDoApp(), "/api/saude");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const corpo = await r.json();
    expect(corpo.ok).toBe(true);
    expect(corpo.gerado_em).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(corpo.componentes.map((c: Json) => c.id)).toEqual(CATALOGO.map(c => c.id));
    for (const c of corpo.componentes) expect(Object.keys(c).sort(), c.id).toEqual(CAMPOS);
    expect(porId(corpo, "app")).toMatchObject({ nivel: "ok", detalhe: "Worker e banco respondendo", critico: true, tipo: "app" });
    // O cron que ainda não rodou é comparado com o início da medição, que é agora.
    expect(porId(corpo, "fila_rodada")).toMatchObject({ nivel: "ok", detalhe: "aguardando a primeira execução", ultimo_sucesso: null });
    expect(porId(corpo, "fila_entrega")).toMatchObject({ nivel: "ok", detalhe: "fila vazia", pendentes: 0 });
    expect(porId(corpo, "dep_cosmos")).toMatchObject({ nivel: "ok", detalhe: "sem uso registrado ainda" });
  });

  it("HEAD responde o mesmo status sem corpo; a barra no fim vale; outro método é 405", async () => {
    rede();
    const env = envDoApp();
    const head = await pedir(env, "/api/saude", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await pedir(env, "/api/saude/")).status).toBe(200);
    const post = await pedir(env, "/api/saude", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(await post.json()).toEqual({ code: "METHOD_NOT_ALLOWED", message: "Use GET, HEAD nesta rota." });
  });
});

describe("os pontos de registro", () => {
  it("a rodada do lote (o cron) vira o último sucesso da fila_rodada", async () => {
    rede();
    const env = envDoApp();
    const r = await pedir(env, "/api/v1/interno/lote", comToken());
    expect((await r.json()).code).toBe("OK");
    await esperar();
    const c = porId(await saude(env), "fila_rodada");
    expect(c.nivel).toBe("ok");
    expect(c.ultimo_sucesso).toMatch(/Z$/);
    expect(c.detalhe).toMatch(/^última execução às \d\d:\d\d$/);
  });

  it("item parado na fila há mais de 1 h: fila_entrega em erro e 503, sem dado do caso no detalhe", async () => {
    rede();
    const env = envDoApp();
    const c = caso({ numero_pedido: "SH7777" });
    expect((await pedir(env, "/api/v1/casos", comToken({ casos: [c] }))).status).toBe(200);
    await env.DB.exec("UPDATE casos SET enfileirado_em = ?", [duasHorasAtras()]);

    const r = await pedir(env, "/api/saude");
    expect(r.status).toBe(503);
    const corpo = await r.json();
    expect(corpo.ok).toBe(false);
    expect(porId(corpo, "fila_entrega")).toMatchObject({ nivel: "erro", pendentes: 1, critico: true });
    expect(porId(corpo, "fila_entrega").detalhe).toMatch(/^1 item\(ns\) na fila, o mais antigo desde (em \d\d\/\d\d às )?\d\d:\d\d$/);
    const texto = JSON.stringify(corpo);
    expect(texto).not.toContain(c.id_solicitacao);
    expect(texto).not.toContain("7777");
  });

  it("os envios: o 400 é tentativa neutra (sem erro); o ensaio (testMode) não conta", async () => {
    rede();
    const env = envDoApp();
    expect((await pedir(env, "/api/sheets/append", postJson({ testMode: true }))).status).toBe(400);
    expect(porId(await saude(env), "reenvio").ultima_tentativa).toBeNull();

    expect((await pedir(env, "/api/sheets/append", postJson({}))).status).toBe(400);
    await esperar();
    expect(porId(await saude(env), "reenvio")).toMatchObject({ nivel: "ok", erros_ultima_hora: 0, ultimo_sucesso: null });
    expect(porId(await saude(env), "reenvio").ultima_tentativa).toMatch(/Z$/);
  });

  it("3 falhas de envio na hora sem nenhum registro: erro e 503, antes e depois de gravadas no banco", async () => {
    rede();
    const env = envDoApp();
    for (let i = 0; i < 3; i++) anotarSaude("reembolso", "erro", { erro: "HTTP 500 (UNKNOWN_ERROR)" });
    const r = await pedir(env, "/api/saude");
    expect(r.status).toBe(503);
    expect(porId(await r.json(), "reembolso")).toMatchObject({
      nivel: "erro", erros_ultima_hora: 3, detalhe: "3 falhas na última hora, sem nenhum sucesso; último erro: HTTP 500 (UNKNOWN_ERROR)",
    });
    // O fim da requisição gravou o que estava anotado: a leitura seguinte vê o mesmo, já do banco.
    await esperar();
    expect(retirarPendentes()).toEqual([]);
    const r2 = await pedir(env, "/api/saude");
    expect(r2.status).toBe(503);
    expect(porId(await r2.json(), "reembolso").erros_ultima_hora).toBe(3);
  });

  it("o bot que registrou sem a automação fica em alerta pela degradação gravada no banco (o extra junta, não troca)", async () => {
    rede();
    const env = envDoApp();
    anotarSaude("bot_reenvio", "ok", { extra: { degradado_por: "Cosmos fora", degradado_em: new Date().toISOString() } });
    await pedir(env, "/api/nao-existe");
    await esperar();
    // Um registro normal depois, sem extra, não apaga a degradação da última hora.
    anotarSaude("bot_reenvio", "ok");
    await pedir(env, "/api/nao-existe");
    await esperar();
    const r = await pedir(env, "/api/saude");
    expect(r.status).toBe(200);
    expect(porId(await r.json(), "bot_reenvio")).toMatchObject({ nivel: "alerta", erros_ultima_hora: 0 });
    expect(porId(await saude(env), "bot_reenvio").detalhe).toMatch(/^registrou sem a automação \(Cosmos fora\) às \d\d:\d\d$/);
  });

  it("a busca de pedido pelo resultado, e o Cosmos medido no fetch real; a resposta da rota segue intacta", async () => {
    const chamadas = rede({
      [new URL(COSMOS).host]: req => (new URL(req.url).pathname.endsWith("/orders/999") ? Response.json({ id: 999, external_id: "SH999LE" }) : Response.json([])),
    });
    const env = envDoApp();
    const cab = { headers: { "x-cosmos-token": "jwt-do-login" } };
    const vazia = await pedir(env, "/api/cosmos/orders?brand=lescent&orderId=123", cab);
    expect(await vazia.json()).toEqual([]);
    const achou = await pedir(env, "/api/cosmos/orders/999?brand=lescent", cab);
    expect(await achou.json()).toEqual({ id: 999, external_id: "SH999LE" });
    expect(chamadas).toHaveLength(2);
    await esperar();

    const corpo = await saude(env);
    expect(porId(corpo, "consulta_pedido")).toMatchObject({ nivel: "ok" });
    expect(porId(corpo, "consulta_pedido").detalhe).toMatch(/^último sucesso às/);
    expect(porId(corpo, "dep_cosmos").detalhe).toMatch(/^respondeu às/);
  });

  it("o Cosmos fora duas vezes seguidas: dep_cosmos em erro, sem 503 (dependência não é crítica)", async () => {
    rede({ [new URL(COSMOS).host]: () => new Response("indisponível", { status: 503 }) });
    const env = envDoApp();
    const cab = { headers: { "x-cosmos-token": "jwt-do-login" } };
    for (let i = 0; i < 2; i++) expect((await pedir(env, "/api/cosmos/orders/1?brand=lescent", cab)).status).toBe(503);
    await esperar();
    const r = await pedir(env, "/api/saude");
    expect(r.status).toBe(200);
    const corpo = await r.json();
    expect(porId(corpo, "dep_cosmos")).toMatchObject({ nivel: "erro", critico: false });
    expect(porId(corpo, "dep_cosmos").detalhe).toMatch(/^Cosmos respondeu HTTP 503 às \d\d:\d\d \(2 falhas seguidas\)$/);
    expect(porId(corpo, "consulta_pedido")).toMatchObject({ nivel: "alerta", erros_ultima_hora: 2 });
  });
});

describe("as sondas", () => {
  it("sem chamada há 15 min, lê a DAG e roda select 1 no Data Mart; a DAG pausada explica a fila parada; a segunda leitura não sonda", async () => {
    const airflow = new AirflowFalso();
    airflow.pausada = true;
    const chamadas = rede({
      [HOST_AIRFLOW]: airflow.manipular,
      [new URL(METABASE).host]: () => Response.json({ status: "completed", data: { rows: [[1]] } }, { status: 202 }),
    });
    const env = envDoApp({
      AIRFLOW_BASE_URL: `http://${HOST_AIRFLOW}/`, AIRFLOW_USER: "cxhub", AIRFLOW_PASSWORD: "senha-de-teste",
      METABASE_URL: METABASE, METABASE_API_KEY: "chave-do-metabase", METABASE_DATABASE_ID: "43",
    });
    expect((await pedir(env, "/api/v1/casos", comToken({ casos: [caso()] }))).status).toBe(200);
    await env.DB.exec("UPDATE casos SET enfileirado_em = ?", [duasHorasAtras()]);

    const corpo = await saude(env);
    expect(porId(corpo, "fila_entrega").detalhe).toMatch(/; a DAG está pausada$/);
    expect(porId(corpo, "dep_airflow").detalhe).toMatch(/^respondeu às/);
    expect(porId(corpo, "dep_datamart").detalhe).toMatch(/^respondeu às/);
    await esperar();
    await saude(env);

    const dag = chamadas.filter(c => c.metodo === "GET" && new URL(c.url).pathname === `/api/v2/dags/${DAG}`);
    const select = chamadas.filter(c => c.url === `${METABASE}/api/dataset`);
    expect([dag.length, select.length]).toEqual([1, 1]);
  });
});

describe("falhas", () => {
  it("o banco fora: app em erro, os outros em alerta sem dados, e 503", async () => {
    rede();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fora: BancoBruto = {
      query: async () => { throw new Error("D1_ERROR: fora"); },
      exec: async () => { throw new Error("D1_ERROR: fora"); },
    };
    const r = await pedir(envDoApp({}, fora), "/api/saude");
    expect(r.status).toBe(503);
    const corpo = await r.json();
    expect(porId(corpo, "app")).toMatchObject({ nivel: "erro", detalhe: "o banco do app não respondeu" });
    for (const c of corpo.componentes.filter((x: Json) => x.id !== "app")) {
      expect(c, c.id).toMatchObject({ nivel: "alerta", detalhe: "sem dados: o banco do app não respondeu", pendentes: null });
    }
  });

  it("o registro que falha (limite do banco) não muda o desfecho da função: só vai ao log", async () => {
    rede();
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    const bruto = bancoEmMemoria();
    const comLimite: BancoBruto = {
      query: (sql, p) => bruto.query(sql, p),
      exec: async (sql, p) => {
        if (sql.includes("saude_")) throw new Error("DB_LIMIT_EXCEEDED");
        return bruto.exec(sql, p);
      },
    };
    const r = await pedir(envDoApp({}, comLimite), "/api/v1/interno/lote", comToken());
    expect(r.status).toBe(200);
    expect((await r.json()).code).toBe("OK");
    await esperar();
    expect(erros.mock.calls.some(c => String(c[0]).startsWith("[saude] registro não gravado: DB_LIMIT_EXCEEDED"))).toBe(true);
  });

  it("a leitura poda as janelas com mais de 48 h e deixa as recentes", async () => {
    rede();
    const env = envDoApp();
    const db = banco(env.DB);
    await garantirTabelasSaude(db);
    const velha = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
    const nova = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const janela of [velha, nova]) await db.exec("INSERT INTO saude_janela (componente, janela, tentativas, erros) VALUES ('reenvio', ?, 1, 0)", [janela]);
    await pedir(env, "/api/saude");
    await esperar();
    expect((await db.query("SELECT janela FROM saude_janela WHERE componente = 'reenvio'")).map(l => l.janela)).toEqual([nova]);
  });
});
