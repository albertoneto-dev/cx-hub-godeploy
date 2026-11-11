// Refund-specific types

export interface RefundStep1FormData {
    responsavel: string;
    tipoSolicitacao: string; // fixo 'reembolso'
    origemReclamacao: string;
    idAtendimento: string;
    marca: string;
    numeroPedido: string;
}

export interface RefundStep2Data {
    solicitarCancelamento: boolean;
    produtosReembolsar: string[];              // IDs dos produtos selecionados
    quantidadesReembolsar: Record<string, number>;
    incluirFrete: boolean;                     // Incluir frete no reembolso
    excecaoPolitica: boolean;                  // Exceção à política CX
    valorReembolso: string;                    // Valor digitado pelo atendente (só quando excecaoPolitica = true)
    motivoReembolso: string;                   // Motivo selecionado do dropdown
    loteProduto: string;
    devolucao: boolean | null;
    statusPedido: string;
    ticketTransportadora: string;
    observacoes: string;
    chavePix: string;                          // Só nas marcas sem Cosmos (ADR-013); opcional, formato conferido
}

// ─── Constants ───────────────────────────────────────────────────────

export const INITIAL_REFUND_STEP1_DATA: RefundStep1FormData = {
    responsavel: '',
    tipoSolicitacao: 'reembolso',
    origemReclamacao: '',
    idAtendimento: '',
    marca: '',
    numeroPedido: '',
};

export const INITIAL_REFUND_STEP2_DATA: RefundStep2Data = {
    solicitarCancelamento: false,
    produtosReembolsar: [],
    quantidadesReembolsar: {},
    incluirFrete: true,
    excecaoPolitica: false,
    valorReembolso: '',
    motivoReembolso: '',
    loteProduto: '',
    devolucao: null,
    statusPedido: '',
    ticketTransportadora: '',
    observacoes: '',
    chavePix: '',
};
