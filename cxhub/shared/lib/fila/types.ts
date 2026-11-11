import type { AtualizacaoCxhub, TipoCasoCxhub } from '../airflow/types';

/** Onde um item está na fila do app `cx-hub` (`docs/fila-cxhub.md`). */
export type SituacaoNaFila = 'pendente' | 'enviado' | 'gravado' | 'recusado';

/**
 * O desfecho de entregar algo à fila, no mesmo molde do registro na gold:
 * - `enfileirado` — a fila guardou (o próximo lote leva à DAG);
 * - `recusado` — com certeza nada foi guardado (configuração, contrato, 4xx): dá para repetir;
 * - `incerto` — pode ter guardado (rede, timeout ou 5xx nas duas tentativas): confira antes de repetir.
 */
export type ResultadoFila =
    | { status: 'enfileirado' }
    | { status: 'recusado'; motivo: string }
    | { status: 'incerto'; motivo: string };

/** Um caso como a fila o devolve: a identidade dele, sem o resto do `CasoCxhub`. */
export interface CasoNaFila {
    idSolicitacao: string;
    tipo: TipoCasoCxhub;
    /** Em minúsculas, como o CX Hub manda (`lescent`) */
    marca: string;
    numeroPedido: string;
    /** O `criado_em` do caso (ISO 8601) */
    criadoEm: string;
    responsavel: string | null;
    situacao: SituacaoNaFila;
}

/** Um caso de `GET /api/v1/casos/abertos`: a identidade, mais o que a lista de solicitações mostra. */
export interface CasoAbertoNaFila extends CasoNaFila {
    valor: number | null;
    motivo: string | null;
}

/** Uma atualização que está na fila (`campos` é o `AtualizacaoCxhub` que vai ao `conf` da DAG). */
export interface AtualizacaoNaFila {
    idAtualizacao: string;
    idSolicitacao: string;
    /** O instante em que o agente agiu (ISO 8601): é o que ordena as atualizações de um caso */
    atualizadoEm: string;
    campos: AtualizacaoCxhub;
    situacao: SituacaoNaFila;
}
