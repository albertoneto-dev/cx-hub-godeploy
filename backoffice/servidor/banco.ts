// env.DB do GoDeploy (SQLite): query para leitura e exec para escrita, uma instrução por chamada, sem transação.
// O esquema se cria no primeiro acesso e persiste entre deploys; a versão gravada em "controle" evita repetir o DDL.
// Sem transação, "pegar" algo (a vez da rodada, uma edição para o lote) é uma escrita com a condição no WHERE, e quem
// pegou é quem viu rowsWritten > 0. O número exato não serve: o GoDeploy conta também as linhas de índice (visto no
// api-procon-processos em 03/11/2026). Listas vão num parâmetro só, como JSON lido por json_each.
// Mesmo desenho do app cx-hub (a fila do CX Hub), de onde vieram o wrapper e a vez da rodada.

import { garantirEsquema as garantirEsquemaDaFila } from "../../servidor/banco";
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

// Adaptação do app cx-hub (fila única, backoffice/ORIGEM.md): a edição mora na tabela `atualizacoes` da fila do app
// (servidor/banco.ts), a mesma das atualizações do CX Hub, e sobe no lote dela. Aqui fica só o que é do backoffice:
// bo_autoria: uma linha por edição feita pelo backoffice (o mesmo id_atualizacao da fila): quem fez e de que linha da
//   gold. conferida: 'na_raw' quando a conferência viu o evento na raw que o Metabase lê (a partir daí a lista já o
//   mostra, e a edição deixa de ser aplicada por cima), ou 'atrasada' quando a DAG a gravou e ela não apareceu em 6 h
//   (sai da tela com aviso); NULL enquanto espera. Sai quando a fila apaga a atualização (7 dias depois de terminada).
// bo_clientes: os dados do cliente do reenvio, que o Metabase não guarda. Ficam aqui de vez (não é fila).
// bo_controle: a versão do esquema e a vez da limpeza.
// bo_edicoes e bo_lotes eram a fila e os lotes próprios do backoffice (até a v9): saem no esquema 2.
const ESQUEMA = [
  "DROP TABLE IF EXISTS bo_edicoes",
  "DROP TABLE IF EXISTS bo_lotes",
  `CREATE TABLE IF NOT EXISTS bo_autoria (
    id_atualizacao TEXT PRIMARY KEY, chave_unica TEXT NOT NULL, tipo TEXT NOT NULL, sigla TEXT, autor TEXT NOT NULL,
    criado_em TEXT NOT NULL, conferida TEXT, conferida_em TEXT)`,
  "CREATE INDEX IF NOT EXISTS ix_bo_autoria_chave ON bo_autoria(chave_unica)",
  `CREATE TABLE IF NOT EXISTS bo_clientes (
    chave_unica TEXT PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT NOT NULL, cep TEXT NOT NULL,
    logradouro TEXT NOT NULL, numero TEXT NOT NULL, complemento TEXT NOT NULL, bairro TEXT NOT NULL,
    cidade TEXT NOT NULL, atualizado_em TEXT NOT NULL, autor TEXT NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS bo_controle (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)",
];

// Sobe a cada mudança no ESQUEMA: o banco com a versão gravada pula o DDL inteiro. "2": a fila única.
const VERSAO_ESQUEMA = "2";

// Uma vez por banco no isolate. Nunca guarda promessa: falhou, a próxima requisição tenta de novo.
const prontos = new WeakSet<object>();

export async function garantirEsquema(D: Banco) {
  if (prontos.has(D.bruto)) return;
  // A fila (casos e atualizações) mora no mesmo banco, e o backoffice lê e grava nela.
  await garantirEsquemaDaFila(D);
  // Banco novo: a tabela controle ainda não existe e a leitura falha; vale como versão diferente.
  const gravada = await D.um("SELECT valor FROM bo_controle WHERE chave = 'esquema'").catch(() => undefined);
  if (gravada?.valor !== VERSAO_ESQUEMA) {
    for (const sql of ESQUEMA) await D.exec(sql);
    await D.exec("INSERT INTO bo_controle (chave, valor) VALUES ('esquema', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", [VERSAO_ESQUEMA]);
  }
  prontos.add(D.bruto);
}

// Marca de tempo que só uma chamada pega por intervalo (a limpeza de hora em hora): grava a hora atual se a anterior
// tiver mais de intervaloMs. Gravou alguma linha = esta chamada pegou.
export async function pegarVez(D: Banco, chave: string, agora: number, intervaloMs: number): Promise<boolean> {
  return (await D.exec(
    "INSERT INTO bo_controle (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor WHERE bo_controle.valor <= ?",
    [chave, isoUtc(agora), isoUtc(agora - intervaloMs)],
  )) > 0;
}
