import type { AtualizacaoCxhub, CasoNaRaw, ReembolsoNaRaw } from '../../../shared/lib/airflow/index';
import { sendAlert, type AlertContext } from '../../../shared/lib/alerts/index';
import { configuracaoQueFalta } from '../../../shared/lib/backendDireto';
import type { SupportedBrand } from '../../../shared/lib/constants';
import {
    casoNoRegistro,
    enfileirarAtualizacao,
    prazoDaFila,
    reembolsoMaisRecenteNoRegistro,
    type ResultadoFila,
} from '../../../shared/lib/fila/index';
import type { PlanilhaDoReembolso } from './refundSheetPort';
import { planilhaDoReembolsoGoogle } from './refundSheetPortGoogle';

/**
 * Cada etapa da planilha na gestão (a leitura antes da fila e a escrita depois), contada de quando ela começa: 15 s. Não
 * é a `JANELA_PLANILHA_MS` da criação (25 s): a gestão tem duas etapas por ação, e o pior caso inteiro tem de caber nos
 * 120 s das rotas — com o `TIMEOUT` de 12 s, a conferência do token no Cosmos (12) + o caso na raw e na fila (~32) + as
 * duas etapas (15 + 15) + a fila (16) + o aviso (2,5) ≈ 92,5 s.
 */
export const JANELA_ETAPA_DA_GESTAO_MS = 15_000;

/**
 * Tudo o que a gestão do reembolso (cancelar, editar, concluir, sincronizar) toca fora do próprio código: o estado
 * do caso (raw + fila do Metabase, ADR-012), a fila, a planilha, a configuração e o aviso no Chat. Entra por
 * parâmetro, como o `deps` de `shared/lib/cosmos/`, para o teste usar uma planilha em memória e fila, raw e Chat falsos.
 *
 * ⚠️ Server-only — fora do barrel de `modules/reembolsos/actions`. Importe pelo caminho completo.
 */
export interface RefundGestaoDeps {
    planilha: PlanilhaDoReembolso;
    /**
     * A solicitação de reembolso mais recente do pedido, na raw ou ainda na fila, com o status que a atualização mais
     * recente deu (`reembolsoMaisRecenteNoRegistro`).
     */
    buscarReembolsoMaisRecente: (marca: SupportedBrand, pedido: string) => Promise<ReembolsoNaRaw | null>;
    /**
     * O caso pelo id, na raw ou ainda na fila: tipo, marca, pedido, `criado_em` e status de execução (`aberto` quando
     * nenhuma atualização trouxe status). O pedido e o `criado_em` são o que acha a linha do caso na planilha.
     */
    buscarCasoPorId: (idSolicitacao: string) => Promise<CasoNaRaw | null>;
    /** Entrega a atualização à fila do Metabase; o lote a leva à gold (até 20 min). */
    enfileirarAtualizacao: (idSolicitacao: string, atualizacao: AtualizacaoCxhub) => Promise<ResultadoFila>;
    /** O instante-limite de uma etapa da planilha (a leitura antes da fila ou a escrita depois), contado de agora. */
    prazoDaPlanilha: () => number;
    /** O que falta configurar (fila e planilha), ou `null`. Faltou ⇒ a gestão recusa antes de consultar. */
    configuracaoQueFalta: () => string | null;
    /** Avisa o Chat. O `sendAlert` não lança, e quem chama também não deixa o aviso alterar a resposta. */
    avisar: (contexto: AlertContext) => Promise<unknown>;
    agora: () => Date;
}

/** O que as rotas usam: a raw, a fila e a planilha do Google de verdade. */
export function depsDaGestaoDoReembolso(): RefundGestaoDeps {
    return {
        planilha: planilhaDoReembolsoGoogle(),
        buscarReembolsoMaisRecente: (marca, pedido) => reembolsoMaisRecenteNoRegistro(marca, pedido),
        buscarCasoPorId: (idSolicitacao) => casoNoRegistro(idSolicitacao),
        enfileirarAtualizacao: (idSolicitacao, atualizacao) => enfileirarAtualizacao(idSolicitacao, atualizacao, prazoDaFila()),
        prazoDaPlanilha: () => Date.now() + JANELA_ETAPA_DA_GESTAO_MS,
        configuracaoQueFalta,
        avisar: sendAlert,
        agora: () => new Date(),
    };
}
