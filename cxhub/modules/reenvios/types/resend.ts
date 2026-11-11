// Resend-specific types

import type { NormalizedAddress } from '../../../shared/types/index';
import type { SelectedProduct, WebhookResponseCode } from './sheets';

export interface TransportadoraReenvio {
    CD: string;
    "Transportadoras de Reenvio": string;
}

export interface DynamicResendDataResponse {
    marcas: string[];
    responsáveis: string[];
    motivos: string[];
    transportadoras_reenvio: TransportadoraReenvio[];
}

// ─── Form State Types ────────────────────────────────────────────────

export interface Step1FormData {
    responsavel: string;
    tipoSolicitacao: string;
    origemReclamacao: string;
    idAtendimento: string;
    marca: string;
    numeroPedido: string;
}

/** O produto que vai no lugar de um item do pedido sem estoque (marcas sem Cosmos, ADR-016). */
export interface SubstituicaoDoItem {
    sku: string;
    name: string;
}

export interface Step2Data {
    solicitarCancelamento: boolean;
    alterarEndereco: boolean;
    produtosComProblema: string[];
    produtosReenviar: string[];
    /** Nas marcas sem Cosmos, liga a seção "Incluir mimo" (desligar esvazia os mimos); nas do Cosmos, o item diferente. */
    itemDiferente: boolean;
    /**
     * Marcas do Cosmos: os itens adicionais do catálogo do Cosmos. Marcas sem Cosmos (ADR-016): os **mimos**, do catálogo
     * do Data Mart (`isGift: true`, quantidade inteira de 1 a 10).
     */
    itensAdicionais: SelectedProduct[];
    /**
     * Só nas marcas sem Cosmos (ADR-016): a troca de um item do pedido sem estoque, pela chave do item (o id do produto
     * ou do componente de kit). As marcas do Cosmos ignoram.
     */
    substituicoes: Record<string, SubstituicaoDoItem>;
    loteProduto: string;
    problemaProduto: string;
    devolucao: string;
    novoEndereco: NormalizedAddress;
    statusPedido: string;
    ticketTransportadora: string;
    transportadoraReenvio: string;
    observacoes: string;
    ReenvioCompleto: string;
    numeroNFManual: string;
    chaveNFManual: string;
    quantidadesReenviar: Record<string, number>;
}

/**
 * O que a tela de resultado mostra (ADR-011 e ADR-012). `SUCCESS` é o reenvio na fila do Metabase e na planilha; quem
 * diz quando ele chegou ao Metabase é a tag da lista. O `codigoDaTelaDoReenvio` traduz a resposta da rota para estes
 * códigos.
 */
export type ResendResultCode = Exclude<WebhookResponseCode, 'SUCCESS_SHEETS_ONLY' | 'API_TIMEOUT'>;

export interface SubmissionResult {
    code: ResendResultCode;
    sentToAPI: boolean;
    orderNumber: string;
    motivo?: string;
    webhookMessage?: string;
    /**
     * `SHEET_WRITE_FAILED`: só a linha da planilha falhou — a gold gravou (a rota esperou o run) ou o run foi disparado
     * (a tela, ADR-011). A tela diz "não repita".
     */
    reason?: 'SHEET_WRITE_FAILED';
    /**
     * A lista de reenvios acompanha o registro desta solicitação: a página a guardou no navegador com o run
     * (`solicitacaoEnviadaDoReenvio`). A tela diz que o status aparece na lista só quando é verdade.
     */
    acompanhadaNaLista?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

export const INITIAL_STEP1_DATA: Step1FormData = {
    responsavel: '',
    tipoSolicitacao: 'reenvio',
    origemReclamacao: '',
    idAtendimento: '',
    marca: '',
    numeroPedido: '',
};

export const INITIAL_STEP2_DATA: Step2Data = {
    solicitarCancelamento: false,
    alterarEndereco: false,
    produtosComProblema: [],
    produtosReenviar: [],
    itemDiferente: false,
    itensAdicionais: [],
    substituicoes: {},
    loteProduto: '',
    problemaProduto: '',
    devolucao: '',
    novoEndereco: {
        logradouro: '',
        numero: '',
        complemento: '',
        bairro: '',
        cidade: '',
        estado: '',
        cep: '',
    },
    statusPedido: '',
    ticketTransportadora: '',
    transportadoraReenvio: '',
    observacoes: '',
    ReenvioCompleto: '',
    numeroNFManual: '',
    chaveNFManual: '',
    quantidadesReenviar: {},
};

// Re-exported from shared — canonical definition in @shared/lib/constants
export { BRAND_DISPLAY_MAP, BRAND_API_TO_DISPLAY } from '../../../shared/lib/constants';
