import { describe, it, expect } from 'vitest';
import { adaptBotPayload } from '@modules/reenvios/actions/adaptBotPayload';
import { ORIGENS, STATUS_OPTIONS } from '@shared/lib/constants';

// ─── Chaves declaradas em ResendSubmissionData (modules/reenvios/types/sheets.ts)
// exceto o opcional `apiData`. Lista explícita de propósito: se uma chave sumir
// do contrato, este teste quebra.
const RESEND_SUBMISSION_KEYS = [
    'timestamp',
    'dataSolicitacao',
    'data_criacao',
    'tipoSolicitacao',
    'responsavel',
    'origemReclamacao',
    'idAtendimento',
    'cdOrigem',
    'nomeCliente',
    'telefoneCliente',
    'enderecoCliente',
    'cep',
    'estado',
    'numeroPedido',
    'numeroNF',
    'chaveNF',
    'cosmosId',
    'produtoComProblema',
    'produtoReenviar',
    'loteProduto',
    'problemaProduto',
    'transportadoraOriginal',
    'transportadoraReenvio',
    'devolucao',
    'ticketTransportadora',
    'statusPedido',
    'ReenvioCompleto',
    'valorReenvio',
    'status',
    'codNfd',
    'automacao',
    'erp',
    'comentarios',
] as const;

// ─── Factory do payload do bot (aninhado, en-US) ─────────────────────

function makeBotPayload(overrides: Record<string, unknown> = {}) {
    return {
        brand: 'rituaria',
        testMode: false,
        handledBy: 'Ana Souza',
        sourceChannel: 'CHAT_ATENDIMENTO',
        supportTicketId: 'TKT-9001',
        notes: 'Cliente pediu urgência',
        customer: { name: 'Maria Cliente' },
        order: {
            ecommerceOrderId: '#220183',
            invoiceNumber: '123456',
            invoiceKey: 'chave-de-acesso-nf',
            batchNumber: 'LOTE-77',
            originWarehouse: 'SP',
            orderStatus: 'NOT_SHIPPED',
        },
        reshipment: {
            isFullReshipment: true,
            requiresReturn: false,
            reason: 'Produto avariado',
            problemItems: [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-B', quantity: 2 }],
            reshipmentItems: [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-B', quantity: 3 }],
            carrier: { name: 'Jadlog' },
        },
        return: { carrierName: 'Correios PAC', carrierTicketId: 'TR-555' },
        ...overrides,
    };
}

describe('adaptBotPayload', () => {
    describe('(a) payload cheio → mapeamento completo', () => {
        it('mapeia todos os campos do bot para ResendSubmissionData', () => {
            const { brand, data } = adaptBotPayload(makeBotPayload());

            expect(brand).toBe('rituaria');

            expect(data.responsavel).toBe('Ana Souza');
            expect(data.origemReclamacao).toBe('Chat Atendimento');
            expect(data.idAtendimento).toBe('TKT-9001');
            expect(data.nomeCliente).toBe('Maria Cliente');

            expect(data.numeroPedido).toBe('#220183');
            expect(data.numeroNF).toBe('123456');
            expect(data.chaveNF).toBe('chave-de-acesso-nf');
            expect(data.cdOrigem).toBe('SP');
            expect(data.loteProduto).toBe('LOTE-77');
            expect(data.statusPedido).toBe('Pedido não foi enviado');

            expect(data.ReenvioCompleto).toBe('Sim');
            expect(data.devolucao).toBe('Não');
            expect(data.problemaProduto).toBe('Produto avariado');
            expect(data.produtoComProblema).toBe('SKU-A;SKU-B');
            expect(data.produtoReenviar).toBe('SKU-A - 1;SKU-B - 3');
            expect(data.transportadoraReenvio).toBe('Jadlog');

            expect(data.transportadoraOriginal).toBe('Correios PAC');
            expect(data.ticketTransportadora).toBe('TR-555');
            expect(data.comentarios).toBe('Cliente pediu urgência');
        });

        it('gera timestamp e dataSolicitacao no servidor (nunca vazios)', () => {
            const { data } = adaptBotPayload(makeBotPayload());

            expect(typeof data.timestamp).toBe('string');
            expect(data.timestamp.length).toBeGreaterThan(0);
            expect(typeof data.dataSolicitacao).toBe('string');
            expect(data.dataSolicitacao.length).toBeGreaterThan(0);
        });

        it('deixa vazios os campos que o payload do bot não carrega', () => {
            const { data } = adaptBotPayload(makeBotPayload());

            expect(data.tipoSolicitacao).toBe('');
            expect(data.telefoneCliente).toBe('');
            expect(data.enderecoCliente).toBe('');
            expect(data.cep).toBe('');
            expect(data.data_criacao).toBe('');
            expect(data.cosmosId).toBe('');
        });

        it('mapeia isFullReshipment=false → "Não" e requiresReturn=true → "Sim"', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({
                    reshipment: { isFullReshipment: false, requiresReturn: true },
                })
            );

            expect(data.ReenvioCompleto).toBe('Não');
            expect(data.devolucao).toBe('Sim');
        });
    });

    describe('(b) payload contendo apenas brand', () => {
        it('não lança e devolve a brand', () => {
            expect(() => adaptBotPayload({ brand: 'lescent' })).not.toThrow();
            expect(adaptBotPayload({ brand: 'lescent' }).brand).toBe('lescent');
        });

        it('(f) devolve TODAS as chaves de ResendSubmissionData como string presente', () => {
            const { data } = adaptBotPayload({ brand: 'lescent' });
            const record = data as unknown as Record<string, unknown>;

            for (const key of RESEND_SUBMISSION_KEYS) {
                expect(Object.prototype.hasOwnProperty.call(record, key), `chave ausente: ${key}`).toBe(true);
                expect(typeof record[key], `chave não-string: ${key}`).toBe('string');
                expect(record[key], `chave undefined: ${key}`).not.toBeUndefined();
            }
        });

        it('deixa vazios todos os campos textuais, exceto os timestamps gerados', () => {
            const { data } = adaptBotPayload({ brand: 'lescent' });
            const record = data as unknown as Record<string, string>;

            for (const key of RESEND_SUBMISSION_KEYS) {
                if (key === 'timestamp' || key === 'dataSolicitacao') {
                    expect(record[key].length, `timestamp vazio: ${key}`).toBeGreaterThan(0);
                    continue;
                }
                expect(record[key], `esperado vazio: ${key}`).toBe('');
            }
        });
    });

    describe('(c) nulls explícitos viram string vazia', () => {
        it('notes/batchNumber/carrierTicketId null → ""', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({
                    notes: null,
                    order: { ecommerceOrderId: '#1', batchNumber: null },
                    return: { carrierName: 'PAC', carrierTicketId: null },
                })
            );

            expect(data.comentarios).toBe('');
            expect(data.loteProduto).toBe('');
            expect(data.ticketTransportadora).toBe('');
            expect(data.transportadoraOriginal).toBe('PAC');
        });
    });

    describe('(d) tradução de enums com passthrough do desconhecido', () => {
        it('traduz aliases conhecidos para os valores canônicos', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({ sourceChannel: 'CHAT_ATENDIMENTO', order: { orderStatus: 'NOT_SHIPPED' } })
            );

            expect(ORIGENS).toContain(data.origemReclamacao);
            expect(STATUS_OPTIONS).toContain(data.statusPedido);
            expect(data.origemReclamacao).toBe('Chat Atendimento');
            expect(data.statusPedido).toBe('Pedido não foi enviado');
        });

        it('faz passthrough do valor cru quando o enum não é reconhecido', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({ sourceChannel: 'WHATSAPP_XYZ', order: { orderStatus: 'FOO_BAR' } })
            );

            expect(data.origemReclamacao).toBe('WHATSAPP_XYZ');
            expect(data.statusPedido).toBe('FOO_BAR');
        });

        it('faz passthrough de valor já canônico', () => {
            const { data } = adaptBotPayload(makeBotPayload({ sourceChannel: 'Instagram' }));

            expect(data.origemReclamacao).toBe('Instagram');
        });
    });

    describe('(e) addressChange', () => {
        it('formata o endereço e preenche estado quando enabled=true', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({
                    addressChange: {
                        enabled: true,
                        address: {
                            street: 'Rua Nova',
                            number: '456',
                            complement: 'Apto 12',
                            district: 'Centro',
                            city: 'São Paulo',
                            state: 'SP',
                        },
                    },
                })
            );

            expect(data.enderecoCliente).toBe('Rua Nova, 456, Apto 12, Centro, São Paulo/SP');
            expect(data.estado).toBe('SP');
        });

        it('ignora o endereço quando enabled=false', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({
                    addressChange: {
                        enabled: false,
                        address: {
                            street: 'Rua Nova',
                            number: '456',
                            complement: 'Apto 12',
                            district: 'Centro',
                            city: 'São Paulo',
                            state: 'SP',
                        },
                    },
                })
            );

            expect(data.enderecoCliente).toBe('');
            expect(data.estado).toBe('');
        });

        it('ignora o endereço quando addressChange está ausente', () => {
            const { data } = adaptBotPayload(makeBotPayload());

            expect(data.enderecoCliente).toBe('');
            expect(data.estado).toBe('');
        });

        it('preenche a coluna cep a partir de postalCode quando enabled=true', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({
                    addressChange: {
                        enabled: true,
                        address: { street: 'Rua Nova', number: '456', city: 'São Paulo', state: 'SP', postalCode: '01310-100' },
                    },
                })
            );

            expect(data.cep).toBe('01310-100');
        });

        it('não vaza o CEP para a coluna quando enabled=false', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({
                    addressChange: {
                        enabled: false,
                        address: { street: 'Rua Nova', number: '456', postalCode: '01310-100' },
                    },
                })
            );

            expect(data.cep).toBe('');
        });

        it('CEP ausente no endereço novo continua string vazia, nunca undefined (RF-14)', () => {
            const { data } = adaptBotPayload(
                makeBotPayload({
                    addressChange: { enabled: true, address: { street: 'Rua Nova', number: '456' } },
                })
            );

            expect(data.cep).toBe('');
        });
    });

    describe('(g) sheets-only: nunca decide automação/valor', () => {
        it.each([
            ['payload cheio', makeBotPayload()],
            ['payload mínimo', { brand: 'lescent' }],
            ['payload com addressChange', makeBotPayload({ addressChange: { enabled: true, address: { state: 'RJ' } } })],
        ])('%s → automacao/status/codNfd/erp/valorReenvio vazios e apiData undefined', (_label, payload) => {
            const { data } = adaptBotPayload(payload);

            expect(data.automacao).toBe('');
            expect(data.status).toBe('');
            expect(data.codNfd).toBe('');
            expect(data.erp).toBe('');
            expect(data.valorReenvio).toBe('');
            expect(data.apiData).toBeUndefined();
        });
    });
});
