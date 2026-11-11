/**
 * Espera antes da 2ª e da 3ª tentativa. Uma etapa (consulta ao Metabase ou disparo da DAG) estourando o
 * timeout nas três tentativas fica perto de 19s, mais as renovações de token no disparo.
 */
export const ESPERAS_RETENTATIVA_MS = [1_000, 3_000];

export type ResultadoTentativas<T> =
    | { ok: true; valor: T; tentativas: number }
    | { ok: false; erro: unknown; tentativas: number };

/**
 * Chama `fn` até dar certo, esperando `ESPERAS_RETENTATIVA_MS` entre as tentativas. Erro que não é
 * `transitorio` para na hora: recusa não melhora com retentativa. Nunca lança.
 */
export async function tentarComRetentativa<T>(
    fn: () => Promise<T>,
    transitorio: (erro: unknown) => boolean,
    esperar: (ms: number) => Promise<void>,
    aoFalhar: (erro: unknown, tentativa: number) => void = () => {},
): Promise<ResultadoTentativas<T>> {
    let ultimoErro: unknown;
    let tentativas = 0;
    for (let i = 0; i <= ESPERAS_RETENTATIVA_MS.length; i++) {
        if (i > 0) await esperar(ESPERAS_RETENTATIVA_MS[i - 1]);
        tentativas++;
        try {
            return { ok: true, valor: await fn(), tentativas };
        } catch (erro) {
            ultimoErro = erro;
            aoFalhar(erro, tentativas);
            if (!transitorio(erro)) break;
        }
    }
    return { ok: false, erro: ultimoErro, tentativas };
}

export function esperar(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
