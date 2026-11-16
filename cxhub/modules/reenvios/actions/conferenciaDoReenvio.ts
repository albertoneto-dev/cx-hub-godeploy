import type { MarcaSemCosmosComPlanilha } from '../../../shared/lib/constants';
import {
    itensOriginaisDoReenvio,
    motivosDoNaoConferido,
    nfDiverge,
    notaDeNaoConferido,
    valorDaNfDeReenvio,
} from '../../../shared/lib/datamart/pedido';
import type { CampoConferido, Conferencia, MotivoPorCampo } from '../../../shared/lib/datamart/pedidoTipos';
import type { ResendSubmissionData } from '../types/index';

/**
 * O que a conferência do pedido no Data Mart muda no reenvio de Ápice, Yenzah e Denavita (ADR-018), antes da fila e da
 * planilha — em qualquer entrada (a tela, a Central de Tickets e o bot passam todos pelo `processResend`):
 * - **NF:** o Data Mart prova que o pedido não tem NF de venda (`ausente`) ⇒ recusa, nada é gravado; tem ⇒ vale a do
 *   Data Mart (a que veio de quem chamou, se difere, só vai para o log); não dá para afirmar (`desconhecida`: sem
 *   resposta, a NF ainda fora do Data Mart, o pedido cancelado no Tiny) ⇒ vale a que veio;
 * - **CD:** o do Data Mart, no lugar do que veio (a tela fixa ES na Ápice e na Yenzah, e ~9% da Ápice sai do RJ);
 * - **"Valor da NF de reenvio (R$)":** o calculado pelos itens originais (o substituto herda o preço, o mimo não entra);
 *   o Data Mart respondeu mas não dá para calcular ⇒ em branco, e o backoffice preenche. Na Ápice e na Yenzah a coluna é
 *   da operação, e o valor vai para ela junto com as fórmulas (`valorNaOperacao`); na Denavita é do formulário;
 * - o que não pôde ser conferido fica com o valor de quem chamou, e uma nota com o motivo vai na frente das observações:
 *   `[CD/NF NÃO CONFERIDOS: DATA MART SEM RESPOSTA]`, `[NF NÃO CONFERIDA: AINDA FORA DO DATA MART]`…
 */
export type ConferenciaDoReenvio =
    | { tipo: 'recusado'; mensagem: string }
    | {
        tipo: 'aplicado';
        data: ResendSubmissionData;
        /** O valor da coluna da operação "Valor da NF de reenvio (R$)" (Ápice e Yenzah), quando o servidor o calculou */
        valorNaOperacao: number | null;
        /** Para o log: a NF que veio de quem chamou e a do Data Mart, quando diferem */
        nfDivergente: { digitada: string; doDataMart: string } | null;
        /** Para o log: por que o valor ficou em branco */
        valorEmBranco: string | null;
        naoConferidos: CampoConferido[];
    };

/** Onde a planilha guarda o valor da NF de reenvio: no bloco da operação (Ápice, Yenzah) ou no formulário (Denavita). */
const VALOR_NA_OPERACAO: Record<MarcaSemCosmosComPlanilha, boolean> = { apice: true, yenzah: true, denavita: false };

/** Onde a NF de venda foi procurada, para a mensagem da recusa. */
const ONDE_A_NF_FOI_PROCURADA: Record<MarcaSemCosmosComPlanilha, string> = {
    apice: 'no Tiny nem na Intelipost',
    yenzah: 'na Intelipost',
    denavita: 'na Intelipost',
};

/** `39.24` → `'39,24'`: o formato do `valorReenvio` (o mesmo do `calculateResendValue`). */
function valorEmTexto(valor: number): string {
    return valor.toFixed(2).replace('.', ',');
}

/** A nota do que não foi conferido vai na frente das observações, como as notas do app antigo (`[CEP NÃO CONFERIDO…]`). */
function comNota(comentarios: string, naoConferidos: CampoConferido[], motivos: MotivoPorCampo = {}): string {
    return [notaDeNaoConferido(naoConferidos, motivos), comentarios].filter(Boolean).join(' | ');
}

export function aplicarConferenciaAoReenvio(
    marca: MarcaSemCosmosComPlanilha,
    data: ResendSubmissionData,
    conferencia: Conferencia,
): ConferenciaDoReenvio {
    if (conferencia.tipo === 'nao_se_aplica') {
        return { tipo: 'aplicado', data, valorNaOperacao: null, nfDivergente: null, valorEmBranco: null, naoConferidos: [] };
    }
    if (conferencia.tipo === 'nao_conferido') {
        const naoConferidos: CampoConferido[] = ['cd', 'nf', 'valor'];
        return {
            tipo: 'aplicado',
            data: { ...data, comentarios: comNota(data.comentarios, naoConferidos) },
            valorNaOperacao: null,
            nfDivergente: null,
            valorEmBranco: null,
            naoConferidos,
        };
    }

    const { contexto } = conferencia;
    if (contexto.nf.estado === 'ausente') {
        return {
            tipo: 'recusado',
            mensagem: `O pedido ${contexto.pedido} não tem NF de venda ${ONDE_A_NF_FOI_PROCURADA[marca]}: não dá para solicitar `
                + 'reenvio ainda. Nada foi registrado. Se a NF acabou de sair, ela pode levar algumas horas para chegar ao Data Mart.',
        };
    }

    const naoConferidos: CampoConferido[] = [];
    const novo: ResendSubmissionData = { ...data };
    let nfDivergente: { digitada: string; doDataMart: string } | null = null;

    if (contexto.nf.estado === 'achada' && contexto.nf.numero) {
        if (nfDiverge(data.numeroNF, contexto.nf.numero)) nfDivergente = { digitada: data.numeroNF, doDataMart: contexto.nf.numero };
        novo.numeroNF = contexto.nf.numero;
    } else {
        naoConferidos.push('nf');
    }

    if (contexto.cd.valor) novo.cdOrigem = contexto.cd.valor;
    else if (!contexto.cd.conferido) naoConferidos.push('cd');

    let valorNaOperacao: number | null = null;
    let valorEmBranco: string | null = null;
    const valor = valorDaNfDeReenvio(contexto, itensOriginaisDoReenvio(data));
    if (valor.tipo === 'calculado') {
        novo.valorReenvio = valorEmTexto(valor.valor);
        if (VALOR_NA_OPERACAO[marca]) valorNaOperacao = valor.valor;
    } else if (valor.tipo === 'em_branco') {
        novo.valorReenvio = '';
        valorEmBranco = valor.motivo;
    } else {
        naoConferidos.push('valor');
    }

    if (naoConferidos.length > 0) novo.comentarios = comNota(data.comentarios, naoConferidos, motivosDoNaoConferido(contexto));
    return { tipo: 'aplicado', data: novo, valorNaOperacao, nfDivergente, valorEmBranco, naoConferidos };
}
