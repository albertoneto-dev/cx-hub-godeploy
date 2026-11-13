import { describe, it, expect } from 'vitest';
import { MARCAS_SEM_COSMOS_COM_PLANILHA, type MarcaSemCosmosComPlanilha } from '@shared/lib/constants';
import { CABECALHO_ESPERADO, colunaDoCabecalho } from '@shared/lib/sheets/cabecalhos';
import { FORMULAS_DA_LINHA } from '@shared/lib/sheets/formulas';
import type { FluxoPlanilha, SheetCell } from '@shared/lib/sheets';
import { buildResendRow } from '@modules/reenvios/actions/buildResendRow';
import { buildRefundRow, COLUNA_DA_CHAVE_PIX, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';

/**
 * O layout de cada uma das 6 planilhas das marcas sem Cosmos (ADR-013), lido pelo NOME da coluna: a linha que o
 * builder monta, posta debaixo do cabeçalho conferido em 2026-11-05 (`CABECALHO_ESPERADO`), tem de pôr cada valor na
 * coluna certa. Valores distintos por campo, para que duas colunas trocadas não passem despercebidas. Os cabeçalhos
 * não têm dado pessoal; os valores são de mentira.
 */

/** Quinta-feira, 05/11/2026, 15:00 em São Paulo. */
const CARIMBO = '05/11/2026 15:00:00';

const indiceDaColuna = (letras: string): number => [...letras].reduce((acc, letra) => acc * 26 + letra.charCodeAt(0) - 64, 0) - 1;

/** A linha como a planilha a mostraria: cabeçalho (sem os espaços das pontas) → valor. */
function porCabecalho(fluxo: FluxoPlanilha, marca: MarcaSemCosmosComPlanilha, linha: SheetCell[]): Record<string, SheetCell> {
    const cabecalho = CABECALHO_ESPERADO[fluxo]?.[marca] ?? [];
    return Object.fromEntries(linha.map((valor, i) => [cabecalho[i]?.trim() ?? `(sem cabeçalho ${i})`, valor]));
}

/** A linha nunca invade as colunas de fórmula (elas vêm depois, pelo `formulas.ts`). */
function primeiraColunaDeFormula(fluxo: FluxoPlanilha, marca: MarcaSemCosmosComPlanilha): number {
    return Math.min(...Object.keys(FORMULAS_DA_LINHA[fluxo]?.[marca] ?? {}).map(indiceDaColuna));
}

describe('reenvio — o layout das 3 planilhas', () => {
    const DATA = {
        ...RESEND_DATA,
        cdOrigem: 'CD ES',
        estado: 'RJ',
        numeroPedido: 'SH1629891AP',
        ReenvioCompleto: 'Sim',
        devolucao: 'Não',
        statusPedido: 'Pedido não foi enviado',
        valorReenvio: '123,45',
        automacao: '',
        erp: '',
        status: '',
        codNfd: '',
    };

    const COMUM = {
        'Carimbo de data/hora': CARIMBO,
        'Endereço de e-mail': null,
        'Responsável :': 'RESP',
        'Origem da reclamação': 'ORIGEM',
        'ID do atendimento': 'ID',
        'CD de Origem': 'CD ES',
        'Número da NF': 'NF',
        'Número do pedido:': 'SH1629891AP',
        'Endereço do cliente:': 'END',
        'CEP': 'CEP',
        'Estado': 'Rio de Janeiro (RJ)',
        'Qual produto apresentou problema?': 'PROD_PROB',
        'Qual produto será reenviado?': 'PROD_REEN',
        'Qual foi o problema do produto?': 'PROBLEMA',
        'Transportadora do pedido original': 'T_ORIG',
        'Número de telefone da cliente': '(11) 99999-0000',
        'Observações': 'COMENT',
        'Pedido será devolvido para a operação?': 'Não',
        'ID do Ticket com a transportadora:': 'TICKET',
        'Status do pedido': 'Pedido não foi enviado',
        'O reenvio é do pedido completo?': 'Sim (Pedido completo)',
        'Qual o nº do lote do produto?': 'LOTE',
    };

    it('Ápice: o formulário (A–Y), o Rastreio vazio como o app grava, e a "Data solicitação" (Z) como valor', () => {
        const linha = buildResendRow('apice', DATA, CARIMBO);
        expect(linha).toHaveLength(26);
        expect(porCabecalho('reenvio', 'apice', linha)).toEqual({
            ...COMUM,
            'Nome do(a) cliente:': 'NOME',
            'Chave da NF': 'CHAVE',
            'Rastreio': null,
            'Data solicitação': '05/11/2026',
        });
    });

    it('Yenzah: o formulário (A–X); a "Data de Solicitação" é fórmula', () => {
        const linha = buildResendRow('yenzah', DATA, CARIMBO);
        expect(linha).toHaveLength(24);
        expect(porCabecalho('reenvio', 'yenzah', linha)).toEqual({
            ...COMUM,
            'Nome do(a) cliente:': 'NOME',
            'Chave da NF': 'CHAVE',
        });
    });

    it('Denavita: outra ordem, "Chave NF", e o valor do reenvio como NÚMERO no próprio formulário', () => {
        const linha = buildResendRow('denavita', { ...DATA, cdOrigem: 'CD MG' }, CARIMBO);
        expect(linha).toHaveLength(25);
        expect(porCabecalho('reenvio', 'denavita', linha)).toEqual({
            ...COMUM,
            'CD de Origem': 'CD MG',
            'Nome do(a) cliente:': 'NOME',
            'Chave NF': 'CHAVE',
            'Valor da NF de reenvio (R$)': 123.45,
        });
    });

    it('reenvio incompleto fica "Não"; valor vazio ou fora do formato fica vazio, nunca texto', () => {
        const linha = buildResendRow('denavita', { ...DATA, ReenvioCompleto: 'Não', valorReenvio: '' }, CARIMBO);
        const celulas = porCabecalho('reenvio', 'denavita', linha);
        expect(celulas['O reenvio é do pedido completo?']).toBe('Não');
        expect(celulas['Valor da NF de reenvio (R$)']).toBeNull();
        expect(porCabecalho('reenvio', 'denavita', buildResendRow('denavita', { ...DATA, valorReenvio: 'R$ 1,00' }, CARIMBO))['Valor da NF de reenvio (R$)']).toBeNull();
    });

    it('a linha para antes das colunas de fórmula', () => {
        for (const marca of MARCAS_SEM_COSMOS_COM_PLANILHA) {
            expect(buildResendRow(marca, DATA, CARIMBO).length, marca).toBeLessThanOrEqual(primeiraColunaDeFormula('reenvio', marca));
        }
    });
});

describe('reembolso — o layout das 3 planilhas', () => {
    const DATA: RefundSubmissionData = {
        brand: 'apice',
        data_criacao: '20/10/2026',
        handledBy: 'Ana',
        sourceChannel: 'Chat Atendimento',
        supportTicketId: 'T-1',
        originWarehouse: 'CD ES',
        customerName: 'Cliente',
        invoiceNumber: '555',
        nfeAccessKey: 'CHAVE',
        batchNumber: 'L1',
        ecommerceOrderId: 'SH1629891AP',
        policyException: true,
        refundAmount: 94.82,
        refundReason: 'Ruptura de Estoque',
        refundScope: 'AP001 - 1;Frete',
        requiresReturn: true,
        carrierTicketId: 'TK',
        carrierName: 'J&T Express',
        orderStatus: 'Pedido não foi enviado',
        isFullRefund: false,
        notes: 'obs',
        pixKey: 'cliente@exemplo.com',
    };

    const COMUM = {
        'Carimbo de data/hora': CARIMBO,
        'Endereço de e-mail': null,
        'Responsável:': 'Ana',
        'Origem da reclamação': 'Chat Atendimento',
        'ID Atendimento': 'T-1',
        'CD de Origem': 'CD ES',
        'Nome do(a) cliente:': 'Cliente',
        'Número do pedido': 'SH1629891AP',
        'Número da NF': '555',
        'Chave da NF': 'CHAVE',
        'Motivo da solicitação do reembolso?': 'Ruptura de Estoque',
        'Valor do reembolso': 94.82,
        'O reembolso é do frete e/ou do pedido?': 'AP001 - 1;Frete',
        'Transportadora do pedido original?': 'J&T Express',
        'Status do pedido': 'Pedido não foi enviado',
        // O que a agente respondeu, não o `isFullRefund` (a paridade com o n8n vale só para as 6 marcas do Cosmos).
        'Pedido será devolvido para a operação?': 'Sim',
        'ID do Ticket com a transportadora:': 'TK',
        'O reembolso é do pedido completo?': 'Não',
        'Deseja reembolsar o pedido como exceção à política de CX?': 'Sim',
        'Origem do pedido': 'Shopify',
        'Recebimento - Chave Pix': 'cliente@exemplo.com',
        'Qual o nº do lote do produto?': 'L1',
    };

    it('Ápice: prazo de 3 dias úteis (data, não texto livre) e "Observações" no fim', () => {
        const linha = buildRefundRow('apice', prepararReembolso(DATA, CARIMBO));
        expect(linha).toHaveLength(24);
        expect(porCabecalho('reembolso', 'apice', linha)).toEqual({
            ...COMUM,
            'Prazo para o reembolso (considerar os 3 dias úteis a partir da solicitação):': '10/11/2026',
            'Observações': 'obs',
        });
    });

    it('Yenzah: prazo de 5 dias úteis, sem "Observações"', () => {
        const linha = buildRefundRow('yenzah', prepararReembolso({ ...DATA, brand: 'yenzah' }, CARIMBO));
        expect(linha).toHaveLength(23);
        expect(porCabecalho('reembolso', 'yenzah', linha)).toEqual({
            ...COMUM,
            'Prazo para o reembolso (considerar os 5 dias úteis a partir da solicitação):': '12/11/2026',
        });
    });

    it('Denavita: outra ordem, com a chave Pix logo depois do valor', () => {
        const linha = buildRefundRow('denavita', prepararReembolso({ ...DATA, brand: 'denavita', originWarehouse: 'CD MG' }, CARIMBO));
        expect(linha).toHaveLength(23);
        expect(porCabecalho('reembolso', 'denavita', linha)).toEqual({
            ...COMUM,
            'CD de Origem': 'CD MG',
            'Prazo para o reembolso (considerar os 5 dias úteis a partir da solicitação):': '12/11/2026',
        });
    });

    it('reembolso do pedido completo: "Pedido completo" no escopo e "Sim (Pedido completo)", como as planilhas usam', () => {
        const celulas = porCabecalho('reembolso', 'yenzah', buildRefundRow('yenzah', prepararReembolso({ ...DATA, isFullRefund: true }, CARIMBO)));
        expect(celulas['O reembolso é do frete e/ou do pedido?']).toBe('Pedido completo');
        expect(celulas['O reembolso é do pedido completo?']).toBe('Sim (Pedido completo)');
    });

    it('sem chave Pix, a célula fica vazia; e COLUNA_DA_CHAVE_PIX aponta para a coluna certa (é ela que o log mascara)', () => {
        for (const marca of MARCAS_SEM_COSMOS_COM_PLANILHA) {
            const comPix = buildRefundRow(marca, prepararReembolso(DATA, CARIMBO));
            expect(CABECALHO_ESPERADO.reembolso?.[marca]?.[COLUNA_DA_CHAVE_PIX[marca]], marca).toBe('Recebimento - Chave Pix');
            expect(comPix[COLUNA_DA_CHAVE_PIX[marca]]).toBe('cliente@exemplo.com');
            const semPix = buildRefundRow(marca, prepararReembolso({ ...DATA, pixKey: '  ' }, CARIMBO));
            expect(semPix[COLUNA_DA_CHAVE_PIX[marca]]).toBeNull();
        }
    });

    it('o Bot nunca reembolsa como exceção, também nessas marcas', () => {
        const celulas = porCabecalho('reembolso', 'apice', buildRefundRow('apice', prepararReembolso({ ...DATA, handledBy: 'Bot' }, CARIMBO)));
        expect(celulas['Deseja reembolsar o pedido como exceção à política de CX?']).toBe('Não');
    });

    it('a linha para antes das colunas de fórmula', () => {
        for (const marca of MARCAS_SEM_COSMOS_COM_PLANILHA) {
            const linha = buildRefundRow(marca, prepararReembolso(DATA, CARIMBO));
            expect(linha.length, marca).toBeLessThanOrEqual(primeiraColunaDeFormula('reembolso', marca));
        }
    });
});

describe('colunaDoCabecalho', () => {
    it('acha o "Valor da NF de reenvio (R$)" do reenvio: AC na Ápice e na Yenzah, e V no formulário da Denavita', () => {
        expect(colunaDoCabecalho('reenvio', 'apice', 'Valor da NF de reenvio (R$)')).toBe('AC');
        expect(colunaDoCabecalho('reenvio', 'yenzah', 'Valor da NF de reenvio (R$)')).toBe('AC');
        expect(colunaDoCabecalho('reenvio', 'denavita', 'Valor da NF de reenvio (R$)')).toBe('V');
    });

    it('a coluna da Ápice e da Yenzah não tem fórmula no molde: o valor pode ir nela', () => {
        for (const marca of ['apice', 'yenzah'] as const) {
            expect(Object.keys(FORMULAS_DA_LINHA.reenvio?.[marca] ?? {}), marca).not.toContain('AC');
        }
    });

    it('ignora os espaços das pontas, vale a primeira e devolve null sem a coluna', () => {
        expect(colunaDoCabecalho('reenvio', 'apice', '  Carimbo de data/hora ')).toBe('A');
        expect(colunaDoCabecalho('reenvio', 'apice', 'Coluna que não existe')).toBeNull();
        expect(colunaDoCabecalho('reembolso', 'apice', 'Valor da NF de reenvio (R$)')).toBeNull();
        expect(colunaDoCabecalho('reenvio', 'kokeshi', 'Carimbo de data/hora')).toBeNull();
    });
});
