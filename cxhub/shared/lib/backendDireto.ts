import { filaConfigurada } from './fila/client';
import { planilhasConfiguradas } from './sheets/googleAuth';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Folga para serialização, resposta e o que a plataforma cobra fora do nosso relógio. */
export const FOLGA_HANDLER_MS = 5_000;

/** Instante-limite das etapas antes do registro (dedup e Cosmos): `timeoutMs` de quem chama, ou a env `TIMEOUT`. */
export function prazoDaRequisicao(timeoutMs?: number): number {
    return Date.now() + (timeoutMs ?? (parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS));
}

/**
 * O que falta para registrar uma solicitação, ou `null` se está tudo configurado. O registro tem **dois lados que
 * andam juntos** — a fila do Metabase (o app `cx-hub`, ADR-012) e a planilha (Google) —, então falta de qualquer um
 * recusa a solicitação **antes** do dedup e do Cosmos (ADR-010): melhor nada registrado do que registrado num lado só.
 *
 * O Metabase (dedup, lista e gestão) não entra aqui de propósito: o dedup já recusa sozinho, e o cancelamento não o
 * usa.
 *
 * `comPlanilha: false` é a marca sem planilha (a Gobeaute, ADR-014): o registro dela é só a fila, então só a fila é
 * conferida.
 *
 * ⚠️ Server-only (lê a configuração da fila e do Google).
 */
export function configuracaoQueFalta({ comPlanilha = true }: { comPlanilha?: boolean } = {}): string | null {
    if (!filaConfigurada()) return 'a fila do Metabase não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)';
    if (comPlanilha && !planilhasConfiguradas()) return 'as planilhas não estão configuradas (GOOGLE_PLANILHAS_EMAIL, GOOGLE_PLANILHAS_TOKEN e SHEETS_ENV)';
    return null;
}
