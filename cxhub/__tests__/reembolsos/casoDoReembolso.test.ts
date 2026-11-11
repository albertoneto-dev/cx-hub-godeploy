import { describe, it, expect } from 'vitest';
import { casoDoReembolso } from '@modules/reembolsos/actions/casoDoReembolso';
import type { RefundSubmissionData } from '@modules/reembolsos/types/submission';

const DATA: RefundSubmissionData = {
    brand: 'lescent',
    data_criacao: '06/10/2026',
    handledBy: 'Agente Teste',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: '123456',
    originWarehouse: 'CD ES',
    customerName: 'Cliente Teste',
    invoiceNumber: '12345',
    nfeAccessKey: '3226',
    batchNumber: null,
    ecommerceOrderId: 'SH9000002LE',
    policyException: false,
    refundAmount: 59.9,
    refundReason: 'Extravio',
    refundScope: 'SKU01 - 1;Frete',
    requiresReturn: false,
    carrierTicketId: null,
    carrierName: 'Jadlog',
    orderStatus: 'Pedido não foi enviado',
    isFullRefund: true,
    notes: 'Observação livre que não vai para a gold',
};

const CRIADO_EM = new Date('2026-10-27T17:05:03.000Z');

function caso(data: RefundSubmissionData = DATA) {
    return casoDoReembolso({ brand: 'lescent', data, idSolicitacao: 'id-2', criadoEm: CRIADO_EM });
}

describe('casoDoReembolso', () => {
    it('monta o caso REEMBOLSO com o de-para do guia da DAG, mais o que a planilha guardava', () => {
        expect(caso()).toEqual({
            id_solicitacao: 'id-2',
            tipo: 'REEMBOLSO',
            marca: 'lescent',
            criado_em: '2026-10-27T17:05:03.000Z',
            numero_pedido: 'SH9000002LE',
            data_pedido: '06/10/2026',
            nf: '12345',
            chave_nf: '3226',
            valor: 59.9,
            motivo: 'Extravio',
            cd_origem: 'CD ES',
            status_pedido: 'Pedido não foi enviado',
            transportadora: 'Jadlog',
            lote: undefined,
            pedido_completo: true,
            devolucao: false,
            responsavel: 'Agente Teste',
            origem: 'Chat Atendimento',
            id_atendimento: '123456',
            escopo_reembolso: 'SKU01 - 1;Frete',
            excecao_politica: false,
            ticket_transportadora: undefined,
        });
    });

    it('nunca leva o nome do cliente nem as observações (texto livre)', () => {
        const c = caso();
        expect(c).not.toHaveProperty('cliente');
        expect(c).not.toHaveProperty('observacoes');
        expect(JSON.stringify(c)).not.toMatch(/Cliente Teste|Observação livre/);
    });

    it('exceção à política vai como booleano, e o Bot nunca reembolsa como exceção', () => {
        expect(caso({ ...DATA, policyException: true }).excecao_politica).toBe(true);
        expect(caso({ ...DATA, policyException: true, handledBy: 'Bot' }).excecao_politica).toBe(false);
    });

    it('ticket da transportadora vai quando preenchido', () => {
        expect(caso({ ...DATA, carrierTicketId: 'TK-9' }).ticket_transportadora).toBe('TK-9');
    });

    it('lote preenchido vai como veio', () => {
        expect(caso({ ...DATA, batchNumber: 'L09' }).lote).toBe('L09');
    });

    it('reembolso não leva SKU nem automação (só reenvio tem)', () => {
        const c = caso();
        expect(c.skus).toBeUndefined();
        expect(c.automacao).toBeUndefined();
    });
});
