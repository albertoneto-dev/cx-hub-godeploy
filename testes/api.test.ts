// A cola das rotas do CX Hub com o Worker (worker.ts e api/): o roteador nos caminhos da Vercel, o process.env montado
// dos segredos do app e a fila chamada dentro do próprio Worker. O ponta a ponta passa pelo worker.fetch, como o
// GoDeploy: enfileira pela rota HTTP da fila e lê pela rota do CX Hub, que confere o token no Cosmos, lê a raw no
// Metabase e pergunta à fila sem rede. A rede falsa recusa qualquer outro destino: se a fila saísse pela rede, quebrava.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Ambiente, ambienteDoApp, atualizarAmbiente, ORIGEM_DA_FILA_NO_WORKER } from "../api/ambiente";
import { after } from "../api/next-server";
import { headersParaARota, ROTAS_DA_API, tratarNaApi } from "../api/roteador";
import { enfileirarAtualizacao } from "../cxhub/shared/lib/fila/client";
import worker from "../worker";
import { bancoEmMemoria, caso, TOKEN, URL_APP } from "./ambiente";

const COSMOS = "https://api.cosmos.test";
const METABASE = "https://metabase.test";

type Chamada = { url: string; metodo: string; authorization: string | null };

// O process.env é do processo inteiro: cada teste devolve o que achou.
let envAntes: Record<string, string | undefined>;
beforeEach(() => {
  envAntes = { ...process.env };
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const chave of Object.keys(process.env)) if (!(chave in envAntes)) delete process.env[chave];
  Object.assign(process.env, envAntes);
  vi.restoreAllMocks();
});

// Cosmos e Metabase falsos; qualquer outra URL é "fetch failed", como um host que não existe.
function redeFalsa(rawTem: string[] = []): Chamada[] {
  const chamadas: Chamada[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (entrada, init) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    chamadas.push({ url, metodo: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    if (url.startsWith(`${COSMOS}/organizations/`)) return Response.json([]);
    if (url === `${METABASE}/api/dataset`) return Response.json({ status: "completed", data: { rows: rawTem.map(id => [id]) } }, { status: 202 });
    throw new TypeError("fetch failed");
  });
  return chamadas;
}

describe("roteador das rotas do CX Hub", () => {
  it("atende as 23 rotas da Vercel, nos mesmos caminhos e métodos", () => {
    expect(ROTAS_DA_API).toEqual([
      { caminho: "/api/auth/login", metodos: ["POST"] },
      { caminho: "/api/cancellation/submit", metodos: ["POST"] },
      { caminho: "/api/cosmos/carriers", metodos: ["GET"] },
      { caminho: "/api/cosmos/orders", metodos: ["GET"] },
      { caminho: "/api/cosmos/orders/[id]", metodos: ["GET"] },
      { caminho: "/api/cosmos/products", metodos: ["GET"] },
      { caminho: "/api/cosmos/products/[id]", metodos: ["GET"] },
      { caminho: "/api/cosmos/resends", metodos: ["GET"] },
      { caminho: "/api/cosmos/resends/[id]", metodos: ["PATCH"] },
      { caminho: "/api/cosmos/resends/[id]/cancel", metodos: ["POST"] },
      { caminho: "/api/datamart/products", metodos: ["GET"] },
      { caminho: "/api/logistica/submit", metodos: ["POST"] },
      { caminho: "/api/reenvio/bot", metodos: ["POST"] },
      { caminho: "/api/refund/cancel", metodos: ["POST"] },
      { caminho: "/api/refund/complete", metodos: ["POST"] },
      { caminho: "/api/refund/submit", metodos: ["POST"] },
      { caminho: "/api/refund/sync", metodos: ["POST"] },
      { caminho: "/api/refund/update", metodos: ["POST"] },
      { caminho: "/api/registro", metodos: ["GET"] },
      { caminho: "/api/resend/data", metodos: ["GET"] },
      { caminho: "/api/sheets/append", metodos: ["POST"] },
      { caminho: "/api/shopify/orders", metodos: ["GET"] },
      { caminho: "/api/solicitacoes", metodos: ["GET"] },
    ]);
  });

  it("404 e 405 no formato { code, message }; a barra no fim não muda a rota", async () => {
    const r404 = await tratarNaApi(new Request(`${URL_APP}/api/nao-existe`));
    expect(r404.status).toBe(404);
    expect(await r404.json()).toMatchObject({ code: "NOT_FOUND" });

    const r405 = await tratarNaApi(new Request(`${URL_APP}/api/refund/submit`));
    expect(r405.status).toBe(405);
    expect(r405.headers.get("allow")).toBe("POST");
    expect(await r405.json()).toMatchObject({ code: "METHOD_NOT_ALLOWED" });

    // Chega à rota (a resposta é a dela: origin inválido), com ou sem a barra.
    const comBarra = await tratarNaApi(new Request(`${URL_APP}/api/resend/data/?origin=nenhuma`));
    expect(comBarra.status).toBe(400);
    expect(await comBarra.json()).toEqual({ error: "origin inválido: use reenvio, reembolso, logistica" });
  });

  it("o token do Cosmos chega no x-cosmos-token e vai à rota no Authorization; a gdk_ do gateway, não", () => {
    const h = (o: Record<string, string>) => headersParaARota(new Headers(o));
    expect(h({ "x-cosmos-token": "jwt-do-login" }).get("authorization")).toBe("Bearer jwt-do-login");
    expect(h({ "x-cosmos-token": "Bearer jwt-do-login" }).get("authorization")).toBe("Bearer jwt-do-login");
    expect(h({ "x-cosmos-token": "jwt-do-login", authorization: "Bearer gdk_chave" }).get("authorization")).toBe("Bearer jwt-do-login");
    expect(h({ authorization: "Bearer gdk_chave" }).has("authorization")).toBe(false);
    // Do navegador, na mesma origem, o Authorization com o token do Cosmos segue como veio.
    expect(h({ authorization: "Bearer jwt-do-login" }).get("authorization")).toBe("Bearer jwt-do-login");
    expect(h({ "x-cosmos-token": "jwt-do-login" }).has("x-cosmos-token")).toBe(false);
  });

  it("a rota recebe o [id] decodificado, o nextUrl e o token do Cosmos; a gdk_ não chega ao Cosmos", async () => {
    vi.stubEnv("COSMOS_API_URL", COSMOS);
    const chamadas = redeFalsa();

    const r = await tratarNaApi(new Request(`${URL_APP}/api/cosmos/orders/%39%38%37?brand=lescent`, {
      headers: { "x-cosmos-token": "jwt-do-login", authorization: "Bearer gdk_chave" },
    }));

    expect(r.status).toBe(200);
    expect(chamadas).toEqual([{ url: `${COSMOS}/organizations/3/orders/987`, metodo: "GET", authorization: "Bearer jwt-do-login" }]);
  });

  it("só com a gdk_ (sem x-cosmos-token), a rota do Cosmos responde que falta o token, sem chamar o Cosmos", async () => {
    vi.stubEnv("COSMOS_API_URL", COSMOS);
    const chamadas = redeFalsa();

    const r = await tratarNaApi(new Request(`${URL_APP}/api/cosmos/orders?brand=lescent&orderId=1`, { headers: { authorization: "Bearer gdk_chave" } }));

    expect(r.status).toBe(401);
    expect(chamadas).toEqual([]);
  });

  it("exceção solta na rota vira 500 no formato { code, message }, com a pilha no log", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    // O login lê o corpo fora do try (no Next, isto era um 500 sem JSON).
    const r = await tratarNaApi(new Request(`${URL_APP}/api/auth/login`, { method: "POST", body: "{não é json" }));
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ code: "UNKNOWN_ERROR" });
    expect(erro).toHaveBeenCalled();
  });

  it("as tarefas do after() vão para o ctx.waitUntil quando a rota responde, e só terminam quando a tarefa termina", async () => {
    const waitUntil = vi.fn();
    await tratarNaApi(new Request(`${URL_APP}/api/nao-existe`), { waitUntil });
    expect(waitUntil).not.toHaveBeenCalled();

    let terminar!: () => void;
    after(() => new Promise<void>(ok => { terminar = ok; }));
    await tratarNaApi(new Request(`${URL_APP}/api/nao-existe`), { waitUntil });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    let terminou = false;
    const segura = waitUntil.mock.calls[0][0] as Promise<unknown>;
    void segura.then(() => { terminou = true; });
    await new Promise(ok => setTimeout(ok, 0));
    expect(terminou).toBe(false);
    terminar();
    await segura;
    expect(terminou).toBe(true);
  });
});

describe("process.env montado dos segredos do app", () => {
  it("completa a fila em processo (a origem interna e o primeiro token aceito), marca produção e ignora o que não é texto", () => {
    expect(ambienteDoApp({ CXHUB_FILA_TOKENS: " t1 , t2", DB: {}, VERCEL_ENV: "preview", OUTRO: "x" })).toEqual({
      CXHUB_FILA_TOKENS: " t1 , t2",
      OUTRO: "x",
      CXHUB_FILA_URL: ORIGEM_DA_FILA_NO_WORKER,
      CXHUB_FILA_TOKEN: "t1",
      VERCEL_ENV: "production",
    });
  });

  it("a fila cadastrada à mão vale mais que a do Worker", () => {
    const amb = ambienteDoApp({ CXHUB_FILA_TOKENS: "t1", CXHUB_FILA_URL: "https://outra-fila.test", CXHUB_FILA_TOKEN: "t9" });
    expect(amb.CXHUB_FILA_URL).toBe("https://outra-fila.test");
    expect(amb.CXHUB_FILA_TOKEN).toBe("t9");
  });

  it("segredo apagado no GoDeploy sai do process.env; o que o app não pôs fica", () => {
    const alvo: Ambiente = { PATH: "/bin" };
    atualizarAmbiente({ A: "1", B: "2" }, alvo);
    atualizarAmbiente({ A: "3" }, alvo);
    expect(alvo).toMatchObject({ PATH: "/bin", A: "3", VERCEL_ENV: "production" });
    expect("B" in alvo).toBe(false);
  });
});

describe("fila dentro do Worker, ponta a ponta pelo worker.fetch", () => {
  const ctx = { waitUntil: vi.fn() };
  const envDoApp = (DB = bancoEmMemoria(), extra: Record<string, string> = {}) => ({
    DB,
    CXHUB_FILA_TOKENS: TOKEN,
    COSMOS_API_URL: COSMOS,
    METABASE_URL: METABASE,
    METABASE_API_KEY: "chave-do-metabase",
    METABASE_DATABASE_ID: "43",
    ...extra,
  });
  const enfileirar = (env: ReturnType<typeof envDoApp>, c: Record<string, unknown>) =>
    worker.fetch(new Request(`${URL_APP}/api/v1/casos`, {
      method: "POST",
      headers: { "x-cxhub-fila-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ casos: [c] }),
    }), env as never, ctx);
  const registro = (env: ReturnType<typeof envDoApp>, id: string) =>
    worker.fetch(new Request(`${URL_APP}/api/registro?ids=${id}`, {
      headers: { "x-cosmos-token": "jwt-do-login", authorization: "Bearer gdk_chave" },
    }), env as never, ctx);

  it("a rota do CX Hub lê a fila sem rede: o caso da fila aparece aguardando, e o que a DAG recusou, recusado", async () => {
    const chamadas = redeFalsa();
    const env = envDoApp();
    const c = caso();

    expect((await enfileirar(env, c)).status).toBe(200);
    const r = await registro(env, c.id_solicitacao);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ code: "SUCCESS", estados: { [c.id_solicitacao]: "aguardando" } });

    await env.DB.exec("UPDATE casos SET situacao = 'recusado' WHERE id_solicitacao = ?", [c.id_solicitacao]);
    expect((await (await registro(env, c.id_solicitacao)).json()).estados[c.id_solicitacao]).toBe("recusado");

    // O Cosmos conferiu o token do login, e a rede só viu o Cosmos e o Metabase: nada da fila saiu do Worker.
    expect(chamadas.filter(ch => ch.url.startsWith(COSMOS)).map(ch => ch.authorization)).toEqual(["Bearer jwt-do-login", "Bearer jwt-do-login"]);
    expect(chamadas.every(ch => ch.url.startsWith(COSMOS) || ch.url.startsWith(METABASE))).toBe(true);
  });

  it("o caso que a raw já tem é gravado, sem perguntar à fila", async () => {
    const c = caso();
    redeFalsa([c.id_solicitacao]);
    const env = envDoApp();
    expect((await (await registro(env, c.id_solicitacao)).json()).estados).toEqual({ [c.id_solicitacao]: "gravado" });
  });

  it("o cliente da fila portado escreve na fila em processo, com o contrato de sempre", async () => {
    redeFalsa();
    const env = envDoApp();
    const c = caso();
    await enfileirar(env, c);

    const r = await enfileirarAtualizacao(c.id_solicitacao, { status_execucao: "Cancelado", responsavel_execucao: "Ana" }, Date.now() + 16_000);

    expect(r).toEqual({ status: "enfileirado" });
    const linhas = (await env.DB.query("SELECT campos FROM atualizacoes WHERE id_solicitacao = ?", [c.id_solicitacao])).rows as Array<Record<string, string>>;
    expect(linhas.map(l => JSON.parse(l.campos))).toEqual([{ status_execucao: "Cancelado", responsavel_execucao: "Ana" }]);
  });

  it("token errado na fila em processo é recusa certa (401), não incerteza: o contrato da chamada de fora vale aqui", async () => {
    redeFalsa();
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = envDoApp(bancoEmMemoria(), { CXHUB_FILA_TOKEN: "token-que-a-fila-nao-aceita" });
    await worker.fetch(new Request(`${URL_APP}/api/nao-existe`), env as never, ctx);

    const r = await enfileirarAtualizacao("caso-qualquer", { status_execucao: "Cancelado" }, Date.now() + 16_000);

    expect(r.status).toBe("recusado");
    expect(r.status === "recusado" && r.motivo).toContain("HTTP 401");
    expect(erro).toHaveBeenCalled();
  });
});
