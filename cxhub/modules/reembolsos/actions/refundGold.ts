import type { SupportedBrand } from '../../../shared/lib/constants';
import type { AtualizacaoCxhub } from '../../../shared/lib/airflow/index';
import type { CasoDaLinha } from '../../../shared/lib/sheets/gravarLinha';
import type { RefundCancelRequest, RefundUpdateRequest } from '../types/management';
import type { RefundManagementResult } from './refundAcesso';
import {
    LOG,
    alteracoesDaExecucao,
    atualizarLinhaDoCaso,
    comAvisoDaPlanilha,
    descreverErro,
    falha,
    falhaDaGravacao,
    lerExecucaoDoCaso,
    recusarSeFaltaConfiguracao,
    situacaoLida,
    sucessoComPlanilha,
    travaComAPlanilhaAcertada,
    trancadaPelaPlanilha,
    type AlteracoesDaLinha,
    type ContextoDaAcao,
} from './refundGestaoComum';
import type { RefundGestaoDeps } from './refundGestaoDeps';
import { colunasDaEdicao, colunasQueFaltam } from './refundSheetColumns';
import type { CelulaDaPlanilha } from './refundSheetPort';

/**
 * Cancelar e editar reembolso: a alteração vai à fila do Metabase (ADR-012), que o lote leva à gold, e depois à
 * planilha da marca (fila e planilha andam juntas). Os códigos e status são os que os antigos webhooks do n8n
 * devolviam (`NOT_FOUND`, `ALREADY_EXECUTED`, ...).
 *
 * A solicitação alterada é a mais recente do pedido (a régua da lista, `mais_recente`), lida da raw e da fila —
 * um caso de agora pode ainda estar na fila, esperando o lote. `Realizado` e `Cancelado` (com as atualizações que
 * ainda estão na fila por cima) travam, como o `acoesDoItem` da lista.
 *
 * **A planilha vence na execução** (ADR-010): quem paga o reembolso marca na planilha. Antes da fila, a gestão lê o
 * Status da linha do caso (a mesma leitura do sincronizar); se a planilha diz `Realizado`, a resposta é `422
 * ALREADY_EXECUTED` sem enfileirar nada, mesmo que o Metabase ainda não saiba. Planilha ilegível ou linha não achada
 * **não** bloqueia: segue como se ela não dissesse nada.
 *
 * A planilha só é escrita depois que a fila aceitou. Se ela falhar (fora do ar, linha ou coluna que não
 * existem), a resposta continua `SUCCESS` — a alteração já vai ao Metabase — e avisa no `message` e no `reason`, e o
 * Chat também.
 *
 * ⚠️ Server-only — fora do barrel de `modules/reembolsos/actions`. Importe pelo caminho completo.
 */

const MENSAGENS_DA_TRAVA = {
    realizado: 'O reembolso já foi executado: não dá mais para alterar.',
    cancelado: 'A solicitação mais recente deste pedido já está cancelada: não dá mais para alterar.',
};

export async function cancelarReembolsoNaGold(
    pedido: RefundCancelRequest,
    deps: RefundGestaoDeps,
): Promise<RefundManagementResult> {
    const resultado = await alterarNaGold(deps, pedido.brand, pedido.ecommerceOrderId, {
        operacao: 'Cancelar reembolso',
        acao: 'cancelar o reembolso',
        atualizacao: { status_execucao: 'Cancelado', responsavel_execucao: pedido.handledBy },
        mensagem: 'Reembolso cancelado.',
        feito: 'Reembolso cancelado',
        naPlanilha: (cabecalho) => alteracoesDaExecucao(cabecalho, pedido.brand, { status: 'Cancelado' }),
        // Já cancelada (uma tentativa anterior ficou `incerto` na fila e não chegou a tocar a planilha): repetir
        // reescreve o Cancelado antes de responder a trava.
        acertarPlanilhaSeJaNoEstado: 'Cancelado',
    });
    if (resultado.body.code === 'SUCCESS') {
        console.log(`${LOG} Reembolso do pedido ${pedido.ecommerceOrderId} (${pedido.brand}) cancelado por ${pedido.handledBy}`);
    }
    return resultado;
}

/**
 * Só valor e motivo. As observações não têm mais onde ficar: a gold não guarda texto livre e a planilha não é
 * mais o registro. O agente é avisado em vez de achar que salvou.
 */
export async function editarReembolsoNaGold(
    pedido: RefundUpdateRequest,
    deps: RefundGestaoDeps,
): Promise<RefundManagementResult> {
    const { refundAmount, refundReason, notes } = pedido.changes;
    const atualizacao: AtualizacaoCxhub = {};
    if (refundAmount !== undefined) atualizacao.valor = refundAmount;
    if (refundReason !== undefined) atualizacao.motivo = refundReason;
    if (Object.keys(atualizacao).length === 0) {
        return falha(422, 'INVALID_REQUEST', 'As observações não são mais guardadas: nada foi alterado.');
    }

    const aviso = notes === undefined ? '' : ' As observações não são mais guardadas.';
    const resultado = await alterarNaGold(deps, pedido.brand, pedido.ecommerceOrderId, {
        operacao: 'Editar reembolso',
        acao: 'editar o reembolso',
        atualizacao,
        mensagem: `Reembolso atualizado.${aviso}`,
        feito: 'Reembolso atualizado',
        naPlanilha: (cabecalho) => alteracoesDaEdicao(cabecalho, pedido),
    });
    if (resultado.body.code === 'SUCCESS') {
        const campos = Object.keys(pedido.changes).join(', ');
        console.log(`${LOG} Reembolso do pedido ${pedido.ecommerceOrderId} (${pedido.brand}) editado por ${pedido.handledBy}: ${campos}`);
    }
    return resultado;
}

/**
 * Valor e motivo nas colunas deles. O valor vai como **número** (`59.9`), que o Sheets mostra no formato da coluna;
 * o texto `'59,90'` ficaria como texto. Coluna que não existe vai em `faltando`.
 */
function alteracoesDaEdicao(cabecalho: CelulaDaPlanilha[], pedido: RefundUpdateRequest): AlteracoesDaLinha {
    const { refundAmount, refundReason } = pedido.changes;
    const colunas = colunasDaEdicao(cabecalho, pedido.brand);
    const alteracoes: AlteracoesDaLinha['alteracoes'] = [];
    const quais: ('valor' | 'motivo')[] = [];

    if (refundAmount !== undefined) {
        if (colunas.valor === null) quais.push('valor');
        else alteracoes.push({ coluna: colunas.valor, valor: refundAmount });
    }
    if (refundReason !== undefined) {
        if (colunas.motivo === null) quais.push('motivo');
        else alteracoes.push({ coluna: colunas.motivo, valor: refundReason });
    }
    return { alteracoes, faltando: colunasQueFaltam(cabecalho, pedido.brand, quais) };
}

interface AlteracaoDoReembolso {
    /** Como o agente chama a ação, para o aviso do Chat: `Cancelar reembolso`. */
    operacao: string;
    /** A ação no infinitivo, para a recusa por falta de configuração: `cancelar o reembolso`. */
    acao: string;
    atualizacao: AtualizacaoCxhub;
    /** A resposta quando a fila aceitou e a planilha mudou. */
    mensagem: string;
    /** O que já foi feito, no começo do aviso de que a planilha não acompanhou. */
    feito: string;
    /** O que reescrever na planilha, dado o cabeçalho. */
    naPlanilha: (cabecalho: CelulaDaPlanilha[]) => AlteracoesDaLinha;
    /**
     * O estado que o caso já pode ter quando a ação é repetida (só cancelar): nesse caso a planilha é reescrita antes
     * da trava `422`, porque uma tentativa anterior pode ter deixado o Metabase mudar e a planilha não.
     */
    acertarPlanilhaSeJaNoEstado?: 'Cancelado';
}

/**
 * Acha a solicitação, confere que não está travada (raw + fila e planilha), entrega a alteração à fila do Metabase
 * e só então leva à planilha. Nunca lança.
 */
async function alterarNaGold(
    deps: RefundGestaoDeps,
    brand: SupportedBrand,
    ecommerceOrderId: string,
    alteracao: AlteracaoDoReembolso,
): Promise<RefundManagementResult> {
    const recusada = recusarSeFaltaConfiguracao(deps, alteracao.acao);
    if (recusada) return recusada;

    let alvo;
    try {
        alvo = await deps.buscarReembolsoMaisRecente(brand, ecommerceOrderId);
    } catch (erro) {
        console.error(`${LOG} Falha ao consultar a solicitação (${brand}, ${ecommerceOrderId}): ${descreverErro(erro)}`);
        return falha(502, 'UNKNOWN_ERROR', 'Não foi possível consultar a solicitação. Nada foi alterado.');
    }

    if (!alvo) return falha(404, 'NOT_FOUND', 'Nenhuma solicitação de reembolso deste pedido.');
    // A linha dela na planilha se acha pelo pedido da solicitação e pelo `criado_em` do caso (ADR-010).
    const caso: CasoDaLinha = { idSolicitacao: alvo.idSolicitacao, pedido: alvo.numeroPedido, criadoEm: alvo.criadoEm };
    const contexto: ContextoDaAcao = {
        brand,
        idSolicitacao: alvo.idSolicitacao,
        numeroPedido: ecommerceOrderId,
        operacao: alteracao.operacao,
    };

    // Realizado: o dinheiro já voltou, e não há o que acertar na planilha.
    if (alvo.status === 'realizado') return falha(422, 'ALREADY_EXECUTED', MENSAGENS_DA_TRAVA.realizado);

    // A planilha vence: um Realizado marcado lá trava, mesmo com o Metabase ainda aberto ou cancelado.
    const leitura = await lerExecucaoDoCaso(deps, brand, caso);
    const naPlanilha = situacaoLida(leitura);
    if (naPlanilha === 'realizado') return trancadaPelaPlanilha();

    if (alvo.status === 'cancelado') {
        const trava = falha(422, 'ALREADY_EXECUTED', MENSAGENS_DA_TRAVA.cancelado);
        const estado = alteracao.acertarPlanilhaSeJaNoEstado;
        // A planilha já consta como cancelada, ou a ação não acerta planilha (editar): só a trava.
        if (!estado || naPlanilha === 'cancelado') return trava;
        const planilha = await atualizarLinhaDoCaso(deps, brand, caso, alteracao.naPlanilha);
        return comAvisoDaPlanilha(deps, contexto, travaComAPlanilhaAcertada(trava, planilha, estado));
    }

    const fila = await deps.enfileirarAtualizacao(alvo.idSolicitacao, alteracao.atualizacao);
    if (fila.status !== 'enfileirado') return falhaDaGravacao(fila, brand, ecommerceOrderId, { planilhaAcompanha: true });

    const planilha = await atualizarLinhaDoCaso(deps, brand, caso, alteracao.naPlanilha);
    return comAvisoDaPlanilha(deps, contexto, sucessoComPlanilha(alteracao.mensagem, alteracao.feito, planilha));
}
