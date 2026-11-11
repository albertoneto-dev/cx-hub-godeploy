import { vi } from 'vitest';

/**
 * As esperas da retentativa da planilha (a escada da cota, `shared/lib/sheets/server.ts`) são `setTimeout` de verdade:
 * com o relógio falso, o teste anda o tempo até a promessa terminar, sem esperar de verdade — e cada espera vence no
 * instante exato em que venceria (o `Date.now()` anda junto).
 */

/** Liga o relógio falso (`setTimeout`, `clearTimeout` e `Date`), parado no instante dado. Desligue com `vi.useRealTimers()`. */
export function ligarRelogioFalso(agora: Date = new Date('2026-11-11T12:00:00.000Z')): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(agora);
}

/**
 * Anda o relógio falso em passos curtos até a promessa terminar (ou até `limiteMs` de tempo falso) e a devolve como
 * terminou, resolvida ou rejeitada.
 *
 * Só no app do GoDeploy: sem timer falso pendente, espera a vez de verdade (`setImmediate`, que não é falso) em vez de
 * andar o relógio. Aqui o JWT do Google é assinado pelo WebCrypto, assíncrono de verdade (no CX Hub, o `createSign` é
 * síncrono), e andar o relógio enquanto ele assina só empurrava o `Date.now()`, sem vencer timer nenhum.
 */
export async function ateTerminar<T>(promessa: Promise<T>, { passoMs = 50, limiteMs = 120_000 } = {}): Promise<T> {
    let terminou = false;
    promessa.then(() => { terminou = true; }, () => { terminou = true; });
    const limiteReal = performance.now() + 10_000;
    for (let andado = 0; !terminou && andado < limiteMs && performance.now() < limiteReal;) {
        if (vi.getTimerCount() === 0) {
            await new Promise((resolve) => setImmediate(resolve));
            continue;
        }
        await vi.advanceTimersByTimeAsync(passoMs);
        andado += passoMs;
    }
    return promessa;
}
