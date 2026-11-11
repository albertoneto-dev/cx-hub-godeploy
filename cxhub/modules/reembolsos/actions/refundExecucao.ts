import type { SupportedBrand } from '../../../shared/lib/constants';
import type { AtualizacaoCxhub, CasoNaRaw } from '../../../shared/lib/airflow/index';
import { formatarDataSP } from '../../../shared/lib/format';
import type { CasoDaLinha } from '../../../shared/lib/sheets/gravarLinha';
import type { RefundExecutionRequest } from '../types/management';
import type { RefundManagementResult } from './refundAcesso';
import {
    LOG,
    alteracoesDaExecucao,
    atualizarLinhaDoCaso,
    comAvisoDaPlanilha,
    descreverErro,
    falha,
    falhaDaGravacao,
    NO_PROXIMO_LOTE,
    lerExecucaoDoCaso,
    recusarSeFaltaConfiguracao,
    situacaoLida,
    sucessoComPlanilha,
    travaComAPlanilhaAcertada,
    trancadaPelaPlanilha,
    type ContextoDaAcao,
} from './refundGestaoComum';
import type { RefundGestaoDeps } from './refundGestaoDeps';
import { dataDaPlanilha } from './refundSheetColumns';

/**
 * A execução do reembolso, que o backoffice marca só na planilha: o CX Hub leva esse estado ao Metabase, pela fila
 * (ADR-012), por dois caminhos, e os dois acham o caso pelo `idSolicitacao` que a lista devolve.
 *
 * - `concluirReembolso`: o agente marca o reembolso como pago pelo CX Hub. `Realizado` (data de hoje, no fuso de São
 *   Paulo, e o agente como responsável) vai à fila e, só depois de ela aceitar, a planilha acompanha.
 * - `sincronizarReembolso`: o que o backoffice já marcou na planilha (`Realizado` ou `Cancelado`) vai à fila.
 *
 * **A planilha vence** (ADR-010): quem paga o reembolso marca na planilha, então ela é a verdade sobre a execução. O
 * sincronizar leva `Realizado` ou `Cancelado` da planilha ao Metabase **mesmo que ele diga outra coisa**; e o
 * concluir não passa por cima de um `Realizado` que a planilha já tem.
 *
 * O id é amarrado ao que a rota espera: a raw ou a fila tem de ter a criação do caso, do tipo `REEMBOLSO` e da marca
 * do corpo. Id de outro tipo ou de outra marca responde `404`, sem enfileirar nada.
 *
 * ⚠️ Server-only — fora do barrel de `modules/reembolsos/actions`. Importe pelo caminho completo.
 */

const MENSAGEM_JA_REALIZADO = 'O reembolso já foi marcado como realizado: não dá para concluir de novo.';
const MENSAGEM_JA_CANCELADO = 'A solicitação já está cancelada: não dá para marcá-la como concluída.';
const MENSAGEM_REALIZADO_E_PLANILHA_CANCELADA =
    'O Metabase consta como Realizado, mas a planilha marca Cancelado: nada foi alterado. Use "Atualizar acompanhamento" para levar o Cancelado da planilha ao Metabase.';

const rotulo = (situacao: 'realizado' | 'cancelado'): 'Realizado' | 'Cancelado' =>
    situacao === 'realizado' ? 'Realizado' : 'Cancelado';

/**
 * O que acha a linha do caso na planilha: o pedido e o `criado_em` do caso (o carimbo da linha é esse mesmo
 * instante), e o id, que só o log e o aviso usam.
 */
const linhaDoCaso = (caso: CasoNaRaw): CasoDaLinha => ({
    idSolicitacao: caso.idSolicitacao,
    pedido: caso.numeroPedido,
    criadoEm: caso.criadoEm,
});

type CasoLido = { ok: true; caso: CasoNaRaw } | { ok: false; resultado: RefundManagementResult };

/**
 * Lê o caso (raw + fila) e confere que o id é de um reembolso da marca do corpo. Sem a criação do caso, de outro tipo
 * (reenvio, cancelamento) ou de outra marca ⇒ `404`, em vez de gravar numa solicitação que a rota não conhece.
 */
async function lerCaso(deps: RefundGestaoDeps, brand: SupportedBrand, idSolicitacao: string): Promise<CasoLido> {
    let caso: CasoNaRaw | null;
    try {
        caso = await deps.buscarCasoPorId(idSolicitacao);
    } catch (erro) {
        console.error(`${LOG} Falha ao consultar o caso (${brand}, ${idSolicitacao}): ${descreverErro(erro)}`);
        return { ok: false, resultado: falha(502, 'UNKNOWN_ERROR', 'Não foi possível consultar a solicitação. Nada foi alterado.') };
    }
    if (!caso || caso.tipo !== 'REEMBOLSO' || caso.marca !== brand) {
        console.error(
            `${LOG} Id sem reembolso desta marca na raw nem na fila (${brand}, ${idSolicitacao}): ${caso ? `é ${caso.tipo} de ${caso.marca}` : 'sem a criação do caso'}`,
        );
        return {
            ok: false,
            resultado: falha(404, 'NOT_FOUND', 'Nenhuma solicitação de reembolso com este id nesta marca. Nada foi alterado.'),
        };
    }
    return { ok: true, caso };
}

export async function concluirReembolso(
    pedido: RefundExecutionRequest,
    deps: RefundGestaoDeps,
): Promise<RefundManagementResult> {
    const { brand, idSolicitacao, handledBy } = pedido;

    const recusada = recusarSeFaltaConfiguracao(deps, 'concluir o reembolso');
    if (recusada) return recusada;

    const lido = await lerCaso(deps, brand, idSolicitacao);
    if (!lido.ok) return lido.resultado;
    const { caso } = lido;
    const contexto: ContextoDaAcao = {
        brand,
        idSolicitacao,
        numeroPedido: caso.numeroPedido || undefined,
        operacao: 'Concluir reembolso',
    };

    // A planilha vence: o que o backoffice marcou lá vale mais que o estado do Metabase. A leitura que falha não bloqueia.
    const naPlanilha = situacaoLida(await lerExecucaoDoCaso(deps, brand, linhaDoCaso(caso)));

    if (caso.status === 'realizado') {
        const trava = falha(422, 'ALREADY_EXECUTED', MENSAGEM_JA_REALIZADO);
        // Metabase e planilha concordam: nada a acertar.
        if (naPlanilha === 'realizado') return trava;
        // A planilha marca Cancelado: ela vence, e reescrever Realizado por cima desfaria o que o backoffice marcou.
        if (naPlanilha === 'cancelado') return falha(422, 'ALREADY_EXECUTED', MENSAGEM_REALIZADO_E_PLANILHA_CANCELADA);

        // O caso já está Realizado e a planilha ainda não: uma tentativa anterior ficou `incerto` na fila e não chegou a
        // tocar a planilha. Reescrever é idempotente (com a data e o responsável que o caso tem), e assim repetir conserta.
        const planilha = await atualizarLinhaDoCaso(deps, brand, linhaDoCaso(caso), (cabecalho) =>
            alteracoesDaExecucao(cabecalho, brand, {
                status: 'Realizado',
                data: dataDaPlanilha(caso.dataExecucao),
                responsavel: caso.responsavelExecucao,
            }),
        );
        return comAvisoDaPlanilha(deps, contexto, travaComAPlanilhaAcertada(trava, planilha, 'Realizado'));
    }
    if (naPlanilha === 'realizado') return trancadaPelaPlanilha();
    if (caso.status === 'cancelado') return falha(422, 'ALREADY_EXECUTED', MENSAGEM_JA_CANCELADO);

    const hoje = formatarDataSP(deps.agora());
    const fila = await deps.enfileirarAtualizacao(idSolicitacao, {
        status_execucao: 'Realizado',
        data_execucao: hoje,
        responsavel_execucao: handledBy,
    });
    if (fila.status !== 'enfileirado') return falhaDaGravacao(fila, brand, idSolicitacao, { planilhaAcompanha: true });

    // Escreve as colunas que existirem e avisa das que faltam, como a edição.
    const planilha = await atualizarLinhaDoCaso(deps, brand, linhaDoCaso(caso), (cabecalho) =>
        alteracoesDaExecucao(cabecalho, brand, { status: 'Realizado', data: hoje, responsavel: handledBy }),
    );

    console.log(`${LOG} Reembolso ${idSolicitacao} (${brand}) marcado como realizado por ${handledBy}`);
    return comAvisoDaPlanilha(deps, contexto, sucessoComPlanilha('Reembolso marcado como concluído.', 'Reembolso concluído', planilha));
}

const SEM_MUDANCA_NA_PLANILHA =
    'A planilha ainda não marca o reembolso como Realizado nem como Cancelado: nada para levar ao Metabase.';

export async function sincronizarReembolso(
    pedido: RefundExecutionRequest,
    deps: RefundGestaoDeps,
): Promise<RefundManagementResult> {
    const { brand, idSolicitacao, handledBy } = pedido;

    const recusada = recusarSeFaltaConfiguracao(deps, 'atualizar o acompanhamento');
    if (recusada) return recusada;

    const contexto: ContextoDaAcao = { brand, idSolicitacao, operacao: 'Atualizar acompanhamento do reembolso' };

    // O caso primeiro (raw + fila): é dele que vêm o pedido e o `criado_em` que acham a linha do caso na planilha (e o
    // tipo e a marca do id, que travam o 404).
    const lido = await lerCaso(deps, brand, idSolicitacao);
    if (!lido.ok) return lido.resultado;
    const { caso } = lido;

    const leitura = await lerExecucaoDoCaso(deps, brand, linhaDoCaso(caso));
    if (!leitura.ok) {
        // Não se altera nada sem a planilha, que aqui é a fonte.
        if (leitura.motivo === 'linha') {
            return comAvisoDaPlanilha(
                deps,
                contexto,
                falha(404, 'NOT_FOUND', 'A linha deste caso não está na planilha. Nada foi alterado.', 'SHEET_ROW_NOT_FOUND'),
            );
        }
        const message =
            leitura.motivo === 'coluna'
                ? `O cabeçalho da planilha não tem a coluna ${leitura.faltando.map((nome) => `"${nome}"`).join(', ')}. Nada foi alterado.`
                : 'Não foi possível ler a planilha. Nada foi alterado.';
        return falha(502, 'SHEETS_ERROR', message, 'SHEET_READ_FAILED');
    }

    // Só Realizado e Cancelado seguem. `Pendente` (e o texto livre da operação) nunca vai: a atualização mais
    // recente vence, e uma planilha atrasada desfaria um Realizado que o CX Hub acabou de enfileirar.
    const { situacao, data: dataNaPlanilha, responsavel } = leitura.execucao;
    if (situacao !== 'realizado' && situacao !== 'cancelado') {
        return { status: 200, body: { code: 'NO_CHANGE', message: SEM_MUDANCA_NA_PLANILHA } };
    }
    if (caso.status === situacao) {
        return { status: 200, body: { code: 'NO_CHANGE', message: `O Metabase já consta como ${rotulo(situacao)}: nada a atualizar.` } };
    }

    // A planilha vence: leva o que ela marca mesmo que o Metabase diga outra coisa (cancelado lá e Realizado na
    // planilha, ou o contrário), porque quem paga o reembolso marca lá.
    const atualizacao: AtualizacaoCxhub = { status_execucao: rotulo(situacao) };
    // Com Cancelado a DAG deixa a data vazia; data que não é data (vazia, texto livre) vai sem ela.
    const data = situacao === 'realizado' ? dataNaPlanilha : null;
    if (data) atualizacao.data_execucao = data;
    if (responsavel) atualizacao.responsavel_execucao = responsavel;

    const fila = await deps.enfileirarAtualizacao(idSolicitacao, atualizacao);
    // Sincronizar só lê a planilha: não há planilha a acertar se a fila não aceitou.
    if (fila.status !== 'enfileirado') return falhaDaGravacao(fila, brand, idSolicitacao);

    console.log(`${LOG} Reembolso ${idSolicitacao} (${brand}) sincronizado com a planilha por ${handledBy}: ${rotulo(situacao)}`);
    const detalhes = [data && `execução em ${data}`, responsavel && `por ${responsavel}`].filter(Boolean).join(' ');
    return {
        status: 200,
        body: {
            code: 'SUCCESS',
            message: `Acompanhamento atualizado: ${rotulo(situacao)}${detalhes ? ` (${detalhes})` : ''} foi para a fila do Metabase. ${NO_PROXIMO_LOTE}`,
        },
    };
}
