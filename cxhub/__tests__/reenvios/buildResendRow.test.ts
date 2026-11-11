import { describe, it, expect } from 'vitest';
import { buildResendRow, pedidoDoReenvio } from '@modules/reenvios/actions/buildResendRow';
import { RESEND_DATA as D } from '../helpers/resend-fixtures';

const C = '27/10/2026 15:00:00';
const P = '220183';
const T = '(11) 99999-0000';
const A = 'Automação';

describe('normalização do node "Data"', () => {
    it('tira o #SHOPIFY do pedido', () => {
        expect(pedidoDoReenvio(D)).toBe(P);
        expect(pedidoDoReenvio({ ...D, numeroPedido: '220183' })).toBe(P);
    });

    it('pedido ausente não derruba a linha (no n8n o .replace() em undefined perdia a solicitação)', () => {
        expect(pedidoDoReenvio({ ...D, numeroPedido: undefined } as unknown as typeof D)).toBe('');
    });
});

// Esperado transcrito dos code nodes `Create <Marca> Row` do `[PROD] - Webhook CXHub`
describe('buildResendRow — paridade com o n8n', () => {
    it('Lescent (tipo de solicitação em B e em X)', () => {
        expect(buildResendRow('lescent', D, C)).toEqual([
            C, 'TIPO', 'RESP', 'NOME', P, 'ORIGEM', 'ID', 'CD', 'NF', 'CHAVE', 'END', 'CEP', 'UF', 'PROD_PROB',
            'PROD_REEN', 'LOTE', null, null, 'PROBLEMA', 'T_ORIG', 'T_REEN', T, 'DEVOL', 'TIPO', 'STATUS_PED',
            'TICKET', null, 'COMPLETO', 'DATA_SOL', null, null, null, 'STATUS', 'VALOR', null, null, 'NFD', null,
            null, null, 'COMENT', A, null,
        ]);
    });

    it('Kokeshi', () => {
        expect(buildResendRow('kokeshi', D, C)).toEqual([
            C, null, 'RESP', 'NOME', 'NF', 'CHAVE', P, 'ORIGEM', 'ID', 'CD', 'END', 'CEP', 'UF', 'PROD_PROB',
            'PROD_REEN', 'LOTE', null, null, 'PROBLEMA', 'T_ORIG', 'T_REEN', T, 'DEVOL', 'TIPO', 'TICKET', null,
            'STATUS_PED', 'COMPLETO', null, 'DATA_SOL', null, null, 'STATUS', 'VALOR', null, 'NFD', null, null,
            'COMENT', null, null, null, null, A,
        ]);
    });

    it('BySamia (comentários em Q e em AA; sem CEP)', () => {
        expect(buildResendRow('bysamia', D, C)).toEqual([
            C, 'RESP', 'ORIGEM', 'ID', 'CD', 'NOME', 'NF', 'CHAVE', P, 'END', 'UF', 'PROD_PROB', 'PROD_REEN',
            'PROBLEMA', 'LOTE', 'T_ORIG', 'COMENT', T, 'DEVOL', 'TIPO', 'TICKET', 'STATUS_PED', 'COMPLETO', null,
            null, null, 'COMENT', 'DATA_SOL', null, 'STATUS', 'VALOR', null, 'NFD', null, null, null, null, A,
        ]);
    });

    it('Auá', () => {
        expect(buildResendRow('aua', D, C)).toEqual([
            C, 'RESP', 'ORIGEM', 'ID', 'CD', 'NOME', 'NF', 'CHAVE', P, 'END', 'UF', 'PROD_PROB', 'PROD_REEN',
            'PROBLEMA', 'LOTE', 'DEVOL', 'T_ORIG', 'COMENT', T, 'TICKET', 'STATUS_PED', 'COMPLETO', null, 'STATUS',
            'VALOR', null, null, 'NFD', null, 'COMENT', null, null, null, A,
        ]);
    });

    it('Barbours (com ERP)', () => {
        expect(buildResendRow('barbours', D, C)).toEqual([
            C, 'RESP', 'ORIGEM', 'ID', 'CD', 'NOME', 'NF', 'CHAVE', P, 'END', 'UF', 'PROD_PROB', 'PROD_REEN',
            'PROBLEMA', 'T_ORIG', T, 'COMENT', 'LOTE', 'DEVOL', 'TICKET', 'STATUS_PED', 'COMPLETO', 'TIPO',
            'DATA_SOL', null, 'STATUS', 'VALOR', 'ERP', 'NFD', null, A, 'COMENT',
        ]);
    });

    it('Rituária (valor na coluna H; com ERP)', () => {
        expect(buildResendRow('rituaria', D, C)).toEqual([
            C, 'RESP', 'ORIGEM', 'ID', 'CD', 'NOME', 'NF', 'VALOR', 'CHAVE', P, 'END', 'PROBLEMA', 'PROD_REEN',
            'PROD_PROB', 'COMENT', 'T_ORIG', 'COMPLETO', 'LOTE', T, null, null, null, 'UF', 'TICKET', 'DEVOL',
            'STATUS_PED', 'TIPO', null, 'ERP', 'NFD', null, null, null, 'STATUS', A,
        ]);
    });

    it('o carimbo da linha é o recebido (o criado_em do caso), não o `timestamp` do corpo, que o formulário monta antes', () => {
        const linha = buildResendRow('kokeshi', { ...D, timestamp: '01/01/2020, 00:00:00' }, C);

        expect(linha[0]).toBe(C);
        expect(linha).not.toContain('01/01/2020, 00:00:00');
        expect(linha).not.toContain('01/01/2020 00:00:00');
    });
});
