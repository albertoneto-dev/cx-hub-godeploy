import type { SupportedBrand } from '../../../shared/lib/constants';
import type { ResultadoFila } from '../../../shared/lib/fila/types';
import type { CasoDaLinha } from '../../../shared/lib/sheets/gravarLinha';
import type { RefundManagementCode, RefundManagementReason } from '../types/management';
import type { RefundManagementResult } from './refundAcesso';
import type { RefundGestaoDeps } from './refundGestaoDeps';
import {
    colunasDaExecucao,
    colunasDoReembolso,
    colunasQueFaltam,
    dataDaPlanilha,
    situacaoNaPlanilha,
    type SituacaoNaPlanilha,
} from './refundSheetColumns';
import type { CelulaDaPlanilha } from './refundSheetPort';

/**
 * O que a gestão do reembolso (`refundGold.ts`: cancelar e editar; `refundExecucao.ts`: concluir e sincronizar)
 * divide: o formato das respostas, o que fazer quando a fila do Metabase não aceita, a leitura do que o backoffice
 * marcou na planilha e a regra de "fila e planilha andam juntas" — a alteração vai à fila primeiro (ADR-012), e a
 * planilha só é tocada depois que a fila aceitou.
 *
 * ⚠️ Server-only — fora do barrel de `modules/reembolsos/actions`. Importe pelo caminho completo.
 */

export const LOG = '[Refund Management Direct]';

export function descreverErro(erro: unknown): string {
    return erro instanceof Error ? erro.message : String(erro);
}

export function falha(
    status: number,
    code: RefundManagementCode,
    message: string,
    reason?: RefundManagementReason,
): RefundManagementResult {
    return { status, body: reason ? { code, message, reason } : { code, message } };
}

/**
 * Faltou configuração (fila ou planilha) ⇒ `503`, antes de consultar qualquer coisa: a gestão altera o Metabase **e**
 * a planilha, e alterar só um lado é pior que não alterar (a mesma régua da criação, ADR-010). `null` = pode seguir.
 */
export function recusarSeFaltaConfiguracao(deps: RefundGestaoDeps, acao: string): RefundManagementResult | null {
    const falta = deps.configuracaoQueFalta();
    if (!falta) return null;
    console.error(`${LOG} ${falta} — recusando (${acao})`);
    return falha(503, 'UNKNOWN_ERROR', `Não foi possível ${acao} (${falta}) — nada foi alterado. Tente novamente.`);
}

/**
 * A fila do Metabase não aceitou a alteração: recusado, certamente não guardou; incerto, pode ter guardado.
 *
 * Repetir é seguro nos dois casos: a alteração repetida leva os mesmos campos, e a DAG aplica a mais recente, então
 * uma cópia que tenha chegado não muda o resultado. Com `planilhaAcompanha` (cancelar, editar e concluir), o incerto
 * avisa que a **planilha não foi atualizada** (ela só é tocada depois da fila) e que repetir a ação a reescreve.
 * Sincronizar não passa a opção: ele só lê a planilha, que já é a fonte.
 */
export function falhaDaGravacao(
    fila: Exclude<ResultadoFila, { status: 'enfileirado' }>,
    brand: SupportedBrand,
    referencia: string,
    opcoes: { planilhaAcompanha?: boolean } = {},
): RefundManagementResult {
    console.error(`${LOG} Alteração ${fila.status} na fila (${brand}, ${referencia}): ${fila.motivo}`);
    if (fila.status === 'recusado') {
        return falha(502, 'SHEETS_ERROR', `Não foi possível registrar a alteração (${fila.motivo}).`);
    }
    const planilha = opcoes.planilhaAcompanha ? ' A planilha não foi atualizada.' : '';
    return falha(
        504,
        'API_TIMEOUT',
        `Não deu para confirmar a entrada da alteração na fila do Metabase (${fila.motivo}).${planilha} Repita a ação: repetir não duplica a alteração.`,
    );
}

// ─── Ler a planilha: o que o backoffice marcou ───────────────────────

/** O que a planilha diz da execução do caso. */
export interface ExecucaoNaPlanilha {
    situacao: SituacaoNaPlanilha;
    /** `dd/mm/aaaa`, ou `null` quando a célula está vazia ou não é data. */
    data: string | null;
    /** Vazio quando ninguém preencheu. */
    responsavel: string;
}

/**
 * - `leitura`: a planilha não respondeu;
 * - `linha`: nenhuma linha da planilha tem o pedido e um carimbo a até 2 min do `criado_em` do caso;
 * - `coluna`: o cabeçalho não tem alguma das colunas de status, data e responsável (`faltando` diz quais).
 */
export type LeituraDaPlanilha =
    | { ok: true; execucao: ExecucaoNaPlanilha }
    | { ok: false; motivo: 'leitura' | 'linha' }
    | { ok: false; motivo: 'coluna'; faltando: string[] };

const texto = (celula: CelulaDaPlanilha | undefined): string =>
    celula === null || celula === undefined ? '' : String(celula).trim();

/**
 * O status, a data e o responsável que a linha do caso tem na planilha — a leitura que o sincronizar faz e que
 * cancelar, editar e concluir fazem antes da fila, para não passar por cima de um `Realizado` que o backoffice
 * já marcou. Nunca lança: o `motivo` diz por que não leu, e quem chama decide (o sincronizar responde o erro; os
 * outros seguem como se a planilha não dissesse nada). O log leva o id, nunca dado pessoal.
 */
export async function lerExecucaoDoCaso(
    deps: RefundGestaoDeps,
    brand: SupportedBrand,
    caso: CasoDaLinha,
): Promise<LeituraDaPlanilha> {
    const prazo = deps.prazoDaPlanilha();
    let cabecalho: CelulaDaPlanilha[] = [];
    let valores: CelulaDaPlanilha[] = [];
    let linha: number | null;
    try {
        linha = await deps.planilha.acharLinhaDoCaso(brand, caso, prazo);
        if (linha !== null) {
            cabecalho = await deps.planilha.lerCabecalho(brand, prazo);
            valores = await deps.planilha.lerLinha(brand, linha, prazo);
        }
    } catch (erro) {
        console.error(`${LOG} Falha ao ler a planilha (${brand}, ${caso.idSolicitacao}): ${descreverErro(erro)}`);
        return { ok: false, motivo: 'leitura' };
    }
    if (linha === null) {
        console.error(`${LOG} Linha do caso não achada na planilha (${brand}, ${caso.idSolicitacao})`);
        return { ok: false, motivo: 'linha' };
    }

    const colunas = colunasDoReembolso(cabecalho, brand);
    if (!colunas) {
        const faltando = colunasQueFaltam(cabecalho, brand, ['status', 'data', 'responsavel']);
        console.error(`${LOG} Cabeçalho sem coluna (${brand}): ${faltando.map((nome) => `"${nome}"`).join(', ')}`);
        return { ok: false, motivo: 'coluna', faltando };
    }

    return {
        ok: true,
        execucao: {
            situacao: situacaoNaPlanilha(valores[colunas.status]),
            data: dataDaPlanilha(valores[colunas.data]),
            responsavel: texto(valores[colunas.responsavel]),
        },
    };
}

/** A situação que a planilha marca, ou `null` quando não deu para ler (aí a planilha não diz nada). */
export const situacaoLida = (leitura: LeituraDaPlanilha): SituacaoNaPlanilha | null =>
    leitura.ok ? leitura.execucao.situacao : null;

/**
 * "A planilha vence": quem paga o reembolso marca na planilha, então um `Realizado` lá é a verdade sobre a execução,
 * mesmo que o Metabase diga outra coisa. A mensagem manda levá-lo ao Metabase pelo "Atualizar acompanhamento".
 */
export const PLANILHA_JA_REALIZADA =
    'A planilha já marca este reembolso como Realizado: nada foi alterado. Use "Atualizar acompanhamento" para levar o Realizado da planilha ao Metabase.';

export const trancadaPelaPlanilha = (): RefundManagementResult => falha(422, 'ALREADY_EXECUTED', PLANILHA_JA_REALIZADA);

// ─── Escrever na planilha, depois da fila ────────────────────────────

export type DesfechoDaPlanilha =
    | { ok: true }
    | { ok: false; reason: Extract<RefundManagementReason, 'SHEET_WRITE_FAILED' | 'SHEET_ROW_NOT_FOUND'>; detalhe: string };

/** O que reescrever na linha do caso, montado a partir do cabeçalho. `faltando` são os nomes de coluna que não existem. */
export interface AlteracoesDaLinha {
    alteracoes: { coluna: number; valor: CelulaDaPlanilha }[];
    faltando: string[];
}

/**
 * Reescreve células na linha do caso (achada pelo pedido e pelo carimbo, `casoNaPlanilha.ts`). Nunca lança: qualquer falha da planilha — fora do
 * ar, linha que não existe, coluna que não está no cabeçalho — vira um desfecho para a resposta avisar, porque a
 * alteração já está na fila e não pode ser desfeita por causa da planilha. O log leva o id, nunca dado pessoal.
 */
export async function atualizarLinhaDoCaso(
    deps: RefundGestaoDeps,
    brand: SupportedBrand,
    caso: CasoDaLinha,
    montar: (cabecalho: CelulaDaPlanilha[]) => AlteracoesDaLinha,
): Promise<DesfechoDaPlanilha> {
    const naoAtualizada = (reason: 'SHEET_WRITE_FAILED' | 'SHEET_ROW_NOT_FOUND', detalhe: string): DesfechoDaPlanilha => {
        console.error(`${LOG} Planilha não atualizada (${brand}, ${caso.idSolicitacao}): ${detalhe}`);
        return { ok: false, reason, detalhe };
    };

    const prazo = deps.prazoDaPlanilha();
    try {
        const linha = await deps.planilha.acharLinhaDoCaso(brand, caso, prazo);
        if (linha === null) return naoAtualizada('SHEET_ROW_NOT_FOUND', 'a linha do caso não está na planilha');

        const { alteracoes, faltando } = montar(await deps.planilha.lerCabecalho(brand, prazo));
        if (alteracoes.length > 0) {
            await deps.planilha.atualizarCelulas(brand, alteracoes.map((alteracao) => ({ linha, ...alteracao })), prazo);
        }
        if (faltando.length > 0) {
            const colunas = faltando.map((nome) => `"${nome}"`).join(', ');
            return naoAtualizada('SHEET_WRITE_FAILED', `o cabeçalho da planilha não tem a coluna ${colunas}`);
        }
        return { ok: true };
    } catch (erro) {
        console.error(`${LOG} Erro da planilha (${brand}, ${caso.idSolicitacao}): ${descreverErro(erro)}`);
        return naoAtualizada('SHEET_WRITE_FAILED', 'a planilha não respondeu');
    }
}

/**
 * A execução do reembolso nas colunas dela: o status e, quando há, a data e o responsável. Escreve as colunas que
 * existem e põe em `faltando` as que o cabeçalho não tem (só as que se queria escrever). Data e responsável que não
 * se conhecem (`null`) não são escritos, em vez de apagar o que a planilha já tem.
 */
export function alteracoesDaExecucao(
    cabecalho: CelulaDaPlanilha[],
    brand: SupportedBrand,
    execucao: { status: 'Realizado' | 'Cancelado'; data?: string | null; responsavel?: string | null },
): AlteracoesDaLinha {
    const colunas = colunasDaExecucao(cabecalho, brand);
    const alteracoes: AlteracoesDaLinha['alteracoes'] = [];
    const semColuna: ('status' | 'data' | 'responsavel')[] = [];

    const escrever = (campo: 'status' | 'data' | 'responsavel', valor: string | null | undefined) => {
        if (!valor) return;
        const coluna = colunas[campo];
        if (coluna === null) semColuna.push(campo);
        else alteracoes.push({ coluna, valor });
    };
    escrever('status', execucao.status);
    escrever('data', execucao.data);
    escrever('responsavel', execucao.responsavel);

    return { alteracoes, faltando: colunasQueFaltam(cabecalho, brand, semColuna) };
}

/**
 * `SUCCESS` quando a fila aceitou e a planilha mudou. Com a fila aceita e a planilha não, continua `SUCCESS` (a
 * alteração já vai ao Metabase), mas a mensagem e o `reason` dizem que a planilha precisa de ajuste à mão.
 */
export function sucessoComPlanilha(
    mensagem: string,
    feito: string,
    planilha: DesfechoDaPlanilha,
): RefundManagementResult {
    if (planilha.ok) return { status: 200, body: { code: 'SUCCESS', message: `${mensagem} ${NO_PROXIMO_LOTE}` } };
    return {
        status: 200,
        body: {
            code: 'SUCCESS',
            reason: planilha.reason,
            message: `${feito} na fila do Metabase, mas a planilha não foi atualizada (${planilha.detalhe}). Atualize a planilha à mão.`,
        },
    };
}

/** O que a resposta de sucesso diz do Metabase: a alteração está na fila, e o lote a leva (ADR-012). */
export const NO_PROXIMO_LOTE = 'O Metabase recebe no próximo lote (até 20 min).';

/**
 * O estado (raw + fila) já era o pedido e a planilha pode ter ficado para trás (uma tentativa anterior ficou
 * `incerto` na fila e não chegou a tocá-la): depois de reescrever a planilha, a trava `422` diz o que aconteceu com
 * ela. Com a planilha que não acompanhou, leva o `reason` e manda ajustar à mão.
 */
export function travaComAPlanilhaAcertada(
    trava: RefundManagementResult,
    planilha: DesfechoDaPlanilha,
    estado: 'Realizado' | 'Cancelado',
): RefundManagementResult {
    if (planilha.ok) {
        return { status: trava.status, body: { ...trava.body, message: `${trava.body.message} A planilha foi atualizada para ${estado}.` } };
    }
    return {
        status: trava.status,
        body: {
            ...trava.body,
            reason: planilha.reason,
            message: `${trava.body.message} A planilha não foi atualizada (${planilha.detalhe}): ajuste à mão.`,
        },
    };
}

// ─── Avisar no Chat ──────────────────────────────────────────────────

/** O que identifica a ação no aviso: nunca dado pessoal (a lista de campos do `AlertContext` não tem onde pôr). */
export interface ContextoDaAcao {
    brand: SupportedBrand;
    idSolicitacao: string;
    /** O pedido, quando já se conhece (cancelar e editar o recebem; concluir lê da raw). */
    numeroPedido?: string;
    /** Em português, como o agente chama a ação: `Cancelar reembolso`. */
    operacao: string;
}

/**
 * Quando a resposta carrega o `reason` de que a planilha não acompanhou (`SHEET_WRITE_FAILED` ou
 * `SHEET_ROW_NOT_FOUND`), avisa o Chat: é trabalho de quem mantém o sistema acertar a planilha ou cadastrar a coluna.
 * Um aviso por chamada, no máximo, e devolve a resposta como veio — **o aviso nunca altera o desfecho** (INV-06): o
 * `sendAlert` já não lança, e o `catch` daqui é redundante de propósito.
 */
export async function comAvisoDaPlanilha(
    deps: RefundGestaoDeps,
    contexto: ContextoDaAcao,
    resultado: RefundManagementResult,
): Promise<RefundManagementResult> {
    const reason = resultado.body.reason;
    if (reason !== 'SHEET_WRITE_FAILED' && reason !== 'SHEET_ROW_NOT_FOUND') return resultado;

    try {
        await deps.avisar({
            reason,
            motivo: `${contexto.operacao}: ${resultado.body.message}`,
            requestId: contexto.idSolicitacao,
            brand: contexto.brand,
            numeroPedido: contexto.numeroPedido,
            // A linha que não existe é causa agregada (fica um card por marca na janela); a escrita que falhou é por caso.
            agruparPor: reason === 'SHEET_ROW_NOT_FOUND' ? `reembolso/${contexto.brand}` : undefined,
        });
    } catch (erro) {
        console.error(`${LOG} Falha ao avisar (ignorada de propósito): ${descreverErro(erro)}`);
    }
    return resultado;
}
