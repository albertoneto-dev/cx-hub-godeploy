import { describe, it, expect } from 'vitest';
import { readJwtExpiry } from '@shared/lib/jwt';

function jwt(payload: unknown): string {
    return ['cabecalho', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'assinatura'].join('.');
}

describe('readJwtExpiry', () => {
    it('lê o exp (segundos) do payload', () => {
        expect(readJwtExpiry(jwt({ exp: 1_800_000_000, sub: 'svc' }))).toBe(1_800_000_000);
    });

    it('devolve null sem exp numérico', () => {
        expect(readJwtExpiry(jwt({ sub: 'svc' }))).toBeNull();
        expect(readJwtExpiry(jwt({ exp: '1800000000' }))).toBeNull();
    });

    it('devolve null para token que não é JWT', () => {
        expect(readJwtExpiry('opaco')).toBeNull();
        expect(readJwtExpiry('a.@@@.c')).toBeNull();
        expect(readJwtExpiry('')).toBeNull();
    });
});
