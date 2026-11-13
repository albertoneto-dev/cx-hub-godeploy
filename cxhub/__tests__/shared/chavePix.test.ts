import { describe, expect, it } from 'vitest';
import { cnpjValido, cpfValido, normalizarChavePix, TIPOS_DE_CHAVE_PIX } from '@shared/lib/pix';

const CPF = '52998224725';
const CPF_TROCADO = '52998224726';
const CNPJ = '11222333000181';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

const erro = (r: ReturnType<typeof normalizarChavePix>) => (r.ok ? null : r.erro);

describe('cpfValido e cnpjValido', () => {
    it('conferem os dígitos verificadores', () => {
        expect(cpfValido(CPF)).toBe(true);
        expect(cpfValido(CPF_TROCADO)).toBe(false);
        expect(cnpjValido(CNPJ)).toBe(true);
        expect(cnpjValido('11222333000182')).toBe(false);
    });

    it('recusam tamanho errado, não numérico e dígitos todos iguais', () => {
        expect(cpfValido('11111111111')).toBe(false);
        expect(cnpjValido('00000000000000')).toBe(false);
        expect(cpfValido('5299822472')).toBe(false);
        expect(cpfValido('5299822472a')).toBe(false);
        expect(cnpjValido('1122233300018')).toBe(false);
    });
});

describe('normalizarChavePix — com tipo', () => {
    it('lista os cinco tipos, na ordem', () => {
        expect(TIPOS_DE_CHAVE_PIX).toEqual(['cpf', 'cnpj', 'email', 'celular', 'aleatoria']);
    });

    it('cpf e cnpj: só os dígitos', () => {
        expect(normalizarChavePix('529.982.247-25', 'cpf')).toEqual({ ok: true, chave: CPF, tipo: 'cpf' });
        expect(normalizarChavePix('11.222.333/0001-81', 'cnpj')).toEqual({ ok: true, chave: CNPJ, tipo: 'cnpj' });
    });

    it('cpf com dígito trocado é recusado, e o cnpj no tipo cpf também', () => {
        expect(erro(normalizarChavePix(CPF_TROCADO, 'cpf'))).toBe('CPF da chave Pix inválido (confira os 11 dígitos).');
        expect(erro(normalizarChavePix(CNPJ, 'cpf'))).toBe('CPF da chave Pix inválido (confira os 11 dígitos).');
        expect(erro(normalizarChavePix('11222333000182', 'cnpj'))).toBe('CNPJ da chave Pix inválido (confira os 14 dígitos).');
    });

    it('email: minúsculas, e o formato é conferido', () => {
        expect(normalizarChavePix('  Cliente@Exemplo.COM ', 'email')).toEqual({ ok: true, chave: 'cliente@exemplo.com', tipo: 'email' });
        expect(erro(normalizarChavePix('cliente@exemplo', 'email'))).toBe('E-mail da chave Pix inválido.');
        expect(erro(normalizarChavePix('a@b.c', 'email'))).toBe('E-mail da chave Pix inválido.');
        expect(erro(normalizarChavePix('cli ente@exemplo.com', 'email'))).toBe('E-mail da chave Pix inválido.');
    });

    it('celular: +55 e os dígitos, tirando zeros à esquerda e o 55', () => {
        expect(normalizarChavePix('(11) 98765-4321', 'celular')).toMatchObject({ ok: true, chave: '+5511987654321' });
        expect(normalizarChavePix('011 98765-4321', 'celular')).toMatchObject({ chave: '+5511987654321' });
        expect(normalizarChavePix('+55 11 98765-4321', 'celular')).toMatchObject({ chave: '+5511987654321' });
        expect(normalizarChavePix('55 11 3333-4444', 'celular')).toMatchObject({ chave: '+551133334444' });
        expect(normalizarChavePix('1133334444', 'celular')).toMatchObject({ chave: '+551133334444' });
        expect(erro(normalizarChavePix('12345', 'celular'))).toBe('Celular da chave Pix inválido (DDD + número).');
        expect(erro(normalizarChavePix('123456789012', 'celular'))).toBe('Celular da chave Pix inválido (DDD + número).');
    });

    it('aleatória: minúsculas, com hífens, com ou sem eles na entrada', () => {
        expect(normalizarChavePix(UUID.toUpperCase(), 'aleatoria')).toEqual({ ok: true, chave: UUID, tipo: 'aleatoria' });
        expect(normalizarChavePix(UUID.replace(/-/g, ''), 'aleatoria')).toMatchObject({ chave: UUID });
        expect(erro(normalizarChavePix('abc', 'aleatoria'))).toBe('Chave aleatória inválida (formato 8-4-4-4-12).');
    });

    it('o tipo aceita espaços e qualquer caixa; tipo desconhecido é recusado', () => {
        expect(normalizarChavePix('cliente@exemplo.com', '  EMAIL ')).toMatchObject({ ok: true, tipo: 'email' });
        expect(erro(normalizarChavePix('cliente@exemplo.com', 'telefone'))).toBe(
            'Tipo de chave Pix desconhecido: use cpf, cnpj, email, celular ou aleatoria.',
        );
    });
});

describe('normalizarChavePix — sem tipo (inferência)', () => {
    it('vazio e só espaços pedem a chave', () => {
        for (const v of ['', '   ', null, undefined]) expect(erro(normalizarChavePix(v))).toBe('Informe a chave Pix.');
        expect(erro(normalizarChavePix('', 'cpf'))).toBe('Informe a chave Pix.');
    });

    it('arroba é e-mail', () => {
        expect(normalizarChavePix('Cliente@Exemplo.com')).toEqual({ ok: true, chave: 'cliente@exemplo.com', tipo: 'email' });
        expect(erro(normalizarChavePix('cliente@'))).toBe('E-mail da chave Pix inválido.');
    });

    it('UUID, com ou sem hífens, é aleatória', () => {
        expect(normalizarChavePix(UUID)).toMatchObject({ tipo: 'aleatoria', chave: UUID });
        expect(normalizarChavePix(UUID.replace(/-/g, '').toUpperCase())).toMatchObject({ tipo: 'aleatoria', chave: UUID });
    });

    it('começando com + é celular', () => {
        expect(normalizarChavePix('+55 (11) 98765-4321')).toEqual({ ok: true, chave: '+5511987654321', tipo: 'celular' });
        expect(erro(normalizarChavePix('+1 555 1234'))).toBe('Celular da chave Pix inválido (DDD + número).');
    });

    it('14 dígitos é CNPJ, e o inválido dá o erro de CNPJ', () => {
        expect(normalizarChavePix('11.222.333/0001-81')).toEqual({ ok: true, chave: CNPJ, tipo: 'cnpj' });
        expect(erro(normalizarChavePix('11222333000182'))).toBe('CNPJ da chave Pix inválido (confira os 14 dígitos).');
    });

    it('11 dígitos: CPF válido vira cpf; com um dígito trocado vira celular', () => {
        expect(normalizarChavePix('529.982.247-25')).toEqual({ ok: true, chave: CPF, tipo: 'cpf' });
        expect(normalizarChavePix(CPF_TROCADO)).toEqual({ ok: true, chave: `+55${CPF_TROCADO}`, tipo: 'celular' });
        expect(normalizarChavePix('(11) 98765-4321')).toMatchObject({ tipo: 'celular' });
    });

    it('10 dígitos é celular; 12 ou 13 começando com 55 também', () => {
        expect(normalizarChavePix('1133334444')).toMatchObject({ tipo: 'celular', chave: '+551133334444' });
        expect(normalizarChavePix('5511987654321')).toMatchObject({ tipo: 'celular', chave: '+5511987654321' });
        expect(normalizarChavePix('551133334444')).toMatchObject({ tipo: 'celular', chave: '+551133334444' });
    });

    it('outros tamanhos e lixo dão o erro genérico', () => {
        const generico = 'Chave Pix inválida: use CPF, CNPJ, e-mail, celular com DDD ou a chave aleatória.';
        for (const v of ['abc', '12345', '123456789012', '1234567890123', 'R$ 94,82', '123456789012345']) {
            expect(erro(normalizarChavePix(v)), v).toBe(generico);
        }
    });
});

describe('normalizarChavePix — o que vem do JSON de quem chama', () => {
    it('número no lugar do texto não lança: a chave e o tipo viram texto', () => {
        const doJson = JSON.parse(`{"chave": ${CPF}, "tipo": 1}`) as { chave: string; tipo: string };
        expect(normalizarChavePix(doJson.chave)).toMatchObject({ ok: true, tipo: 'cpf', chave: CPF });
        expect(erro(normalizarChavePix(CPF, doJson.tipo))).toBe('Tipo de chave Pix desconhecido: use cpf, cnpj, email, celular ou aleatoria.');
    });
});
