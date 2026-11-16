import type { MarcaSemCosmosComPlanilha } from '../../../shared/lib/constants';
import { motivosDoNaoConferido, nfDiverge, notaDeNaoConferido } from '../../../shared/lib/datamart/pedido';
import type { CampoConferido, Conferencia, MotivoPorCampo } from '../../../shared/lib/datamart/pedidoTipos';
import { normalizarChavePix } from '../../../shared/lib/pix';
import type { RefundSubmissionData } from '../types/index';

/**
 * O que a conferência do pedido no Data Mart muda no reembolso de Ápice, Yenzah e Denavita (ADR-018), antes da fila e da
 * planilha, em qualquer entrada:
 * - **NF:** o Data Mart prova que o pedido não tem NF de venda (`ausente`) ⇒ recusa, nada é gravado; tem ⇒ vale a do
 *   Data Mart (a que veio, se difere, só vai para o log); não dá para afirmar (`desconhecida`: sem resposta, a NF ainda
 *   fora do Data Mart, o pedido cancelado no Tiny) ⇒ vale a que veio;
 * - **CD:** o do Data Mart, no lugar do que veio;
 * - o que não pôde ser conferido fica com o que veio, e a nota, com o motivo, vai na frente das observações. Só a
 *   planilha da Ápice tem a coluna "Observações" no reembolso: na Yenzah e na Denavita a nota fica só no log.
 */
export type ConferenciaDoReembolso =
    | { tipo: 'recusado'; mensagem: string }
    | {
        tipo: 'aplicado';
        data: RefundSubmissionData;
        /** Para o log: a NF que veio de quem chamou e a do Data Mart, quando diferem */
        nfDivergente: { digitada: string; doDataMart: string } | null;
        naoConferidos: CampoConferido[];
    };

const ONDE_A_NF_FOI_PROCURADA: Record<MarcaSemCosmosComPlanilha, string> = {
    apice: 'no Tiny nem na Intelipost',
    yenzah: 'na Intelipost',
    denavita: 'na Intelipost',
};

function comNota(notas: string | null, naoConferidos: CampoConferido[], motivos: MotivoPorCampo = {}): string {
    return [notaDeNaoConferido(naoConferidos, motivos), notas ?? ''].filter(Boolean).join(' | ');
}

export function aplicarConferenciaAoReembolso(
    marca: MarcaSemCosmosComPlanilha,
    data: RefundSubmissionData,
    conferencia: Conferencia,
): ConferenciaDoReembolso {
    if (conferencia.tipo === 'nao_se_aplica') return { tipo: 'aplicado', data, nfDivergente: null, naoConferidos: [] };
    if (conferencia.tipo === 'nao_conferido') {
        const naoConferidos: CampoConferido[] = ['cd', 'nf'];
        return { tipo: 'aplicado', data: { ...data, notes: comNota(data.notes, naoConferidos) }, nfDivergente: null, naoConferidos };
    }

    const { contexto } = conferencia;
    if (contexto.nf.estado === 'ausente') {
        return {
            tipo: 'recusado',
            mensagem: `O pedido ${contexto.pedido} não tem NF de venda ${ONDE_A_NF_FOI_PROCURADA[marca]}: não dá para solicitar `
                + 'reembolso ainda. Nada foi registrado. Se a NF acabou de sair, ela pode levar algumas horas para chegar ao Data Mart.',
        };
    }

    const naoConferidos: CampoConferido[] = [];
    const novo: RefundSubmissionData = { ...data };
    let nfDivergente: { digitada: string; doDataMart: string } | null = null;

    if (contexto.nf.estado === 'achada' && contexto.nf.numero) {
        if (nfDiverge(data.invoiceNumber, contexto.nf.numero)) nfDivergente = { digitada: data.invoiceNumber, doDataMart: contexto.nf.numero };
        novo.invoiceNumber = contexto.nf.numero;
    } else {
        naoConferidos.push('nf');
    }

    if (contexto.cd.valor) novo.originWarehouse = contexto.cd.valor;
    else if (!contexto.cd.conferido) naoConferidos.push('cd');

    if (naoConferidos.length > 0) novo.notes = comNota(data.notes, naoConferidos, motivosDoNaoConferido(contexto));
    return { tipo: 'aplicado', data: novo, nfDivergente, naoConferidos };
}

/**
 * A chave Pix do reembolso, em toda marca com planilha. **Nunca recusa por formato** (pedido da Maria, 16/11/2026:
 * "coletar chave Pix aceitando qualquer valor"): a Central de Tickets manda o texto como a agente digitou, sem tipo.
 * - vazia: `{ ok: true, chave: null }`, ou erro se a marca a exige (`obrigatoria`, que vem de fora: Ápice, Yenzah e
 *   Denavita com `CHAVE_PIX_OBRIGATORIA=on`);
 * - com `pixKeyType` e válida pelo tipo (ADR-018, `normalizarChavePix`): grava a normalizada, como outros clientes ainda
 *   mandam;
 * - em qualquer outro caso (sem tipo, tipo desconhecido, fora do formato): grava o texto com `trim()`, como veio.
 *
 * ⚠️ A chave é dado pessoal sensível: nem ela nem o erro (que não a repete) vão ao log aqui.
 */
export function chavePixDoReembolso(
    data: Pick<RefundSubmissionData, 'pixKey' | 'pixKeyType'>,
    obrigatoria: boolean,
): { ok: true; chave: string | null } | { ok: false; erro: string } {
    if (!String(data.pixKey ?? '').trim()) {
        return obrigatoria
            ? { ok: false, erro: 'Informe a chave Pix da cliente: o reembolso desta marca é pago por Pix.' }
            : { ok: true, chave: null };
    }
    const comoVeio = String(data.pixKey).trim();
    if (!String(data.pixKeyType ?? '').trim()) return { ok: true, chave: comoVeio };
    const chave = normalizarChavePix(data.pixKey, data.pixKeyType);
    return { ok: true, chave: chave.ok ? chave.chave : comoVeio };
}
