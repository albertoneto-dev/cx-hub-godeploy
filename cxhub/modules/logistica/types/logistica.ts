// Logistica-specific types

import type { NormalizedAddress } from '../../../shared/types/index';

// ─── Problem Types ──────────────────────────────────────────────────

export type LogisticaProblema = 'Pedido Atrasado' | 'Acareação' | 'Endereço Errado' | 'Barra Entrega';

export const PROBLEMAS: LogisticaProblema[] = [
    'Pedido Atrasado',
    'Acareação',
    'Endereço Errado',
    'Barra Entrega',
];

/**
 * Problema exibido na UI → string `issue` que o worker `cx-ticketcreator`
 * aceita em `POST /gogroup-tickets-clind`.
 *
 * O worker usa o vocabulário SEM acento (`Acareacao`, `Endereco Errado`) e
 * snake_case minúsculo para barra de entrega (`barra_entrega`). Enviar o
 * rótulo acentuado da UI resulta em `400 payload inválido`.
 *
 * O worker também aceita `Avaria` e `Extravio`, que a UI ainda não oferece.
 */
export const ISSUE_MAP: Record<LogisticaProblema, string> = {
    'Pedido Atrasado': 'Pedido Atrasado',
    'Acareação': 'Acareacao',
    'Endereço Errado': 'Endereco Errado',
    'Barra Entrega': 'barra_entrega',
};

// ─── Form State Types ───────────────────────────────────────────────

export interface LogisticaFormData {
    responsavel: string;
    problema: LogisticaProblema | '';
    marca: string;
    numeroPedido: string;
}

export type LogisticaAddressData = NormalizedAddress;

// ─── Response Types ─────────────────────────────────────────────────

/**
 * Códigos que o módulo logística reconhece. Mapeiam 1:1 para os desfechos
 * do worker `cx-ticketcreator` (`POST /gogroup-tickets-clind`), mais erros
 * de infraestrutura (`API_TIMEOUT`, `UNKNOWN_ERROR`).
 *
 * Desfecho de negócio vem SEMPRE em HTTP 200, no campo `code`. HTTP 400
 * (payload inválido) e 401 (secret ausente/errado) são falhas de integração
 * e degradam para `UNKNOWN_ERROR`.
 *
 * `ESCALATE_TO_HUMAN` do worker significa "pedido não achado OU prazo
 * vencido" — o route handler separa os dois pela presença de `ticket_id`:
 * com ticket → `TICKET_DEADLINE_EXPIRED`, sem → `ORDER_FETCH_FAILED`.
 */
export type LogisticaResponseCode =
    // ─── Sucesso: ticket criado ─────────────────────────────────────
    | 'DELAY_TICKET_CREATED'
    | 'INVESTIGATION_CREATED'
    | 'ADDRESS_TICKET_CREATED'
    // ─── Informacional: nenhum ticket necessário ou duplicado ───────
    | 'TICKET_EXISTS'
    | 'TICKET_COMPLETED'
    | 'ORDER_ON_TIME'
    | 'ORDER_NOT_SENT'
    // ─── Rejeitado: regra de negócio bloqueia a criação ─────────────
    | 'INVESTIGATION_INVALID'
    | 'AVARIA_INVALID'
    | 'BARRA_ENTREGA_INVALID'
    | 'ADDRESS_MISSING'
    // ─── Escalação: requer intervenção humana ───────────────────────
    | 'DELAY_ESCALATED'
    | 'INVESTIGATION_EXPIRED'
    | 'CARRIER_NOT_AUTOMATED'
    | 'TICKET_DEADLINE_EXPIRED'
    // ─── Erro de busca de pedido ─────────────────────────────────────
    | 'ORDER_FETCH_FAILED'
    // ─── Erros de infraestrutura ────────────────────────────────────
    | 'API_TIMEOUT'
    | 'UNKNOWN_ERROR';

/** Categoria UX que agrupa códigos com mesma apresentação visual. */
export type LogisticaCodeCategory = 'success' | 'info' | 'rejection' | 'escalation' | 'error';

/**
 * Conjunto de códigos que o worker retorna indicando ticket criado.
 * Usado pelo route handler para classificar como sucesso.
 */
export const WEBHOOK_SUCCESS_CODES = [
    'DELAY_TICKET_CREATED',
    'INVESTIGATION_CREATED',
    'ADDRESS_TICKET_CREATED',
] as const;

/**
 * Todos os códigos que o worker devolve literalmente em `code` e que
 * passam direto para o app, sem tradução.
 *
 * Ficam de fora, de propósito:
 *  - `ESCALATE_TO_HUMAN` — o route handler o desdobra em
 *    `TICKET_DEADLINE_EXPIRED` / `ORDER_FETCH_FAILED` pela presença de `ticket_id`;
 *  - `ORDER_NOT_SENT` — o worker devolve `"ORDER NO SENT"` (com espaço, sem o
 *    "T" de NOT); normalizamos na borda da API route;
 *  - `API_TIMEOUT` / `UNKNOWN_ERROR` — só o app os produz.
 */
export const WEBHOOK_KNOWN_CODES = [
    'DELAY_TICKET_CREATED',
    'INVESTIGATION_CREATED',
    'ADDRESS_TICKET_CREATED',
    'TICKET_EXISTS',
    'TICKET_COMPLETED',
    'ORDER_ON_TIME',
    'INVESTIGATION_INVALID',
    'AVARIA_INVALID',
    'BARRA_ENTREGA_INVALID',
    'ADDRESS_MISSING',
    'DELAY_ESCALATED',
    'INVESTIGATION_EXPIRED',
    'CARRIER_NOT_AUTOMATED',
] as const;

/** Mapa código → categoria UX. */
export const CODE_CATEGORY: Record<LogisticaResponseCode, LogisticaCodeCategory> = {
    DELAY_TICKET_CREATED: 'success',
    INVESTIGATION_CREATED: 'success',
    ADDRESS_TICKET_CREATED: 'success',
    TICKET_EXISTS: 'info',
    TICKET_COMPLETED: 'info',
    ORDER_ON_TIME: 'info',
    ORDER_NOT_SENT: 'info',
    INVESTIGATION_INVALID: 'rejection',
    AVARIA_INVALID: 'rejection',
    BARRA_ENTREGA_INVALID: 'rejection',
    ADDRESS_MISSING: 'rejection',
    DELAY_ESCALATED: 'escalation',
    INVESTIGATION_EXPIRED: 'escalation',
    CARRIER_NOT_AUTOMATED: 'escalation',
    TICKET_DEADLINE_EXPIRED: 'escalation',
    ORDER_FETCH_FAILED: 'error',
    API_TIMEOUT: 'error',
    UNKNOWN_ERROR: 'error',
};

export interface LogisticaSubmitResponse {
    code: LogisticaResponseCode;
    message: string;
}

export interface LogisticaSubmissionResult {
    code: LogisticaResponseCode;
    orderNumber: string;
    webhookMessage?: string;
}

// ─── Constants ──────────────────────────────────────────────────────

export const INITIAL_FORM_DATA: LogisticaFormData = {
    responsavel: '',
    problema: '',
    marca: '',
    numeroPedido: '',
};

export const INITIAL_ADDRESS_DATA: LogisticaAddressData = {
    logradouro: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    estado: '',
    cep: '',
};

// Re-exported from shared — canonical definition in @shared/lib/constants
export { BRAND_DISPLAY_MAP, BRAND_API_TO_DISPLAY, UF_TO_STATE_NAME } from '../../../shared/lib/constants';
