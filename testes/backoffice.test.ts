// O backoffice dentro do app, pelo worker.fetch: as rotas em /api/backoffice, as tabelas dele (bo_*) no mesmo env.DB
// da fila e a etapa dele na rodada do cron da fila (fila única: backoffice/ORIGEM.md).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { banco } from "../servidor/banco";
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

  it("a rodada do cron da fila roda também a etapa do backoffice; as tabelas convivem no mesmo banco", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = envDoApp();
    const r = await chamar(env, "/api/v1/interno/lote", { method: "POST", headers: { "x-cxhub-fila-token": TOKEN } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ code: "OK", disparo: { estado: "vazio" }, backoffice: { conferencia: { estado: "nada" }, limpeza: true } });
    const tabelas = (await banco(env.DB).query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map(l => l.name);
    expect(tabelas).toEqual(expect.arrayContaining(["casos", "atualizacoes", "lotes", "controle", "bo_autoria", "bo_clientes", "bo_controle"]));
    expect(tabelas).not.toContain("bo_edicoes");
    expect(tabelas).not.toContain("bo_lotes");
  });

  it("o backoffice não tem rodada própria: /api/backoffice/interno/lote é 404", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await chamar(envDoApp(), "/api/backoffice/interno/lote", { method: "POST", headers: { "x-usuario-email": "ana.silva@gocase.com" } });
    expect(r.status).toBe(404);
  });

  it("o banco da v9 (bo_edicoes e bo_lotes) sobe para o esquema da fila única sem perder os dados do cliente", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = envDoApp();
    const db = banco(env.DB);
    // O que a v9 deixou no env.DB: as tabelas antigas, um cliente guardado e a versão 1 do esquema do backoffice.
    for (const sql of [
      "CREATE TABLE bo_edicoes (id_atualizacao TEXT PRIMARY KEY)",
      "CREATE TABLE bo_lotes (id TEXT PRIMARY KEY)",
      `CREATE TABLE bo_clientes (chave_unica TEXT PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT NOT NULL, cep TEXT NOT NULL,
        logradouro TEXT NOT NULL, numero TEXT NOT NULL, complemento TEXT NOT NULL, bairro TEXT NOT NULL, cidade TEXT NOT NULL,
        atualizado_em TEXT NOT NULL, autor TEXT NOT NULL)`,
      "INSERT INTO bo_clientes VALUES ('cxhub|abc', 'Maria', '', '', '', '', '', '', '', '2026-11-11T00:00:00.000Z', 'ana@gocase.com')",
      "CREATE TABLE bo_controle (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)",
      "INSERT INTO bo_controle VALUES ('esquema', '1')",
    ]) await db.exec(sql);
    expect((await chamar(env, "/api/backoffice/estado", { headers: { "x-usuario-email": "ana.silva@gocase.com" } })).status).toBe(200);
    const tabelas = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map(l => l.name);
    expect(tabelas).toEqual(expect.arrayContaining(["bo_autoria", "atualizacoes"]));
    expect(tabelas).not.toContain("bo_edicoes");
    expect(await db.um("SELECT nome FROM bo_clientes WHERE chave_unica = 'cxhub|abc'")).toMatchObject({ nome: "Maria" });
    expect(await db.um("SELECT valor FROM bo_controle WHERE chave = 'esquema'")).toMatchObject({ valor: "2" });
  });
});
