// O SQL que o app manda ao Metabase: a página da lista, a contagem, um caso e a conferência das edições gravadas.
//
// GOLD + RAW. A base é a gold.fct_reenvio_reembolso_gobeaute com os casos do CX Hub que a raw já mudou e a gold ainda
// não mostra trocados pelos "frescos" (servidor/raw.ts: os eventos da raw remontados com as regras do dbt). A gold só é
// montada de hora em hora; a raw recebe o caso e a atualização no fim de cada lote. Filtro, busca, ordem e contagem
// valem sobre essa base, então um caso novo ou alterado aparece (e filtra) pelo valor de agora.
//
// PAGINAÇÃO POR CURSOR (keyset). O Metabase não pagina SQL nativo, e OFFSET num filtro que muda enquanto se lê pula ou
// repete linha. Cada página é "as próximas N linhas na ordem (data_solicitacao desc, chave_unica desc)", e a seguinte
// começa depois da última linha vista: (data_solicitacao, chave_unica) < (data da última, chave da última). A chave
// desempata linhas com a mesma data, então nenhuma linha pula nem se repete entre as páginas, mesmo com linha nova
// chegando no topo. A data_solicitacao nunca é nula (o dbt e o raw.ts sempre a preenchem).
//
// Datas saem como texto (to_char), sem passar pelo fuso do Metabase: a data_solicitacao é hora de São Paulo sem fuso,
// e o cursor precisa do valor exato para comparar.

import type { Tipo } from "../shared/campos";
import { COLUNAS_GOLD, type CasoGold, type ColunaGold, type FiltroStatus, type ValorGold } from "../shared/tipos";
import { literalSql } from "./metabase";
import { ctesDosCasosFrescos } from "./raw";

export const TABELA_GOLD = "gold.fct_reenvio_reembolso_gobeaute";
export const TABELA_RAW = "raw.cxhub_reenvio_reembolso_eventos";

// A coluna da tabela por trás de cada coluna que o app devolve (duas têm nome próprio na API).
const COLUNA_DA_TABELA: Partial<Record<ColunaGold, string>> = { data_pedido: "data_pedido_original_coorte", carregado_em: "_loaded_at" };
const COLUNAS_DA_BASE = COLUNAS_GOLD.map(c => COLUNA_DA_TABELA[c] ?? c).join(", ");

const EXPRESSAO: Partial<Record<ColunaGold, string>> = {
  data_solicitacao: `to_char(data_solicitacao, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
  data_execucao: "to_char(data_execucao, 'YYYY-MM-DD')",
  prazo_execucao: "to_char(prazo_execucao, 'YYYY-MM-DD')",
  data_pedido: "to_char(data_pedido_original_coorte, 'YYYY-MM-DD')",
  carregado_em: `to_char(_loaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
};

const SELECT = COLUNAS_GOLD.map(c => (EXPRESSAO[c] ? `${EXPRESSAO[c]} as ${c}` : c)).join(", ");

// Depois das colunas da gold, a que diz que o Cosmos já registrou o reenvio: a criação do caso na raw com automacao =
// true (o CX Hub o criou no Cosmos pela automação, e o Cosmos confirmou). A gold não guarda o flag (vira o responsável
// "Automação", que uma edição pode trocar); a criação na raw não muda. Só o caso do CX Hub tem criação na raw.
const reenvioNoCosmos = (raw: string) => `(tipo = 'REENVIO' and chave_unica like 'cxhub|%' and exists (select 1 from ${raw} r `
  + "where r.id_solicitacao = substr(chave_unica, 7) and r.tipo_evento = 'caso' and r.payload ->> 'automacao' = 'true')) as reenvio_no_cosmos";

// ─── A raw virtual: a raw mais os casos que ainda estão na fila do app ──────────
// Adaptação do app cx-hub (fila única, backoffice/ORIGEM.md). O caso que o CX Hub acabou de registrar fica na fila do
// app até o lote o levar à DAG (até 10 min); a raw ainda não o tem. Para a lista mostrá-lo e o backoffice poder editá-lo
// já, a criação dele entra na consulta como um evento a mais da raw: o mesmo SQL das regras do dbt monta a linha, e
// filtros, busca, contagem e cursor valem para ela como para as outras. Só entra o caso que a raw ainda não tem (not
// exists): depois que a DAG o grava, vale o evento de verdade.
//
// A CTE tem só os casos da fila ("fila_eventos"), e cada lugar que lê a raw lê a tabela de verdade unida a ela (RAW_COM_
// FILA, uma subconsulta que o Postgres desdobra). Uma CTE com a raw inteira seria lida em vários lugares, e o Postgres
// a materializaria: copiaria a raw toda a cada página, sem os índices dela.

/** Um caso da fila do app: o id e o corpo que vai ao conf da DAG (o payload da criação na raw). */
export type CasoDaFila = { id: string; dados: string };

const cteDaFila = (fila: readonly CasoDaFila[]) => `fila_eventos as (
  select v.id_solicitacao, 'caso'::text as tipo_evento, now() as disparado_em, 'fila:' || v.id_solicitacao || ':0' as evento_id,
    now() as _loaded_at, cast(v.payload as jsonb) as payload
  from (values ${fila.map(x => `(${literalSql(x.id)}, ${literalSql(x.dados)})`).join(", ")}) as v(id_solicitacao, payload)
  where not exists (select 1 from ${TABELA_RAW} k where k.id_solicitacao = v.id_solicitacao and k.tipo_evento = 'caso')
)`;

const COLUNAS_DA_RAW = "id_solicitacao, tipo_evento, disparado_em, evento_id, _loaded_at, payload";
const RAW_COM_FILA = `(select ${COLUNAS_DA_RAW} from ${TABELA_RAW} union all select ${COLUNAS_DA_RAW} from fila_eventos)`;
const rawCom = (fila: readonly CasoDaFila[]) => (fila.length ? RAW_COM_FILA : TABELA_RAW);

// A base: a gold sem os casos pendentes, mais esses casos como a raw os mostra. Com idSolicitacao, só aquele caso.
// Com casos da fila, a raw lida é a virtual.
function base(idSolicitacao: string | null = null, fila: readonly CasoDaFila[] = []): string {
  return `with ${fila.length ? `${cteDaFila(fila)},\n` : ""}${ctesDosCasosFrescos({ tabelaGold: TABELA_GOLD, tabelaRaw: rawCom(fila), idSolicitacao, literal: literalSql })},
base as (
  select ${COLUNAS_DA_BASE} from ${TABELA_GOLD} g where not exists (select 1 from pendentes p where p.chave = g.chave_unica)
  union all
  select ${COLUNAS_DA_BASE} from frescos
)`;
}

export type Filtro = { tipo: Tipo; sigla: string | null; status: FiltroStatus | null; busca: string | null };
export type Cursor = { d: string; c: string };

// Onde a busca procura (sem diferenciar maiúsculas): pedido, NF, chave da NF, atendimento, responsáveis, SKUs, NFD,
// motivo e a chave da linha.
const COLUNAS_DA_BUSCA = [
  "numero_pedido", "cod_nf_original", "chave_nf", "id_atendimento", "responsavel_atendimento", "responsavel_execucao",
  "sku_produto_problema", "produtos_reenvio", "escopo_reembolso", "cod_nfd", "motivo", "chave_unica",
];

// % e _ da busca valem como texto, não como curinga.
const escaparLike = (s: string) => s.replace(/[\\%_]/g, m => `\\${m}`);

function condicoes(f: Filtro): string[] {
  const c = [`tipo = ${literalSql(f.tipo)}`];
  if (f.sigla) c.push(`sigla = ${literalSql(f.sigla)}`);
  if (f.status === "sem_status") c.push("coalesce(status_execucao, '') = ''");
  else if (f.status) c.push(`status_execucao = ${literalSql(f.status)}`);
  if (f.busca) {
    const padrao = literalSql(`%${escaparLike(f.busca)}%`);
    c.push(`(${COLUNAS_DA_BUSCA.map(col => `${col} ilike ${padrao}`).join(" or ")})`);
  }
  return c;
}

// Uma linha a mais que a página: se ela vier, há página seguinte. O flag do Cosmos vem por fora da página, para só ser
// procurado nas linhas que voltam (a data já sai como texto, que ordena igual).
export function sqlDaPagina(f: Filtro, cursor: Cursor | null, tamanho: number, fila: readonly CasoDaFila[] = []): string {
  const c = condicoes(f);
  if (cursor) c.push(`(data_solicitacao, chave_unica) < (${literalSql(cursor.d)}::timestamp, ${literalSql(cursor.c)})`);
  return `${base(null, fila)}
select pagina.*, ${reenvioNoCosmos(rawCom(fila))} from (
  select ${SELECT} from base where ${c.join(" and ")} order by data_solicitacao desc, chave_unica desc limit ${tamanho + 1}
) pagina order by data_solicitacao desc, chave_unica desc`;
}

export const sqlDaContagem = (f: Filtro, fila: readonly CasoDaFila[] = []) => `${base(null, fila)}
select count(*) as total from base where ${condicoes(f).join(" and ")}`;

// Um caso pela chave. O do CX Hub (cxhub|<id>) olha também a raw daquele caso (e, ainda na fila, a criação dele lá);
// o do histórico, só a gold.
export function sqlDoCaso(chave: string, fila: readonly CasoDaFila[] = []): string {
  const id = chave.startsWith("cxhub|") ? chave.slice("cxhub|".length) : null;
  if (!id) return `select ${SELECT}, ${reenvioNoCosmos(TABELA_RAW)} from ${TABELA_GOLD} where chave_unica = ${literalSql(chave)}`;
  // A chave da gold sai do id em minúsculas (chaveDoCaso, em raw.ts); o id na fila vem como o CX Hub o mandou, e é ele
  // que a raw guarda: com o caso na fila, o recorte usa o dela.
  const doCaso = fila.filter(x => x.id.toLowerCase() === id);
  return `${base(doCaso[0]?.id ?? id, doCaso)}
select ${SELECT}, ${reenvioNoCosmos(rawCom(doCaso))} from base where chave_unica = ${literalSql(chave)}`;
}

export type ItemConferencia = { idAtualizacao: string; idSolicitacao: string };

// Para cada edição gravada, o evento dela na raw (pelo id_atualizacao, que a raw guarda no payload e tem índice único).
// Edição que não aparece no resultado ainda não chegou à réplica que o Metabase lê (atrasa minutos). A que aparece já é
// mostrada pela lista (a base lê a raw), e pode sair do env.DB.
export function sqlDaConferencia(itens: ItemConferencia[]): string {
  const valores = itens.map(i => `(${literalSql(i.idAtualizacao)}, ${literalSql(i.idSolicitacao)})`).join(", ");
  return `select v.id_atualizacao, to_char(e._loaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as na_raw `
    + `from (values ${valores}) as v(id_atualizacao, id_solicitacao) `
    + `join ${TABELA_RAW} e on e.id_solicitacao = v.id_solicitacao and e.tipo_evento = 'atualizacao' `
    + "and e.payload ->> 'id_atualizacao' = v.id_atualizacao";
}

const valorGold = (v: unknown): ValorGold =>
  v === null || v === undefined ? null : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v);

// A linha do Metabase (array na ordem do SELECT, com o flag do Cosmos no fim) como objeto.
export function casoDaLinha(linha: unknown[]): CasoGold {
  const caso = { reenvio_no_cosmos: linha[COLUNAS_GOLD.length] === true || linha[COLUNAS_GOLD.length] === "true" } as CasoGold;
  COLUNAS_GOLD.forEach((col, i) => {
    caso[col] = valorGold(linha[i]);
  });
  return caso;
}

// ─── Cursor ─────────────────────────────────────────────────────────────────
// Opaco para a tela: base64url de [data, chave]. A chave pode ter acento (as do histórico), daí o UTF-8.

const DATA_DO_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

export function codificarCursor(c: Cursor): string {
  let bin = "";
  for (const b of new TextEncoder().encode(JSON.stringify([c.d, c.c]))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function lerCursor(s: string): Cursor | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const [d, c] = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)))) as unknown[];
    if (typeof d === "string" && DATA_DO_CURSOR.test(d) && typeof c === "string" && c.length > 0 && c.length <= 300) return { d, c };
  } catch {
    // cai no null
  }
  return null;
}

export const cursorDoCaso = (caso: CasoGold): Cursor | null =>
  typeof caso.data_solicitacao === "string" && typeof caso.chave_unica === "string" ? { d: caso.data_solicitacao, c: caso.chave_unica } : null;
