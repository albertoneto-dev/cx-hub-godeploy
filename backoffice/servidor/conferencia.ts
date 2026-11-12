// A parte do backoffice na rodada da fila do app (servidor/lote.ts da raiz, a etapa posRodada), que o cron chama a
// cada 10 min. A fila já levou as edições à DAG junto das atualizações do CX Hub; aqui fica o que é só do backoffice:
// 1. CONFERE no Metabase as edições que a DAG gravou: quando a raw que o Metabase lê já tem o evento, a lista já o
//    mostra (ela lê gold + raw, gold.ts) e a edição deixa de ser aplicada por cima. Gravada há mais de 6 h sem aparecer
//    também deixa, com aviso (a DAG confirmou a gravação; a réplica atrasa minutos, não horas);
// 2. uma vez por hora, apaga a autoria das edições que a fila já não tem (descartadas, ou apagadas 7 dias depois).
//
// Adaptação do app cx-hub (fila única, backoffice/ORIGEM.md): no app de origem, a conferência era um passo do lote
// próprio do backoffice (servidor/lote.ts de lá), que apagava a edição do env.DB; aqui a fila é a dona da linha, e a
// conferência só marca a autoria.

import { garantirEsquema, pegarVez, type Banco } from "./banco";
import type { Config } from "./config";
import type { Busca } from "./contexto";
import { sqlDaConferencia, type ItemConferencia } from "./gold";
import { comoMetabaseErro, consultar } from "./metabase";
import { HORA, isoUtc, type Relogio } from "./tempo";

const ESPERA_MAXIMA_NA_RAW_MS = 6 * HORA;
const CONFERIR_POR_RODADA = 200;
const TEMPO_DA_CONSULTA_MS = 15_000;
// A autoria é gravada um instante antes da atualização (edicoes.ts): a limpeza só apaga a que ficou sozinha há mais
// que isto, para não pegar uma edição sendo salva.
const FOLGA_DA_AUTORIA_MS = HORA;

export type DependenciasDaConferencia = { db: Banco; cfg: Config; fetch: Busca; relogio: Relogio };
type Etapa = { estado: string; [detalhe: string]: unknown };

/** A etapa do backoffice na rodada da fila. `prazo`: depois dele, nada de chamada ao Metabase (fica para a próxima). */
export async function rodadaDoBackoffice(d: DependenciasDaConferencia, prazo: number): Promise<{ nome: string; resumo: unknown; avisos: string[] }> {
  await garantirEsquema(d.db);
  const avisos: string[] = [];
  const conferencia = await conferir(d, prazo, avisos);
  const limpeza = await limpar(d);
  return { nome: "backoffice", resumo: { conferencia, limpeza }, avisos };
}

async function conferir(d: DependenciasDaConferencia, prazo: number, avisos: string[]): Promise<Etapa> {
  const linhas = await d.db.query(
    `SELECT b.id_atualizacao, a.id_solicitacao, a.terminado_em FROM bo_autoria b JOIN atualizacoes a ON a.id_atualizacao = b.id_atualizacao
     WHERE a.situacao = 'gravado' AND b.conferida IS NULL ORDER BY a.terminado_em, b.id_atualizacao LIMIT ?`,
    [CONFERIR_POR_RODADA],
  );
  if (!linhas.length) return { estado: "nada" };
  const m = d.cfg.metabase;
  if (!m) return { estado: "sem_metabase", gravadas: linhas.length };
  if (d.relogio.agora() > prazo) return { estado: "sem_tempo", gravadas: linhas.length };
  const itens: ItemConferencia[] = linhas.map(l => ({ idAtualizacao: String(l.id_atualizacao), idSolicitacao: String(l.id_solicitacao) }));
  let resposta: unknown[][];
  try {
    resposta = await consultar(m, d.fetch, sqlDaConferencia(itens), TEMPO_DA_CONSULTA_MS);
  } catch (err) {
    const e = comoMetabaseErro(err);
    // Rede ou 5xx: a próxima rodada confere. Erro de SQL ou de permissão não melhora sozinho: avisa.
    if (!e.transitorio) avisos.push(`A conferência das edições do backoffice no Metabase falhou (${e.message}): elas seguem na tela até ela voltar.`);
    return { estado: "sem_resposta", erro: e.message, gravadas: linhas.length };
  }
  const naRaw = new Set(resposta.map(l => String(l[0])));

  const agora = d.relogio.agora();
  const prontas: string[] = [];
  const atrasadas: string[] = [];
  for (const l of linhas) {
    const id = String(l.id_atualizacao);
    if (naRaw.has(id)) prontas.push(id);
    else if (agora - Date.parse(String(l.terminado_em)) > ESPERA_MAXIMA_NA_RAW_MS) atrasadas.push(id);
  }
  await marcar(d.db, prontas, "na_raw", agora);
  await marcar(d.db, atrasadas, "atrasada", agora);
  if (atrasadas.length)
    avisos.push(`${atrasadas.length} edição(ões) do backoffice que a DAG gravou não apareceram na raw do Metabase em 6 h e saíram da tela (a réplica do Data Mart está parada?): ${atrasadas.slice(0, 10).join(", ")}`);
  return { estado: "conferido", naRaw: prontas.length, atrasadas: atrasadas.length, esperando: linhas.length - prontas.length - atrasadas.length };
}

async function marcar(db: Banco, ids: string[], conferida: "na_raw" | "atrasada", agora: number) {
  if (!ids.length) return;
  await db.exec(
    "UPDATE bo_autoria SET conferida = ?, conferida_em = ? WHERE conferida IS NULL AND id_atualizacao IN (SELECT value FROM json_each(?))",
    [conferida, isoUtc(agora), JSON.stringify(ids)],
  );
}

async function limpar(d: DependenciasDaConferencia): Promise<boolean> {
  const agora = d.relogio.agora();
  if (!(await pegarVez(d.db, "limpeza", agora, HORA))) return false;
  await d.db.exec(
    "DELETE FROM bo_autoria WHERE criado_em < ? AND NOT EXISTS (SELECT 1 FROM atualizacoes a WHERE a.id_atualizacao = bo_autoria.id_atualizacao)",
    [isoUtc(agora - FOLGA_DA_AUTORIA_MS)],
  );
  return true;
}
