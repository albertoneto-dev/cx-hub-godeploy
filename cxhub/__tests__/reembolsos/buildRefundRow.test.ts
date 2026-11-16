import { describe, it, expect } from 'vitest';
import { buildRefundRow, COLUNA_DA_CHAVE_PIX, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
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
            'SP', '555', 'CHAVE', 'PAC', 'Entregue', 'L1', 'Não', 'TK', 'obs', 'Não', 'Sim', null, null,
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

// A chave Pix nas marcas do Cosmos (pedido da Maria, 16/11/2026): a posição vem do cabeçalho das planilhas de produção.
describe('buildRefundRow — a chave Pix nas marcas do Cosmos', () => {
    const PIX = 'chave-qualquer 123';
    const comChave = prepararReembolso({ ...DATA, pixKey: PIX }, C);
    const semChave = prepararReembolso({ ...DATA, pixKey: null }, C);

    it.each([
        ['lescent', 22, 23],
        ['bysamia', 12, 24],
        ['aua', 11, 22],
        ['barbours', 16, 23],
        ['rituaria', 10, 26],
    ] as const)('%s: a chave cai na coluna %i, e o resto da linha não muda', (marca, indice, tamanho) => {
        const linha = buildRefundRow(marca, comChave);
        expect(linha).toHaveLength(tamanho);
        expect(linha[indice]).toBe(PIX);
        expect(COLUNA_DA_CHAVE_PIX[marca]).toBe(indice);
        // Sem a chave, a mesma linha com `null` no lugar dela: nada mais se mexeu.
        const sem = buildRefundRow(marca, semChave);
        expect(sem[indice]).toBeNull();
        expect(linha.filter((_, i) => i !== indice)).toEqual(sem.filter((_, i) => i !== indice));
    });

    it('lescent: a V (21) é "Origem do pedido" e fica vazia; a chave é a W (22)', () => {
        expect(buildRefundRow('lescent', comChave).slice(19)).toEqual(['Não', 'Sim', null, PIX]);
    });

    it('kokeshi: nenhuma posição muda; a chave vai no fim das Observações (índice 20), numa nova linha', () => {
        const linha = buildRefundRow('kokeshi', comChave);
        expect(linha).toHaveLength(23);
        expect(linha[20]).toBe(`obs\nChave Pix: ${PIX}`);
        expect(linha.filter((_, i) => i !== 20)).toEqual(buildRefundRow('kokeshi', semChave).filter((_, i) => i !== 20));
        expect(buildRefundRow('kokeshi', semChave)).toEqual([
            C, null, 'Ana', 'Cliente', '220183', 'Avaria', 'SKU01 - 1;Frete', null, 'Chat Atendimento', 150.5, 'T-1',
            'SP', '555', 'CHAVE', 'PAC', 'Entregue', null, null, 'Não', 'TK', 'obs', 'Não', 'Sim',
        ]);
        expect(COLUNA_DA_CHAVE_PIX.kokeshi).toBe(20);
    });

    it('kokeshi: sem observação a célula é só a chave; sem as duas, fica vazia', () => {
        const semObs = { ...DATA, notes: null };
        expect(buildRefundRow('kokeshi', prepararReembolso({ ...semObs, pixKey: PIX }, C))[20]).toBe(`Chave Pix: ${PIX}`);
        expect(buildRefundRow('kokeshi', prepararReembolso({ ...semObs, pixKey: null }, C))[20]).toBeNull();
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
