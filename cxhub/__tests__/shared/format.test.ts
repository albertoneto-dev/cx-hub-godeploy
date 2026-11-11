import { describe, it, expect } from 'vitest';
import { formatPhone, cepDigits, isCepValido, formatarDataSP, isUuid } from '@shared/lib/format';

describe('formatarDataSP', () => {
    it('é o dia de São Paulo, não o de UTC: 01:30 UTC de 31/10 ainda é 30/10 em São Paulo', () => {
        expect(formatarDataSP(new Date('2026-10-31T01:30:00Z'))).toBe('30/10/2026');
    });

    it('depois das 03:00 UTC já é o mesmo dia nos dois fusos', () => {
        expect(formatarDataSP(new Date('2026-10-31T15:00:00Z'))).toBe('31/10/2026');
    });

    it('vira o dia às 03:00 UTC (UTC-3, sem horário de verão)', () => {
        expect(formatarDataSP(new Date('2026-10-31T02:59:59Z'))).toBe('30/10/2026');
        expect(formatarDataSP(new Date('2026-10-31T03:00:00Z'))).toBe('31/10/2026');
    });

    it('dia e mês com zero à esquerda', () => {
        expect(formatarDataSP(new Date('2026-03-05T15:00:00Z'))).toBe('05/03/2026');
    });
});

describe('formatPhone', () => {
    it('formata número BR com 9 dígitos (celular)', () => {
        expect(formatPhone('5511999887766')).toBe('+55 (11) 99988-7766');
    });

    it('formata número BR com 8 dígitos (fixo)', () => {
        expect(formatPhone('551133445566')).toBe('+55 (11) 3344-5566');
    });

    it('retorna sem alteração quando não começa com 55', () => {
        expect(formatPhone('1234567890')).toBe('1234567890');
    });

    it('retorna sem alteração quando curto demais', () => {
        expect(formatPhone('5511')).toBe('5511');
    });

    it('lida com caracteres não numéricos', () => {
        expect(formatPhone('+55 (11) 99988-7766')).toBe('+55 (11) 99988-7766');
    });
});

// A régua destes dois é a MESMA do Cosmos, não uma escolha nossa: o ERP normaliza removendo todo
// não-dígito e exige exatamente 8 dígitos (Confluence GO/1417117699 §3.2 e §21.2). Por isso o hífen é
// irrelevante e não há normalização a fazer antes de mandar o valor adiante.
describe('cepDigits', () => {
    it('remove o hífen', () => {
        expect(cepDigits('29101-290')).toBe('29101290');
    });

    it('devolve inalterado o que já é só dígito', () => {
        expect(cepDigits('29101290')).toBe('29101290');
    });

    it('remove ponto e espaço em volta', () => {
        expect(cepDigits(' 29.101-290 ')).toBe('29101290');
    });

    it('descarta letras', () => {
        expect(cepDigits('2910abc1290')).toBe('29101290');
    });

    it('string vazia vira vazia', () => {
        expect(cepDigits('')).toBe('');
    });

    it('nulo e ausente viram vazio — nunca undefined (RF-14)', () => {
        expect(cepDigits(null)).toBe('');
        expect(cepDigits(undefined)).toBe('');
    });
});

describe('isCepValido', () => {
    it('aceita 8 dígitos com hífen', () => {
        expect(isCepValido('29101-290')).toBe(true);
    });

    it('aceita 8 dígitos sem hífen', () => {
        expect(isCepValido('29101290')).toBe(true);
    });

    it('aceita hífen fora de posição — o ERP só conta dígitos', () => {
        expect(isCepValido('2910-1290')).toBe(true);
    });

    it('recusa 7 dígitos', () => {
        expect(isCepValido('2910129')).toBe(false);
    });

    it('recusa 9 dígitos', () => {
        expect(isCepValido('291012900')).toBe(false);
    });

    it('recusa texto sem dígito', () => {
        expect(isCepValido('abc')).toBe(false);
    });

    it('recusa vazio, nulo e ausente', () => {
        expect(isCepValido('')).toBe(false);
        expect(isCepValido(null)).toBe(false);
        expect(isCepValido(undefined)).toBe(false);
    });
});

describe('isUuid', () => {
    it.each([
        '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f',
        '6F1C0E2A-1111-4C2B-9D3E-0A1B2C3D4E5F',
        '00000000-0000-0000-0000-000000000000',
    ])('aceita %s', (valor) => {
        expect(isUuid(valor)).toBe(true);
    });

    it.each([
        ['vazio', ''],
        ['marcador de teste', '<id>'],
        ['sem hífens', '6f1c0e2a11114c2b9d3e0a1b2c3d4e5f'],
        ['curto', '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5'],
        ['longo', '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f0'],
        ['com letra fora do hexadecimal', '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5g'],
        ['com espaço nas pontas', ' 6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f '],
        ['com quebra de linha no fim', '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f\n'],
        ['dois ids colados', '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f 6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f'],
    ])('recusa %s', (_nome, valor) => {
        expect(isUuid(valor)).toBe(false);
    });
});
