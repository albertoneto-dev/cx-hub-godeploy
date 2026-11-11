// Os motivos de reenvio e de reembolso, lidos do app GoDeploy rota-dados-cxhub (GET /api/v1/form-data?origin=…), o
// mesmo que o CX Hub usa para os dropdowns (shared/lib/formDataApi.ts de lá, ADR-009). O motivo do drawer é um desses:
// a tela mostra a lista, e o servidor confere de novo antes de guardar.
//
// A lista fica 5 min em memória por isolate (muda pouco, e cada abertura de drawer a pediria). Erro nunca é guardado:
// a próxima chamada tenta de novo.

import type { ConfigRotaDados } from "./config";
import type { Busca } from "./contexto";

export class RotaDadosErro extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotaDadosErro";
  }
}

export type Origem = "reenvio" | "reembolso";

const VALIDADE_MS = 5 * 60_000;
const TEMPO_LIMITE_MS = 8_000;
const guardados = new Map<string, { motivos: string[]; ate: number }>();

export const limparCacheDaRotaDados = () => guardados.clear();

// Adaptação do app cx-hub (backoffice/ORIGEM.md): o corpo do GET /api/v1/form-data pode vir de uma fonte de fora. No
// app cx-hub vem da cache da rota dados no env.DB (api/cacheDaRotaDados.ts), que o cron renova a cada 5 min e que o
// formulário e o bot do CX Hub também usam. Sem fonte, a busca é a de sempre, direto na rota dados.
export type FonteDaRotaDados = (origem: Origem) => Promise<{ status: number; body: unknown }>;
let fonte: FonteDaRotaDados | null = null;
export const usarFonteDaRotaDados = (f: FonteDaRotaDados | null) => {
  fonte = f;
};

export async function motivosDaOrigem(cfg: ConfigRotaDados, f: Busca, origem: Origem, agora: number): Promise<string[]> {
  const chave = `${cfg.url}|${origem}`;
  const guardado = guardados.get(chave);
  if (guardado && guardado.ate > agora) return guardado.motivos;
  const corpo = fonte ? await daFonte(fonte, origem) : await daRotaDados(cfg, f, origem);
  const motivos = (corpo as { motivos?: unknown } | null)?.motivos;
  if (!Array.isArray(motivos) || !motivos.length || !motivos.every(m => typeof m === "string" && m.trim()))
    throw new RotaDadosErro("a rota de dados respondeu sem a lista de motivos");
  const lista = (motivos as string[]).map(m => m.trim());
  guardados.set(chave, { motivos: lista, ate: agora + VALIDADE_MS });
  return lista;
}

async function daFonte(fonte: FonteDaRotaDados, origem: Origem): Promise<unknown> {
  const r = await fonte(origem);
  if (r.status === 200) return r.body;
  const motivo = (r.body as { error?: unknown } | null)?.error;
  throw new RotaDadosErro(typeof motivo === "string" && motivo ? `${motivo} (HTTP ${r.status})` : `a rota de dados respondeu HTTP ${r.status}`);
}

async function daRotaDados(cfg: ConfigRotaDados, f: Busca, origem: Origem): Promise<unknown> {
  const cabecalhos: Record<string, string> = { accept: "application/json", "x-form-data-token": cfg.token };
  if (cfg.chave) cabecalhos.authorization = `Bearer ${cfg.chave}`;
  let status: number;
  let corpo: unknown;
  try {
    // manual: sem a chave certa o gateway responde 302 para a tela de login, que não pode virar "sucesso".
    const r = await f(`${cfg.url}/api/v1/form-data?origin=${origem}`, {
      method: "GET", headers: cabecalhos, redirect: "manual", signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
    status = r.status;
    corpo = await r.json().catch(() => null);
  } catch (err) {
    const nome = (err as Error)?.name;
    throw new RotaDadosErro(nome === "TimeoutError" || nome === "AbortError" ? "a rota de dados não respondeu a tempo" : "a rota de dados está inalcançável");
  }
  if ((status >= 300 && status < 400) || status === 401 || status === 403)
    throw new RotaDadosErro(`a rota de dados recusou a credencial (HTTP ${status}): confira FORM_DATA_API_TOKEN e FORM_DATA_GODEPLOY_KEY`);
  if (status < 200 || status >= 300) throw new RotaDadosErro(`a rota de dados respondeu HTTP ${status}`);
  return corpo;
}
