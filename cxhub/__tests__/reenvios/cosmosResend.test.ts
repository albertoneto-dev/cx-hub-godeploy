import { describe, it, expect } from 'vitest';
import { buildCosmosResendBody, interpretarErroCosmos } from '@modules/reenvios/actions/cosmosResend';
import { RESEND_DATA } from '../helpers/resend-fixtures';

describe('buildCosmosResendBody', () => {
    it('monta o corpo campo a campo como o jsonBody do node', () => {
        expect(buildCosmosResendBody(RESEND_DATA)).toEqual({
            order: {
                reason: 'PROBLEMA',
                carrier_id: 161,
                products: [{ id: 7, quantity: 2, unit_price: '49.90' }],
                shipping_address: {
                    name: 'NOME',
                    phone: '11999990000',
                    street: 'Rua A',
                    number: '10',
                    complement: 'Ap 1',
                    neighborhood: 'Centro',
                    city: 'São Paulo',
                    state: 'SP',
                    postal_code: '01001000',
                    service_name: 'Expresso',
                },
                shipping_cost: '10.00',
                discount_amount: '5.00',
            },
        });
    });

    it('telefone fica só com dígitos e +', () => {
        const corpo = buildCosmosResendBody({ ...RESEND_DATA, telefoneCliente: '+55 (11) 9.9999-0000' });
        expect(corpo?.order.shipping_address.phone).toBe('+5511999990000');
    });

    it('sem apiData não há corpo', () => {
        expect(buildCosmosResendBody({ ...RESEND_DATA, apiData: undefined })).toBeNull();
    });
});

describe('interpretarErroCosmos', () => {
    it('422 "SKU sem saldo" ⇒ OUT_OF_STOCK com o SKU', () => {
        expect(interpretarErroCosmos(422, { error: 'SKU sem saldo: KS03010' })).toEqual({
            code: 'OUT_OF_STOCK',
            message: 'Não foi possível reenviar: o SKU KS03010 está sem saldo no Cosmos. Verifique o estoque ou solicite reenvio manual.',
        });
    });

    it('"sem saldo" sem o SKU legível cai no texto genérico do produto', () => {
        expect(interpretarErroCosmos(422, { error: 'Item sem saldo' }).message).toContain('o SKU produto selecionado');
    });

    it('outra recusa com motivo ⇒ API_ERROR repetindo o motivo do ERP', () => {
        expect(interpretarErroCosmos(422, { error: 'Transportadora inválida' })).toEqual({
            code: 'API_ERROR',
            message: 'O Cosmos recusou o reenvio: Transportadora inválida',
        });
    });

    it('"sem saldo" fora de um 422 não é falta de estoque', () => {
        expect(interpretarErroCosmos(500, { error: 'SKU sem saldo: X' }).code).toBe('API_ERROR');
    });

    it('erro estruturado vira texto em vez de [object Object]', () => {
        expect(interpretarErroCosmos(400, { error: { carrier_id: ['inválido'] } }).message)
            .toBe('O Cosmos recusou o reenvio: {"carrier_id":["inválido"]}');
    });

    it('sem corpo ⇒ a mensagem genérica do n8n', () => {
        expect(interpretarErroCosmos(502, null)).toEqual({
            code: 'API_ERROR',
            message: 'Ocorreu um erro ao se conectar ao servidor do Cosmos.',
        });
    });
});
