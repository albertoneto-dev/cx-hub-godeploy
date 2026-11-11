import { describe, it, expect } from 'vitest';
import { resolveCdOrigem, formatCdOrigem } from '@shared/lib/shopify/cd-utils';

describe('resolveCdOrigem', () => {
    describe('barbours', () => {
        it('SP → SP', () => {
            expect(resolveCdOrigem('SP', 'barbours')).toBe('SP');
        });

        it('RJ → RJ', () => {
            expect(resolveCdOrigem('RJ', 'barbours')).toBe('RJ');
        });

        it('MG → ES (outros estados)', () => {
            expect(resolveCdOrigem('MG', 'barbours')).toBe('ES');
        });

        it('ES → ES', () => {
            expect(resolveCdOrigem('ES', 'barbours')).toBe('ES');
        });
    });

    describe('lescent', () => {
        it('SP → SP', () => {
            expect(resolveCdOrigem('SP', 'lescent')).toBe('SP');
        });

        it('RJ → ES (lescent não tem CD RJ)', () => {
            expect(resolveCdOrigem('RJ', 'lescent')).toBe('ES');
        });

        it('MG → ES', () => {
            expect(resolveCdOrigem('MG', 'lescent')).toBe('ES');
        });
    });

    describe('kokeshi', () => {
        it('SP → SP', () => {
            expect(resolveCdOrigem('SP', 'kokeshi')).toBe('SP');
        });

        it('RJ → ES', () => {
            expect(resolveCdOrigem('RJ', 'kokeshi')).toBe('ES');
        });
    });

    describe('bysamia', () => {
        it('SP → SP', () => {
            expect(resolveCdOrigem('SP', 'bysamia')).toBe('SP');
        });

        it('SC → ES', () => {
            expect(resolveCdOrigem('SC', 'bysamia')).toBe('ES');
        });
    });

    describe('aua', () => {
        it('SP → SP', () => {
            expect(resolveCdOrigem('SP', 'aua')).toBe('SP');
        });

        it('PR → ES', () => {
            expect(resolveCdOrigem('PR', 'aua')).toBe('ES');
        });
    });

    describe('rituaria', () => {
        it('SP → SP', () => {
            expect(resolveCdOrigem('SP', 'rituaria')).toBe('SP');
        });

        it('RJ → RJ', () => {
            expect(resolveCdOrigem('RJ', 'rituaria')).toBe('RJ');
        });

        it('MG → ES (outros estados)', () => {
            expect(resolveCdOrigem('MG', 'rituaria')).toBe('ES');
        });

        it('ES → ES', () => {
            expect(resolveCdOrigem('ES', 'rituaria')).toBe('ES');
        });
    });

    describe('UF vazia', () => {
        it('string vazia → "-"', () => {
            expect(resolveCdOrigem('', 'lescent')).toBe('-');
        });

        it('string vazia para barbours → "-"', () => {
            expect(resolveCdOrigem('', 'barbours')).toBe('-');
        });
    });
});

describe('formatCdOrigem', () => {
    it('SP → "CD SP"', () => {
        expect(formatCdOrigem('SP')).toBe('CD SP');
    });

    it('ES → "CD ES"', () => {
        expect(formatCdOrigem('ES')).toBe('CD ES');
    });

    it('RJ → "CD RJ"', () => {
        expect(formatCdOrigem('RJ')).toBe('CD RJ');
    });

    it('"-" → ""', () => {
        expect(formatCdOrigem('-')).toBe('');
    });

    it('string vazia → ""', () => {
        expect(formatCdOrigem('')).toBe('');
    });
});
