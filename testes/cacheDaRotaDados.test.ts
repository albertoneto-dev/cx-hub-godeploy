// A cache da rota dados (api/cacheDaRotaDados.ts): o leitor (acerto, busca ao vivo, a última boa quando a rota dados
// cai), a renovação das três origens, a rota do cron que a renova e, pelo worker.fetch, o /api/resend/data lendo pela
// cache. A rota dados é um fetch falso; o env.DB, o SQLite em memória.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leitorComCache, renovarCache, VALIDADE_MAXIMA_MS, VALIDADE_MS } from "../api/cacheDaRotaDados";
import { banco } from "../servidor/banco";
import worker from "../worker";
import { bancoEmMemoria, TOKEN, URL_APP } from "./ambiente";

const ROTA_DADOS = "https://rota-dados.exemplo";
const corpoDe = (origem: string, versao = 1) => ({ marcas: ["lescent"], "responsáveis": ["Ana"], motivos: [`motivo ${origem} v${versao}`] });
const ok = (origem: string, versao = 1) => ({ status: 200, body: corpoDe(origem, versao) });
const T0 = Date.parse("2026-11-11T12:00:00Z");

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("leitor com cache", () => {
  const montar = () => {
    const db = banco(bancoEmMemoria());
    let agora = T0;
    const leitor = leitorComCache(() => db, () => agora);
    return { db, leitor, andar: (ms: number) => { agora += ms; } };
  };

  it("a primeira leitura busca ao vivo e guarda; enquanto a cache tem menos de 15 min, a rota dados não é chamada", async () => {
    const { leitor, andar } = montar();
    const aoVivo = vi.fn(async () => ok("reenvio"));
    expect(await leitor("reenvio", aoVivo)).toEqual(ok("reenvio"));
    andar(VALIDADE_MS - 1);
    expect(await leitor("reenvio", aoVivo)).toEqual(ok("reenvio"));
    expect(aoVivo).toHaveBeenCalledTimes(1);
  });

  it("cache vencida: busca de novo e troca o que está guardado", async () => {
    const { leitor, andar } = montar();
    await leitor("reembolso", async () => ok("reembolso", 1));
    andar(VALIDADE_MS);
    expect(await leitor("reembolso", async () => ok("reembolso", 2))).toEqual(ok("reembolso", 2));
    expect(await leitor("reembolso", async () => ok("reembolso", 3))).toEqual(ok("reembolso", 2));
  });

  it("rota dados fora: serve a última boa até 24 h, com aviso no log; depois disso, devolve o erro", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { leitor, andar } = montar();
    await leitor("logistica", async () => ok("logistica"));
    const fora = async () => ({ status: 502, body: { error: "App de configuração do formulário inalcançável" } });
    andar(VALIDADE_MS + 1);
    expect(await leitor("logistica", fora)).toEqual(ok("logistica"));
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining("servindo a cache"));
    andar(VALIDADE_MAXIMA_MS);
    expect((await leitor("logistica", fora)).status).toBe(502);
  });

  it("sem nada guardado e a rota dados fora: o erro passa como veio, e nada entra na cache", async () => {
    const { db, leitor } = montar();
    expect(await leitor("reenvio", async () => ({ status: 504, body: { error: "não respondeu" } }))).toEqual({ status: 504, body: { error: "não respondeu" } });
    expect(await db.query("SELECT * FROM cache_rota_dados")).toEqual([]);
  });

  it("o env.DB fora não derruba a leitura: vira busca ao vivo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const leitor = leitorComCache(() => { throw new Error("env.DB fora"); }, () => T0);
    expect(await leitor("reenvio", async () => ok("reenvio"))).toEqual(ok("reenvio"));
  });
});

describe("renovação das três origens", () => {
  it("renova cada origem; a que falha fica como estava e não impede as outras", async () => {
    const db = banco(bancoEmMemoria());
    await renovarCache(db, () => T0, async o => ok(o, 1));
    const r = await renovarCache(db, () => T0 + 1, async o => (o === "reembolso" ? { status: 502, body: { error: "fora" } } : ok(o, 2)));
    expect(r.reenvio.estado).toBe("renovada");
    expect(r.reembolso).toMatchObject({ estado: "falhou", status: 502, erro: "fora" });
    expect(r.logistica.estado).toBe("renovada");
    const guardados = Object.fromEntries((await db.query("SELECT origem, corpo FROM cache_rota_dados")).map(l => [l.origem, JSON.parse(String(l.corpo))]));
    expect(guardados).toEqual({ reenvio: corpoDe("reenvio", 2), reembolso: corpoDe("reembolso", 1), logistica: corpoDe("logistica", 2) });
  });
});

describe("pelo worker.fetch", () => {
  const ctx = { waitUntil: vi.fn() };
  const envDoApp = (DB = bancoEmMemoria()) => ({
    DB,
    CXHUB_FILA_TOKENS: TOKEN,
    FORM_DATA_API_URL: ROTA_DADOS,
    FORM_DATA_API_TOKEN: "token-da-rota-dados",
    FORM_DATA_GODEPLOY_KEY: "gdk_de_teste",
  });
  const chamar = (env: ReturnType<typeof envDoApp>, caminho: string, init: RequestInit = {}) =>
    worker.fetch(new Request(URL_APP + caminho, init), env as never, ctx);
  // A rota dados falsa: conta as chamadas por origem; "fora" a derruba.
  function rotaDadosFalsa() {
    const chamadas: string[] = [];
    let fora = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async entrada => {
      const url = new URL(String(entrada instanceof Request ? entrada.url : entrada));
      if (url.origin !== ROTA_DADOS) throw new TypeError("fetch failed");
      const origem = url.searchParams.get("origin") ?? "";
      chamadas.push(origem);
      if (fora) throw new TypeError("fetch failed");
      return Response.json(corpoDe(origem));
    });
    return { chamadas, derrubar: () => { fora = true; } };
  }
  const cron = (env: ReturnType<typeof envDoApp>, caminho: string) =>
    chamar(env, caminho, { method: "POST", headers: { "x-godeploy-cron": `t=${Math.floor(Date.now() / 1000)};sig=${"ab".repeat(32)}` } });

  it("o /api/resend/data lê pela cache: a segunda chamada não vai à rota dados", async () => {
    const rota = rotaDadosFalsa();
    const env = envDoApp();
    const r1 = await chamar(env, "/api/resend/data?origin=reenvio");
    const r2 = await chamar(env, "/api/resend/data?origin=reenvio");
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await r2.json()).toEqual(corpoDe("reenvio"));
    expect(rota.chamadas).toEqual(["reenvio"]);
  });

  it("POST /api/interno/rota-dados com o token da fila renova as três; sem token nem cron ⇒ 401; GET ⇒ 405", async () => {
    const rota = rotaDadosFalsa();
    const env = envDoApp();
    const r = await chamar(env, "/api/interno/rota-dados", { method: "POST", headers: { "x-cxhub-fila-token": TOKEN } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ code: "OK", renovadas: 3 });
    expect(rota.chamadas).toEqual(["reenvio", "reembolso", "logistica"]);
    // Depois da renovação, a leitura sai da cache.
    expect((await chamar(env, "/api/resend/data?origin=logistica")).status).toBe(200);
    expect(rota.chamadas).toHaveLength(3);
    expect((await chamar(env, "/api/interno/rota-dados", { method: "POST" })).status).toBe(401);
    expect((await chamar(env, "/api/interno/rota-dados")).status).toBe(405);
  });

  it("a rota dados fora na renovação: 502 FALHOU, e a leitura segue servindo o que já estava guardado", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rota = rotaDadosFalsa();
    const env = envDoApp();
    await chamar(env, "/api/interno/rota-dados", { method: "POST", headers: { "x-cxhub-fila-token": TOKEN } });
    rota.derrubar();
    const r = await chamar(env, "/api/interno/rota-dados", { method: "POST", headers: { "x-cxhub-fila-token": TOKEN } });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ code: "FALHOU", renovadas: 0 });
    expect((await chamar(env, "/api/resend/data?origin=reembolso")).status).toBe(200);
  });

  it("o cron sem assinatura tem uma trava por rota: o lote da fila e a cache no mesmo minuto passam os dois", async () => {
    rotaDadosFalsa();
    const env = envDoApp();
    expect((await cron(env, "/api/v1/interno/lote")).status).toBe(200);
    expect((await cron(env, "/api/interno/rota-dados")).status).toBe(200);
    // A mesma rota de novo em menos de 30 s continua barrada.
    expect((await cron(env, "/api/interno/rota-dados")).status).toBe(429);
  });
});
