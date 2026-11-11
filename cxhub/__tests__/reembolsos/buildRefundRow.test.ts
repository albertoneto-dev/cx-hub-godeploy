import { describe, it, expect } from 'vitest';
import { buildRefundRow, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import { camposFaltandoNoReembolso } from '@modules/reembolsos/actions/validateRefundBody';
import type { RefundSubmissionData } from '@modules/reembolsos/types';

const DATA: RefundSubmissionData = {
    brand: 'lescent',
    data_criacao: '20/10/2026',
    handledBy: 'Ana',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'T-1',
    originWarehouse: 'SP',
    customerName: 'Cliente',
    invoiceNumber: '555',
    nfeAccessKey: 'CHAVE',
    batchNumber: 'L1',
    ecommerceOrderId: '220183',
    policyException: true,
    refundAmount: 150.5,
    refundReason: 'Avaria',
    refundScope: 'SKU01 - 1;Frete',
    requiresReturn: true,
    carrierTicketId: 'TK',
    carrierName: 'PAC',
    orderStatus: 'Entregue',
    isFullRefund: false,
    notes: 'obs',
};

const C = '27/10/2026 15:00:00';
const fonte = prepararReembolso(DATA, C);

describe('prepararReembolso (node "Sheets Interface")', () => {
    it('"devolvido" e "pedido completo" saem os dois do isFullRefund — paridade com o n8n', () => {
        expect(prepararReembolso({ ...DATA, isFullRefund: true, requiresReturn: false }, C)).toMatchObject({
            devolvido: 'Sim',
            pedidoCompleto: 'Sim',
        });
        expect(prepararReembolso({ ...DATA, isFullRefund: false, requiresReturn: true }, C)).toMatchObject({
            devolvido: 'Não',
            pedidoCompleto: 'Não',
        });
    });

    it('exceção à política só para quem não é Bot', () => {
        expect(fonte.excecaoPolitica).toBe('Sim');
        expect(prepararReembolso({ ...DATA, policyException: false }, C).excecaoPolitica).toBe('Não');
        expect(prepararReembolso({ ...DATA, handledBy: 'Bot' }, C).excecaoPolitica).toBe('Não');
    });

    it('valor vai como número (o Set do n8n tipava como number)', () => {
        expect(fonte.valor).toBe(150.5);
        expect(prepararReembolso({ ...DATA, refundAmount: '99.9' as unknown as number }, C).valor).toBe(99.9);
        expect(prepararReembolso({ ...DATA, refundAmount: 'abc' as unknown as number }, C).valor).toBeNull();
    });
});

// Esperado transcrito dos code nodes `Build <Marca> Row` do `[PROD] - Webhook Refund CXHub`
describe('buildRefundRow — paridade com o n8n', () => {
    it('Lescent', () => {
        expect(buildRefundRow('lescent', fonte)).toEqual([
            C, 'Ana', 'Cliente', 'Avaria', '220183', 'SKU01 - 1;Frete', null, 'Chat Atendimento', 'T-1', 150.5,
            'SP', '555', 'CHAVE', 'PAC', 'Entregue', 'L1', 'Não', 'TK', 'obs', 'Não', 'Sim',
        ]);
    });

    it('BySamia', () => {
        expect(buildRefundRow('bysamia', fonte)).toEqual([
            C, null, 'Ana', 'Chat Atendimento', 'T-1', 'SP', 'Cliente', '555', 'CHAVE', '220183', null, 150.5, null,
            'Avaria', 'L1', 'PAC', 'SKU01 - 1;Frete', 'Entregue', null, 'obs', 'Não', 'TK', 'Não', 'Sim',
        ]);
    });

    it('Kokeshi (sem coluna de lote)', () => {
        expect(buildRefundRow('kokeshi', fonte)).toEqual([
            C, null, 'Ana', 'Cliente', '220183', 'Avaria', 'SKU01 - 1;Frete', null, 'Chat Atendimento', 150.5, 'T-1',
            'SP', '555', 'CHAVE', 'PAC', 'Entregue', null, null, 'Não', 'TK', 'obs', 'Não', 'Sim',
        ]);
    });

    it('Auá', () => {
        expect(buildRefundRow('aua', fonte)).toEqual([
            C, null, 'Ana', 'Chat Atendimento', 'T-1', 'SP', 'Cliente', '555', 'CHAVE', '220183', 150.5, null,
            'Avaria', 'L1', 'Não', 'PAC', 'SKU01 - 1;Frete', 'Entregue', 'obs', 'TK', 'Não', 'Sim',
        ]);
    });

    it('Barbours', () => {
        expect(buildRefundRow('barbours', fonte)).toEqual([
            C, null, 'Ana', 'Chat Atendimento', 'T-1', 'SP', 'Cliente', '220183', '555', 'CHAVE', null, 150.5, 'PAC',
            'Avaria', 'SKU01 - 1;Frete', 'Entregue', null, 'obs', 'L1', 'Não', 'TK', 'Não', 'Sim',
        ]);
    });

    it('Rituária (sem coluna de devolução; semana/mês/ano são fórmula da planilha)', () => {
        expect(buildRefundRow('rituaria', fonte)).toEqual([
            C, null, 'Ana', 'Chat Atendimento', 'T-1', 'SP', '555', 'CHAVE', '220183', null, null, 'Avaria', 'L1',
            'PAC', 'SKU01 - 1;Frete', 'Entregue', 'obs', null, null, null, 'Cliente', 150.5, 'TK', 'Não', 'Sim', null,
        ]);
    });

    it('lote/ticket/observações nulos viram célula vazia', () => {
        const vazio = prepararReembolso({ ...DATA, batchNumber: null, carrierTicketId: null, notes: null }, C);
        expect(buildRefundRow('lescent', vazio).slice(15, 19)).toEqual([null, 'Não', null, null]);
    });
});

describe('camposFaltandoNoReembolso (node "Validate Body")', () => {
    it('corpo completo passa', () => {
        expect(camposFaltandoNoReembolso(DATA as unknown as Record<string, unknown>)).toEqual([]);
    });

    it('null e ausente reprovam; string vazia e false passam', () => {
        const corpo = { ...DATA, nfeAccessKey: '', isFullRefund: false, carrierName: null } as unknown as Record<string, unknown>;
        delete corpo.orderStatus;
        expect(camposFaltandoNoReembolso(corpo)).toEqual(['carrierName', 'orderStatus']);
    });

    it('opcionais do n8n (lote, ticket, observações) podem vir nulos', () => {
        const corpo = { ...DATA, batchNumber: null, carrierTicketId: null, notes: null };
        expect(camposFaltandoNoReembolso(corpo as unknown as Record<string, unknown>)).toEqual([]);
    });
});
