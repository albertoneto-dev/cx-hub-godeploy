import type { MarcaCxHub } from '../constants';
import type { TipoSolicitacaoListada } from '../solicitacoes/types';

/**
 * O acompanhamento do registro no Metabase, do lado do navegador (ADR-011 e ADR-012).
 *
 * A tela responde quando a solicitação está na fila do Metabase e na planilha; o lote a leva à raw em até 20 min. O
 * navegador guarda a solicitação enviada (`enviadas.ts`), e a lista de reenvios ou de reembolsos mostra a tag dela,
 * perguntando a `GET /api/registro` de 10 em 10 min se a raw já a tem.
 */

/** Onde o caso está, como `GET /api/registro` responde. */
export type EstadoDoRegistro = 'gravado' | 'aguardando' | 'recusado';

export type RegistroCode =
    | 'SUCCESS'
    | 'INVALID_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'API_TIMEOUT'
    | 'UNAVAILABLE'
    | 'UNKNOWN_ERROR';

/** Resposta de `GET /api/registro`. `estados` (um por id perguntado) vem só com `SUCCESS`. */
export interface RegistroResponse {
    code: RegistroCode;
    message: string;
    estados?: Record<string, EstadoDoRegistro>;
}

/**
 * O que a tag da lista mostra: `em_andamento` é "Aguardando Metabase" (na fila, esperando o lote), `sucesso` é
 * "Gravado no Metabase" (a raw tem o caso) e `falhou` é "Não gravado no Metabase" (a DAG recusou o caso).
 */
export type EstadoDoEnvio = 'em_andamento' | 'sucesso' | 'falhou';

/**
 * Uma solicitação que este navegador enviou e que a lista acompanha até a raw trazê-la. Sem dado de cliente: só o
 * que a linha da lista mostra, como a `SolicitacaoListada`.
 */
export interface SolicitacaoEnviada {
    /** O `id_solicitacao` do caso: é por ele que se pergunta o estado, e é o que a linha terá quando a raw a trouxer. */
    idSolicitacao: string;
    tipo: TipoSolicitacaoListada;
    marca: MarcaCxHub;
    numeroPedido: string;
    /** Quando a tela recebeu a resposta, ISO 8601 com fuso. */
    enviadaEm: string;
    valor: number | null;
    motivo: string | null;
    responsavel: string | null;
    estado: EstadoDoEnvio;
    /** Só reenvio: o Cosmos já criou o reenvio. Com o registro falho, a agente avisa o suporte em vez de repetir. */
    noCosmos?: boolean;
    /**
     * A linha da planilha falhou no envio (`SHEET_WRITE_FAILED`, ADR-010): o caso foi à fila, e a tela pediu o suporte
     * para a planilha. Muda o aviso do "Não gravado": sem a planilha e sem o Metabase, nada ficou gravado.
     */
    semPlanilha?: boolean;
    /** O cancelamento pedido junto. Sem `idSolicitacao`, a tela já recebeu o erro dele e não há o que acompanhar. */
    cancelamento?: { idSolicitacao?: string; estado: EstadoDoEnvio };
}
