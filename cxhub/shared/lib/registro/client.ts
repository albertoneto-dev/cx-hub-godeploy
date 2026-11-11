import type { RegistroResponse } from './types';

export interface RespostaDoRegistro {
    /** HTTP; `0` = nem houve resposta (rede). */
    status: number;
    body: RegistroResponse;
}

/**
 * `GET /api/registro`: onde os casos estão agora (gravados na raw, aguardando na fila ou recusados). Nunca lança.
 *
 * Não desloga no 401, ao contrário das outras chamadas do navegador: quem pergunta é o acompanhamento da lista, em
 * segundo plano, e sair do login por causa dele tiraria a agente do que ela estava fazendo.
 */
export async function consultarRegistro(ids: string[], token: string): Promise<RespostaDoRegistro> {
    const params = new URLSearchParams({ ids: ids.join(',') });
    let res: Response;
    try {
        res = await fetch(`/api/registro?${params.toString()}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
        });
    } catch (error) {
        console.error('[Registro] Falha de rede:', error);
        return { status: 0, body: { code: 'UNKNOWN_ERROR', message: 'Falha de rede ao chamar o CX Hub.' } };
    }

    const corpo = (await res.json().catch(() => null)) as RegistroResponse | null;
    if (!corpo || typeof corpo.code !== 'string') {
        return { status: res.status, body: { code: 'UNKNOWN_ERROR', message: `Resposta inesperada do CX Hub (HTTP ${res.status}).` } };
    }
    return { status: res.status, body: corpo };
}
