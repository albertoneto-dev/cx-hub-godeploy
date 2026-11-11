import { describe, it, expect } from 'vitest';
import {
    CODE_CATEGORY,
    WEBHOOK_SUCCESS_CODES,
    WEBHOOK_KNOWN_CODES,
} from '@modules/logistica/types';
import type { LogisticaResponseCode, LogisticaCodeCategory } from '@modules/logistica/types';

/**
 * Todos os LogisticaResponseCode definidos no tipo union.
 * Mantido sincronizado manualmente — se o tipo mudar, o TypeScript vai
 * reclamar que faltam/sobram entradas, forçando atualização aqui.
 */
const ALL_RESPONSE_CODES: LogisticaResponseCode[] = [
    // Sucesso
    'DELAY_TICKET_CREATED',
    'INVESTIGATION_CREATED',
    'ADDRESS_TICKET_CREATED',
    // Informacional
    'TICKET_EXISTS',
    'TICKET_COMPLETED',
    'ORDER_ON_TIME',
    'ORDER_NOT_SENT',
    // Rejeição
    'INVESTIGATION_INVALID',
    'AVARIA_INVALID',
    'BARRA_ENTREGA_INVALID',
    'ADDRESS_MISSING',
    // Escalação
    'DELAY_ESCALATED',
    'INVESTIGATION_EXPIRED',
    'CARRIER_NOT_AUTOMATED',
    'TICKET_DEADLINE_EXPIRED',
    // Erro
    'ORDER_FETCH_FAILED',
    'API_TIMEOUT',
    'UNKNOWN_ERROR',
];

const VALID_CATEGORIES: LogisticaCodeCategory[] = [
    'success',
    'info',
    'rejection',
    'escalation',
    'error',
];

describe('CODE_CATEGORY', () => {
    it('todo LogisticaResponseCode tem uma entrada em CODE_CATEGORY', () => {
        for (const code of ALL_RESPONSE_CODES) {
            expect(CODE_CATEGORY[code], `CODE_CATEGORY faltando para "${code}"`).toBeDefined();
        }
    });

    it('todo valor de CODE_CATEGORY é uma LogisticaCodeCategory válida', () => {
        for (const [code, category] of Object.entries(CODE_CATEGORY)) {
            expect(
                VALID_CATEGORIES.includes(category as LogisticaCodeCategory),
                `Categoria inválida "${category}" para código "${code}"`,
            ).toBe(true);
        }
    });

    it('não há chaves em CODE_CATEGORY que não sejam LogisticaResponseCode', () => {
        const codeKeys = Object.keys(CODE_CATEGORY);
        for (const key of codeKeys) {
            expect(
                ALL_RESPONSE_CODES.includes(key as LogisticaResponseCode),
                `CODE_CATEGORY contém código desconhecido "${key}" — adicione-o em ALL_RESPONSE_CODES se for novo`,
            ).toBe(true);
        }
    });

    it('CODE_CATEGORY tem exatamente o mesmo número de entradas que LogisticaResponseCode', () => {
        expect(Object.keys(CODE_CATEGORY)).toHaveLength(ALL_RESPONSE_CODES.length);
    });
});

describe('WEBHOOK_SUCCESS_CODES', () => {
    it('contém exatamente os 3 códigos de criação de ticket', () => {
        expect([...WEBHOOK_SUCCESS_CODES].sort()).toEqual([
            'ADDRESS_TICKET_CREATED',
            'DELAY_TICKET_CREATED',
            'INVESTIGATION_CREATED',
        ]);
    });

    it('são todos classificados como "success" em CODE_CATEGORY', () => {
        for (const code of WEBHOOK_SUCCESS_CODES) {
            expect(
                CODE_CATEGORY[code as LogisticaResponseCode],
                `WEBHOOK_SUCCESS_CODES contém "${code}" mas CODE_CATEGORY não o classifica como "success"`,
            ).toBe('success');
        }
    });

    it('todo código "success" em CODE_CATEGORY está em WEBHOOK_SUCCESS_CODES', () => {
        const successCodes = ALL_RESPONSE_CODES.filter((c) => CODE_CATEGORY[c] === 'success');
        for (const code of successCodes) {
            expect(
                (WEBHOOK_SUCCESS_CODES as readonly string[]).includes(code),
                `"${code}" é "success" em CODE_CATEGORY mas não está em WEBHOOK_SUCCESS_CODES`,
            ).toBe(true);
        }
    });
});

describe('WEBHOOK_KNOWN_CODES', () => {
    it('é subconjunto de LogisticaResponseCode', () => {
        for (const code of WEBHOOK_KNOWN_CODES) {
            expect(
                ALL_RESPONSE_CODES.includes(code as LogisticaResponseCode),
                `WEBHOOK_KNOWN_CODES contém "${code}" que não é um LogisticaResponseCode`,
            ).toBe(true);
        }
    });

    it('contém todos os WEBHOOK_SUCCESS_CODES', () => {
        for (const code of WEBHOOK_SUCCESS_CODES) {
            expect(
                (WEBHOOK_KNOWN_CODES as readonly string[]).includes(code),
                `WEBHOOK_SUCCESS_CODES contém "${code}" mas está ausente de WEBHOOK_KNOWN_CODES`,
            ).toBe(true);
        }
    });

    it('não contém códigos de infraestrutura (API_TIMEOUT, UNKNOWN_ERROR)', () => {
        const infraCodes = ['API_TIMEOUT', 'UNKNOWN_ERROR'];
        for (const code of infraCodes) {
            expect(
                (WEBHOOK_KNOWN_CODES as readonly string[]).includes(code),
                `"${code}" é código de infraestrutura e não deveria estar em WEBHOOK_KNOWN_CODES`,
            ).toBe(false);
        }
    });

    it('não contém ORDER_NOT_SENT (normalizado do typo "ORDER NO SENT")', () => {
        // ORDER_NOT_SENT é criado por normalização no route handler,
        // o worker real retorna "ORDER NO SENT" — portanto este código
        // não deve aparecer literalmente em WEBHOOK_KNOWN_CODES.
        expect(
            (WEBHOOK_KNOWN_CODES as readonly string[]).includes('ORDER_NOT_SENT'),
        ).toBe(false);
    });

    it('não contém os códigos que o route handler desdobra (ESCALATE_TO_HUMAN)', () => {
        // O worker devolve `ESCALATE_TO_HUMAN` para dois casos distintos; o
        // route handler os separa em TICKET_DEADLINE_EXPIRED / ORDER_FETCH_FAILED
        // pela presença de `ticket_id`. Nenhum dos dois vem literalmente do worker.
        for (const code of ['ESCALATE_TO_HUMAN', 'TICKET_DEADLINE_EXPIRED', 'ORDER_FETCH_FAILED']) {
            expect(
                (WEBHOOK_KNOWN_CODES as readonly string[]).includes(code),
                `"${code}" não deveria estar em WEBHOOK_KNOWN_CODES`,
            ).toBe(false);
        }
    });
});
