// Leitura do Data Mart pela API do Metabase: SQL nativo em POST /api/dataset, com a chave no X-API-KEY (o grupo dela
// precisa de SQL nativo no banco). Mesmo desenho do CX Hub (shared/lib/metabase/client.ts) e do chargeback-webui. O
// /api/dataset responde 202 até quando a consulta falha (o erro vem no corpo), por isso o `status` do corpo é
// conferido, e não só o HTTP.
//
// Só leitura, na réplica: METABASE_DATABASE_ID é o "Data Mart" (43 em metabase.gobeaute.com.br). A réplica pode ficar
// minutos atrás do primário. Nada aqui escreve no Data Mart: a escrita é o lote para a DAG (servidor/lote.ts).

import type { ConfigMetabase } from "./config";
import type { Busca } from "./contexto";

export const TEMPO_LIMITE_MS = 20_000;

export class MetabaseErro extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "MetabaseErro";
  }

  // Vale tentar de novo: rede, tempo esgotado, 5xx, 429 e consulta interrompida. Chave recusada, falta de permissão e
  // SQL, coluna ou tabela errados não mudam na segunda tentativa.
  get transitorio(): boolean {
    if (this.status >= 400 && this.status < 500 && this.status !== 429) return false;
    return !/does not exist|n[aã]o existe|permission|permiss|syntax|sintaxe/i.test(this.message);
  }
}

export const comoMetabaseErro = (err: unknown): MetabaseErro =>
  err instanceof MetabaseErro ? err : new MetabaseErro(0, String((err as Error)?.message || err).slice(0, 300));

// Literal de texto para o SQL montado no código: aspas dobradas, NUL recusado. Todo valor que vem de fora (filtro,
// busca, cursor, chave) passa por aqui.
export function literalSql(valor: string): string {
  if (valor.includes("\0")) throw new MetabaseErro(400, "valor com NUL");
  return `'${valor.replace(/'/g, "''")}'`;
}

type RespostaDataset = { status?: string; error?: unknown; data?: { rows?: unknown } };

// Roda um SELECT no Data Mart e devolve as linhas (data.rows), na ordem das colunas do SELECT. Uma tentativa só: quem
// chama decide se retenta, pelo `transitorio`. Nunca lança outra coisa além de MetabaseErro.
export async function consultar(cfg: ConfigMetabase, f: Busca, sql: string, tempoMs = TEMPO_LIMITE_MS): Promise<unknown[][]> {
  let status: number;
  let texto: string;
  try {
    const r = await f(`${cfg.url}/api/dataset`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.chave },
      body: JSON.stringify({ database: cfg.banco, type: "native", native: { query: sql } }),
      signal: AbortSignal.timeout(tempoMs),
    });
    status = r.status;
    texto = await r.text();
  } catch (err) {
    const nome = (err as Error)?.name;
    if (nome === "TimeoutError" || nome === "AbortError") throw new MetabaseErro(0, `o Metabase não respondeu em ${tempoMs / 1000} s`);
    throw new MetabaseErro(0, `Metabase inalcançável: ${String((err as Error)?.message || err).slice(0, 200)}`);
  }
  if (status < 200 || status >= 300) {
    // Página de erro HTML (proxy na frente do Metabase) vira só o <title>.
    const resumo = /<title>([^<]*)<\/title>/i.exec(texto)?.[1]?.trim() ?? texto.slice(0, 300);
    throw new MetabaseErro(status, `Metabase HTTP ${status}: ${resumo}`);
  }
  let corpo: RespostaDataset;
  try {
    corpo = JSON.parse(texto) as RespostaDataset;
  } catch {
    throw new MetabaseErro(502, "a resposta do Metabase não é JSON");
  }
  if (corpo.status === "failed" || corpo.error) throw new MetabaseErro(status, String(corpo.error ?? "a consulta falhou").slice(0, 500));
  const linhas = corpo.data?.rows;
  if (!Array.isArray(linhas)) throw new MetabaseErro(502, "a resposta do Metabase não tem data.rows");
  return linhas as unknown[][];
}
