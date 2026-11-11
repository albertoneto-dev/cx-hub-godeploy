export interface CancellationPayload {
    brand: string;
    'Responsável': string;
    'Nome do(a) cliente': string;
    'Número do pedido (Shopify)': string;
    'Observações': string;
    'Número da NF': string;
    'CD de origem': string;
    'Status': string;
    'Local da Tratativa': string;
    'Tratativa': string;
}

/**
 * `API_TIMEOUT` é a fila do Metabase incerta com a linha já na planilha (ADR-012): o cancelamento não deve ser
 * repetido.
 */
export type CancellationResponseCode = 'SUCCESS' | 'API_TIMEOUT' | 'UNKNOWN_ERROR';

export interface CancellationResponse {
    code: CancellationResponseCode;
    message: string;
    /**
     * `SHEET_WRITE_FAILED` (ADR-010): a fila do Metabase guardou e só a linha da planilha falhou: o cancelamento ESTÁ
     * registrado e não deve ser repetido. Ausente nos demais casos.
     */
    reason?: 'SHEET_WRITE_FAILED';
    /** O caso que foi à fila do Metabase: vem sempre que a planilha foi tentada (ADR-012). */
    idSolicitacao?: string;
}

export interface CancellationResult {
    code: CancellationResponseCode;
    message: string;
    /** O `reason` da rota: `SHEET_WRITE_FAILED` é o cancelamento registrado com a planilha falhando. */
    reason?: 'SHEET_WRITE_FAILED';
    /** O caso que foi à fila do Metabase: o que a lista acompanha junto da solicitação principal. */
    idSolicitacao?: string;
}
