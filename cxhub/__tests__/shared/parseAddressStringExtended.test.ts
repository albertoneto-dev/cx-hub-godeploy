import { describe, it, expect } from 'vitest';
import { parseAddressStringExtended } from '@shared/lib/cosmos/address-utils';

describe('parseAddressStringExtended', () => {
    describe('no commas — passthrough', () => {
        it('keeps logradouro and uses number arg directly', () => {
            const result = parseAddressStringExtended('Rua das Flores', '123', '');
            expect(result.logradouro).toBe('Rua das Flores');
            expect(result.numero).toBe('123');
            expect(result.complemento).toBe('');
            expect(result.bairro).toBe('');
        });

        it('returns empty strings when street is empty', () => {
            const result = parseAddressStringExtended('', '10', '');
            expect(result.logradouro).toBe('');
            expect(result.numero).toBe('10');
            expect(result.complemento).toBe('');
            expect(result.bairro).toBe('');
        });
    });

    describe('2 parts — fallback heuristic', () => {
        it('extracts number from second part when it looks numeric', () => {
            const result = parseAddressStringExtended('Rua A, 100', '', '');
            expect(result.logradouro).toBe('Rua A');
            expect(result.numero).toBe('100');
            expect(result.complemento).toBe('');
            expect(result.bairro).toBe('');
        });

        it('preserves complement arg in fallback path', () => {
            // 2-part address: complement arg is merged into result
            const result = parseAddressStringExtended('Rua Teste, 50', '', 'Apto 8');
            expect(result.logradouro).toBe('Rua Teste');
            expect(result.numero).toBe('50');
            expect(result.complemento).toBe('Apto 8');
            expect(result.bairro).toBe('');
        });
    });

    describe('3 parts — Logradouro, Número, [Complemento ou Bairro]', () => {
        it('treats third part as bairro when it has no complement prefix', () => {
            const result = parseAddressStringExtended('Rua Bahia, 255, Canto do Forte', '', '');
            expect(result.logradouro).toBe('Rua Bahia');
            expect(result.numero).toBe('255');
            expect(result.complemento).toBe('');
            expect(result.bairro).toBe('Canto do Forte');
        });

        it('treats third part as complemento when it starts with "Apto"', () => {
            const result = parseAddressStringExtended('Rua Bahia, 255, Apto 12', '', '');
            expect(result.logradouro).toBe('Rua Bahia');
            expect(result.numero).toBe('255');
            expect(result.complemento).toBe('Apto 12');
            expect(result.bairro).toBe('');
        });

        it('treats third part as complemento when it starts with "Casa"', () => {
            const result = parseAddressStringExtended('Rua X, 10, Casa', '', '');
            expect(result.complemento).toBe('Casa');
            expect(result.bairro).toBe('');
        });

        it('treats third part as complemento when it starts with "Bloco"', () => {
            const result = parseAddressStringExtended('Av. Principal, 500, Bloco B', '', '');
            expect(result.complemento).toBe('Bloco B');
            expect(result.bairro).toBe('');
        });
    });

    describe('4 parts — Logradouro, Número, Complemento, Bairro', () => {
        it('maps all four parts correctly', () => {
            const result = parseAddressStringExtended('Rua Bahia, 255, Apartamento 113, Canto do Forte', '', '');
            expect(result.logradouro).toBe('Rua Bahia');
            expect(result.numero).toBe('255');
            expect(result.complemento).toBe('Apartamento 113');
            expect(result.bairro).toBe('Canto do Forte');
        });
    });

    describe('5 parts — Logradouro, Número, Bairro, Cidade, CEP (no complement)', () => {
        it('uses third part as bairro and leaves complemento empty', () => {
            const result = parseAddressStringExtended('Rua Adílio Ramos, 1482, Bairro Alto, Curitiba, 82820-100', '', '');
            expect(result.logradouro).toBe('Rua Adílio Ramos');
            expect(result.numero).toBe('1482');
            expect(result.complemento).toBe('');
            expect(result.bairro).toBe('Bairro Alto');
        });
    });

    describe('6+ parts — Logradouro, Número, Complemento, Bairro, Cidade, CEP', () => {
        it('maps indices 0–3 and ignores cidade/CEP', () => {
            const result = parseAddressStringExtended('Rua Mário Maia, 95, Casa, Conjunto Laélia Alcântara, Rio Branco, 69914-480', '', '');
            expect(result.logradouro).toBe('Rua Mário Maia');
            expect(result.numero).toBe('95');
            expect(result.complemento).toBe('Casa');
            expect(result.bairro).toBe('Conjunto Laélia Alcântara');
        });
    });
});
