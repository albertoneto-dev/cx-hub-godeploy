// env.DB do GoDeploy (SQLite): query para leitura e exec para escrita, uma instrução por chamada, sem transação.
// O esquema se cria no primeiro acesso e persiste entre deploys; a versão gravada em "controle" evita repetir o DDL.
// Sem transação, "pegar" algo (a vez da rodada, uma edição para o lote) é uma escrita com a condição no WHERE, e quem
// pegou é quem viu rowsWritten > 0. O número exato não serve: o GoDeploy conta também as linhas de índice (visto no
// api-procon-processos em 03/11/2026). Listas vão num parâmetro só, como JSON lido por json_each.
// Mesmo desenho do app cx-hub (a fila do CX Hub), de onde vieram o wrapper e a vez da rodada.

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

// edicoes: a "tabela temporária" — cada edição salva no drawer, até o Metabase mostrá-la. situacao: pendente → enviado
//   (lote_id e posicao preenchidos) → gravado (a DAG confirmou) → a linha é APAGADA quando a raw que o Metabase lê tem
//   o evento (a lista lê gold + raw). recusado: a DAG recusou (fica 7 dias, para quem editou ver o motivo). campos: o
//   que vai ao conf, com os nomes do contrato da DAG. tentativas: quantos lotes desta edição falharam sem resultado (o
//   segundo a recusa).
// lotes: montando (edições marcadas, run ainda não aceito) → disparado → terminado (desfecho diz como).
// clientes: os dados do cliente do reenvio, que o Metabase não guarda. Ficam aqui de vez (não é fila).
// controle: a versão do esquema, a vez da rodada, a última limpeza e o resumo da última rodada.
const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS bo_edicoes (
    id_atualizacao TEXT PRIMARY KEY, id_solicitacao TEXT NOT NULL, chave_unica TEXT NOT NULL, tipo TEXT NOT NULL,
    sigla TEXT, campos TEXT NOT NULL, atualizado_em TEXT NOT NULL, autor TEXT NOT NULL, situacao TEXT NOT NULL,
    lote_id TEXT, posicao INTEGER, tentativas INTEGER NOT NULL DEFAULT 0, erro TEXT, criado_em TEXT NOT NULL,
    mudou_em TEXT NOT NULL, gravado_em TEXT, terminado_em TEXT)`,
  "CREATE INDEX IF NOT EXISTS ix_bo_edicoes_fila ON bo_edicoes(situacao, atualizado_em, criado_em, id_atualizacao)",
  "CREATE INDEX IF NOT EXISTS ix_bo_edicoes_chave ON bo_edicoes(chave_unica, atualizado_em)",
  "CREATE INDEX IF NOT EXISTS ix_bo_edicoes_lote ON bo_edicoes(lote_id)",
  `CREATE TABLE IF NOT EXISTS bo_lotes (
    id TEXT PRIMARY KEY, situacao TEXT NOT NULL, desfecho TEXT, itens INTEGER NOT NULL DEFAULT 0,
    clears INTEGER NOT NULL DEFAULT 0, gravados INTEGER, recusados INTEGER, erro TEXT, criado_em TEXT NOT NULL,
    disparado_em TEXT, terminado_em TEXT)`,
  "CREATE INDEX IF NOT EXISTS ix_bo_lotes_situacao ON bo_lotes(situacao, criado_em)",
  "CREATE INDEX IF NOT EXISTS ix_bo_lotes_terminado ON bo_lotes(terminado_em)",
  `CREATE TABLE IF NOT EXISTS bo_clientes (
    chave_unica TEXT PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT NOT NULL, cep TEXT NOT NULL,
    logradouro TEXT NOT NULL, numero TEXT NOT NULL, complemento TEXT NOT NULL, bairro TEXT NOT NULL,
    cidade TEXT NOT NULL, atualizado_em TEXT NOT NULL, autor TEXT NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS bo_controle (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)",
];

// Sobe a cada mudança no ESQUEMA: o banco com a versão gravada pula o DDL inteiro.
const VERSAO_ESQUEMA = "1";

// Uma vez por banco no isolate. Nunca guarda promessa: falhou, a próxima requisição tenta de novo.
const prontos = new WeakSet<object>();

export async function garantirEsquema(D: Banco) {
  if (prontos.has(D.bruto)) return;
  // Banco novo: a tabela controle ainda não existe e a leitura falha; vale como versão diferente.
  const gravada = await D.um("SELECT valor FROM bo_controle WHERE chave = 'esquema'").catch(() => undefined);
  if (gravada?.valor !== VERSAO_ESQUEMA) {
    for (const sql of ESQUEMA) await D.exec(sql);
    await D.exec("INSERT INTO bo_controle (chave, valor) VALUES ('esquema', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", [VERSAO_ESQUEMA]);
  }
  prontos.add(D.bruto);
}

// Marca de tempo que só uma chamada pega por intervalo (a rodada do lote, a limpeza de hora em hora, o cron sem
// assinatura): grava a hora atual se a anterior tiver mais de intervaloMs. Gravou alguma linha = esta chamada pegou.
export async function pegarVez(D: Banco, chave: string, agora: number, intervaloMs: number): Promise<boolean> {
  return (await D.exec(
    "INSERT INTO bo_controle (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor WHERE bo_controle.valor <= ?",
    [chave, isoUtc(agora), isoUtc(agora - intervaloMs)],
  )) > 0;
}

// Devolve a vez antes do intervalo acabar, se ela ainda for de quem a pegou nesse instante (texto vazio vem antes de
// qualquer data, então a próxima chamada pega na hora).
export async function soltarVez(D: Banco, chave: string, agora: number) {
  await D.exec("UPDATE bo_controle SET valor = '' WHERE chave = ? AND valor = ?", [chave, isoUtc(agora)]);
}
