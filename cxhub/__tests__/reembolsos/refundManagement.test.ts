import { describe, it, expect } from 'vitest';
import {
    parseRefundCancelRequest,
    parseRefundExecutionRequest,
    parseRefundUpdateRequest,
} from '@modules/reembolsos/actions/refundManagement';

/**
 * O corpo das rotas de cancelar e editar reembolso. Estrito de propósito: campo desconhecido é recusado
 * em vez de ignorado, para um erro de digitação não virar "sucesso" sem mudar nada.
 */

const BASE = { brand: 'lescent', ecommerceOrderId: 'SH9000105LC', handledBy: 'Ana' };

describe('parseRefundCancelRequest', () => {
    it('aceita e normaliza marca, pedido e textos', () => {
        expect(parseRefundCancelRequest({
            brand: ' Lescent ', ecommerceOrderId: ' SH9000105LC ', handledBy: ' Ana ', reason: ' Cliente desistiu ',
        })).toEqual({
            ok: true,
            value: { brand: 'lescent', ecommerceOrderId: 'SH9000105LC', handledBy: 'Ana', reason: 'Cliente desistiu' },
        });
    });

    it.each([
        [null, 'Corpo da requisição inválido.'],
        [{ ...BASE, brand: 'apice', reason: 'x' }, 'Marca inválida: apice.'],
        [{ ...BASE, ecommerceOrderId: 'ABC', reason: 'x' }, 'Informe ecommerceOrderId'],
        [{ ...BASE, ecommerceOrderId: "SH1'; drop", reason: 'x' }, 'Informe ecommerceOrderId'],
        [{ ...BASE, handledBy: ' ', reason: 'x' }, 'Informe handledBy'],
        [{ ...BASE }, 'Informe reason'],
        [{ ...BASE, reason: 'x', refundAmount: 10 }, 'Campo desconhecido: refundAmount.'],
    ])('recusa %j', (body, mensagem) => {
        const resultado = parseRefundCancelRequest(body);
        expect(resultado.ok).toBe(false);
        expect(!resultado.ok && resultado.message).toContain(mensagem);
    });
});

describe('parseRefundUpdateRequest', () => {
    it('aceita valor, motivo e observações', () => {
        expect(parseRefundUpdateRequest({
            ...BASE, changes: { refundAmount: 59.9, refundReason: ' Extravio ', notes: '' },
        })).toEqual({
            ok: true,
            value: { ...BASE, changes: { refundAmount: 59.9, refundReason: 'Extravio', notes: '' } },
        });
    });

    it.each([
        [{ ...BASE }, 'Informe changes'],
        [{ ...BASE, changes: {} }, 'Nada para editar'],
        [{ ...BASE, changes: { amount: 10 } }, 'Campo não editável: amount.'],
        [{ ...BASE, changes: { refundAmount: 0 } }, 'refundAmount deve ser um número maior que zero.'],
        [{ ...BASE, changes: { refundAmount: '59,90' } }, 'refundAmount deve ser um número maior que zero.'],
        [{ ...BASE, changes: { refundReason: ' ' } }, 'refundReason deve ser texto não vazio.'],
        [{ ...BASE, changes: { notes: 1 } }, 'notes deve ser texto.'],
        [{ ...BASE, reason: 'x', changes: { notes: 'a' } }, 'Campo desconhecido: reason.'],
    ])('recusa %j', (body, mensagem) => {
        const resultado = parseRefundUpdateRequest(body);
        expect(resultado.ok).toBe(false);
        expect(!resultado.ok && resultado.message).toContain(mensagem);
    });
});

describe('parseRefundExecutionRequest', () => {
    const ID = '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f';
    const EXECUCAO = { brand: 'lescent', idSolicitacao: ID, handledBy: '<agente>' };

    it('aceita e normaliza marca, id e agente', () => {
        expect(parseRefundExecutionRequest({ brand: ' Lescent ', idSolicitacao: ' 6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f ', handledBy: ' <agente> ' })).toEqual({
            ok: true,
            value: EXECUCAO,
        });
    });

    it('aceita o id em maiúsculas (UUID é UUID em qualquer caixa)', () => {
        const id = ID.toUpperCase();
        expect(parseRefundExecutionRequest({ ...EXECUCAO, idSolicitacao: id })).toEqual({ ok: true, value: { ...EXECUCAO, idSolicitacao: id } });
    });

    it.each([
        [null, 'Corpo da requisição inválido.'],
        [[], 'Corpo da requisição inválido.'],
        ['texto', 'Corpo da requisição inválido.'],
        [{ ...EXECUCAO, brand: 'apice' }, 'Marca inválida: apice.'],
        [{ ...EXECUCAO, brand: undefined }, 'Marca inválida: (vazia).'],
        [{ ...EXECUCAO, idSolicitacao: undefined }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, idSolicitacao: '' }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, idSolicitacao: '<id>' }, 'Informe idSolicitacao (o id da solicitação, um UUID'],
        [{ ...EXECUCAO, idSolicitacao: 'SH9000105LC' }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, idSolicitacao: `${ID} ${ID}` }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, idSolicitacao: ID.replaceAll('-', '') }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, idSolicitacao: `${ID}0` }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, idSolicitacao: `${ID.slice(0, -1)}g` }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, idSolicitacao: "x' or '1'='1" }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, idSolicitacao: 12 }, 'Informe idSolicitacao'],
        [{ ...EXECUCAO, handledBy: undefined }, 'Informe handledBy'],
        [{ ...EXECUCAO, handledBy: '  ' }, 'Informe handledBy'],
        [{ ...EXECUCAO, ecommerceOrderId: '<pedido>' }, 'Campo desconhecido: ecommerceOrderId.'],
        [{ ...EXECUCAO, reason: 'x' }, 'Campo desconhecido: reason.'],
    ])('recusa %j', (body, mensagem) => {
        const resultado = parseRefundExecutionRequest(body);
        expect(resultado.ok).toBe(false);
        expect(!resultado.ok && resultado.message).toContain(mensagem);
    });
});
