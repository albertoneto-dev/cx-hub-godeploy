import type { MarcaComPlanilha, MarcaSemCosmosComPlanilha } from '../../../shared/lib/constants';
import { somarDiasUteis } from '../../../shared/lib/format';
import type { SheetCell } from '../../../shared/lib/sheets/index';
import type { RefundSubmissionData } from '../types/index';

/**
 * Linha da planilha de reembolso — transcrição do workflow `[PROD] - Webhook Refund CXHub`: o node
 * "Sheets Interface" (que dava nome às colunas) vira `prepararReembolso`, e os code nodes `Build <Marca> Row`
 * viram `buildRefundRow`. `null` é coluna que o n8n pulava.
 *
 * Paridade deliberada (ADR-007, "migrar igual, corrigir depois"), inclusive no que parece errado:
 * - "Pedido será devolvido para a operação?" sai do `isFullRefund`, não do `requiresReturn`;
 * - a Kokeshi não tem coluna de lote, e a Rituária não tem a de devolução.
 *
 * O carimbo é o `criado_em` do caso (o mesmo instante que vai para a gold), formatado por quem monta a linha: é por ele e
 * pelo pedido que o CX Hub acha esta linha depois (`casoNaPlanilha.ts`, ADR-010).
 */

export interface RefundRowSource {
    carimbo: string;
    responsavel: string;
    origem: string;
    idAtendimento: string;
    cdOrigem: string;
    nomeCliente: string;
    numeroNF: string;
    lote: string | null;
    numeroPedido: string;
    valor: number | null;
    motivo: string;
    escopo: string;
    devolvido: 'Sim' | 'Não';
    ticketTransportadora: string | null;
    transportadora: string;
    statusPedido: string;
    pedidoCompleto: 'Sim' | 'Não';
    observacoes: string | null;
    excecaoPolitica: 'Sim' | 'Não';
    chaveNF: string;
    /**
     * "Pedido será devolvido para a operação?" como a agente respondeu (`requiresReturn`). Só as marcas sem Cosmos usam
     * (ADR-013): as 6 do Cosmos seguem o `devolvido` do n8n.
     */
    devolucaoInformada: 'Sim' | 'Não';
    /** Só nas marcas sem Cosmos (ADR-013). Dado pessoal sensível: nunca vai ao log (`COLUNA_DA_CHAVE_PIX`). */
    chavePix: string | null;
}

function numero(valor: unknown): number | null {
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
    if (typeof valor === 'string' && valor.trim() !== '' && Number.isFinite(Number(valor))) return Number(valor);
    return null;
}

/** O node "Sheets Interface": nomeia cada coluna e aplica as poucas regras que o n8n tinha. */
export function prepararReembolso(data: RefundSubmissionData, carimbo: string): RefundRowSource {
    const completo = data.isFullRefund === true ? 'Sim' : 'Não';
    return {
        carimbo,
        responsavel: data.handledBy,
        origem: data.sourceChannel,
        idAtendimento: data.supportTicketId,
        cdOrigem: data.originWarehouse,
        nomeCliente: data.customerName,
        numeroNF: data.invoiceNumber,
        lote: data.batchNumber,
        numeroPedido: data.ecommerceOrderId,
        valor: numero(data.refundAmount),
        motivo: data.refundReason,
        escopo: data.refundScope,
        devolvido: completo,
        ticketTransportadora: data.carrierTicketId,
        transportadora: data.carrierName,
        statusPedido: data.orderStatus,
        pedidoCompleto: completo,
        observacoes: data.notes,
        // O Bot nunca reembolsa como exceção — mesmo que o campo venha `true`.
        excecaoPolitica: data.handledBy !== 'Bot' && data.policyException === true ? 'Sim' : 'Não',
        chaveNF: data.nfeAccessKey,
        devolucaoInformada: data.requiresReturn === true ? 'Sim' : 'Não',
        chavePix: data.pixKey?.trim() || null,
    };
}

const v = (valor: string | number | null | undefined): SheetCell => valor ?? null;

const BUILDERS: Record<MarcaComPlanilha, (s: RefundRowSource) => SheetCell[]> = {
    lescent: (s) => [
        v(s.carimbo), v(s.responsavel), v(s.nomeCliente), v(s.motivo), v(s.numeroPedido), v(s.escopo), null,
        v(s.origem), v(s.idAtendimento), v(s.valor), v(s.cdOrigem), v(s.numeroNF), v(s.chaveNF),
        v(s.transportadora), v(s.statusPedido), v(s.lote), v(s.devolvido), v(s.ticketTransportadora),
        v(s.observacoes), v(s.pedidoCompleto), v(s.excecaoPolitica),
    ],
    bysamia: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.origem), v(s.idAtendimento), v(s.cdOrigem), v(s.nomeCliente),
        v(s.numeroNF), v(s.chaveNF), v(s.numeroPedido), null, v(s.valor), null, v(s.motivo), v(s.lote),
        v(s.transportadora), v(s.escopo), v(s.statusPedido), null, v(s.observacoes), v(s.devolvido),
        v(s.ticketTransportadora), v(s.pedidoCompleto), v(s.excecaoPolitica),
    ],
    kokeshi: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.nomeCliente), v(s.numeroPedido), v(s.motivo), v(s.escopo), null,
        v(s.origem), v(s.valor), v(s.idAtendimento), v(s.cdOrigem), v(s.numeroNF), v(s.chaveNF),
        v(s.transportadora), v(s.statusPedido), null, null, v(s.devolvido), v(s.ticketTransportadora),
        v(s.observacoes), v(s.pedidoCompleto), v(s.excecaoPolitica),
    ],
    aua: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.origem), v(s.idAtendimento), v(s.cdOrigem), v(s.nomeCliente),
        v(s.numeroNF), v(s.chaveNF), v(s.numeroPedido), v(s.valor), null, v(s.motivo), v(s.lote), v(s.devolvido),
        v(s.transportadora), v(s.escopo), v(s.statusPedido), v(s.observacoes), v(s.ticketTransportadora),
        v(s.pedidoCompleto), v(s.excecaoPolitica),
    ],
    barbours: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.origem), v(s.idAtendimento), v(s.cdOrigem), v(s.nomeCliente),
        v(s.numeroPedido), v(s.numeroNF), v(s.chaveNF), null, v(s.valor), v(s.transportadora), v(s.motivo),
        v(s.escopo), v(s.statusPedido), null, v(s.observacoes), v(s.lote), v(s.devolvido),
        v(s.ticketTransportadora), v(s.pedidoCompleto), v(s.excecaoPolitica),
    ],
    rituaria: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.origem), v(s.idAtendimento), v(s.cdOrigem), v(s.numeroNF),
        v(s.chaveNF), v(s.numeroPedido), null, null, v(s.motivo), v(s.lote), v(s.transportadora), v(s.escopo),
        v(s.statusPedido), v(s.observacoes), null, null, null, v(s.nomeCliente), v(s.valor),
        v(s.ticketTransportadora), v(s.pedidoCompleto), v(s.excecaoPolitica), null,
    ],
    // ─── Marcas sem Cosmos (ADR-013): o layout das planilhas que o app "Reenvio e Reembolso" grava, cabeçalho em
    // `shared/lib/sheets/cabecalhos.ts`, com o vocabulário que elas usam. O "Endereço de e-mail" (B) fica vazio: o login
    // do CX Hub não identifica a pessoa. As colunas da operação não são escritas aqui; as de fórmula vêm depois.
    apice: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.origem), v(s.idAtendimento), v(s.cdOrigem), v(s.nomeCliente),
        v(s.numeroPedido), v(s.numeroNF), v(s.chaveNF), v(s.motivo), v(s.valor), escopoDaPlanilha(s),
        v(s.transportadora), v(s.statusPedido), v(prazoDoReembolso(s, 'apice')), v(s.devolucaoInformada),
        v(s.ticketTransportadora), completoDaPlanilha(s), v(s.excecaoPolitica), ORIGEM_DO_PEDIDO, v(s.chavePix),
        v(s.lote), v(s.observacoes),
    ],
    yenzah: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.origem), v(s.idAtendimento), v(s.cdOrigem), v(s.nomeCliente),
        v(s.numeroPedido), v(s.numeroNF), v(s.chaveNF), v(s.motivo), v(s.valor), escopoDaPlanilha(s),
        v(s.transportadora), v(s.statusPedido), v(prazoDoReembolso(s, 'yenzah')), v(s.devolucaoInformada),
        v(s.ticketTransportadora), completoDaPlanilha(s), v(s.excecaoPolitica), ORIGEM_DO_PEDIDO, v(s.chavePix),
        v(s.lote),
    ],
    denavita: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.origem), v(s.idAtendimento), v(s.cdOrigem), v(s.nomeCliente),
        v(s.numeroNF), v(s.chaveNF), v(s.numeroPedido), v(s.valor), v(s.chavePix), v(s.motivo), v(s.lote),
        escopoDaPlanilha(s), v(s.devolucaoInformada), v(s.ticketTransportadora), v(s.transportadora),
        ORIGEM_DO_PEDIDO, v(s.statusPedido), completoDaPlanilha(s), v(prazoDoReembolso(s, 'denavita')),
        v(s.excecaoPolitica),
    ],
};

/**
 * Dias úteis do "Prazo para o reembolso", como o cabeçalho de cada planilha diz ("considerar os N dias úteis a partir
 * da solicitação"): 3 na Ápice, 5 na Yenzah e na Denavita.
 */
export const DIAS_UTEIS_DO_REEMBOLSO: Record<MarcaSemCosmosComPlanilha, number> = { apice: 3, yenzah: 5, denavita: 5 };

/** A coluna (0-based) da chave Pix em cada layout: é ela que o log da linha que falhou mascara. */
export const COLUNA_DA_CHAVE_PIX: Record<MarcaSemCosmosComPlanilha, number> = { apice: 21, yenzah: 21, denavita: 11 };

/** O pedido das marcas sem Cosmos só vem da Shopify (ADR-013): é o "Origem do pedido" de quase todas as linhas delas. */
const ORIGEM_DO_PEDIDO = 'Shopify';

/** A data do carimbo mais os dias úteis da marca, `dd/MM/yyyy` — o Sheets a guarda como data (`USER_ENTERED`). */
function prazoDoReembolso(s: RefundRowSource, marca: MarcaSemCosmosComPlanilha): string {
    return somarDiasUteis(s.carimbo.slice(0, 10), DIAS_UTEIS_DO_REEMBOLSO[marca]);
}

/** "O reembolso é do pedido completo?": as planilhas usam `Sim (Pedido completo)` e `Não`. */
function completoDaPlanilha(s: RefundRowSource): SheetCell {
    return s.pedidoCompleto === 'Sim' ? 'Sim (Pedido completo)' : 'Não';
}

/** "O reembolso é do frete e/ou do pedido?": `Pedido completo` quando é; senão, os SKUs (e o frete) como o CX Hub monta. */
function escopoDaPlanilha(s: RefundRowSource): SheetCell {
    return s.pedidoCompleto === 'Sim' ? 'Pedido completo' : v(s.escopo);
}

export function buildRefundRow(brand: MarcaComPlanilha, source: RefundRowSource): SheetCell[] {
    return BUILDERS[brand](source);
}
