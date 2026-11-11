// A cache das listas da rota dados (o app GoDeploy rota-dados-cxhub: marcas, responsáveis, motivos, transportadoras),
// no env.DB. Por quê: a rota dados é outro app do GoDeploy, e cada chamada a ela paga o gateway de novo (cerca de 0,8 s
// medidos em 2026-11-11), mas as listas mudam pouco. Quem lê: o /api/resend/data, as marcas que o bot aceita
// (cxhub/shared/lib/formDataApi.ts) e os motivos do backoffice (backoffice/servidor/rotaDados.ts).
//
// O cron chama POST /api/interno/rota-dados a cada 5 min e renova as três origens. Quem lê usa a cache enquanto ela
// tiver até VALIDADE_MS (15 min: três rodadas do cron de folga); mais velha, busca ao vivo e guarda. Com a rota dados
// fora, serve a última resposta boa até VALIDADE_MAXIMA_MS (24 h), com aviso no log, para o formulário e o bot não
// pararem por causa dela. Só a resposta 200 (já conferida contra o contrato pelo formDataApi) entra na cache; erro nunca.

import type { FormDataOrigin } from "../cxhub/shared/lib/fetchFormData";
import type { LeitorDaRotaDados, RespostaDosDadosDoFormulario } from "../cxhub/shared/lib/formDataApi";
import { tokenValido } from "../servidor/app";
import type { Banco } from "../servidor/banco";
import type { Contexto, Dependencias } from "../servidor/contexto";
import { autorizarCron } from "../servidor/cron";
import { erro, json } from "../servidor/http";
import { isoUtc } from "../servidor/tempo";

export const CAMINHO_DA_CACHE = "/api/interno/rota-dados";
export const ORIGENS_DA_ROTA_DADOS: readonly FormDataOrigin[] = ["reenvio", "reembolso", "logistica"];
export const VALIDADE_MS = 15 * 60_000;
export const VALIDADE_MAXIMA_MS = 24 * 60 * 60_000;

type BuscaAoVivo = (origem: FormDataOrigin) => Promise<RespostaDosDadosDoFormulario>;

// A tabela mora no mesmo env.DB da fila, com nome próprio. Criada uma vez por banco no isolate.
const prontos = new WeakSet<object>();
async function garantirTabela(db: Banco) {
  if (prontos.has(db.bruto)) return;
  await db.exec("CREATE TABLE IF NOT EXISTS cache_rota_dados (origem TEXT PRIMARY KEY, corpo TEXT NOT NULL, buscado_em TEXT NOT NULL)");
  prontos.add(db.bruto);
}

type Guardado = { corpo: unknown; em: number };

async function lerGuardado(db: Banco, origem: string): Promise<Guardado | null> {
  const l = await db.um("SELECT corpo, buscado_em FROM cache_rota_dados WHERE origem = ?", [origem]);
  if (!l) return null;
  const em = Date.parse(String(l.buscado_em));
  if (Number.isNaN(em)) return null;
  try {
    return { corpo: JSON.parse(String(l.corpo)), em };
  } catch {
    return null;
  }
}

async function guardar(db: Banco, origem: string, corpo: unknown, agora: number) {
  await db.exec(
    "INSERT INTO cache_rota_dados (origem, corpo, buscado_em) VALUES (?, ?, ?) ON CONFLICT(origem) DO UPDATE SET corpo = excluded.corpo, buscado_em = excluded.buscado_em",
    [origem, JSON.stringify(corpo), isoUtc(agora)],
  );
}

const minutos = (ms: number) => Math.round(ms / 60_000);

/**
 * O leitor que o formDataApi usa (usarLeitorDaRotaDados). O banco e o relógio vêm de funções porque o env.DB só existe
 * depois que a requisição chega. Falha do banco nunca derruba a leitura: vira busca ao vivo, como sem cache.
 */
export function leitorComCache(obterDb: () => Banco, agora: () => number): LeitorDaRotaDados {
  return async (origem, aoVivo) => {
    let db: Banco | null = null;
    let guardado: Guardado | null = null;
    try {
      db = obterDb();
      await garantirTabela(db);
      guardado = await lerGuardado(db, origem);
    } catch (err) {
      console.error(`[cache da rota dados] o env.DB não respondeu; busca ao vivo: ${(err as Error)?.message || err}`);
    }
    const t = agora();
    if (guardado && t - guardado.em < VALIDADE_MS) return { status: 200, body: guardado.corpo };

    const vivo = await aoVivo();
    if (vivo.status === 200) {
      if (db) await guardar(db, origem, vivo.body, t).catch(err => console.error(`[cache da rota dados] não guardou ${origem}: ${(err as Error)?.message || err}`));
      return vivo;
    }
    if (guardado && t - guardado.em < VALIDADE_MAXIMA_MS) {
      console.warn(`[cache da rota dados] a rota dados respondeu HTTP ${vivo.status} para ${origem}; servindo a cache de ${minutos(t - guardado.em)} min`);
      return { status: 200, body: guardado.corpo };
    }
    return vivo;
  };
}

type Renovacao = { estado: "renovada" | "falhou"; status: number; ms: number; erro?: string };

/** Renova as três origens, ao vivo. Uma origem que falha não impede as outras, e a cache dela fica como estava. */
export async function renovarCache(db: Banco, agora: () => number, buscar: BuscaAoVivo): Promise<Record<string, Renovacao>> {
  await garantirTabela(db);
  const saida: Record<string, Renovacao> = {};
  for (const origem of ORIGENS_DA_ROTA_DADOS) {
    const inicio = agora();
    const r = await buscar(origem).catch((err): RespostaDosDadosDoFormulario => ({ status: 502, body: { error: String((err as Error)?.message || err) } }));
    const ms = agora() - inicio;
    if (r.status === 200) {
      await guardar(db, origem, r.body, agora());
      saida[origem] = { estado: "renovada", status: 200, ms };
    } else {
      const motivo = (r.body as { error?: unknown } | null)?.error;
      saida[origem] = { estado: "falhou", status: r.status, ms, ...(typeof motivo === "string" ? { erro: motivo } : {}) };
    }
  }
  return saida;
}

/**
 * POST /api/interno/rota-dados: a rodada do cron (X-Godeploy-Cron) ou uma chamada à mão com o x-cxhub-fila-token.
 * Responde 200 com o que renovou; 502 se nenhuma origem renovou (a cache fica como estava e o cron registra a falha).
 */
export async function rotaDaCacheDaRotaDados(req: Request, deps: Dependencias, buscar: BuscaAoVivo): Promise<Response> {
  const url = new URL(req.url);
  const c: Contexto = { ...deps, req, url, agora: deps.relogio.agora() };
  if (req.method !== "POST") return erro(405, "METHOD_NOT_ALLOWED", "Use POST nesta rota.", { allow: "POST" });
  if (!tokenValido(req, deps.cfg.tokens)) {
    const cron = await autorizarCron(c);
    if (cron === "negado") return erro(401, "UNAUTHORIZED", "x-cxhub-fila-token ausente ou inválido.");
    if (cron === "cedo")
      return erro(429, "TOO_MANY_REQUESTS", "Rodada recente: sem a assinatura conferida, o cron roda no máximo uma vez a cada 30 s.", { "retry-after": "30" });
  }
  let origens: Record<string, Renovacao>;
  try {
    origens = await renovarCache(deps.db, () => deps.relogio.agora(), buscar);
  } catch (err) {
    console.error("[cache da rota dados] o env.DB não respondeu:", (err as Error)?.stack || err);
    return erro(503, "UNAVAILABLE", "A cache não conseguiu ler ou gravar agora. Repetir é seguro.");
  }
  const renovadas = Object.values(origens).filter(o => o.estado === "renovada").length;
  console.log(`cache da rota dados: ${JSON.stringify(origens)}`);
  return json({ code: renovadas ? "OK" : "FALHOU", em: isoUtc(c.agora), renovadas, origens }, renovadas ? 200 : 502);
}
