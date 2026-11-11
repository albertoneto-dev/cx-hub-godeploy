/**
 * `exp` (segundos) do payload do JWT, ou `null` se o token não for legível.
 *
 * É o que os clientes de serviço — Cosmos e Airflow — usam para decidir até quando o token cacheado vale. Não
 * valida assinatura; só lê o prazo que o emissor declarou. Só com APIs da web (`atob`, `TextDecoder`): o Worker
 * não tem `Buffer`.
 */
export function readJwtExpiry(token: string): number | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const binario = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
        const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binario, (c) => c.charCodeAt(0))));
        return typeof payload?.exp === 'number' ? payload.exp : null;
    } catch {
        return null;
    }
}
