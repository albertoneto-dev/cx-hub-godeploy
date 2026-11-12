// O backoffice e a fila do app (servidor/), que dividem o mesmo env.DB. Adaptação do app cx-hub (fila única,
// backoffice/ORIGEM.md): a edição do backoffice é uma atualização da fila, ao lado das que o CX Hub manda, e sobe no
// lote dela, depois do caso (o lote leva a criação antes da alteração); o caso que ainda está na fila entra na consulta
// do Metabase como raw virtual (gold.ts).

import { enfileirarAtualizacoes } from "../../servidor/fila";
import type { Tipo } from "../shared/campos";
import type { Banco } from "./banco";
import type { CasoDaFila } from "./gold";
import { isoUtc } from "./tempo";

// A DAG grava a raw antes de o lote ser lido como gravado, mas a réplica que o Metabase lê atrasa minutos: o caso
// gravado há pouco ainda entra na raw virtual (a consulta descarta o que a raw de verdade já tem).
const JANELA_GRAVADO_MS = 60 * 60_000;
const MAX_CASOS = 200;

/** Os casos que a raw talvez ainda não tenha: na fila (pendente, enviado) ou gravados na última hora. */
export async function casosDaFila(db: Banco, o: { tipo?: Tipo; id?: string }, agora: number): Promise<CasoDaFila[]> {
  const filtros = ["(situacao IN ('pendente', 'enviado') OR (situacao = 'gravado' AND terminado_em >= ?))"];
  const params: unknown[] = [isoUtc(agora - JANELA_GRAVADO_MS)];
  if (o.tipo) {
    filtros.push("tipo = ?");
    params.push(o.tipo);
  }
  if (o.id) {
    filtros.push("id_solicitacao = ? COLLATE NOCASE");
    params.push(o.id);
  }
  const linhas = await db.query(
    `SELECT id_solicitacao, dados FROM casos WHERE ${filtros.join(" AND ")} ORDER BY criado_em_utc DESC LIMIT ?`,
    [...params, MAX_CASOS],
  );
  // O jsonb do Postgres recusa o \u0000: um caso assim derrubaria a consulta da lista inteira. Fica de fora (a DAG
  // também não conseguiria gravá-lo na raw).
  return linhas
    .map(l => ({ id: String(l.id_solicitacao), dados: String(l.dados) }))
    .filter(x => !x.dados.includes("\\u0000"));
}

/**
 * O id do caso como o CX Hub o mandou. A chave da gold o tem em minúsculas, e a DAG casa o id exato: se a fila ainda
 * guarda o caso (7 dias), vale o dela. O CX Hub gera UUID em minúsculas, então quase sempre os dois são iguais.
 */
export async function idDoCaso(db: Banco, idDaChave: string): Promise<string> {
  const l = await db.um("SELECT id_solicitacao FROM casos WHERE id_solicitacao = ? COLLATE NOCASE LIMIT 1", [idDaChave]);
  return l ? String(l.id_solicitacao) : idDaChave;
}

/** A edição entra na fila como uma atualização do caso, pendente até o próximo lote. */
export async function enfileirarEdicao(db: Banco, e: { id: string; idSolicitacao: string; campos: Record<string, string | number> }, agora: number) {
  const quando = isoUtc(agora);
  await enfileirarAtualizacoes(db, [{ id: e.id, idSolicitacao: e.idSolicitacao, atualizadoEm: quando, atualizadoEmUtc: quando, campos: JSON.stringify(e.campos) }], agora);
}
