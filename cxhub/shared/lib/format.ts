import { UF_TO_STATE_NAME } from './constants';

/** Formats a Brazilian phone number for display (e.g. +55 (11) 99999-9999) */
export function formatPhone(phone: string): string {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('55') && cleaned.length >= 12) {
        const ddd = cleaned.slice(2, 4);
        const number = cleaned.slice(4);
        const formattedNumber = number.length === 9
            ? `${number.slice(0, 5)}-${number.slice(5)}`
            : `${number.slice(0, 4)}-${number.slice(4)}`;
        return `+55 (${ddd}) ${formattedNumber}`;
    }
    return phone;
}

/**
 * Só os dígitos do CEP.
 *
 * Não é uma convenção nossa: o Cosmos normaliza o CEP removendo todo não-dígito antes de aplicar as
 * regras de roteamento (Confluence GO/1417117699 §3.2 e §21.2). Por isso o hífen é irrelevante e o valor
 * segue adiante **como veio** — quem sanitiza é o ERP; aqui só se conta.
 */
export function cepDigits(cep: string | null | undefined): string {
    return (cep ?? '').replace(/\D/g, '');
}

/**
 * CEP bem-formado = exatamente 8 dígitos, a mesma régua que o ERP exige (§21.2).
 *
 * **Bem-formado não é correto:** um CEP de 8 dígitos que não casa com faixa de roteamento nenhuma faz o
 * Cosmos salvar o reenvio *sem CD e sem ERP, sem falha alguma* (§13.7) — fica parado e ninguém é avisado.
 * Descartar esse caso exigiria consulta externa, que está fora de escopo por decisão registrada.
 */
export function isCepValido(cep: string | null | undefined): boolean {
    return /^\d{8}$/.test(cepDigits(cep));
}

const FORMATO_SP = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
});

/**
 * `dd/MM/yyyy HH:mm:ss` no fuso de São Paulo — o carimbo que as mensagens mostram ao agente (ex.: "feito por
 * Ana em 28/10/2026 15:04:12"). Montado por partes porque a pontuação entre data e hora do `toLocaleString`
 * depende da versão do ICU do runtime.
 */
export function formatarCarimboSP(data: Date): string {
    const p = Object.fromEntries(FORMATO_SP.formatToParts(data).map((parte) => [parte.type, parte.value]));
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** `dd/MM/yyyy` no fuso de São Paulo: o "hoje" que a planilha e a gold guardam como data de execução. */
export function formatarDataSP(data: Date): string {
    return formatarCarimboSP(data).slice(0, 10);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `true` quando o texto é um UUID (`8-4-4-4-12` em hexadecimal, em qualquer caixa), o formato do `id_solicitacao` que
 * o CX Hub gera na criação do caso. Sem trim: quem chama decide se limpa o texto antes.
 */
export function isUuid(valor: string): boolean {
    return UUID.test(valor);
}

const DATA_BR = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * A data `dias` dias úteis depois de `data` (`dd/MM/yyyy`), no mesmo formato — o `WORKDAY` da planilha, sem feriados:
 * o próprio dia não conta, sábado e domingo são pulados. É o "Prazo para o reembolso" das marcas sem Cosmos (ADR-013),
 * contado da data do carimbo (que já é a de São Paulo). Data fora do formato ⇒ `''`.
 */
export function somarDiasUteis(data: string, dias: number): string {
    const m = DATA_BR.exec(data.trim());
    if (!m) return '';
    // Meio-dia em UTC: a conta é de calendário, e nenhum fuso desloca o dia.
    const dia = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12));
    if (dia.getUTCDate() !== Number(m[1]) || dia.getUTCMonth() !== Number(m[2]) - 1) return '';
    for (let contados = 0; contados < dias;) {
        dia.setUTCDate(dia.getUTCDate() + 1);
        if (dia.getUTCDay() !== 0 && dia.getUTCDay() !== 6) contados++;
    }
    const doisDigitos = (n: number) => String(n).padStart(2, '0');
    return `${doisDigitos(dia.getUTCDate())}/${doisDigitos(dia.getUTCMonth() + 1)}/${dia.getUTCFullYear()}`;
}

/** `RJ` → `Rio de Janeiro (RJ)`, como as planilhas das marcas sem Cosmos guardam o estado. Fora da lista de UFs, como veio. */
export function estadoComSigla(estado: string | null | undefined): string {
    const uf = (estado ?? '').trim().toUpperCase();
    const nome = UF_TO_STATE_NAME[uf];
    return nome ? `${nome} (${uf})` : (estado ?? '');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHAVE_ALEATORIA = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * A chave Pix tem um dos formatos que o Banco Central aceita: CPF (11 dígitos), CNPJ (14), telefone (10 ou 11 dígitos,
 * com ou sem o `+55`), e-mail ou chave aleatória (UUID, com ou sem hífen). Pontuação de CPF, CNPJ e telefone não
 * importa. Só confere o **formato**: os dígitos verificadores e a existência da chave ficam com quem paga.
 *
 * ⚠️ Chave Pix é dado pessoal sensível: quem chama não loga o valor.
 */
export function ehChavePixValida(valor: string): boolean {
    const texto = valor.trim();
    if (!texto) return false;
    if (texto.includes('@')) return EMAIL.test(texto);
    if (CHAVE_ALEATORIA.test(texto)) return true;
    // Fora e-mail e chave aleatória, só dígitos e a pontuação de documento e telefone.
    if (!/^\+?[\d\s.\-/()]+$/.test(texto)) return false;
    const digitos = texto.replace(/\D/g, '');
    const semPais = texto.startsWith('+') && digitos.startsWith('55') ? digitos.slice(2) : digitos;
    if (texto.startsWith('+')) return semPais.length === 10 || semPais.length === 11;
    return [10, 11, 14].includes(digitos.length);
}
