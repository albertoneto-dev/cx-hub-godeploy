import type { AtualizacaoCxhub, CasoCxhub, TipoCasoCxhub } from '../airflow/types';
import type { MarcaCxHub } from '../constants';
import { lerNumeroDaLoja, mesmoPedido } from '../pedido/numeroDaLoja';
import { casoNoRegistro, type EstadoDeps } from './estado';

/**
 * A solicitação da tela que não deu certo também fica registrada (decisão deste app em 2026-11-27, depois da Black: o
 * Cosmos lento barrou reenvios sem deixar rastro). O caso vai à fila com `automacao=false` e uma atualização que diz o
 * desfecho, e a linha vai à planilha com o status e a causa. A nova tentativa manda o `idSolicitacao` da que falhou e
 * reescreve o mesmo caso e a mesma linha (uma linha por pedido).
 *
 * ⚠️ Server-only: fala com a fila.
 */

const LOG = '[Sem execução]';

/**
 * A trava (`REGISTRAR_FALHA_DA_TELA=on`), desligada por padrão: a Central de Tickets precisa mandar o `idSolicitacao` na
 * nova tentativa antes, senão cada tentativa vira uma linha. Lida a cada chamada, para ligar e desligar sem deploy.
 */
export function registrarFalhaDaTela(): boolean {
    return (process.env.REGISTRAR_FALHA_DA_TELA ?? '').trim().toLowerCase() === 'on';
}

/**
 * O `responsavel_execucao` do caso registrado sem execução. A DAG só aceita Realizado, Cancelado e Pendente no status, e
 * é este responsável que separa o "não realizado" de um cancelamento de verdade (e libera a nova tentativa).
 */
export const RESPONSAVEL_SEM_EXECUCAO = 'CX Hub';

/**
 * - `nao_realizado`: com certeza nada foi feito. Vai `Cancelado`: o dedup libera o pedido, os indicadores o deixam fora
 *   e o backoffice trava a linha.
 * - `a_conferir`: o Cosmos não respondeu depois do `POST /resend`, e o reenvio pode existir. Vai `Pendente`: o dbt casa
 *   o `-R-n` do Cosmos e o caso vira Realizado sozinho se o reenvio foi criado (Cancelado impediria o casamento).
 */
export type DesfechoSemExecucao = 'nao_realizado' | 'a_conferir';

export interface SemExecucao {
    desfecho: DesfechoSemExecucao;
    /** O status da linha na planilha, ex.: "Reenvio não realizado (erro de comunicação com o Cosmos)" */
    status: string;
    /** O que a agente faz com a linha, que vai nos comentários junto do status */
    proximoPasso: string;
}

/** A atualização que marca o caso como registrado sem execução. */
export function execucaoDoSemExecucao(desfecho: DesfechoSemExecucao): AtualizacaoCxhub {
    return {
        status_execucao: desfecho === 'a_conferir' ? 'Pendente' : 'Cancelado',
        responsavel_execucao: RESPONSAVEL_SEM_EXECUCAO,
    };
}

/** A nota que vai nos comentários (reenvio) ou nas observações (reembolso) da linha. */
export function notaDoSemExecucao(sem: SemExecucao): string {
    return `[CXHub] ${sem.status}: ${sem.proximoPasso}`;
}

/** A tentativa anterior que a nova reescreve: o id e o `criado_em` (que também é o carimbo da linha). */
export interface TentativaAnterior {
    idSolicitacao: string;
    criadoEm: Date;
}

const ID_VALIDO = /^[A-Za-z0-9-]{1,64}$/;

/**
 * A tentativa anterior que pode ser refeita: o caso desse id, do mesmo tipo, marca e pedido, que o CX Hub registrou sem
 * execução. Qualquer outra coisa (id que não existe, de outro pedido, ou de um caso que já deu certo) é `null`, e a
 * solicitação segue como nova, com o dedup de sempre: o id vem da tela, e nunca pula o dedup de outro caso. Erro de
 * leitura sobe, como no dedup.
 */
export async function tentativaSemExecucao(
    idSolicitacao: string | undefined,
    tipo: TipoCasoCxhub,
    marca: MarcaCxHub,
    pedido: string,
    deps?: EstadoDeps,
): Promise<TentativaAnterior | null> {
    if (!idSolicitacao || !ID_VALIDO.test(idSolicitacao)) return null;
    const caso = await casoNoRegistro(idSolicitacao, deps);
    const valido = caso !== null
        && caso.tipo.toUpperCase() === tipo
        && caso.marca.toLowerCase() === marca
        && mesmoPedido(caso.numeroPedido, lerNumeroDaLoja(pedido, marca))
        && ['cancelado', 'pendente'].includes(caso.status)
        && (caso.responsavelExecucao ?? '').trim().toLowerCase() === RESPONSAVEL_SEM_EXECUCAO.toLowerCase()
        && !Number.isNaN(caso.criadoEm.getTime());
    if (!valido) {
        console.warn(`${LOG} ${idSolicitacao} não é uma tentativa sem execução de ${tipo} ${marca} ${pedido}: segue como solicitação nova`);
        return null;
    }
    return { idSolicitacao: caso.idSolicitacao, criadoEm: caso.criadoEm };
}

/**
 * A atualização que leva o caso de agora por cima do caso da tentativa anterior: os campos dele (a DAG ignora a
 * identidade e o `automacao` na atualização) e a `execucao`.
 */
export function atualizacaoDoCaso(caso: CasoCxhub, execucao: AtualizacaoCxhub | null): AtualizacaoCxhub {
    const { id_solicitacao: _id, tipo: _tipo, marca: _marca, criado_em: _criado, numero_pedido: _pedido, automacao: _auto, ...campos } = caso;
    return { ...campos, ...execucao };
}
