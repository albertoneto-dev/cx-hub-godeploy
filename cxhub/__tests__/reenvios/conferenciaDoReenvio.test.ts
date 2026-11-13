import { describe, expect, it } from 'vitest';
import { aplicarConferenciaAoReenvio } from '@modules/reenvios/actions/conferenciaDoReenvio';
import type { ContextoDoPedido } from '@shared/lib/datamart/pedidoTipos';
import type { ResendSubmissionData } from '@modules/reenvios/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';

/**
 * O que a conferência no Data Mart muda no reenvio das marcas sem Cosmos (ADR-018): a NF, o CD e o valor da NF de
 * reenvio, a recusa do pedido sem NF e a nota do que não foi conferido.
 */

const DATA: ResendSubmissionData = {
    ...RESEND_DATA,
    numeroPedido: 'SH1731559AP',
    cdOrigem: 'CD ES',
    numeroNF: '10157987',
    produtoReenviar: '40132 - 1',
    itensOriginaisReenviados: [{ sku: '40132', quantidade: 1 }],
    valorReenvio: '189,90',
    comentarios: 'Obs da agente',
};

function contexto(parcial: Partial<ContextoDoPedido> = {}): ContextoDoPedido {
    return {
        marca: 'apice',
        numero: '1731559',
        pedido: 'SH1731559AP',
        nf: { estado: 'achada', numero: '10157987' },
        cd: { valor: 'CD ES', conferido: true },
        statusSugerido: null,
        avisos: [],
        kits: [{ sku: '40132', componentes: ['20683', '20684', '20688', '20690', '20696'].map((sku) => ({ sku, quantidade: 1 })) }],
        baseDoValor: {
            total: 305.7,
            produtos: 289.8,
            desconto: 0,
            frete: 15.9,
            precos: { '20683': 37.2, '20684': 38.76, '20688': 37.2, '20690': 41.86, '20696': 34.88, '20910': 48.13, '20911': 51.77 },
        },
        baseConferida: true,
        unidadesDoPedido: { '20683': 1, '20684': 1, '20688': 1, '20690': 1, '20696': 1, '20910': 1, '20911': 1 },
        ...parcial,
    };
}

const aplicado = (r: ReturnType<typeof aplicarConferenciaAoReenvio>) => {
    if (r.tipo !== 'aplicado') throw new Error('esperava aplicado');
    return r;
};

describe('aplicarConferenciaAoReenvio', () => {
    it('sem conferência (marca fora das três), nada muda', () => {
        expect(aplicarConferenciaAoReenvio('apice', DATA, { tipo: 'nao_se_aplica' })).toEqual({
            tipo: 'aplicado', data: DATA, valorNaOperacao: null, nfDivergente: null, valorEmBranco: null, naoConferidos: [],
        });
    });

    it('nada conferido (número fora do formato, falha inesperada): vale o que veio, com a nota dos três', () => {
        const r = aplicado(aplicarConferenciaAoReenvio('apice', DATA, { tipo: 'nao_conferido', motivo: 'x' }));
        expect(r.data).toEqual({ ...DATA, comentarios: '[CD/NF/VALOR NÃO CONFERIDOS: DATA MART SEM RESPOSTA] | Obs da agente' });
        expect(r.naoConferidos).toEqual(['cd', 'nf', 'valor']);
        expect(r.valorNaOperacao).toBeNull();
    });

    it('pedido sem NF é recusado, com onde a NF foi procurada em cada marca', () => {
        const ausente = { nf: { estado: 'ausente' as const, numero: null } };
        const apice = aplicarConferenciaAoReenvio('apice', DATA, { tipo: 'lido', contexto: contexto(ausente) });
        expect(apice).toEqual({
            tipo: 'recusado',
            mensagem: 'O pedido SH1731559AP não tem NF de venda no Tiny nem na Intelipost: não dá para solicitar reenvio ainda. '
                + 'Nada foi registrado. Se a NF acabou de sair, ela pode levar algumas horas para chegar ao Data Mart.',
        });
        const yenzah = aplicarConferenciaAoReenvio('yenzah', DATA, { tipo: 'lido', contexto: contexto({ ...ausente, marca: 'yenzah', pedido: 'SH5478YE' }) });
        expect(yenzah.tipo === 'recusado' && yenzah.mensagem).toContain('O pedido SH5478YE não tem NF de venda na Intelipost:');
    });

    it('o Kit Cachos inteiro: a NF e o CD do Data Mart, e o valor 200,32 na coluna da operação da Ápice', () => {
        const r = aplicado(aplicarConferenciaAoReenvio('apice', { ...DATA, numeroNF: '', cdOrigem: 'CD ES' }, {
            tipo: 'lido', contexto: contexto({ cd: { valor: 'CD RJ', conferido: true } }),
        }));
        expect(r.data).toMatchObject({ numeroNF: '10157987', cdOrigem: 'CD RJ', valorReenvio: '200,32', comentarios: 'Obs da agente' });
        expect(r.valorNaOperacao).toBe(200.32);
        // NF digitada vazia não é divergência.
        expect(r.nfDivergente).toBeNull();
        expect(r.naoConferidos).toEqual([]);
    });

    it('a NF digitada que difere da do Data Mart é trocada, e a divergência vem para o log', () => {
        const r = aplicado(aplicarConferenciaAoReenvio('apice', { ...DATA, numeroNF: '10157988' }, { tipo: 'lido', contexto: contexto() }));
        expect(r.data.numeroNF).toBe('10157987');
        expect(r.nfDivergente).toEqual({ digitada: '10157988', doDataMart: '10157987' });
    });

    it('na Yenzah o valor também vai para a operação; na Denavita, não (a coluna é do formulário)', () => {
        const lido = { tipo: 'lido' as const, contexto: contexto() };
        expect(aplicado(aplicarConferenciaAoReenvio('yenzah', DATA, lido)).valorNaOperacao).toBe(200.32);
        const denavita = aplicado(aplicarConferenciaAoReenvio('denavita', DATA, lido));
        expect(denavita.valorNaOperacao).toBeNull();
        expect(denavita.data.valorReenvio).toBe('200,32');
    });

    it('o valor que não dá para calcular fica em branco, com o motivo para o log, e sem nota', () => {
        const r = aplicado(aplicarConferenciaAoReenvio('apice', { ...DATA, itensOriginaisReenviados: [{ sku: '99999', quantidade: 1 }] }, {
            tipo: 'lido', contexto: contexto(),
        }));
        expect(r.data.valorReenvio).toBe('');
        expect(r.valorEmBranco).toBe('o SKU 99999 não está na NF original');
        expect(r.valorNaOperacao).toBeNull();
        expect(r.data.comentarios).toBe('Obs da agente');
    });

    it('cada leitura que falhou vale o que veio e entra na nota; o CD conferido mas desconhecido fica como veio, sem nota', () => {
        const r = aplicado(aplicarConferenciaAoReenvio('apice', DATA, {
            tipo: 'lido',
            contexto: contexto({ nf: { estado: 'desconhecida', numero: null }, cd: { valor: null, conferido: true }, baseConferida: false }),
        }));
        expect(r.data).toMatchObject({ numeroNF: '10157987', cdOrigem: 'CD ES', valorReenvio: '189,90' });
        expect(r.naoConferidos).toEqual(['nf', 'valor']);
        expect(r.data.comentarios).toBe('[NF/VALOR NÃO CONFERIDOS: DATA MART SEM RESPOSTA] | Obs da agente');
    });

    it('a nota vai sozinha quando não há observações', () => {
        const r = aplicado(aplicarConferenciaAoReenvio('apice', { ...DATA, comentarios: '' }, {
            tipo: 'lido', contexto: contexto({ cd: { valor: null, conferido: false } }),
        }));
        expect(r.data.comentarios).toBe('[CD NÃO CONFERIDO: DATA MART SEM RESPOSTA]');
    });
});
