import type { DynamicResendDataResponse } from '../../modules/reenvios/types/index';

export type FormDataOrigin = 'reenvio' | 'reembolso' | 'logistica';

/**
 * Client-side guard for INV-01: the dynamic form data must carry non-empty
 * `marcas` and `responsáveis` arrays, or the request pages can't be filled.
 *
 * A `200 OK` with a malformed/incomplete payload is treated as a failure just
 * like an HTTP error — both surface a visible error + retry instead of silently
 * empty dropdowns (RF-02). `motivos`/`transportadoras_reenvio` stay optional:
 * they vary per origin and the pages already read them defensively.
 *
 * Returns the payload unchanged when valid; throws with a clear message otherwise.
 */
export function validateFormDataShape(data: unknown): DynamicResendDataResponse {
    if (!data || typeof data !== 'object') {
        throw new Error('Dados do formulário inválidos: resposta vazia ou malformada.');
    }
    const payload = data as Record<string, unknown>;
    if (!Array.isArray(payload.marcas) || payload.marcas.length === 0) {
        throw new Error('Dados do formulário incompletos: lista de marcas ausente ou vazia.');
    }
    if (!Array.isArray(payload.responsáveis) || payload.responsáveis.length === 0) {
        throw new Error('Dados do formulário incompletos: lista de responsáveis ausente ou vazia.');
    }
    return data as DynamicResendDataResponse;
}

/**
 * Fetches dynamic form data from the shared /api/resend/data endpoint.
 * Used by all modules that need responsáveis, marcas, motivos, and transportadoras.
 *
 * Throws on HTTP error or on a malformed payload (see `validateFormDataShape`).
 */
export async function getDynamicFormData(origin: FormDataOrigin): Promise<DynamicResendDataResponse> {
    const response = await fetch(`/api/resend/data?origin=${origin}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
        },
    });
    if (!response.ok) {
        throw new Error(`Erro ${response.status}: ${response.statusText}`);
    }
    return validateFormDataShape(await response.json());
}
