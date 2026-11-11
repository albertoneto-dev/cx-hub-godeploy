// O backoffice dentro do app, pelo worker.fetch: as rotas em /api/backoffice e as tabelas dele (bo_*) no mesmo env.DB
// da fila, sem uma travar a outra (as duas têm a vez "rodada", cada uma na sua tabela de controle).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { banco, garantirEsquema, pegarVez } from "../servidor/banco";
import worker from "../worker";
import { bancoEmMemoria, TOKEN, URL_APP } from "./ambiente";

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const ctx = { waitUntil: vi.fn() };
const envDoApp = (DB = bancoEmMemoria()) => ({ DB, CXHUB_FILA_TOKENS: TOKEN });
const chamar = (env: ReturnType<typeof envDoApp>, caminho: string, init: RequestInit = {}) =>
  worker.fetch(new Request(URL_APP + caminho, init), env as never, ctx);

describe("backoffice no worker", () => {
  it("GET /api/backoffice/eu responde com quem chama (x-usuario-email); sem ninguém, 401", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = envDoApp();
    const r = await chamar(env, "/api/backoffice/eu", { headers: { "x-usuario-email": "ana.silva@gocase.com" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ email: "ana.silva@gocase.com", janelaDias: 30, tamanhoPagina: 50 });
    expect((await chamar(env, "/api/backoffice/eu")).status).toBe(401);
  });

  it("a rodada do backoffice não espera a da fila: cada uma tem a sua vez, e as tabelas convivem no mesmo banco", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = envDoApp();
    const fila = banco(env.DB);
    await garantirEsquema(fila);
    expect(await pegarVez(fila, "rodada", Date.now(), 60_000)).toBe(true);
    const r = await chamar(env, "/api/backoffice/interno/lote", { method: "POST", headers: { "x-usuario-email": "ana.silva@gocase.com" } });
    expect(r.status).toBe(200);
    expect((await r.json()).code).toBe("OK");
    const tabelas = (await fila.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map(l => l.name);
    expect(tabelas).toEqual(expect.arrayContaining(["casos", "atualizacoes", "lotes", "controle", "bo_edicoes", "bo_lotes", "bo_clientes", "bo_controle"]));
  });
});
