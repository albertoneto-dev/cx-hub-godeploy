import { describe, it, expect } from 'vitest';
import { validateFormDataShape } from '@shared/lib/fetchFormData';

const validPayload = {
    marcas: ['lescent', 'kokeshi'],
    responsáveis: ['Ana', 'Bruno'],
    motivos: ['Motivo A'],
    transportadoras_reenvio: [],
};

describe('validateFormDataShape (INV-01 client-side guard)', () => {
    it('returns the payload unchanged when shape is valid', () => {
        expect(validateFormDataShape(validPayload)).toBe(validPayload);
    });

    it('requires only marcas + responsáveis (motivos/transportadoras optional)', () => {
        const minimal = { marcas: ['lescent'], responsáveis: ['Ana'] };
        expect(validateFormDataShape(minimal)).toBe(minimal);
    });

    it('throws when the response is null', () => {
        expect(() => validateFormDataShape(null)).toThrow();
    });

    it('throws when the response is not an object', () => {
        expect(() => validateFormDataShape('nope')).toThrow();
    });

    it('throws when marcas is missing', () => {
        expect(() => validateFormDataShape({ responsáveis: ['Ana'] })).toThrow();
    });

    it('throws when responsáveis is missing', () => {
        expect(() => validateFormDataShape({ marcas: ['lescent'] })).toThrow();
    });

    it('throws when marcas is not an array', () => {
        expect(() => validateFormDataShape({ marcas: 'lescent', responsáveis: ['Ana'] })).toThrow();
    });

    it('throws when responsáveis is not an array', () => {
        expect(() => validateFormDataShape({ marcas: ['lescent'], responsáveis: 'Ana' })).toThrow();
    });

    it('throws when marcas is an empty array', () => {
        expect(() => validateFormDataShape({ marcas: [], responsáveis: ['Ana'] })).toThrow();
    });

    it('throws when responsáveis is an empty array', () => {
        expect(() => validateFormDataShape({ marcas: ['lescent'], responsáveis: [] })).toThrow();
    });
});
