import { consultarDataMart, literalSql } from '../metabase/index';
import { janelaDaLista } from '../solicitacoes/paginacao';
import type { FiltroSolicitacoes, SolicitacaoListada } from '../solicitacoes/types';
import { SIGLA_DA_MARCA } from './gold';
import { TABELA_RAW, ULTIMO_STATUS } from './raw';

/** Quantas solicitações cada página traz. É também o que a fila aceita numa pergunta das atualizações (20 ids). */
export const TAMANHO_DA_PAGINA = 20;

/** Um caso que a fila guarda e a raw talvez ainda não mostre: só o que a lista precisa para ordenar e agrupar. */
export interface CasoDaFilaNaLista {
    idSolicitacao: string;
    marca: string;
    numeroPedido: string;
    /** O `criado_em` do caso (ISO 8601, `toISOString()`) */
    criadoEm: string;
}

export interface OpcoesDaLista {
    /** A partir de 1. */
    pagina: number;
    /** Os casos da fila: entram na ordem e na contagem junto da raw, menos o que a raw já tem. */
    daFila: readonly CasoDaFilaNaLista[];
    /** Agora, em ms: o começo da janela de 30 dias. */
    agora: number;
}

const digitos = (texto: string) => texto.replace(/\D/g, '');

/** O começo da janela (ISO), ou `null` na busca por pedido, que não tem janela (`janelaDaLista`). */
export function inicioDaJanela(filtro: FiltroSolicitacoes, agora: number): string | null {
    const dias = janelaDaLista(filtro);
    return dias === null ? null : new Date(agora - dias * 24 * 3600_000).toISOString();
}

/** O `criado_em` do caso: o mesmo texto da fila (`toISOString()`), para as duas ordenarem juntas. */
const CRIADO_NA_RAW = `coalesce(nullif(btrim(c.criado_em), ''), to_char(c.disparado_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

/** Mais novo primeiro, e o id desempata: a mesma ordem em toda página, para nenhuma linha pular ou repetir. */
const ordem = (alias: string) => `${alias}.criado collate "C" desc, ${alias}.id_solicitacao collate "C" desc`;

/**
 * SELECT de uma página da lista de solicitações do CX Hub: a raw de eventos (e não a gold, que só é montada de hora em
 * hora) **junto** dos casos da fila do Metabase (ADR-012), passados no `values`. É no SQL que as duas se juntam, para a
 * contagem, a ordem e o "mais recente do pedido" valerem para a lista inteira, e não só para a página:
 * - `c`: a criação de cada caso da raw (`distinct on`), do tipo, marca e pedido pedidos;
 * - `j`: `c` mais os casos da fila que a raw ainda não tem (`da_fila`);
 * - `o`: `j` na janela de 30 dias (sem janela na busca por pedido), com o `mais_recente` por marca e dígitos do pedido;
 * - `p`: a página.
 *
 * A data é o `criado_em` do caso (quando a agente enviou), na raw e na fila, comparado como texto (`collate "C"`): o
 * `toISOString()` tem tamanho fixo e é em UTC, então a ordem do texto é a do tempo, e um texto fora do formato não
 * derruba a consulta. O `total` sai de uma linha só (`t`), então a página além da última ainda o traz, numa linha sem
 * id. Só entram valores montados no código e escapados (`literalSql`).
 */
export function sqlDaListaDeSolicitacoes(filtro: FiltroSolicitacoes, opcoes: OpcoesDaLista): string {
    const numero = digitos(filtro.pedido ?? '');
    const desde = inicioDaJanela(filtro, opcoes.agora);
    const pagina = Math.max(1, Math.trunc(opcoes.pagina) || 1);

    const filtros = [`e.tipo_evento = 'caso'`, `upper(btrim(e.payload ->> 'tipo')) = ${literalSql(filtro.tipo)}`];
    if (filtro.marca) filtros.push(`lower(btrim(e.marca)) = ${literalSql(filtro.marca)}`);
    if (numero) {
        filtros.push(`regexp_replace(e.payload ->> 'numero_pedido', '[^0-9]', '', 'g') = ${literalSql(numero)}`);
    }
    // O lote roda depois da criação (`disparado_em` >= `criado_em`): este corte não perde nada da janela.
    if (desde) filtros.push(`e.disparado_em >= ${literalSql(desde)}::timestamptz`);

    const daFila = opcoes.daFila.map((caso) =>
        `(${[caso.idSolicitacao, caso.marca, caso.numeroPedido, caso.criadoEm].map(literalSql).join(', ')})`);
    const uniaoComAFila = daFila.length === 0 ? '' : `
    union all
    select f.id_solicitacao, f.marca, f.numero_pedido, f.criado, true
    from (values ${daFila.join(',\n                 ')}) as f (id_solicitacao, marca, numero_pedido, criado)
    where not exists (select 1 from c where c.id_solicitacao = f.id_solicitacao)`;

    return `with c as (
    select distinct on (e.id_solicitacao)
           e.id_solicitacao,
           lower(btrim(e.marca)) as marca,
           e.payload ->> 'numero_pedido' as numero_pedido,
           e.payload ->> 'valor' as valor,
           e.payload ->> 'motivo' as motivo,
           nullif(btrim(e.payload ->> 'responsavel'), '') as responsavel,
           e.payload ->> 'criado_em' as criado_em,
           e.disparado_em
    from ${TABELA_RAW} e
    where ${filtros.join('\n      and ')}
    order by e.id_solicitacao, e.disparado_em desc, e.evento_id desc),
j as (
    select c.id_solicitacao, c.marca, c.numero_pedido, ${CRIADO_NA_RAW} as criado, false as da_fila
    from c${uniaoComAFila}),
o as (
    select j.*,
           row_number() over (partition by j.marca, regexp_replace(j.numero_pedido, '[^0-9]', '', 'g') order by ${ordem('j')}) = 1 as mais_recente
    from j${desde ? `\n    where j.criado collate "C" >= ${literalSql(desde)}` : ''}),
p as (
    select o.* from o
    order by ${ordem('o')}
    limit ${TAMANHO_DA_PAGINA} offset ${(pagina - 1) * TAMANHO_DA_PAGINA})
select t.total, p.id_solicitacao, p.marca, p.numero_pedido, p.criado, p.da_fila, p.mais_recente,
       c.valor, c.motivo, initcap(s.status) as status_execucao, c.responsavel, c.criado_em
from (select count(*) as total from o) t
left join p on true
left join c on c.id_solicitacao = p.id_solicitacao
${ULTIMO_STATUS}
order by ${ordem('p')}`;
}

function texto(valor: unknown): string | null {
    return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/** O valor chega como número ou, do payload (texto), como `59.9` ou `R$ 1.234,56`. A fila manda o mesmo. */
export function valorEmReais(valor: unknown): number | null {
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
    const limpo = typeof valor === 'string' ? valor.replace(/R\$\s*/i, '').trim() : '';
    if (!limpo) return null;
    const n = Number(limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo);
    return Number.isFinite(n) ? n : null;
}

/** São Paulo não tem horário de verão desde 2019: UTC−3 o ano todo. */
const SAO_PAULO_MS = -3 * 3600_000;

/** O `criado_em` (ISO) em hora de São Paulo, sem fuso, como a lista mostra a data (`dataSolicitacao`). */
export function dataEmSaoPaulo(criadoEm: string): string {
    const instante = Date.parse(criadoEm);
    return Number.isNaN(instante) ? criadoEm : new Date(instante + SAO_PAULO_MS).toISOString().slice(0, 19);
}

/** Uma linha da página. A da fila vem com o que o SQL sabe dela; valor, motivo e situação ficam com quem a passou. */
export interface LinhaDaPagina {
    solicitacao: SolicitacaoListada;
    daFila: boolean;
}

export interface PaginaDaLista {
    /** A lista inteira (raw + fila), não só a página */
    total: number;
    linhas: LinhaDaPagina[];
}

/**
 * Lê uma página da lista pelo Metabase. Linha de marca desconhecida fica de fora. Erro do Metabase sobe
 * (`MetabaseError`): quem chama decide a resposta.
 */
export async function listarPaginaDaRaw(filtro: FiltroSolicitacoes, opcoes: OpcoesDaLista): Promise<PaginaDaLista> {
    const resultado = await consultarDataMart(sqlDaListaDeSolicitacoes(filtro, opcoes));
    const total = Number(resultado[0]?.[0] ?? 0);
    const linhas = resultado.flatMap((linha): LinhaDaPagina[] => {
        const [, id, marcaNaLista, numeroPedido, criado, daFila, maisRecente, valor, motivo, status, responsavel, criadoEm] = linha;
        const marca = typeof marcaNaLista === 'string' ? marcaNaLista.trim().toLowerCase() : '';
        if (typeof id !== 'string' || !id || !Object.hasOwn(SIGLA_DA_MARCA, marca)) return [];
        return [{
            daFila: daFila === true,
            solicitacao: {
                idSolicitacao: id,
                tipo: filtro.tipo,
                marca: marca as SolicitacaoListada['marca'],
                numeroPedido: String(numeroPedido ?? ''),
                dataSolicitacao: dataEmSaoPaulo(String(criado ?? '')),
                valor: valorEmReais(valor),
                motivo: texto(motivo),
                statusExecucao: texto(status),
                responsavel: texto(responsavel),
                maisRecenteDoPedido: maisRecente === true,
                // Da raw, o do payload (o carimbo da planilha); da fila, o que ela mandou.
                criadoEm: daFila === true ? texto(criado) : texto(criadoEm),
                // Quem diz é a planilha (`comPresencaNaPlanilha`, na rota); a raw não sabe.
                naPlanilha: null,
                situacaoNaFila: null,
            },
        }];
    });
    return { total: Number.isFinite(total) ? total : 0, linhas };
}
