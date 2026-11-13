// A página /docs (api/docs.ts) pelo worker.fetch, como o GoDeploy a chama, e a especificação (api/docsRotas.ts) em dia
// com o app: as rotas do roteador e da fila são exatamente as documentadas, cada uma com âncora e link na navegação, e
// os exemplos não trazem chave, webhook ou e-mail de verdade.

import { describe, expect, it } from "vitest";
import { ancoraDoEndpoint, PAGINA_DOS_DOCS } from "../api/docs";
import { ENDPOINTS, GRUPOS } from "../api/docsRotas";
import { ROTAS_DA_API } from "../api/roteador";
import worker from "../worker";
import { URL_APP } from "./ambiente";

const pedir = (caminho: string, init?: RequestInit) => worker.fetch(new Request(URL_APP + caminho, init), {} as never);

// As rotas da fila, como o servidor/app.ts as atende.
const ROTAS_DA_FILA = [
  "POST /api/v1/casos", "GET /api/v1/casos", "GET /api/v1/casos/abertos", "GET /api/v1/casos/{id}",
  "POST /api/v1/atualizacoes", "GET /api/v1/atualizacoes", "GET /api/v1/estado", "POST /api/v1/interno/lote",
];

// As do backoffice, como o backoffice/servidor/app.ts as atende, e a da cache da rota dados (worker.ts). Rota nova ou
// removida lá entra ou sai daqui e da página (CLAUDE.md: a página /docs reflete sempre o estado atual da API).
const ROTAS_NOVAS = [
  "GET /api/backoffice/eu", "GET /api/backoffice/solicitacoes", "GET /api/backoffice/solicitacoes/{chave}",
  "POST /api/backoffice/solicitacoes/{chave}/edicoes", "DELETE /api/backoffice/edicoes/{id}", "GET /api/backoffice/estado",
  "POST /api/interno/rota-dados",
];
const ehDoHub = (d: string) => !/ \/api\/(v1|backoffice|interno)\//.test(d);

describe("página /docs", () => {
  it("GET /docs e /docs/ devolvem o HTML, sem depender de segredo nenhum (env vazio)", async () => {
    for (const caminho of ["/docs", "/docs/"]) {
      const r = await pedir(caminho);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const csp = r.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("font-src https://fonts.gstatic.com");
      const html = await r.text();
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain("<title>Gogroup · CX Hub API</title>");
    }
  });

  it("HEAD responde sem corpo; outro método leva o 405 do contrato", async () => {
    const head = await pedir("/docs", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = await pedir("/docs", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(await post.json()).toEqual({ code: "METHOD_NOT_ALLOWED", message: "Use GET, HEAD nesta rota." });
  });

  it("só /docs é a página: /docs/outra e /docsx seguem para o roteador (404 JSON)", async () => {
    for (const caminho of ["/docs/outra", "/docsx"]) {
      const r = await pedir(caminho);
      expect(r.status).toBe(404);
      expect((await r.json()).code).toBe("NOT_FOUND");
    }
  });
});

describe("especificação dos endpoints (api/docsRotas.ts)", () => {
  const documentados = ENDPOINTS.map((e) => `${e.method} ${e.path}`);

  it("as rotas do roteador são exatamente as documentadas fora da fila, com cada método", () => {
    const doRoteador = ROTAS_DA_API.flatMap((r) => r.metodos.map((m) => `${m} ${r.caminho.replace(/\[(\w+)\]/g, "{$1}")}`));
    // As 23 da Vercel e o order-context da ADR-018.
    expect(ROTAS_DA_API).toHaveLength(24);
    expect(documentados.filter(ehDoHub).sort()).toEqual(doRoteador.sort());
  });

  it("as rotas da fila são exatamente as documentadas em /api/v1", () => {
    expect(documentados.filter((d) => d.includes(" /api/v1/")).sort()).toEqual([...ROTAS_DA_FILA].sort());
  });

  it("as rotas do backoffice e a da cache são exatamente as documentadas em /api/backoffice e /api/interno", () => {
    expect(documentados.filter((d) => / \/api\/(backoffice|interno)\//.test(d)).sort()).toEqual([...ROTAS_NOVAS].sort());
  });

  it("cada rota documentada do backoffice responde no app (nenhuma é 404 de rota inexistente)", async () => {
    for (const d of ROTAS_NOVAS) {
      const [metodo, caminho] = d.split(" ");
      const r = await worker.fetch(new Request(URL_APP + caminho.replace("{chave}", "cxhub%7Cx").replace("{id}", "x"), { method: metodo }), {} as never);
      const corpo = (await r.json().catch(() => ({}))) as { code?: string; message?: string };
      // Sem quem chama, sem token ou sem banco, a rota recusa ou falha, mas não com a 404 de "rota não encontrada".
      expect(`${d}: ${r.status} ${corpo.message ?? ""}`).not.toMatch(/: 404 (Não encontrado|Rota não encontrada)/);
    }
  });

  it("nenhum endpoint repetido; cada um tem grupo, resumo e pelo menos uma resposta", () => {
    expect(new Set(documentados).size).toBe(documentados.length);
    const tags = new Set(GRUPOS.map((g) => g.tag));
    for (const e of ENDPOINTS) {
      expect(tags.has(e.tag), `${e.method} ${e.path}: grupo ${e.tag}`).toBe(true);
      expect(e.summary.length, `${e.method} ${e.path}: resumo`).toBeGreaterThan(0);
      expect(e.responses.length, `${e.method} ${e.path}: respostas`).toBeGreaterThan(0);
    }
  });

  it("cada endpoint tem âncora na página e link na navegação (a lateral e o menu do celular)", () => {
    for (const e of ENDPOINTS) {
      const ancora = ancoraDoEndpoint(e);
      expect(PAGINA_DOS_DOCS, ancora).toContain(`id="${ancora}"`);
      expect(PAGINA_DOS_DOCS.split(`href="#${ancora}"`).length - 1, ancora).toBe(2);
    }
  });

  it("os exemplos não trazem chave do GoDeploy ou do gateway, webhook do Slack nem e-mail de verdade", () => {
    const texto = JSON.stringify(ENDPOINTS);
    expect(texto).not.toMatch(/\b(?:gdk|igw)_[A-Za-z0-9]{12,}/);
    expect(texto).not.toMatch(/hooks\.slack\.com\/services\//i);
    const emails = texto.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? [];
    expect(emails.filter((e) => !e.endsWith("@exemplo.com"))).toEqual([]);
  });
});

describe("HTML da página", () => {
  it("sem script, e de fora só a fonte do Google Fonts", () => {
    expect(PAGINA_DOS_DOCS).not.toMatch(/<script/i);
    const externos = [...PAGINA_DOS_DOCS.matchAll(/\b(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
    expect(externos.length).toBeGreaterThan(0);
    for (const url of externos) expect(url, url).toMatch(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com(?:\/|$)/);
  });

  it("o \\\\ dos exemplos de curl vira uma barra só", () => {
    expect(PAGINA_DOS_DOCS).toContain('orderId=12345" \\\n  -H');
    expect(PAGINA_DOS_DOCS).not.toContain("\\\\\n");
  });

  it("as tags estão fechadas", () => {
    const tags = ["html", "head", "body", "header", "nav", "aside", "main", "section", "footer", "details", "summary", "div",
      "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "ul", "ol", "li", "p", "a", "h1", "h2", "h3", "h4", "mark",
      "span", "strong", "b", "title", "style"];
    for (const tag of tags) {
      const abertas = PAGINA_DOS_DOCS.match(new RegExp(`<${tag}[\\s>]`, "g"))?.length ?? 0;
      const fechadas = PAGINA_DOS_DOCS.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
      expect(fechadas, `<${tag}>`).toBe(abertas);
    }
  });
});
