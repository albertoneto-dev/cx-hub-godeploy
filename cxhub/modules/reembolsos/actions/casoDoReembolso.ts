// `import type`: o módulo do Airflow é server-only, e este arquivo entra no barrel das actions.
import type { CasoCxhub } from '../../../shared/lib/airflow/types';
import type { MarcaCxHub } from '../../../shared/lib/constants';
import type { RefundSubmissionData } from '../types/submission';

export interface CasoDoReembolsoInput {
    brand: MarcaCxHub;
    data: RefundSubmissionData;
    idSolicitacao: string;
    criadoEm: Date;
}

/**
 * O caso REEMBOLSO de uma solicitação — o que o backend direto grava na gold no lugar da linha da planilha
 * (ADR-008). De-para da tabela da seção 1 do guia da DAG, mais o que a linha levava e a gold não tinha (escopo,
 * exceção à política, ticket da transportadora); sem o nome do cliente e sem as observações (texto livre).
 */
export function casoDoReembolso(input: CasoDoReembolsoInput): CasoCxhub {
    const { brand, data, idSolicitacao, criadoEm } = input;
    return {
        id_solicitacao: idSolicitacao,
        tipo: 'REEMBOLSO',
        marca: brand,
        criado_em: criadoEm.toISOString(),
        numero_pedido: data.ecommerceOrderId,
        data_pedido: data.data_criacao,
        nf: data.invoiceNumber,
        chave_nf: data.nfeAccessKey,
        valor: data.refundAmount,
        motivo: data.refundReason,
        cd_origem: data.originWarehouse,
        status_pedido: data.orderStatus,
        transportadora: data.carrierName,
        lote: data.batchNumber ?? undefined,
        pedido_completo: data.isFullRefund,
        devolucao: data.requiresReturn,
        responsavel: data.handledBy,
        origem: data.sourceChannel,
        id_atendimento: data.supportTicketId,
        escopo_reembolso: data.refundScope,
        // O Bot nunca reembolsa como exceção, mesmo que o campo venha `true` (regra que o n8n aplicava na linha).
        excecao_politica: data.handledBy !== 'Bot' && data.policyException === true,
        ticket_transportadora: data.carrierTicketId ?? undefined,
    };
}
