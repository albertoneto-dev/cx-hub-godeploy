// env.DB do GoDeploy (SQLite): query para leitura e exec para escrita, uma instrução por chamada, sem transação.
// O esquema se cria no primeiro acesso e persiste entre deploys; a versão gravada em "controle" evita repetir o DDL.
// Sem transação, "pegar" algo (a vez da rodada, um item para o lote) é uma escrita com a condição no WHERE, e quem
// pegou é quem viu rowsWritten > 0. O número exato não serve: o GoDeploy conta também as linhas de índice (visto no
// api-procon-processos em 03/11/2026). Listas vão num parâmetro só, como JSON lido por json_each: a escrita de um
// lote inteiro é uma instrução (atômica), e nenhuma chega perto do limite de parâmetros por instrução.

import { isoUtc } from "./tempo";

export interface BancoBruto {
  query(sql: string, params?: unknown[]): Promise<{ columns?: string[]; rows?: unknown[] }>;
  exec(sql: string, params?: unknown[]): Promise<{ rowsWritten: number }>;
}

export type Linha = Record<string, unknown>;

export type Banco = {
  bruto: BancoBruto;
  query(sql: string, params?: unknown[]): Promise<Linha[]>;
  um(sql: string, params?: unknown[]): Promise<Linha | undefined>;
  exec(sql: string, params?: unknown[]): Promise<number>;
};

// undefined vira null e booleano vira 0/1: o SQLite só guarda texto, número e null.
const parametros = (params: unknown[]) => params.map(p => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));

// Sempre manda o array de params e devolve as linhas como objetos.
export function banco(bruto: BancoBruto): Banco {
  const query = async (sql: string, params: unknown[] = []) => {
    const r = await bruto.query(sql, parametros(params));
    const cols = r.columns || [];
    return (r.rows || []).map(row => (Array.isArray(row)
      ? Object.fromEntries(cols.map((c, i) => [c, row[i]]))
      : { ...(row as Linha) }));
  };
  return {
    bruto,
    query,
    async um(sql, params = []) {
      return (await query(sql, params))[0];
    },
    async exec(sql, params = []) {
      return Number((await bruto.exec(sql, parametros(params))).rowsWritten || 0);
    },
  };
}

// situacao de casos e atualizações: pendente → enviado (lote_id e posicao preenchidos) → gravado ou recusado.
// tentativas: quantos lotes deste item falharam sem resultado da DAG (o segundo o recusa).
// dados/campos: o que vai ao conf, como o CX Hub mandou.
const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS casos (
    id_solicitacao TEXT PRIMARY KEY, tipo TEXT NOT NULL, marca TEXT NOT NULL, numero_pedido TEXT NOT NULL,
    pedido_digitos TEXT NOT NULL, criado_em TEXT NOT NULL, criado_em_utc TEXT NOT NULL, responsavel TEXT,
    dados TEXT NOT NULL, situacao TEXT NOT NULL, lote_id TEXT, posicao INTEGER, tentativas INTEGER NOT NULL DEFAULT 0,
    erro TEXT, enfileirado_em TEXT NOT NULL, mudou_em TEXT NOT NULL, terminado_em TEXT)`,
  "CREATE INDEX IF NOT EXISTS ix_casos_fila ON casos(situacao, enfileirado_em, criado_em_utc, id_solicitacao)",
  "CREATE INDEX IF NOT EXISTS ix_casos_pedido ON casos(tipo, marca, pedido_digitos, criado_em_utc)",
  "CREATE INDEX IF NOT EXISTS ix_casos_lote ON casos(lote_id)",
  "CREATE INDEX IF NOT EXISTS ix_casos_terminado ON casos(terminado_em)",
  `CREATE TABLE IF NOT EXISTS atualizacoes (
    id_atualizacao TEXT PRIMARY KEY, id_solicitacao TEXT NOT NULL, atualizado_em TEXT NOT NULL,
    atualizado_em_utc TEXT NOT NULL, campos TEXT NOT NULL, situacao TEXT NOT NULL, lote_id TEXT, posicao INTEGER,
    tentativas INTEGER NOT NULL DEFAULT 0, erro TEXT, enfileirado_em TEXT NOT NULL, mudou_em TEXT NOT NULL, terminado_em TEXT)`,
  "CREATE INDEX IF NOT EXISTS ix_atualizacoes_fila ON atualizacoes(situacao, atualizado_em_utc, enfileirado_em, id_atualizacao)",
  "CREATE INDEX IF NOT EXISTS ix_atualizacoes_caso ON atualizacoes(id_solicitacao, atualizado_em_utc)",
  "CREATE INDEX IF NOT EXISTS ix_atualizacoes_lote ON atualizacoes(lote_id)",
  "CREATE INDEX IF NOT EXISTS ix_atualizacoes_terminado ON atualizacoes(terminado_em)",
  // Lote: montando (itens marcados, run ainda não aceito) → disparado → terminado (desfecho diz como).
  `CREATE TABLE IF NOT EXISTS lotes (
    id TEXT PRIMARY KEY, situacao TEXT NOT NULL, desfecho TEXT, casos INTEGER NOT NULL DEFAULT 0,
    atualizacoes INTEGER NOT NULL DEFAULT 0, clears INTEGER NOT NULL DEFAULT 0, gravados INTEGER, recusados INTEGER,
    erro TEXT, criado_em TEXT NOT NULL, disparado_em TEXT, terminado_em TEXT)`,
  "CREATE INDEX IF NOT EXISTS ix_lotes_situacao ON lotes(situacao, criado_em)",
  "CREATE INDEX IF NOT EXISTS ix_lotes_terminado ON lotes(terminado_em)",
  // Marcas do próprio app: versão do esquema, a vez da rodada, a última limpeza, o resumo da última rodada.
  "CREATE TABLE IF NOT EXISTS controle (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)",
];

// Sobe a cada mudança no ESQUEMA: o banco com a versão gravada pula o DDL inteiro.
const VERSAO_ESQUEMA = "1";

// Uma vez por banco no isolate. Nunca guarda promessa: falhou, a próxima requisição tenta de novo.
const prontos = new WeakSet<object>();

export async function garantirEsquema(D: Banco) {
  if (prontos.has(D.bruto)) return;
  // Banco novo: a tabela controle ainda não existe e a leitura falha; vale como versão diferente.
  const gravada = await D.um("SELECT valor FROM controle WHERE chave = 'esquema'").catch(() => undefined);
  if (gravada?.valor !== VERSAO_ESQUEMA) {
    for (const sql of ESQUEMA) await D.exec(sql);
    await D.exec("INSERT INTO controle (chave, valor) VALUES ('esquema', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", [VERSAO_ESQUEMA]);
  }
  prontos.add(D.bruto);
}

// Marca de tempo que só uma chamada pega por intervalo (a rodada do lote, a limpeza de hora em hora, o cron sem
// assinatura): grava a hora atual se a anterior tiver mais de intervaloMs. Gravou alguma linha = esta chamada pegou.
export async function pegarVez(D: Banco, chave: string, agora: number, intervaloMs: number): Promise<boolean> {
  return (await D.exec(
    "INSERT INTO controle (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor WHERE controle.valor <= ?",
    [chave, isoUtc(agora), isoUtc(agora - intervaloMs)],
  )) > 0;
}

// Devolve a vez antes do intervalo acabar, se ela ainda for de quem a pegou nesse instante (texto vazio vem antes de
// qualquer data, então a próxima chamada pega na hora).
export async function soltarVez(D: Banco, chave: string, agora: number) {
  await D.exec("UPDATE controle SET valor = '' WHERE chave = ? AND valor = ?", [chave, isoUtc(agora)]);
}
