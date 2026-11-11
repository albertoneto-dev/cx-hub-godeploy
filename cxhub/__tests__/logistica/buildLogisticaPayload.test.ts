import { describe, it, expect } from 'vitest';
import { buildLogisticaPayload } from '@modules/logistica/actions/buildLogisticaPayload';
import type { LogisticaFormData, LogisticaAddressData, LogisticaProblema } from '@modules/logistica/types';
import { ISSUE_MAP, PROBLEMAS } from '@modules/logistica/types';
import { createNormalizedOrder, createNormalizedAddress } from '../helpers/factories';

function validFormData(overrides: Partial<LogisticaFormData> = {}): LogisticaFormData {
    return {
        responsavel: 'Maria Santos',
        problema: 'Acareação',
        marca: 'Kokeshi',
        numeroPedido: '220183',
        ...overrides,
    };
}

function validAddress(overrides: Partial<LogisticaAddressData> = {}): LogisticaAddressData {
    return {
        logradouro: 'Rua Voluntário Benedito Sérgio',
        numero: '940',
        complemento: 'Bloco A',
        bairro: 'Parque São Cristóvão',
        cidade: 'Taubaté',
        estado: 'SP',
        cep: '12053-000',
        ...overrides,
    };
}

describe('buildLogisticaPayload', () => {
    describe('payload base (sem endereço)', () => {
        it('constrói payload corretamente para problema != Endereço Errado', () => {
            const orderData = createNormalizedOrder({ order_name: 'SH220183BB' });
            const payload = buildLogisticaPayload({
                formData: validFormData(),
                orderData,
            });

            expect(payload.orderId).toBe('SH220183BB');
            expect(payload.issue).toBe('Acareacao');
            expect(payload.brand).toBe('kokeshi');
            expect(payload.variables.executed_by).toBe('Maria Santos — CXHub');
            expect(payload.variables.correct_address).toBeUndefined();
        });

        it('sempre envia callerType = agent', () => {
            const payload = buildLogisticaPayload({
                formData: validFormData(),
                orderData: createNormalizedOrder(),
            });
            expect(payload.callerType).toBe('agent');
        });

        it('usa order_name como orderId', () => {
            const orderData = createNormalizedOrder({ order_name: '#SHOPIFY123456' });
            const payload = buildLogisticaPayload({
                formData: validFormData(),
                orderData,
            });
            expect(payload.orderId).toBe('#SHOPIFY123456');
        });

        it('mapeia marcas corretamente', () => {
            const orderData = createNormalizedOrder();

            const cases: Array<[string, string]> = [
                ['Lescent', 'lescent'],
                ['Kokeshi', 'kokeshi'],
                ['BySamia', 'bysamia'],
                ['Auá', 'aua'],
                ['Barbours', 'barbours'],
                ['Rituária', 'rituaria'],
            ];

            for (const [display, api] of cases) {
                const payload = buildLogisticaPayload({
                    formData: validFormData({ marca: display }),
                    orderData,
                });
                expect(payload.brand).toBe(api);
            }
        });

        // O worker `cx-ticketcreator` só aceita o vocabulário sem acento —
        // enviar o rótulo da UI resulta em 400. Ver ISSUE_MAP.
        it('traduz o problema da UI para o `issue` do worker', () => {
            const orderData = createNormalizedOrder();

            const cases: Array<[LogisticaProblema, string]> = [
                ['Pedido Atrasado', 'Pedido Atrasado'],
                ['Acareação', 'Acareacao'],
                ['Endereço Errado', 'Endereco Errado'],
                ['Barra Entrega', 'barra_entrega'],
            ];

            for (const [problema, issue] of cases) {
                const payload = buildLogisticaPayload({
                    formData: validFormData({ problema }),
                    orderData,
                });
                expect(payload.issue, `problema "${problema}"`).toBe(issue);
            }
        });

        it('o `issue` traduzido cobre exatamente os PROBLEMAS da UI', () => {
            for (const problema of PROBLEMAS) {
                expect(ISSUE_MAP[problema], `ISSUE_MAP faltando para "${problema}"`).toBeTruthy();
            }
            expect(Object.keys(ISSUE_MAP)).toHaveLength(PROBLEMAS.length);
        });

        it('todos os tipos de problema geram payload base corretamente', () => {
            const orderData = createNormalizedOrder();

            for (const problema of ['Pedido Atrasado', 'Acareação', 'Barra Entrega'] as const) {
                const payload = buildLogisticaPayload({
                    formData: validFormData({ problema }),
                    orderData,
                });
                expect(payload.issue).toBe(ISSUE_MAP[problema]);
                expect(payload.variables.correct_address).toBeUndefined();
            }
        });
    });

    describe('payload com endereço (Endereço Errado)', () => {
        it('inclui correct_address quando problema é Endereço Errado', () => {
            const orderData = createNormalizedOrder({
                nomeCliente: 'Ronaldo Marui',
                telefoneCliente: '(19) 9812-98485',
            });

            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress(),
            });

            expect(payload.issue).toBe('Endereco Errado');
            expect(payload.variables.correct_address).toBeDefined();

            const addr = payload.variables.correct_address!;
            expect(addr.firstname).toBe('Ronaldo');
            expect(addr.lastname).toBe('Marui');
            expect(addr.address1).toBe('Rua Voluntário Benedito Sérgio');
            expect(addr.address2).toBe('940');
            expect(addr.address3).toBe('Bloco A');
            expect(addr.address4).toBe('Parque São Cristóvão');
            expect(addr.phone).toBe('(19) 9812-98485');
            expect(addr.city).toBe('Taubaté');
            expect(addr.zipcode).toBe('12053000');
            expect(addr.country_code).toBe('31');
            expect(addr.state).toBe('São Paulo');
        });

        it('não inclui correct_address quando addressData não fornecido', () => {
            const orderData = createNormalizedOrder();
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
            });

            expect(payload.variables.correct_address).toBeUndefined();
        });

        it('gera fullAddress concatenando campos', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'João Silva' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress(),
            });

            const addr = payload.variables.correct_address!;
            // Igualdade exata, não `toContain`: o `fullAddress` é o corpo do e-mail que a
            // transportadora lê, então o que importa é a linha inteira. Com `toContain` um
            // campo estranho no meio (foi o caso do `country_code`) passa despercebido.
            expect(addr.fullAddress).toBe(
                'Rua Voluntário Benedito Sérgio, 940, Bloco A, Parque São Cristóvão, Taubaté, São Paulo, 12053000',
            );
        });

        it('não coloca o country_code no fullAddress', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'João Silva' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress(),
            });

            const addr = payload.variables.correct_address!;
            // O '31' continua sendo enviado no campo próprio...
            expect(addr.country_code).toBe('31');
            // ...mas não pode aparecer na linha de endereço, entre o estado e o CEP.
            expect(addr.fullAddress).not.toContain(', 31,');
        });

        it('omite complemento vazio do fullAddress', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'João Silva' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress({ complemento: '' }),
            });

            const addr = payload.variables.correct_address!;
            // Should not have ", ," (consecutive commas from empty field)
            expect(addr.fullAddress).not.toMatch(/,\s*,/);
        });

        it('remove caracteres não numéricos do CEP', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'João Silva' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress({ cep: '12.053-000' }),
            });

            expect(payload.variables.correct_address!.zipcode).toBe('12053000');
        });
    });

    describe('splitName', () => {
        it('separa nome e sobrenome', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'Ronaldo Marui' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress(),
            });

            const addr = payload.variables.correct_address!;
            expect(addr.firstname).toBe('Ronaldo');
            expect(addr.lastname).toBe('Marui');
        });

        it('sobrenome vazio quando nome único', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'Ronaldo' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress(),
            });

            const addr = payload.variables.correct_address!;
            expect(addr.firstname).toBe('Ronaldo');
            expect(addr.lastname).toBe('');
        });

        it('sobrenome com múltiplas partes', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'Ana Maria da Silva' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress(),
            });

            const addr = payload.variables.correct_address!;
            expect(addr.firstname).toBe('Ana');
            expect(addr.lastname).toBe('Maria da Silva');
        });
    });

    describe('UF_TO_STATE_NAME mapping', () => {
        it('mapeia SP para São Paulo', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'Teste' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress({ estado: 'SP' }),
            });
            expect(payload.variables.correct_address!.state).toBe('São Paulo');
        });

        it('mapeia RJ para Rio de Janeiro', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'Teste' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress({ estado: 'RJ' }),
            });
            expect(payload.variables.correct_address!.state).toBe('Rio de Janeiro');
        });

        it('fallback para valor original quando UF não encontrada', () => {
            const orderData = createNormalizedOrder({ nomeCliente: 'Teste' });
            const payload = buildLogisticaPayload({
                formData: validFormData({ problema: 'Endereço Errado' }),
                orderData,
                addressData: validAddress({ estado: 'XX' }),
            });
            expect(payload.variables.correct_address!.state).toBe('XX');
        });
    });
});
