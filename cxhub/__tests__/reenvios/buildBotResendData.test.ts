import { describe, it, expect } from 'vitest';
import { buildBotResendData, stripAutomation } from '@modules/reenvios/actions/buildBotResendData';
import type { BotResendPayload } from '@modules/reenvios/actions/adaptBotPayload';
import type { ResendSubmissionData } from '@modules/reenvios/types/sheets';
import type { NormalizedOrder } from '@shared/types';
import {
    createNormalizedOrder,
    createNormalizedProduct,
    createErpPayloadItem,
} from '../helpers/factories';

// ─── Factories locais ───────────────────────────────────────────────

function makeBotPayload(overrides: Partial<BotResendPayload> = {}): BotResendPayload {
    return {
        brand: 'Lescent',
        handledBy: 'Bot Atendimento',
        sourceChannel: 'CHAT_ATENDIMENTO',
        supportTicketId: 'TICKET-991',
        notes: 'Cliente relatou frasco vazando',
        customer: { name: 'Cliente Bot' },
        order: {
            ecommerceOrderId: '#220183',
            batchNumber: 'LOTE-77',
            orderStatus: 'Produto avariado/extraviado',
        },
        reshipment: {
            isFullReshipment: true,
            requiresReturn: true,
            reason: 'Produto avariado',
        },
        return: { carrierTicketId: 'TKT-CARRIER-5' },
        ...overrides,
    };
}

/** Pedido Cosmos simples: 2 produtos de topo, ambos com preço no ERP. */
function makeOrder(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
    return createNormalizedOrder({
        transportadora: 'Correios PAC',
        produtos: [
            createNormalizedProduct({
                id: 'prod-1', product_id: 100, nome: 'Produto A',
                sku: 'SKU-A', quantidade: 2, preco: '50.00',
            }),
            createNormalizedProduct({
                id: 'prod-2', product_id: 200, nome: 'Produto B',
                sku: 'SKU-B', quantidade: 1, preco: '30.00',
            }),
        ],
        erpPayloadItems: [
            createErpPayloadItem({ sku: 'SKU-A', quantity: 2, unit_price: 50, discount_value: 0 }),
            createErpPayloadItem({ sku: 'SKU-B', quantity: 1, unit_price: 30, discount_value: 0 }),
        ],
        ...overrides,
    });
}

// ─── buildBotResendData ─────────────────────────────────────────────

describe('buildBotResendData — reenvio completo', () => {
    it('produtoComProblema traz os SKUs de todos os produtos de topo', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload(),
        });

        expect(result.submissionData.produtoComProblema).toBe('SKU-A;SKU-B');
    });

    it('produtoReenviar traz "<SKU> - <qtd>" com a quantidade do pedido', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload(),
        });

        expect(result.submissionData.produtoReenviar).toBe('SKU-A - 2;SKU-B - 1');
    });

    it('marca a linha como reenvio completo do tipo Reenvio', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload(),
        });

        expect(result.brand).toBe('lescent');
        expect(result.submissionData.ReenvioCompleto).toBe('Sim');
        expect(result.submissionData.tipoSolicitacao).toBe('Reenvio');
    });
});

describe('buildBotResendData — automação', () => {
    it('preenche os campos de automação quando elegível', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload(),
        });

        expect(result.shouldSend).toBe(true);
        expect(result.motivo).toBeUndefined();
        expect(result.submissionData.automacao).toBe('Automação');
        expect(result.submissionData.status).toBe('Realizado');
        expect(result.submissionData.codNfd).toBe('Pendente');
        expect(result.submissionData.erp).toBe('Protheus');
        expect(result.submissionData.valorReenvio).not.toBe('');
    });

    it('monta apiData com carrierId da marca, produtos reais e endereço do pedido', () => {
        const order = makeOrder();
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: order,
            botPayload: makeBotPayload(),
        });

        const apiData = result.submissionData.apiData;
        expect(apiData).toBeDefined();
        expect(apiData!.carrierId).toBe(23); // lescent PAC
        expect(apiData!.carrierServiceName).toBe('EXPRESSO_CORREIOS_PAC');
        expect(apiData!.resendProducts).toEqual(
            expect.arrayContaining([
                { product_id: 100, quantity: 2, unit_price: '50' },
                { product_id: 200, quantity: 1, unit_price: '30' },
            ])
        );
        expect(apiData!.shippingAddress).toEqual({
            street: order.endereco.logradouro,
            number: order.endereco.numero,
            complement: order.endereco.complemento,
            neighborhood: order.endereco.bairro,
            city: order.endereco.cidade,
            state: order.endereco.estado,
            postal_code: order.endereco.cep,
        });
    });
});

describe('buildBotResendData — transportadora', () => {
    it('a transportadora do bot tem precedência sobre a do pedido', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({ transportadora: 'Correios PAC' }),
            botPayload: makeBotPayload({
                reshipment: { isFullReshipment: true, carrier: { name: 'Loggi Standard' } },
            }),
        });

        expect(result.submissionData.transportadoraReenvio).toBe('Loggi');
        expect(result.submissionData.apiData!.carrierId).toBe(21); // lescent Loggi
    });

    it('sem transportadora do bot, usa a do pedido com casamento tolerante', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({ transportadora: 'CORREIOS - SEDEX' }),
            botPayload: makeBotPayload(),
        });

        expect(result.submissionData.transportadoraReenvio).toBe('Sedex');
        expect(result.submissionData.apiData!.carrierId).toBe(27); // lescent Sedex
    });

    it('transportadoraOriginal recebe o valor do pedido como veio', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({ transportadora: 'CORREIOS - SEDEX' }),
            botPayload: makeBotPayload({
                reshipment: { isFullReshipment: true, carrier: { name: 'Loggi Standard' } },
            }),
        });

        expect(result.submissionData.transportadoraOriginal).toBe('CORREIOS - SEDEX');
    });

    // O mapa nome→id é um artefato da UI (o dropdown dá um NOME). No caminho do bot o nome vem do ERP,
    // num vocabulário que o mapa não cobre — foi assim que 'Anjun Express' deixou o bot 0/5 em produção.
    // O id autoritativo já vem no pedido (`adapter.ts` ← `order.carrier.id`), então não há palpite algum.
    it('nome fora do mapa mas pedido com carrierId → usa o do pedido em vez de degradar', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({
                transportadora: 'Anjun Express',
                carrierId: 4211,
                carrierServiceName: 'EXPRESSO_ANJUN_STANDARD',
            }),
            botPayload: makeBotPayload({ reshipment: { isFullReshipment: true } }),
        });

        expect(result.shouldSend).toBe(true);
        expect(result.motivo).toBeUndefined();
        expect(result.submissionData.apiData!.carrierId).toBe(4211);
        expect(result.submissionData.apiData!.carrierServiceName).toBe('EXPRESSO_ANJUN_STANDARD');
        expect(result.submissionData.automacao).toBe('Automação');
    });

    it('a coluna guarda o nome cru do ERP quando o fallback age — a linha ainda diz a um humano qual era', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({
                transportadora: 'Anjun Express',
                carrierId: 4211,
                carrierServiceName: 'EXPRESSO_ANJUN_STANDARD',
            }),
            botPayload: makeBotPayload({ reshipment: { isFullReshipment: true } }),
        });

        expect(result.submissionData.transportadoraReenvio).toBe('Anjun Express');
    });

    // Assimetria de estrago: o nó do Cosmos no n8n tem `onError: continueErrorOutput`, e a saída de erro
    // NÃO passa pelo append — recusa do ERP significa solicitação perdida, sem linha e sem alarme. Então
    // par incompleto degrada: uma fila humana custa menos que a solicitação inteira (INV-05).
    it('carrierId sem service_name NÃO ativa o fallback — degrada em vez de arriscar recusa do ERP', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({
                transportadora: 'Anjun Express',
                carrierId: 4211,
                carrierServiceName: '',
            }),
            botPayload: makeBotPayload({ reshipment: { isFullReshipment: true } }),
        });

        expect(result.shouldSend).toBe(false);
        expect(result.motivo!.toLowerCase()).toContain('transportadora');
        expect(result.submissionData.apiData).toBeUndefined();
        expect(result.submissionData.automacao).toBe('');
    });

    it('o mapa tem precedência sobre o carrierId do pedido quando o nome casa', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({ transportadora: 'Correios PAC', carrierId: 9999 }),
            botPayload: makeBotPayload(),
        });

        expect(result.submissionData.apiData!.carrierId).toBe(23); // lescent PAC, não 9999
    });

    it('transportadora não resolvível → sem automação e com motivo', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({ transportadora: 'Transportadora Desconhecida' }),
            botPayload: makeBotPayload({ reshipment: { isFullReshipment: true } }),
        });

        expect(result.shouldSend).toBe(false);
        expect(result.motivo).toBeTruthy();
        expect(result.motivo!.toLowerCase()).toContain('transportadora');
        expect(result.submissionData.automacao).toBe('');
        expect(result.submissionData.status).toBe('');
        expect(result.submissionData.codNfd).toBe('');
        expect(result.submissionData.erp).toBe('');
        expect(result.submissionData.valorReenvio).toBe('');
        expect(result.submissionData.apiData).toBeUndefined();
    });

    it('classifica a reprovação da transportadora na ORIGEM (reason legível por máquina)', () => {
        // O `reason` nasce aqui, e não na rota, de propósito (ADR-005): quem decide já sabe por quê.
        // Fazer a rota adivinhar por trecho do `motivo` criaria um acoplamento que se rompe em silêncio
        // na primeira vez que alguém reescrever a frase — e o aviso pararia de sair sem nada avisar.
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({ transportadora: 'Anjun Express' }),
            botPayload: makeBotPayload({ reshipment: { isFullReshipment: true } }),
        });

        expect(result.shouldSend).toBe(false);
        expect(result.reason).toBe('CARRIER_UNRESOLVED');
        expect(result.motivo).toContain('Anjun Express');
    });
});

describe('buildBotResendData — dado do bot prevalece', () => {
    it('mapeia cada campo do bot para a coluna correspondente', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload(),
        });

        const d = result.submissionData;
        expect(d.responsavel).toBe('Bot Atendimento');
        expect(d.problemaProduto).toBe('Produto avariado');
        expect(d.idAtendimento).toBe('TICKET-991');
        expect(d.comentarios).toBe('Cliente relatou frasco vazando');
        expect(d.loteProduto).toBe('LOTE-77');
        expect(d.origemReclamacao).toBe('Chat Atendimento');
        expect(d.statusPedido).toBe('Produto avariado/extraviado');
        expect(d.devolucao).toBe('Sim');
        expect(d.ticketTransportadora).toBe('TKT-CARRIER-5');
    });

    it('requiresReturn=false vira "Não"', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload({
                reshipment: { isFullReshipment: true, requiresReturn: false },
            }),
        });

        expect(result.submissionData.devolucao).toBe('Não');
    });

    it('campo que o bot não manda nunca vira undefined', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: { brand: 'Lescent' },
        });

        const d = result.submissionData;
        const colunas: Array<keyof ResendSubmissionData> = [
            'timestamp', 'dataSolicitacao', 'data_criacao', 'tipoSolicitacao', 'responsavel',
            'origemReclamacao', 'idAtendimento', 'cdOrigem', 'nomeCliente', 'telefoneCliente',
            'enderecoCliente', 'cep', 'estado', 'numeroPedido', 'numeroNF', 'chaveNF', 'cosmosId',
            'produtoComProblema', 'produtoReenviar', 'loteProduto', 'problemaProduto',
            'transportadoraOriginal', 'transportadoraReenvio', 'devolucao', 'ticketTransportadora',
            'statusPedido', 'ReenvioCompleto', 'valorReenvio', 'status', 'codNfd', 'automacao',
            'erp', 'comentarios',
        ];

        colunas.forEach(coluna => {
            expect(typeof d[coluna], `coluna ${coluna}`).toBe('string');
        });
        expect(d.idAtendimento).toBe('');
        expect(d.loteProduto).toBe('');
    });
});

describe('buildBotResendData — dados do pedido', () => {
    it('cliente, pedido, NF e endereço vêm do pedido', () => {
        const order = makeOrder();
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: order,
            botPayload: makeBotPayload(),
        });

        const d = result.submissionData;
        expect(d.nomeCliente).toBe(order.nomeCliente);
        expect(d.telefoneCliente).not.toBe('');
        expect(d.numeroPedido).toBe(order.numeroPedido);
        expect(d.numeroNF).toBe('123456');
        expect(d.chaveNF).toBe('chave-acesso-teste');
        expect(d.cosmosId).toBe('12345');
        expect(d.cdOrigem).toContain('SP');
        expect(d.enderecoCliente).toBe(order.enderecoCliente);
        expect(d.cep).toBe('01001-000');
        expect(d.estado).toBe('SP');
    });
});

describe('buildBotResendData — kit', () => {
    it('precifica o kit pela soma dos componentes no erpPayloadItems', () => {
        const order = makeOrder({
            produtos: [
                createNormalizedProduct({
                    id: 'kit-1', product_id: 10, nome: 'Kit Completo',
                    sku: 'KIT-001', quantidade: 1, preco: '100', isKit: true,
                    kitComponents: [
                        createNormalizedProduct({ id: 'comp-1', product_id: 11, nome: 'Componente A', sku: 'COMP-A', quantidade: 1, preco: '50' }),
                        createNormalizedProduct({ id: 'comp-2', product_id: 12, nome: 'Componente B', sku: 'COMP-B', quantidade: 1, preco: '30' }),
                    ],
                }),
            ],
            erpPayloadItems: [
                createErpPayloadItem({ sku: 'COMP-A', quantity: 1, unit_price: 50, discount_value: 0 }),
                createErpPayloadItem({ sku: 'COMP-B', quantity: 1, unit_price: 30, discount_value: 0 }),
            ],
        });

        const result = buildBotResendData({
            brand: 'lescent',
            orderData: order,
            botPayload: makeBotPayload(),
        });

        expect(result.submissionData.produtoReenviar).toBe('KIT-001 - 1');
        expect(result.submissionData.apiData!.resendProducts).toEqual([
            { product_id: 10, quantity: 1, unit_price: '80' },
        ]);
    });
});

describe('buildBotResendData — pedido Shopify', () => {
    it('não automatiza e devolve motivo', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder({ source: 'shopify' }),
            botPayload: makeBotPayload(),
        });

        expect(result.shouldSend).toBe(false);
        expect(result.motivo).toBeTruthy();
        expect(result.submissionData.automacao).toBe('');
        expect(result.submissionData.status).toBe('');
        expect(result.submissionData.codNfd).toBe('');
        expect(result.submissionData.erp).toBe('');
        expect(result.submissionData.valorReenvio).toBe('');
        expect(result.submissionData.apiData).toBeUndefined();
    });
});

describe('buildBotResendData — troca de endereço do bot', () => {
    const enderecoNovo = {
        street: 'Av Nova',
        number: '456',
        complement: 'Apto 10',
        district: 'Vila',
        city: 'Campinas',
        state: 'SP',
    };

    it('usa o endereço do bot e leva o CEP aos DOIS destinos', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload({
                addressChange: {
                    enabled: true,
                    address: { ...enderecoNovo, postalCode: '13010-000' },
                },
            }),
        });

        const d = result.submissionData;
        expect(d.enderecoCliente).toContain('Av Nova');
        expect(d.enderecoCliente).toContain('456');
        expect(d.enderecoCliente).toContain('Campinas');
        expect(d.apiData!.shippingAddress.street).toBe('Av Nova');
        expect(d.apiData!.shippingAddress.number).toBe('456');
        expect(d.apiData!.shippingAddress.city).toBe('Campinas');
        expect(d.apiData!.shippingAddress.state).toBe('SP');

        // A MESMA linha alimenta a coluna da planilha e o corpo que vai ao ERP. O valor vai como o bot
        // mandou: o Cosmos normaliza removendo não-dígitos (Confluence §3.2), então o hífen é irrelevante.
        expect(d.cep).toBe('13010-000');
        expect(d.apiData!.shippingAddress.postal_code).toBe('13010-000');
    });

    it('sem postalCode, o CEP do endereço novo fica vazio (quem barra é a guarda da rota)', () => {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload({
                addressChange: { enabled: true, address: enderecoNovo },
            }),
        });

        expect(result.submissionData.cep).toBe('');
        expect(result.submissionData.apiData!.shippingAddress.postal_code).toBe('');
    });

    it('endereço desligado ⇒ CEP do pedido original, sem regressão no caminho em produção', () => {
        const order = makeOrder();
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: order,
            botPayload: makeBotPayload({
                addressChange: { enabled: false, address: { ...enderecoNovo, postalCode: '13010-000' } },
            }),
        });

        expect(result.submissionData.cep).toBe(order.endereco.cep);
        expect(result.submissionData.apiData!.shippingAddress.postal_code).toBe(order.endereco.cep);
    });
});

// ─── stripAutomation ────────────────────────────────────────────────

describe('stripAutomation', () => {
    function makeAutomatedData(): ResendSubmissionData {
        const result = buildBotResendData({
            brand: 'lescent',
            orderData: makeOrder(),
            botPayload: makeBotPayload(),
        });
        return result.submissionData;
    }

    it('zera os campos de automação e remove apiData', () => {
        const original = makeAutomatedData();
        const stripped = stripAutomation(original);

        expect(stripped.valorReenvio).toBe('');
        expect(stripped.status).toBe('');
        expect(stripped.codNfd).toBe('');
        expect(stripped.automacao).toBe('');
        expect(stripped.erp).toBe('');
        expect('apiData' in stripped ? stripped.apiData : undefined).toBeUndefined();
    });

    it('preserva as outras colunas', () => {
        const original = makeAutomatedData();
        const stripped = stripAutomation(original);

        expect(stripped.produtoReenviar).toBe(original.produtoReenviar);
        expect(stripped.produtoComProblema).toBe(original.produtoComProblema);
        expect(stripped.numeroPedido).toBe(original.numeroPedido);
        expect(stripped.transportadoraReenvio).toBe(original.transportadoraReenvio);
        expect(stripped.responsavel).toBe(original.responsavel);
        expect(stripped.ReenvioCompleto).toBe(original.ReenvioCompleto);
    });

    it('não muta o objeto original', () => {
        const original = makeAutomatedData();
        const antes = JSON.stringify(original);

        stripAutomation(original);

        expect(JSON.stringify(original)).toBe(antes);
        expect(original.automacao).toBe('Automação');
        expect(original.apiData).toBeDefined();
    });
});
