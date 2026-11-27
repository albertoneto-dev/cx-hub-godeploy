// Refund submission types

export interface RefundSubmissionData {
    brand: string;
    data_criacao: string;            // Data de criação do pedido (dd/mm/aaaa)
    handledBy: string;
    sourceChannel: string;
    supportTicketId: string;
    originWarehouse: string;
    customerName: string;
    invoiceNumber: string;
    nfeAccessKey: string;
    batchNumber: string | null;
    ecommerceOrderId: string;
    policyException: boolean;
    refundAmount: number;
    refundReason: string;
    refundScope: string;               // "Frete" ou "SKU01 - 1;SKU02 - 3;Frete"
    requiresReturn: boolean;
    carrierTicketId: string | null;
    carrierName: string;
    orderStatus: string;
    isFullRefund: boolean;
    notes: string | null;
    /**
     * Chave Pix da cliente, para o financeiro pagar, como a agente digitou: lida em toda marca com planilha (as do
     * Cosmos desde 16/11/2026) e aceita com qualquer texto. **Dado pessoal sensível**: vai só para a planilha (na
     * Kokeshi, no fim das Observações da linha) — nunca para a fila, a gold ou o log.
     */
    pixKey?: string | null;
    /**
     * O tipo da chave Pix (`cpf`, `cnpj`, `email`, `celular` ou `aleatoria`), opcional (ADR-018). Se vier e a chave valer
     * para ele, o servidor a grava normalizada; em qualquer outro caso grava o texto como veio, sem recusar.
     */
    pixKeyType?: string | null;
    /**
     * Com o motivo "Avaria informada pelo cliente" (23/11/2026): o cliente mandou foto da caixa ou do produto? Vai à
     * fila do Metabase como `foto_avaria`; a planilha não muda (quem chama põe a resposta nas `notes`, se quiser).
     * Opcional: quem não manda segue igual, e o caso vai sem o campo.
     */
    damagePhotoSent?: boolean | null;
}

export type RefundWebhookResponseCode =
    | 'SUCCESS'
    | 'SHEETS_ERROR'
    | 'DUPLICATE_REFUND'
    | 'API_TIMEOUT'
    | 'UNKNOWN_ERROR';

export interface RefundSubmitResponse {
    code: RefundWebhookResponseCode;
    message: string;
    /**
     * `SHEET_WRITE_FAILED` (ADR-010): a fila do Metabase guardou e só a linha da planilha falhou — a solicitação ESTÁ
     * registrada e não deve ser repetida. Ausente nos demais casos (inclusive o `SHEETS_ERROR` de fila que recusou, em
     * que nada foi gravado).
     */
    reason?: 'SHEET_WRITE_FAILED' | 'REGISTRADO_SEM_EXECUCAO';
    /**
     * O caso que foi à fila do Metabase (ADR-012): a lista acompanha por ele quando a raw o recebe. Vem sempre que a
     * planilha foi tentada (`SUCCESS`, `SHEET_WRITE_FAILED` e o `API_TIMEOUT` da fila incerta) e, com
     * `REGISTRAR_FALHA_DA_TELA`, no `REGISTRADO_SEM_EXECUCAO`: é ele que a tela manda de volta na nova tentativa.
     */
    idSolicitacao?: string;
    /** Só com `reason: REGISTRADO_SEM_EXECUCAO`: o status que o reembolso recebeu na planilha, para a tela mostrar. */
    statusRegistrado?: string;
}

/**
 * O que a tela de resultado mostra (`codigoDaTelaDoReembolso`). `SUCCESS` é o reembolso na fila do Metabase e na
 * planilha (ADR-012); quando ele chega ao Metabase, a tag da lista de reembolsos mostra.
 */
export type RefundResultCode = 'SUCCESS' | 'DUPLICATE_REFUND' | 'SHEETS_ERROR' | 'UNKNOWN_ERROR';

export interface RefundSubmissionResult {
    code: RefundResultCode;
    orderNumber: string;
    webhookMessage?: string;
    /** O `reason` da resposta: com `SHEET_WRITE_FAILED` a tela diz "registrada no Metabase, não repita" */
    reason?: 'SHEET_WRITE_FAILED';
    /**
     * A solicitação ficou no navegador e a lista acompanha o run (ADR-011). Com `SHEET_WRITE_FAILED`, a tela não afirma
     * que o Metabase gravou: diz que está gravando, e o desfecho aparece na tag da lista.
     */
    acompanhadaNaLista?: boolean;
}
