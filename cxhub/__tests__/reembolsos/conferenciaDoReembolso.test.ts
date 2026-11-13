import { describe, expect, it } from 'vitest';
import { aplicarConferenciaAoReembolso, chavePixDoReembolso } from '@modules/reembolsos/actions/conferenciaDoReembolso';
import type { ContextoDoPedido } from '@shared/lib/datamart/pedidoTipos';
import type { RefundSubmissionData } from '@modules/reembolsos/types';

/** O que a conferência no Data Mart muda no reembolso das marcas sem Cosmos, e a chave Pix (ADR-018). */

const DATA: RefundSubmissionData = {
    brand: 'apice',
    data_criacao: '27/10/2026',
    handledBy: 'Ana',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'T-1',
    originWarehouse: 'CD ES',
    customerName: 'Cliente',
    invoiceNumber: '10157987',
    nfeAccessKey: '',
    batchNumber: null,
    ecommerceOrderId: 'SH1731559AP',
    policyException: false,
    refundAmount: 39.24,
    refundScope: '20688 - 1',
    refundReason: 'Avaria por Transportes',
    requiresReturn: false,
    carrierTicketId: null,
    carrierName: 'Anjun',
    orderStatus: 'Pedido não entregue (em trânsito)',
    isFullRefund: false,
    notes: 'Obs',
};

const CONTEXTO: ContextoDoPedido = {
    marca: 'apice',
    numero: '1731559',
    pedido: 'SH1731559AP',
    nf: { estado: 'achada', numero: '10157987' },
    cd: { valor: 'CD RJ', conferido: true },
    statusSugerido: null,
    avisos: [],
    kits: [],
    baseDoValor: null,
    baseConferida: true,
    unidadesDoPedido: {},
};

describe('aplicarConferenciaAoReembolso', () => {
    it('sem conferência nada muda; nada conferido põe a nota de CD e NF', () => {
        expect(aplicarConferenciaAoReembolso('apice', DATA, { tipo: 'nao_se_aplica' })).toEqual({
            tipo: 'aplicado', data: DATA, nfDivergente: null, naoConferidos: [],
        });
        const r = aplicarConferenciaAoReembolso('apice', { ...DATA, notes: null }, { tipo: 'nao_conferido', motivo: 'x' });
        expect(r).toEqual({
            tipo: 'aplicado',
            data: { ...DATA, notes: '[CD/NF NÃO CONFERIDOS: DATA MART SEM RESPOSTA]' },
            nfDivergente: null,
            naoConferidos: ['cd', 'nf'],
        });
    });

    it('pedido sem NF é recusado', () => {
        const r = aplicarConferenciaAoReembolso('denavita', DATA, {
            tipo: 'lido', contexto: { ...CONTEXTO, marca: 'denavita', pedido: 'SH423209DN', nf: { estado: 'ausente', numero: null } },
        });
        expect(r).toEqual({
            tipo: 'recusado',
            mensagem: 'O pedido SH423209DN não tem NF de venda na Intelipost: não dá para solicitar reembolso ainda. Nada foi '
                + 'registrado. Se a NF acabou de sair, ela pode levar algumas horas para chegar ao Data Mart.',
        });
    });

    it('a NF e o CD do Data Mart entram no lugar dos que vieram; a NF que diverge vem para o log', () => {
        const r = aplicarConferenciaAoReembolso('apice', { ...DATA, invoiceNumber: '999' }, { tipo: 'lido', contexto: CONTEXTO });
        expect(r).toEqual({
            tipo: 'aplicado',
            data: { ...DATA, invoiceNumber: '10157987', originWarehouse: 'CD RJ' },
            nfDivergente: { digitada: '999', doDataMart: '10157987' },
            naoConferidos: [],
        });
    });

    it('o que não foi lido fica como veio, com a nota na frente das observações', () => {
        const r = aplicarConferenciaAoReembolso('apice', DATA, {
            tipo: 'lido', contexto: { ...CONTEXTO, nf: { estado: 'desconhecida', numero: null }, cd: { valor: null, conferido: false } },
        });
        expect(r).toMatchObject({
            tipo: 'aplicado',
            data: { invoiceNumber: '10157987', originWarehouse: 'CD ES', notes: '[CD/NF NÃO CONFERIDOS: DATA MART SEM RESPOSTA] | Obs' },
            naoConferidos: ['nf', 'cd'],
        });
    });
});

describe('chavePixDoReembolso', () => {
    it('vazia: passa sem chave quando não é obrigatória, e é recusada quando é', () => {
        for (const pixKey of [undefined, null, '', '   ']) {
            expect(chavePixDoReembolso({ pixKey }, false)).toEqual({ ok: true, chave: null });
            expect(chavePixDoReembolso({ pixKey }, true)).toEqual({
                ok: false, erro: 'Informe a chave Pix da cliente: o reembolso desta marca é pago por Pix.',
            });
        }
    });

    it('normaliza pelo tipo informado ou inferido', () => {
        expect(chavePixDoReembolso({ pixKey: '529.982.247-25' }, true)).toEqual({ ok: true, chave: '52998224725' });
        expect(chavePixDoReembolso({ pixKey: '(11) 98765-4321', pixKeyType: 'celular' }, true)).toEqual({ ok: true, chave: '+5511987654321' });
        expect(chavePixDoReembolso({ pixKey: 'Cliente@Exemplo.com' }, false)).toEqual({ ok: true, chave: 'cliente@exemplo.com' });
    });

    it('a chave inválida para o tipo é recusada com o erro do tipo', () => {
        expect(chavePixDoReembolso({ pixKey: '52998224726', pixKeyType: 'cpf' }, false)).toEqual({
            ok: false, erro: 'CPF da chave Pix inválido (confira os 11 dígitos).',
        });
    });
});
