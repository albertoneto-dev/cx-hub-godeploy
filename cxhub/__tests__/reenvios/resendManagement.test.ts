import { describe, it, expect } from 'vitest';
import type { CosmosDetailedOrder } from '@shared/types';
import {
    RESEND_LOCKED_ERP_STATUSES,
    buildCancelReason,
    buildResendUpdateBody,
    checkResendActionable,
    matchResendsOfOrder,
    parseCosmosOrderId,
    parseResendCancelRequest,
    parseResendUpdateRequest,
} from '@modules/reenvios/actions/resendManagement';

const ORDER: Pick<CosmosDetailedOrder, 'shipping' | 'customer'> = {
    customer: {
        name: 'Cliente Teste',
        email: 'cliente@example.com',
        phone: '11900000000',
        document: '00000000000',
        type: 'cpf',
    },
    shipping: {
        name: 'Cliente Teste',
        phone: '11900000000',
        address: {
            street: 'Rua Antiga',
            number: '10',
            complement: 'Ap 1',
            neighborhood: 'Centro',
            city: 'São Paulo',
            state: 'SP',
            postal_code: '01000-000',
        },
        service_name: 'NORMAL_J&T',
        cost: '12.5',
    },
};

describe('checkResendActionable', () => {
    it.each(['waiting', 'integration_error', 'no_balance', 'unauthorized'])(
        'permite reenvio com erp_status %s',
        (erpStatus) => {
            expect(checkResendActionable({ origin: 'resend', status: 'pending', erp_status: erpStatus }))
                .toEqual({ ok: true });
        },
    );

    it.each([...RESEND_LOCKED_ERP_STATUSES])('bloqueia com erp_status %s (o faturamento começou)', (erpStatus) => {
        expect(checkResendActionable({ origin: 'resend', status: 'erp', erp_status: erpStatus }))
            .toMatchObject({ ok: false, code: 'RESEND_LOCKED' });
    });

    it('recusa pedido que não é reenvio, mesmo dentro da janela', () => {
        expect(checkResendActionable({ origin: 'shopify', status: 'pending', erp_status: 'waiting' }))
            .toMatchObject({ ok: false, code: 'NOT_A_RESEND' });
    });

    it('recusa reenvio já cancelado', () => {
        expect(checkResendActionable({ origin: 'resend', status: 'cancelled', erp_status: 'waiting' }))
            .toMatchObject({ ok: false, code: 'RESEND_CANCELLED' });
    });

    it('confere a origem antes do status: pedido comum cancelado é NOT_A_RESEND', () => {
        expect(checkResendActionable({ origin: 'shopify', status: 'cancelled', erp_status: 'invoiced' }))
            .toMatchObject({ ok: false, code: 'NOT_A_RESEND' });
    });
});

describe('buildCancelReason', () => {
    it('leva o agente no motivo, porque o Cosmos grava o usuário de serviço como autor', () => {
        expect(buildCancelReason({ handledBy: 'Ana', reason: 'Cliente desistiu' }))
            .toBe('Cancelado via CX Hub por Ana: Cliente desistiu');
    });
});

describe('matchResendsOfOrder', () => {
    const orders = [
        { external_id: 'SH12345LC-R-1', origin: 'resend' },
        { external_id: 'SH12345LC-R-2', origin: 'resend' },
        { external_id: 'SH12345LC', origin: 'shopify' },
        { external_id: 'SH112345LC-R-1', origin: 'resend' },
        { external_id: 'SH123456LC-R-1', origin: 'resend' },
        { external_id: '#SHOPIFY12345-R-1', origin: 'resend' },
    ];

    it('fica só com os reenvios do pedido, nos dois formatos de external_id', () => {
        expect(matchResendsOfOrder(orders, '12345').map((order) => order.external_id)).toEqual([
            'SH12345LC-R-1',
            'SH12345LC-R-2',
            '#SHOPIFY12345-R-1',
        ]);
    });

    it('aceita o número com # ou letras, como a busca do pedido', () => {
        expect(matchResendsOfOrder(orders, '#12345')).toHaveLength(3);
    });

    it('casa original com sufixo numérico (SH<id><sigla><n>)', () => {
        expect(matchResendsOfOrder([{ external_id: 'SH12345LC1-R-1', origin: 'resend' }], '12345')).toHaveLength(1);
    });

    it('ignora sufixo de reenvio com origem diferente de resend', () => {
        expect(matchResendsOfOrder([{ external_id: 'SH12345LC-R-1', origin: 'internal' }], '12345')).toEqual([]);
    });

    it('número sem dígitos não casa nada', () => {
        expect(matchResendsOfOrder(orders, 'abc')).toEqual([]);
    });
});

describe('parseCosmosOrderId', () => {
    it('aceita só dígitos', () => {
        expect(parseCosmosOrderId('42')).toBe('42');
        expect(parseCosmosOrderId('4a')).toBeNull();
        expect(parseCosmosOrderId('')).toBeNull();
    });
});

describe('parseResendCancelRequest', () => {
    it('aceita e apara handledBy e reason', () => {
        expect(parseResendCancelRequest({ handledBy: ' Ana ', reason: ' Cliente desistiu ' }))
            .toEqual({ ok: true, value: { handledBy: 'Ana', reason: 'Cliente desistiu' } });
    });

    it('exige handledBy', () => {
        expect(parseResendCancelRequest({ reason: 'Cliente desistiu' }))
            .toEqual({ ok: false, message: 'Informe handledBy (agente responsável).' });
    });

    it('exige reason não vazio', () => {
        expect(parseResendCancelRequest({ handledBy: 'Ana', reason: '   ' }))
            .toEqual({ ok: false, message: 'Informe reason (motivo do cancelamento).' });
    });

    it('recusa corpo que não é objeto', () => {
        expect(parseResendCancelRequest(null)).toMatchObject({ ok: false });
        expect(parseResendCancelRequest([])).toMatchObject({ ok: false });
    });
});

describe('parseResendUpdateRequest', () => {
    it('aceita endereço parcial, transportadora e cliente', () => {
        expect(parseResendUpdateRequest({
            handledBy: 'Ana',
            shippingAddress: { street: ' Rua Nova ', number: '200' },
            carrierId: 161,
            customer: { phone: '11911111111' },
        })).toEqual({
            ok: true,
            value: {
                handledBy: 'Ana',
                shippingAddress: { street: 'Rua Nova', number: '200' },
                carrierId: 161,
                customer: { phone: '11911111111' },
            },
        });
    });

    it('recusa produtos e frete, orientando a cancelar e abrir outro reenvio', () => {
        const result = parseResendUpdateRequest({ handledBy: 'Ana', products: [], shippingCost: 0 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain('products, shippingCost');
            expect(result.message).toContain('cancele e abra outro reenvio');
        }
    });

    it('recusa campo desconhecido dentro do endereço (ex.: zipcode)', () => {
        expect(parseResendUpdateRequest({ handledBy: 'Ana', shippingAddress: { zipcode: '01000000' } }))
            .toEqual({ ok: false, message: 'Campo desconhecido em shippingAddress: zipcode.' });
    });

    it('recusa valor que não é texto', () => {
        expect(parseResendUpdateRequest({ handledBy: 'Ana', shippingAddress: { number: 200 } }))
            .toEqual({ ok: false, message: 'shippingAddress.number deve ser texto.' });
    });

    it('recusa objeto vazio em shippingAddress', () => {
        expect(parseResendUpdateRequest({ handledBy: 'Ana', shippingAddress: {} }))
            .toEqual({ ok: false, message: 'shippingAddress está vazio.' });
    });

    it.each(['161', 0, -1, 1.5])('recusa carrierId inválido (%s)', (carrierId) => {
        expect(parseResendUpdateRequest({ handledBy: 'Ana', carrierId })).toMatchObject({ ok: false });
    });

    it('exige alguma coisa para editar', () => {
        expect(parseResendUpdateRequest({ handledBy: 'Ana' }))
            .toEqual({ ok: false, message: 'Nada para editar: informe shippingAddress, carrierId ou customer.' });
    });

    it('exige handledBy', () => {
        expect(parseResendUpdateRequest({ carrierId: 161 }))
            .toEqual({ ok: false, message: 'Informe handledBy (agente responsável).' });
    });
});

describe('buildResendUpdateBody', () => {
    it('mescla o endereço sobre o atual, mantém frete e serviço, e replica na cobrança', () => {
        const result = buildResendUpdateBody(ORDER, {
            handledBy: 'Ana',
            shippingAddress: { street: 'Rua Nova', number: '200' },
        });

        const endereco = {
            name: 'Cliente Teste',
            phone: '11900000000',
            street: 'Rua Nova',
            number: '200',
            complement: 'Ap 1',
            neighborhood: 'Centro',
            city: 'São Paulo',
            state: 'SP',
            postal_code: '01000-000',
        };
        expect(result).toEqual({
            ok: true,
            value: {
                order: {
                    shipping_address: { ...endereco, service_name: 'NORMAL_J&T', cost: '12.5' },
                    billing_address: endereco,
                },
            },
        });
    });

    it('troca de transportadora leva o shopify_name dela no service_name, sem mexer na cobrança', () => {
        const result = buildResendUpdateBody(
            ORDER,
            { handledBy: 'Ana', carrierId: 161 },
            { id: 161, shopify_name: 'NORMAL_LOGGI_STANDARD' },
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.order.carrier_id).toBe(161);
            expect(result.value.order.shipping_address).toMatchObject({
                street: 'Rua Antiga',
                service_name: 'NORMAL_LOGGI_STANDARD',
                cost: '12.5',
            });
            expect(result.value.order).not.toHaveProperty('billing_address');
        }
    });

    it('mescla o cliente mantendo o tipo do documento', () => {
        expect(buildResendUpdateBody(ORDER, { handledBy: 'Ana', customer: { phone: '11911111111' } })).toEqual({
            ok: true,
            value: {
                order: {
                    customer: {
                        name: 'Cliente Teste',
                        email: 'cliente@example.com',
                        phone: '11911111111',
                        document: '00000000000',
                        type: 'cpf',
                    },
                },
            },
        });
    });

    it('recusa endereço que fica incompleto depois da edição', () => {
        expect(buildResendUpdateBody(ORDER, { handledBy: 'Ana', shippingAddress: { street: '' } }))
            .toEqual({ ok: false, message: 'Endereço incompleto depois da edição: falta street.' });
    });

    it('recusa CEP que não tem 8 dígitos', () => {
        expect(buildResendUpdateBody(ORDER, { handledBy: 'Ana', shippingAddress: { postalCode: '0100' } }))
            .toEqual({ ok: false, message: 'CEP inválido: precisa ter 8 dígitos.' });
    });

    it('só manda os objetos que mudam, e nunca metadata', () => {
        const result = buildResendUpdateBody(
            ORDER,
            { handledBy: 'Ana', shippingAddress: { number: '1' }, customer: { name: 'Outro Nome' } },
            { id: 1, shopify_name: 'NORMAL_J&T' },
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(Object.keys(result.value.order).sort())
                .toEqual(['billing_address', 'carrier_id', 'customer', 'shipping_address']);
        }
    });
});
