import type { MarcaCxHub } from '../constants';

/** Os tipos que as listas mostram. O cancelamento paralelo não tem gestão. */
export type TipoSolicitacaoListada = 'REENVIO' | 'REEMBOLSO';

/**
 * Uma solicitação gravada pelo CX Hub, como está na raw de eventos (`raw.cxhub_reenvio_reembolso_eventos`). Sem
 * dado de cliente: o que a lista precisa para o agente achar a solicitação e alterá-la.
 */
export interface SolicitacaoListada {
    idSolicitacao: string;
    tipo: TipoSolicitacaoListada;
    marca: MarcaCxHub;
    numeroPedido: string;
    /** `aaaa-mm-ddThh:mm:ss` em hora de São Paulo, sem fuso: o `criado_em` do caso (quando a agente enviou). */
    dataSolicitacao: string;
    /**
     * O `criado_em` do caso (ISO 8601), o carimbo que a linha da planilha tem: é por ele (e pelo pedido) que se acha a
     * linha. `null` na enviada deste navegador, que já sabe pelo envio se a planilha gravou.
     */
    criadoEm: string | null;
    /**
     * Se a linha da solicitação está na planilha da marca (a tag "Sucesso"/"Falhou" da planilha). `null` quando não deu
     * para saber (planilha fora, sem configuração, sem `criado_em`). Na enviada, `false` só quando a planilha falhou no
     * envio.
     */
    naPlanilha: boolean | null;
    /**
     * A linha veio da fila do Metabase, e não da raw (ADR-012): `pendente` ou `enviado` (a tag "Aguardando Metabase") ou
     * `recusado` ("Não gravado no Metabase"). `null` na linha da raw, no caso já gravado e na enviada deste navegador.
     */
    situacaoNaFila: 'pendente' | 'enviado' | 'recusado' | null;
    valor: number | null;
    motivo: string | null;
    /** `Realizado`, `Cancelado`, `Pendente`, ou `null` enquanto não há execução. */
    statusExecucao: string | null;
    responsavel: string | null;
    /**
     * A mais recente do mesmo tipo para o pedido. No reembolso, só ela pode ser alterada: é a linha que o n8n
     * acha na planilha.
     */
    maisRecenteDoPedido: boolean;
}

export interface FiltroSolicitacoes {
    tipo: TipoSolicitacaoListada;
    marca?: MarcaCxHub;
    /** Número do pedido em qualquer formato (`SH9000105LC`, `#9000105`): valem os dígitos. */
    pedido?: string;
}

export type ListaSolicitacoesCode =
    | 'SUCCESS'
    | 'INVALID_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'UNAVAILABLE'
    | 'API_TIMEOUT'
    | 'UNKNOWN_ERROR';

/** Onde a página está na lista inteira (raw + fila, na janela de 30 dias ou todo o histórico do pedido). */
export interface PaginacaoDaLista {
    /** A página que veio, a partir de 1. */
    pagina: number;
    porPagina: number;
    /** Quantas solicitações a lista tem ao todo. */
    total: number;
    /** Nunca menos de 1: a lista vazia tem uma página, vazia. */
    totalPaginas: number;
}

/** Uma página da lista, como o servidor a monta. */
export interface PaginaDeSolicitacoes {
    solicitacoes: SolicitacaoListada[];
    paginacao: PaginacaoDaLista;
}

export interface ListaSolicitacoesResponse {
    code: ListaSolicitacoesCode;
    message: string;
    solicitacoes?: SolicitacaoListada[];
    /** Vem junto das `solicitacoes`, no `SUCCESS`. */
    paginacao?: PaginacaoDaLista;
}
