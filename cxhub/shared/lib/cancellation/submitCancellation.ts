import type { CancellationPayload, CancellationResult } from './types';

/** Só o que o corpo traz: o `reason` só quando é o da planilha, e o `idSolicitacao` só quando é texto. */
function comCaso(
    code: CancellationResult['code'],
    message: string,
    body: { reason?: unknown; idSolicitacao?: unknown } | null,
): CancellationResult {
    return {
        code,
        message,
        ...(body?.reason === 'SHEET_WRITE_FAILED' ? { reason: 'SHEET_WRITE_FAILED' as const } : {}),
        ...(typeof body?.idSolicitacao === 'string' ? { idSolicitacao: body.idSolicitacao } : {}),
    };
}

/**
 * O cancelamento pedido junto do reenvio ou do reembolso, pela tela: a rota entrega o caso à fila do Metabase e grava a
 * planilha (ADR-012), e a lista acompanha o caso pelo `idSolicitacao` da resposta.
 */
export async function submitCancellation(
    brand: string,
    payload: CancellationPayload,
): Promise<CancellationResult> {
    try {
        const res = await fetch('/api/cancellation/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brand, data: payload }),
        });

        const body = await res.json().catch(() => null);

        if (res.status === 504) {
            return comCaso('API_TIMEOUT', body?.message || 'O sistema demorou para responder.', body);
        }

        if (!body || !res.ok) {
            return {
                code: 'UNKNOWN_ERROR',
                message: body?.message || 'Erro ao enviar cancelamento.',
            };
        }

        return comCaso(body.code ?? 'UNKNOWN_ERROR', body.message ?? '', body);
    } catch {
        return {
            code: 'UNKNOWN_ERROR',
            message: 'Erro de conexão ao enviar cancelamento.',
        };
    }
}
