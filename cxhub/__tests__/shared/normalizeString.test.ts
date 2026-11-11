import { describe, it, expect } from 'vitest';
import { normalizeString } from '@shared/lib/cosmos/address-utils';

describe('normalizeString', () => {
    it('removes acute accent and lowercases', () => {
        expect(normalizeString('Miréia')).toBe('mireia');
    });

    it('removes accents from multiple characters', () => {
        expect(normalizeString('São Paulo')).toBe('sao paulo');
    });

    it('converts uppercase to lowercase', () => {
        expect(normalizeString('UPPERCASE')).toBe('uppercase');
    });

    it('removes grave accent', () => {
        expect(normalizeString('já')).toBe('ja');
    });

    it('removes cedilha', () => {
        expect(normalizeString('Coração')).toBe('coracao');
    });

    it('preserves spaces', () => {
        expect(normalizeString('Vila Mariana')).toBe('vila mariana');
    });

    it('returns empty string for empty input', () => {
        expect(normalizeString('')).toBe('');
    });

    it('returns empty string for null', () => {
        expect(normalizeString(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
        expect(normalizeString(undefined)).toBe('');
    });

    it('leaves strings without accents unchanged (only lowercased)', () => {
        expect(normalizeString('centro')).toBe('centro');
    });
});
