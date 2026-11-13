/**
 * A chave Pix das marcas sem Cosmos (ADR-013): valida e normaliza para a forma em que a planilha a guarda. A regra veio
 * do app antigo dessas marcas.
 *
 * ⚠️ Chave Pix é dado pessoal sensível: nada aqui loga o valor, e quem chama também não deve.
 */

export type TipoDeChavePix = 'cpf' | 'cnpj' | 'email' | 'celular' | 'aleatoria';

export const TIPOS_DE_CHAVE_PIX: readonly TipoDeChavePix[] = ['cpf', 'cnpj', 'email', 'celular', 'aleatoria'];

export type ChavePixNormalizada = { ok: true; chave: string; tipo: TipoDeChavePix } | { ok: false; erro: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const ERRO: Record<TipoDeChavePix | 'generico', string> = {
    cpf: 'CPF da chave Pix inválido (confira os 11 dígitos).',
    cnpj: 'CNPJ da chave Pix inválido (confira os 14 dígitos).',
    email: 'E-mail da chave Pix inválido.',
    celular: 'Celular da chave Pix inválido (DDD + número).',
    aleatoria: 'Chave aleatória inválida (formato 8-4-4-4-12).',
    generico: 'Chave Pix inválida: use CPF, CNPJ, e-mail, celular com DDD ou a chave aleatória.',
};

const ERRO_TIPO_DESCONHECIDO = 'Tipo de chave Pix desconhecido: use cpf, cnpj, email, celular ou aleatoria.';

const todosIguais = (digitos: string) => /^(\d)\1+$/.test(digitos);

/** O verificador do CPF: os `tamanho` primeiros dígitos com pesos `tamanho + 1` até 2. */
function digitoDoCpf(digitos: string, tamanho: number): number {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(digitos[i]) * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
}

/** CPF de 11 dígitos, com os dois verificadores certos e não todos iguais. */
export function cpfValido(digitos: string): boolean {
    if (!/^\d{11}$/.test(digitos) || todosIguais(digitos)) return false;
    return digitoDoCpf(digitos, 9) === Number(digitos[9]) && digitoDoCpf(digitos, 10) === Number(digitos[10]);
}

const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digitoDoCnpj(digitos: string, pesos: number[]): number {
    const soma = pesos.reduce((s, peso, i) => s + Number(digitos[i]) * peso, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
}

/** CNPJ de 14 dígitos, com os dois verificadores certos e não todos iguais. */
export function cnpjValido(digitos: string): boolean {
    if (!/^\d{14}$/.test(digitos) || todosIguais(digitos)) return false;
    return digitoDoCnpj(digitos, PESOS_CNPJ_1) === Number(digitos[12]) && digitoDoCnpj(digitos, PESOS_CNPJ_2) === Number(digitos[13]);
}

function comoCelular(valor: string): string | null {
    let digitos = valor.replace(/\D/g, '').replace(/^0+/, '');
    if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) digitos = digitos.slice(2);
    return digitos.length === 10 || digitos.length === 11 ? `+55${digitos}` : null;
}

function comoAleatoria(valor: string): string | null {
    if (!UUID.test(valor)) return null;
    const h = valor.replace(/-/g, '').toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A chave do tipo pedido, na forma gravada; `null` quando o valor não é uma chave válida daquele tipo. */
function normalizarComoTipo(valor: string, tipo: TipoDeChavePix): string | null {
    switch (tipo) {
        case 'cpf': {
            const digitos = valor.replace(/\D/g, '');
            return cpfValido(digitos) ? digitos : null;
        }
        case 'cnpj': {
            const digitos = valor.replace(/\D/g, '');
            return cnpjValido(digitos) ? digitos : null;
        }
        case 'email':
            return EMAIL.test(valor) ? valor.toLowerCase() : null;
        case 'celular':
            return comoCelular(valor);
        case 'aleatoria':
            return comoAleatoria(valor);
    }
}

/** O tipo mais provável de uma chave sem tipo declarado; `null` quando nada serve. */
function inferirTipo(valor: string): TipoDeChavePix | null {
    if (valor.includes('@')) return 'email';
    if (UUID.test(valor)) return 'aleatoria';
    if (valor.startsWith('+')) return 'celular';
    if (!/^[\d\s.\-/()]+$/.test(valor)) return null;
    const digitos = valor.replace(/\D/g, '');
    if (digitos.length === 14) return 'cnpj';
    if (digitos.length === 11) return cpfValido(digitos) ? 'cpf' : 'celular';
    if (digitos.length === 10) return 'celular';
    if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) return 'celular';
    return null;
}

/**
 * Valida a chave Pix e a devolve normalizada (CPF/CNPJ só dígitos, e-mail em minúsculas, celular `+55…`, aleatória
 * em minúsculas com hífens). Com `tipo`, vale só aquele tipo; sem ele, o tipo é inferido pelo formato.
 */
export function normalizarChavePix(valor: string | null | undefined, tipo?: string | null): ChavePixNormalizada {
    // `String(...)`: a chave e o tipo vêm do JSON de quem chama, e um número no lugar do texto não pode virar 500.
    const texto = String(valor ?? '').trim();
    if (!texto) return { ok: false, erro: 'Informe a chave Pix.' };

    let tipoFinal: TipoDeChavePix | null;
    if (tipo !== undefined && tipo !== null) {
        const pedido = String(tipo).trim().toLowerCase();
        const conhecido = TIPOS_DE_CHAVE_PIX.find((t) => t === pedido);
        if (!conhecido) return { ok: false, erro: ERRO_TIPO_DESCONHECIDO };
        tipoFinal = conhecido;
    } else {
        tipoFinal = inferirTipo(texto);
    }
    if (!tipoFinal) return { ok: false, erro: ERRO.generico };

    const chave = normalizarComoTipo(texto, tipoFinal);
    return chave === null ? { ok: false, erro: ERRO[tipoFinal] } : { ok: true, chave, tipo: tipoFinal };
}
