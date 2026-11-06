// Roteamento do app cx-hub (docs/fila-cxhub.md). O gateway do GoDeploy confere a chave gdk_ (visibilidade
// authenticated); o app confere o x-cxhub-fila-token, antes de ler o corpo ou tocar no banco. A rota do lote também
// aceita o X-Godeploy-Cron do cron da plataforma. O worker.ts passa as dependências reais; os testes passam falsos.

import { garantirEsquema } from "./banco";
import type { Contexto, Dependencias } from "./contexto";
import { iguais } from "./cripto";
import { autorizarCron } from "./cron";
import { estado, listarAbertos, listarAtualizacoes, listarCasos, postAtualizacoes, postCasos, verCaso } from "./fila";
import { decodificar, erro } from "./http";
import { rodada } from "./lote";

const ROTA_DA_FILA = /^\/api\/v1\/(casos|atualizacoes|estado)(?:\/([^/]+))?$/;
const NEGADO = "x-cxhub-fila-token ausente ou inválido.";

// Compara com todos os tokens aceitos, sem parar no primeiro: o tempo não revela qual chegou perto.
function tokenValido(req: Request, tokens: string[]): boolean {
  const veio = (req.headers.get("x-cxhub-fila-token") || "").trim();
  let ok = false;
  for (const t of tokens) ok = iguais(veio, t) || ok;
  return Boolean(veio) && ok;
}

const metodoErrado = (permitidos: string) => erro(405, "METHOD_NOT_ALLOWED", `Use ${permitidos} nesta rota.`, { allow: permitidos });

export async function tratar(req: Request, deps: Dependencias): Promise<Response> {
  const url = new URL(req.url);
  const caminho = url.pathname.replace(/\/+$/, "") || "/";
  const c: Contexto = { ...deps, req, url, agora: deps.relogio.agora() };
  try {
    if (caminho === "/api/v1/interno/lote") return await rotaDoLote(c);
    const m = caminho.match(ROTA_DA_FILA);
    if (!m) return erro(404, "NOT_FOUND", "Rota não encontrada. Ver docs/fila-cxhub.md no repositório do CX Hub.");
    if (!tokenValido(req, c.cfg.tokens)) return erro(401, "UNAUTHORIZED", NEGADO);
    await garantirEsquema(c.db);
    const [, recurso, id] = m;
    const metodo = req.method;
    if (recurso === "casos" && id === "abertos") return metodo === "GET" ? await listarAbertos(c) : metodoErrado("GET");
    if (recurso === "casos" && id) return metodo === "GET" ? await verCaso(c, decodificar(id)) : metodoErrado("GET");
    if (id) return erro(404, "NOT_FOUND", "Rota não encontrada.");
    if (recurso === "casos") return metodo === "POST" ? await postCasos(c) : metodo === "GET" ? await listarCasos(c) : metodoErrado("GET, POST");
    if (recurso === "atualizacoes")
      return metodo === "POST" ? await postAtualizacoes(c) : metodo === "GET" ? await listarAtualizacoes(c) : metodoErrado("GET, POST");
    return metodo === "GET" ? await estado(c) : metodoErrado("GET");
  } catch (err) {
    // O que sobra aqui é o banco (env.DB fora, limite do mês): as escritas são idempotentes, repetir é seguro.
    console.error(`falha em ${req.method} ${caminho}:`, (err as Error)?.stack || err);
    return erro(503, "UNAVAILABLE", "A fila não conseguiu ler ou gravar agora. Repetir é seguro.");
  }
}

// O cron do GoDeploy (X-Godeploy-Cron) ou uma chamada à mão com o x-cxhub-fila-token.
async function rotaDoLote(c: Contexto): Promise<Response> {
  if (c.req.method !== "POST") return metodoErrado("POST");
  if (!tokenValido(c.req, c.cfg.tokens)) {
    const cron = await autorizarCron(c);
    if (cron === "negado") return erro(401, "UNAUTHORIZED", NEGADO);
    if (cron === "cedo")
      return erro(429, "TOO_MANY_REQUESTS", "Rodada recente: sem a assinatura conferida, o cron roda no máximo uma vez a cada 30 s.", { "retry-after": "30" });
  }
  await garantirEsquema(c.db);
  return rodada(c);
}
