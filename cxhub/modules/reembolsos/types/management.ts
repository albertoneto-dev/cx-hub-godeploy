import type { SupportedBrand } from '../../../shared/lib/constants';

/**
 * Códigos das rotas de gestão de reembolso (`/api/refund/cancel`, `/update`, `/complete` e `/sync`). Os do n8n
 * (`SUCCESS`, `NOT_FOUND`, `ALREADY_EXECUTED`, `SHEETS_ERROR`, `UNKNOWN_ERROR`) passam como vieram; os
 * outros nascem no CX Hub.
 */
export type RefundManagementCode =
    | 'SUCCESS'
    | 'NO_CHANGE'
    | 'INVALID_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'ALREADY_EXECUTED'
    | 'SHEETS_ERROR'
    | 'API_TIMEOUT'
    | 'UNKNOWN_ERROR';

/**
 * O que a planilha não acompanhou. A gold e a planilha andam juntas: quando a gold confirma e a planilha falha, a
 * resposta continua `SUCCESS` (a gold já mudou), mas leva o `reason` para o agente acertar a planilha à mão.
 * - `SHEET_WRITE_FAILED`: a escrita falhou (planilha fora do ar, coluna que não está no cabeçalho);
 * - `SHEET_ROW_NOT_FOUND`: a linha do caso (o pedido e o carimbo do `criado_em`) não está na planilha;
 * - `SHEET_READ_FAILED`: só na sincronização, que não faz nada sem ler a planilha.
 */
export type RefundManagementReason = 'SHEET_WRITE_FAILED' | 'SHEET_ROW_NOT_FOUND' | 'SHEET_READ_FAILED';

export interface RefundManagementResponse {
    code: RefundManagementCode;
    message: string;
    reason?: RefundManagementReason;
}

export interface RefundCancelRequest {
    brand: SupportedBrand;
    /** O `ecommerceOrderId` da solicitação: o n8n acha a linha mais recente deste pedido. */
    ecommerceOrderId: string;
    handledBy: string;
    reason: string;
}

/** Só estes três são editáveis (decisão de 2026-10-23). */
export interface RefundChanges {
    refundAmount?: number;
    refundReason?: string;
    notes?: string;
}

export interface RefundUpdateRequest {
    brand: SupportedBrand;
    ecommerceOrderId: string;
    handledBy: string;
    changes: RefundChanges;
}

/**
 * Marcar como concluído e atualizar o acompanhamento: a solicitação é achada pelo `idSolicitacao` que a lista
 * devolve, não pelo pedido (são ações sobre um caso, não sobre "o mais recente do pedido").
 */
export interface RefundExecutionRequest {
    brand: SupportedBrand;
    idSolicitacao: string;
    handledBy: string;
}
