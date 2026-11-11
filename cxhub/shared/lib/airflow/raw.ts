import type { MarcaCxHub } from '../constants';
import { consultarDataMart, literalSql } from '../metabase/index';
import type { TipoCasoCxhub } from './types';

/**
 * Leituras da raw de eventos do CX Hub pelo Metabase (ADR-008): o dedup de 24h, o reembolso mais recente de um
 * pedido e um caso pelo id (tipo, marca e status). A raw, e não a gold, porque é ela que recebe o evento quando o
 * run da DAG termina — a gold só é montada de hora em hora (`gobeaute_reenvio_reembolso_dbt`). Ainda assim há o
 * atraso da réplica do Data Mart (minutos): duas solicitações iguais dentro dele passam.
 *
 * Uma linha da raw é um item do `conf`: `tipo_evento = 'caso'` (criação) ou `'atualizacao'`. Tipo e número do
 * pedido só existem no `payload` (jsonb). Só entram valores montados no código (tipo, marca, dígitos do pedido).
 */

export const TABELA_RAW = 'raw.cxhub_reenvio_reembolso_eventos';

const digitos = (pedido: string) => pedido.replace(/\D/g, '');

/**
 * O status de execução mais recente de cada caso, a partir das atualizações (a criação não traz status). Com
 * `comExecucao`, traz também a data e o responsável que essa mesma atualização levou (`null` quando não vieram).
 *
 * No lote (ADR-012) as atualizações de um caso dividem o mesmo run e o mesmo `disparado_em`: quem as ordena é o
 * `atualizado_em` do payload, que o CX Hub grava com `toISOString()` (tamanho fixo, em UTC, então a ordem do texto é a
 * do tempo). As de antes do lote não o têm e são todas mais antigas: ficam por último, na ordem do `disparado_em`.
 */
function ultimoStatus(comExecucao = false): string {
    return `left join lateral (
    select lower(btrim(u.payload ->> 'status_execucao')) as status${comExecucao
        ? `,
           nullif(btrim(u.payload ->> 'data_execucao'), '') as data_execucao,
           nullif(btrim(u.payload ->> 'responsavel_execucao'), '') as responsavel_execucao`
        : ''}
    from ${TABELA_RAW} u
    where u.id_solicitacao = c.id_solicitacao
      and u.tipo_evento = 'atualizacao'
      and (u.payload -> 'status_execucao') is not null
    order by u.payload ->> 'atualizado_em' desc nulls last, u.disparado_em desc, u.evento_id desc
    limit 1
  ) s on true`;
}

export const ULTIMO_STATUS = ultimoStatus();

function criacoesDoPedido(
    tipo: TipoCasoCxhub,
    marca: MarcaCxHub,
    numero: string,
    janela24h: boolean,
    comCriadoEm = false,
): string {
    return `select distinct on (e.id_solicitacao)
           e.id_solicitacao,
           e.payload ->> 'numero_pedido' as numero_pedido,
           nullif(btrim(e.payload ->> 'responsavel'), '') as responsavel,
           e.disparado_em${comCriadoEm ? `,
           e.payload ->> 'criado_em' as criado_em` : ''}
    from ${TABELA_RAW} e
    where e.tipo_evento = 'caso'${janela24h
        // `_loaded_at` tem índice e é sempre depois de `disparado_em`: corta a tabela antes do filtro real.
        ? `
      and e._loaded_at >= now() - interval '25 hours'
      and e.disparado_em >= now() - interval '24 hours'`
        : ''}
      and upper(btrim(e.payload ->> 'tipo')) = ${literalSql(tipo)}
      and lower(btrim(e.marca)) = ${literalSql(marca)}
      and regexp_replace(e.payload ->> 'numero_pedido', '[^0-9]', '', 'g') = ${literalSql(numero)}
    order by e.id_solicitacao, e.disparado_em desc, e.evento_id desc`;
}

/**
 * Solicitação do mesmo tipo, marca e pedido (comparado pelos dígitos) aberta nas últimas 24h e não cancelada:
 * refazer depois de cancelar é abrir outro caso, como o guia da DAG trata.
 */
export function sqlDaSolicitacaoRecente(tipo: TipoCasoCxhub, marca: MarcaCxHub, pedido: string): string {
    return `with c as (${criacoesDoPedido(tipo, marca, digitos(pedido), true)})
select c.numero_pedido, c.responsavel,
       to_char(c.disparado_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as solicitado_em,
       c.id_solicitacao
from c
${ULTIMO_STATUS}
where s.status is distinct from 'cancelado'
order by c.disparado_em desc
limit 1`;
}

export interface SolicitacaoRecente {
    /** O caso que barra a nova: com ele se confere se há um cancelamento ainda na fila (ADR-012) */
    idSolicitacao: string;
    pedido: string;
    responsavel: string;
    /** ISO 8601 */
    solicitadoEm: string;
}

/** A solicitação que faz o dedup barrar a nova, ou `null`. Pedido sem dígito não é consultado. Erro do Metabase sobe. */
export async function buscarSolicitacaoRecente(
    tipo: TipoCasoCxhub,
    marca: MarcaCxHub,
    pedido: string,
): Promise<SolicitacaoRecente | null> {
    if (!digitos(pedido)) return null;
    const [linha] = await consultarDataMart(sqlDaSolicitacaoRecente(tipo, marca, pedido));
    if (!linha) return null;
    const [numero, responsavel, solicitadoEm, id] = linha;
    return {
        idSolicitacao: String(id ?? ''),
        pedido: String(numero ?? ''),
        responsavel: String(responsavel ?? ''),
        solicitadoEm: String(solicitadoEm ?? ''),
    };
}

/** O reembolso mais recente do pedido (pela criação), com o status de execução atual. */
export function sqlDoReembolsoMaisRecente(marca: MarcaCxHub, pedido: string): string {
    return `with c as (${criacoesDoPedido('REEMBOLSO', marca, digitos(pedido), false, true)}),
alvo as (select * from c order by disparado_em desc limit 1)
select c.id_solicitacao, c.numero_pedido, coalesce(s.status, 'aberto') as status_execucao, c.criado_em
from alvo c
${ULTIMO_STATUS}`;
}

/**
 * O `criado_em` do caso, como o CX Hub o gravou (ISO 8601): é o instante que também é o carimbo da linha na planilha.
 * Texto que não é data vira uma `Date` inválida (`NaN`), e a busca da linha na planilha a trata como "sem linha".
 */
const criadoEmDoCaso = (valor: unknown): Date => new Date(String(valor ?? '').trim());

export interface ReembolsoNaRaw {
    idSolicitacao: string;
    numeroPedido: string;
    /** `realizado`, `cancelado`, `pendente` ou `aberto` (nenhuma atualização de status) */
    status: string;
    /** O `criado_em` do caso: com o pedido, é o que acha a linha dele na planilha */
    criadoEm: Date;
}

/** `null` quando o pedido não tem reembolso registrado pelo CX Hub. Erro do Metabase sobe. */
export async function buscarReembolsoMaisRecente(marca: MarcaCxHub, pedido: string): Promise<ReembolsoNaRaw | null> {
    if (!digitos(pedido)) return null;
    const [linha] = await consultarDataMart(sqlDoReembolsoMaisRecente(marca, pedido));
    if (!linha) return null;
    const [id, numero, status, criadoEm] = linha;
    return {
        idSolicitacao: String(id ?? ''),
        numeroPedido: String(numero ?? ''),
        status: String(status ?? 'aberto'),
        criadoEm: criadoEmDoCaso(criadoEm),
    };
}

/**
 * Um caso pelo id: o evento de criação (tipo, marca e pedido, que amarram o id ao que a rota espera) e o status de
 * execução mais recente, com a data e o responsável que essa atualização levou. Id que a raw não conhece não
 * devolve linha. Nada de `?` do jsonb: o `(payload -> 'campo') is not null` do `ultimoStatus` é o mesmo teste sem
 * o operador que o JDBC do Metabase leria como parâmetro.
 */
export function sqlDoCasoPorId(idSolicitacao: string): string {
    return `with c as (
    select e.id_solicitacao,
           upper(btrim(e.payload ->> 'tipo')) as tipo,
           lower(btrim(e.marca)) as marca,
           e.payload ->> 'numero_pedido' as numero_pedido,
           e.payload ->> 'criado_em' as criado_em
    from ${TABELA_RAW} e
    where e.id_solicitacao = ${literalSql(idSolicitacao)}
      and e.tipo_evento = 'caso'
    order by e.disparado_em desc, e.evento_id desc
    limit 1)
select c.id_solicitacao, c.tipo, c.marca, c.numero_pedido, c.criado_em,
       coalesce(s.status, 'aberto') as status_execucao, s.data_execucao, s.responsavel_execucao
from c
${ultimoStatus(true)}`;
}

export interface CasoNaRaw {
    idSolicitacao: string;
    /** `REENVIO`, `REEMBOLSO` ou `CANCELAMENTO` (em maiúsculas) */
    tipo: string;
    /** Em minúsculas, como a raw guarda (`lescent`) */
    marca: string;
    numeroPedido: string;
    /** O `criado_em` do caso: com o pedido, é o que acha a linha dele na planilha */
    criadoEm: Date;
    /** `realizado`, `cancelado`, `pendente` ou `aberto` (nenhuma atualização de status) */
    status: string;
    /** A data e o responsável que a atualização de status mais recente levou, quando levou */
    dataExecucao: string | null;
    responsavelExecucao: string | null;
}

/** `null` quando a raw não tem a criação desse id. Erro do Metabase sobe. */
export async function buscarCasoPorId(idSolicitacao: string): Promise<CasoNaRaw | null> {
    const [linha] = await consultarDataMart(sqlDoCasoPorId(idSolicitacao));
    if (!linha) return null;
    const [id, tipo, marca, numero, criadoEm, status, data, responsavel] = linha;
    const texto = (valor: unknown): string | null => {
        const limpo = valor === null || valor === undefined ? '' : String(valor).trim();
        return limpo || null;
    };
    return {
        idSolicitacao: String(id ?? ''),
        tipo: String(tipo ?? '').trim().toUpperCase(),
        marca: String(marca ?? '').trim().toLowerCase(),
        numeroPedido: String(numero ?? ''),
        criadoEm: criadoEmDoCaso(criadoEm),
        status: String(status ?? '').trim().toLowerCase() || 'aberto',
        dataExecucao: texto(data),
        responsavelExecucao: texto(responsavel),
    };
}
