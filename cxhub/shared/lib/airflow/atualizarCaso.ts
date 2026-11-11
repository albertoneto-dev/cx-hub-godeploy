import { after } from '../../../../api/next-server';
import { sendAlert, type AlertReason } from '../alerts/index';
import { consultarDataMart, literalSql, metabaseConfigurado, MetabaseError } from '../metabase/index';
import { enfileirarAtualizacao, filaConfigurada, prazoDaFila } from '../fila/client';
import { SIGLA_DA_MARCA, TABELA_GOLD } from './gold';
import { esperar, tentarComRetentativa } from './retentativa';
import type { AlteracaoGold, LocalizadorCasoGold, TipoCasoCxhub } from './types';

/**
 * Leva à gold os cancelamentos e as edições de reenvio feitos pelo CX Hub no Cosmos — pela fila do Metabase
 * (ADR-012), que o lote leva ao modo `atualizacoes` da DAG `gobeaute_reenvio_reembolso_etl`.
 *
 * A DAG acha o caso pelo `id_solicitacao`, que nasce na criação e o CX Hub não guarda. Por isso, antes de
 * enfileirar, o id é lido de volta da própria gold pelo Metabase (`sqlDoCasoNaGold`). Duas regras: nunca atrasa
 * nem muda a resposta da alteração (roda no `after`), e falha não some (vira aviso no Chat).
 */

const LOG = '[Gold Reenvio/Reembolso]';
const SEM_ID = '(caso não achado na gold)';

const TIPO_LEGIVEL: Record<TipoCasoCxhub, string> = {
    REENVIO: 'Reenvio',
    REEMBOLSO: 'Reembolso',
    CANCELAMENTO: 'Cancelamento',
};

/**
 * SELECT que acha na gold o caso de uma alteração, ou `null` quando o localizador não tem como casar.
 *
 * O pedido é comparado só pelos dígitos: é o número da loja, o mesmo dentro de `SH9000106BB` e de
 * `#9000106`. Caso já cancelado fica de fora: cancelado é final, e o reenvio refeito é outro caso.
 */
export function sqlDoCasoNaGold(localizador: LocalizadorCasoGold): string | null {
    const sigla = SIGLA_DA_MARCA[localizador.marca];
    const numero = pedidoDoLocalizador(localizador).replace(/-R-\d+$/i, '').replace(/\D/g, '');
    if (!sigla || !numero) return null;

    const filtros = [
        `fonte = 'CX Hub'`,
        `tipo = ${literalSql(localizador.tipo)}`,
        `sigla = ${literalSql(sigla)}`,
        `regexp_replace(numero_pedido, '[^0-9]', '', 'g') = ${literalSql(numero)}`,
        `coalesce(status_execucao, '') <> 'Cancelado'`,
    ];
    const selecao = `select chave_unica from ${TABELA_GOLD} where `;

    if (localizador.tipo === 'REEMBOLSO') {
        // A mais recente do pedido: a mesma régua do n8n para achar a linha na planilha.
        return `${selecao}${filtros.join(' and ')} order by data_solicitacao desc limit 1`;
    }

    const criado = new Date(localizador.reenvioCriadoEm);
    if (Number.isNaN(criado.getTime())) return null;
    // A data_solicitacao é hora de Fortaleza, sem fuso. A janela é a do acompanhamento (o -R-n criado de 1 dia
    // antes a 30 dias depois da solicitação), vista do lado do -R-n; ganha o caso mais perto dele.
    const quando = `(timestamptz ${literalSql(criado.toISOString())} at time zone 'America/Fortaleza')`;
    filtros.push(
        `data_solicitacao > ${quando} - interval '30 days'`,
        `data_solicitacao <= ${quando} + interval '1 day'`,
    );
    return `${selecao}${filtros.join(' and ')} order by abs(extract(epoch from data_solicitacao - ${quando})) limit 1`;
}

/** O id do caso (a `chave_unica` sem o `cxhub|`), ou `null` quando nada casou. Erro do Metabase sobe. */
export async function buscarCasoNaGold(sql: string): Promise<string | null> {
    const chave = (await consultarDataMart(sql))[0]?.[0];
    if (typeof chave !== 'string' || !chave.startsWith('cxhub|')) return null;
    return chave.slice('cxhub|'.length) || null;
}

function pedidoDoLocalizador(localizador: LocalizadorCasoGold): string {
    return localizador.tipo === 'REENVIO' ? localizador.pedidoReenvio : localizador.numeroPedido;
}

function rotulo(alteracao: AlteracaoGold): string {
    return `${TIPO_LEGIVEL[alteracao.localizador.tipo]} ${alteracao.evento}`;
}

function transitorioMetabase(erro: unknown): boolean {
    return erro instanceof MetabaseError ? erro.transitorio : true;
}

function descreverErroMetabase(erro: unknown): string {
    if (erro instanceof MetabaseError) return erro.message.slice(0, 200);
    return erro instanceof Error ? erro.message : String(erro);
}

export interface AtualizarCasoDeps {
    esperar: (ms: number) => Promise<void>;
    agora: () => Date;
}

async function avisar(
    reason: Extract<AlertReason, 'GOLD_UPDATE_FAILED' | 'GOLD_UPDATE_NO_CASE'>,
    alteracao: AlteracaoGold,
    extra: { requestId: string; detalhe?: string; tentativas?: string },
): Promise<void> {
    try {
        await sendAlert({
            reason,
            motivo: `${rotulo(alteracao)} no CX Hub, mas a gold não foi atualizada`,
            // O id do caso, quando achado: é o que permite redisparar a atualização.
            requestId: extra.requestId,
            brand: alteracao.localizador.marca,
            numeroPedido: pedidoDoLocalizador(alteracao.localizador),
            detalhe: extra.detalhe,
            tentativas: extra.tentativas,
        });
    } catch (erroAviso) {
        console.error(`${LOG} Falha ao avisar (ignorada de propósito):`, erroAviso);
    }
}

/**
 * Acha o caso na gold e entrega a atualização à fila do Metabase. `true` = a fila aceitou. Nunca lança.
 */
export async function registrarAtualizacaoNaGold(
    alteracao: AlteracaoGold,
    deps: AtualizarCasoDeps = { esperar, agora: () => new Date() },
): Promise<boolean> {
    const descricao = `${rotulo(alteracao)} ${pedidoDoLocalizador(alteracao.localizador)}`;
    const sql = sqlDoCasoNaGold(alteracao.localizador);
    if (!sql) {
        console.warn(`${LOG} ${descricao}: sem número de pedido ou data para achar o caso na gold`);
        await avisar('GOLD_UPDATE_NO_CASE', alteracao, { requestId: SEM_ID, detalhe: 'pedido sem número ou data ilegível' });
        return false;
    }

    const busca = await tentarComRetentativa(
        () => buscarCasoNaGold(sql),
        transitorioMetabase,
        deps.esperar,
        (erro, tentativa) => console.warn(`${LOG} ${descricao}: consulta ${tentativa} ao Metabase falhou: ${descreverErroMetabase(erro)}`),
    );
    if (!busca.ok) {
        console.error(`${LOG} ${descricao}: desistindo de achar o caso na gold — avisando no Chat`);
        await avisar('GOLD_UPDATE_FAILED', alteracao, {
            requestId: SEM_ID,
            detalhe: `Metabase: ${descreverErroMetabase(busca.erro)}`,
            tentativas: transitorioMetabase(busca.erro)
                ? `${busca.tentativas} consultas, com espera entre elas`
                : 'nenhuma retentativa: o Metabase recusou a consulta',
        });
        return false;
    }
    if (!busca.valor) {
        console.warn(`${LOG} ${descricao}: nenhum caso do CX Hub na gold casou com o pedido`);
        await avisar('GOLD_UPDATE_NO_CASE', alteracao, { requestId: SEM_ID });
        return false;
    }

    const id = busca.valor;
    // A retentativa do transitório já está no `enfileirarAtualizacao` (a fila é idempotente por `id_atualizacao`).
    const fila = await enfileirarAtualizacao(id, alteracao.atualizacao, prazoDaFila(), deps.agora());
    if (fila.status === 'enfileirado') {
        console.log(`${LOG} ${descricao}: atualização de ${id} na fila do Metabase`);
        return true;
    }

    console.error(`${LOG} ${descricao}: a fila não aceitou a atualização de ${id} (${fila.status}) — avisando no Chat`);
    await avisar('GOLD_UPDATE_FAILED', alteracao, {
        requestId: id,
        detalhe: `fila do Metabase: ${fila.motivo}`,
        tentativas: fila.status === 'incerto' ? '2 tentativas: pode ter chegado à fila' : 'nenhuma: a fila recusou',
    });
    return false;
}

/**
 * O que as rotas de cancelar e editar chamam quando a alteração foi confirmada. `null` (nada a levar) não faz
 * nada. Sem `CXHUB_FILA_*` ou sem `METABASE_*` no ambiente, a atualização fica desligada, sem erro.
 */
export function agendarAtualizacaoNaGold(alteracao: AlteracaoGold | null): void {
    if (!alteracao) return;
    if (!filaConfigurada() || !metabaseConfigurado()) {
        console.info(`${LOG} CXHUB_FILA_* ou METABASE_* ausente — ${rotulo(alteracao)} não vai para a gold`);
        return;
    }
    try {
        after(() => registrarAtualizacaoNaGold(alteracao));
    } catch (erro) {
        // `after` só falha fora do escopo de uma requisição. Atualizar sem esperar ainda é melhor que perder.
        console.warn(`${LOG} after() indisponível (${erro instanceof Error ? erro.message : String(erro)}) — atualizando sem esperar`);
        void registrarAtualizacaoNaGold(alteracao);
    }
}
