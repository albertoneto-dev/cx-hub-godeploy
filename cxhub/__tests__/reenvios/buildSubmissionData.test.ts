import { describe, it, expect } from 'vitest';
import { buildSubmissionData } from '@modules/reenvios/actions/buildSubmissionData';
import type { Step1FormData, Step2Data } from '@modules/reenvios/types/resend';
import { INITIAL_STEP1_DATA, INITIAL_STEP2_DATA } from '@modules/reenvios/types/resend';
import type { NormalizedOrder } from '@shared/types';

// ─── Factories ──────────────────────────────────────────────────────

function makeFormData(overrides: Partial<Step1FormData> = {}): Step1FormData {
    return {
        ...INITIAL_STEP1_DATA,
        responsavel: 'Teste',
        tipoSolicitacao: 'reenvio',
        origemReclamacao: 'Email',
        idAtendimento: '123',
        marca: 'Lescent',
        numeroPedido: '#220183',
        ...overrides,
    };
}

function makeStep2Data(overrides: Partial<Step2Data> = {}): Step2Data {
    return {
        ...INITIAL_STEP2_DATA,
        produtosComProblema: ['prod-1'],
        produtosReenviar: ['prod-1'],
        problemaProduto: 'Danificado',
        devolucao: 'nao',
        statusPedido: 'Entregue',
        transportadoraReenvio: 'PAC',
        ReenvioCompleto: 'sim',
        quantidadesReenviar: { 'prod-1': 1 },
        ...overrides,
    };
}

function makeOrderData(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
    return {
        source: 'cosmos',
        cosmos_id: 42,
        shopify_id: '220183',
        order_name: '#220183',
        numeroPedido: '#220183',
        numeroNF: '123456',
        invoiceAccessKey: 'chave-acesso',
        nomeCliente: 'Cliente Teste',
        telefoneCliente: '5511999999999',
        enderecoCliente: 'Rua Teste, 123, Centro, São Paulo/SP',
        endereco: {
            logradouro: 'Rua Teste',
            numero: '123',
            complemento: '',
            bairro: 'Centro',
            cidade: 'São Paulo',
            estado: 'SP',
            cep: '01001-000',
        },
        transportadora: 'PAC',
        cdOrigem: 'SP',
        produtos: [
            {
                id: 'prod-1',
                product_id: 100,
                nome: 'Produto A',
                sku: 'SKU-001',
                quantidade: 1,
                preco: '50.00',
            },
        ],
        erpPayloadItems: [
            { sku: 'SKU-001', quantity: 1, unit_price: 50, discount_value: 5 },
        ],
        shippingCost: '10.00',
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('buildSubmissionData', () => {
    it('retorna brand correta para Lescent', () => {
        const result = buildSubmissionData({
            formData: makeFormData({ marca: 'Lescent' }),
            step2Data: makeStep2Data(),
            orderData: makeOrderData(),
        });

        expect(result.brand).toBe('lescent');
    });

    it('retorna brand correta para Kokeshi', () => {
        const result = buildSubmissionData({
            formData: makeFormData({ marca: 'Kokeshi' }),
            step2Data: makeStep2Data(),
            orderData: makeOrderData(),
        });

        expect(result.brand).toBe('kokeshi');
    });

    it('monta dados basicos do formulario', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data(),
            orderData: makeOrderData(),
        });

        expect(result.submissionData.responsavel).toBe('Teste');
        expect(result.submissionData.tipoSolicitacao).toBe('Reenvio');
        expect(result.submissionData.origemReclamacao).toBe('Email');
        expect(result.submissionData.idAtendimento).toBe('123');
        expect(result.submissionData.cdOrigem).toBe('CD SP');
    });

    it('formata telefone com DDD e 11 digitos', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data(),
            orderData: makeOrderData({ telefoneCliente: '5511999887766' }),
        });

        expect(result.submissionData.telefoneCliente).toBe('(11) 99988-7766');
    });

    it('formata telefone com 10 digitos', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data(),
            orderData: makeOrderData({ telefoneCliente: '1133445566' }),
        });

        expect(result.submissionData.telefoneCliente).toBe('(11) 3344-5566');
    });

    it('usa endereco original quando alterarEndereco=false', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({ alterarEndereco: false }),
            orderData: makeOrderData(),
        });

        expect(result.submissionData.enderecoCliente).toBe('Rua Teste, 123, Centro, São Paulo/SP');
        expect(result.submissionData.cep).toBe('01001-000');
        expect(result.submissionData.estado).toBe('SP');
    });

    it('usa novo endereco quando alterarEndereco=true', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({
                alterarEndereco: true,
                novoEndereco: {
                    logradouro: 'Av Nova',
                    numero: '456',
                    complemento: 'Apto 10',
                    bairro: 'Vila',
                    cidade: 'Campinas',
                    estado: 'SP',
                    cep: '13000-000',
                },
            }),
            orderData: makeOrderData(),
        });

        expect(result.submissionData.enderecoCliente).toBe('Av Nova, 456, Apto 10, Vila, Campinas/SP');
        expect(result.submissionData.cep).toBe('13000-000');
    });

    it('monta produtosComProblema como SKUs separados por ;', () => {
        const order = makeOrderData({
            produtos: [
                { id: 'p1', product_id: 1, nome: 'A', sku: 'SKU-A', quantidade: 1, preco: '10' },
                { id: 'p2', product_id: 2, nome: 'B', sku: 'SKU-B', quantidade: 1, preco: '20' },
            ],
        });

        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({
                produtosComProblema: ['p1', 'p2'],
                produtosReenviar: ['p1'],
                quantidadesReenviar: { 'p1': 1 },
            }),
            orderData: order,
        });

        expect(result.submissionData.produtoComProblema).toBe('SKU-A;SKU-B');
    });

    it('monta produtosReenviar com SKU e quantidade', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({
                produtosReenviar: ['prod-1'],
                quantidadesReenviar: { 'prod-1': 2 },
            }),
            orderData: makeOrderData(),
        });

        expect(result.submissionData.produtoReenviar).toBe('SKU-001 - 2');
    });

    it('shouldSend=true para reenvio cosmos com produto nao-brinde', () => {
        const result = buildSubmissionData({
            formData: makeFormData({ tipoSolicitacao: 'reenvio' }),
            step2Data: makeStep2Data(),
            orderData: makeOrderData({ source: 'cosmos' }),
        });

        expect(result.shouldSend).toBe(true);
        expect(result.motivo).toBeUndefined();
    });

    it('shouldSend=false para pedido Shopify', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data(),
            orderData: makeOrderData({ source: 'shopify' }),
        });

        expect(result.shouldSend).toBe(false);
        expect(result.motivo).toContain('Shopify');
    });

    it('shouldSend=false para tipo cashback', () => {
        const result = buildSubmissionData({
            formData: makeFormData({ tipoSolicitacao: 'cashback' }),
            step2Data: makeStep2Data(),
            orderData: makeOrderData(),
        });

        expect(result.shouldSend).toBe(false);
    });

    it('preenche campos API quando shouldSend=true', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data(),
            orderData: makeOrderData(),
        });

        expect(result.shouldSend).toBe(true);
        expect(result.submissionData.status).toBe('Realizado');
        expect(result.submissionData.codNfd).toBe('Pendente');
        expect(result.submissionData.automacao).toBe('Automação');
        expect(result.submissionData.erp).toBe('Protheus');
        expect(result.submissionData.valorReenvio).not.toBe('');
    });

    it('campos API vazios quando shouldSend=false', () => {
        const result = buildSubmissionData({
            formData: makeFormData({ tipoSolicitacao: 'cashback' }),
            step2Data: makeStep2Data(),
            orderData: makeOrderData(),
        });

        expect(result.submissionData.status).toBe('');
        expect(result.submissionData.codNfd).toBe('');
        expect(result.submissionData.automacao).toBe('');
        expect(result.submissionData.valorReenvio).toBe('');
        expect(result.submissionData.apiData).toBeUndefined();
    });

    it('inclui apiData com carrier e products quando shouldSend=true', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({ transportadoraReenvio: 'PAC' }),
            orderData: makeOrderData(),
        });

        expect(result.submissionData.apiData).toBeDefined();
        expect(result.submissionData.apiData!.carrierId).toBe(23); // lescent PAC
        expect(result.submissionData.apiData!.carrierServiceName).toBe('EXPRESSO_CORREIOS_PAC');
        expect(result.submissionData.apiData!.resendProducts.length).toBeGreaterThan(0);
    });

    it('usa NF manual para pedidos Shopify', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({
                numeroNFManual: '999',
                chaveNFManual: 'chave-manual',
            }),
            orderData: makeOrderData({ source: 'shopify' }),
        });

        expect(result.submissionData.numeroNF).toBe('999');
        expect(result.submissionData.chaveNF).toBe('chave-manual');
    });

    it('usa NF do pedido para Cosmos', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data(),
            orderData: makeOrderData({
                source: 'cosmos',
                numeroNF: '123456',
                invoiceAccessKey: 'chave-cosmos',
            }),
        });

        expect(result.submissionData.numeroNF).toBe('123456');
        expect(result.submissionData.chaveNF).toBe('chave-cosmos');
    });

    it('converte devolucao sim/nao para Sim/Nao', () => {
        const result1 = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({ devolucao: 'sim' }),
            orderData: makeOrderData(),
        });
        expect(result1.submissionData.devolucao).toBe('Sim');

        const result2 = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({ devolucao: 'nao' }),
            orderData: makeOrderData(),
        });
        expect(result2.submissionData.devolucao).toBe('Não');
    });

    it('inclui itens adicionais nos produtosReenviar', () => {
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({
                produtosReenviar: ['prod-1'],
                itensAdicionais: [{
                    id: 200,
                    sku: 'EXTRA-SKU',
                    name: 'Brinde Extra',
                    price: '0.02',
                    is_kit: false,
                    isGift: true,
                    quantidade: 1,
                }],
            }),
            orderData: makeOrderData(),
        });

        expect(result.submissionData.produtoReenviar).toContain('EXTRA-SKU - 1');
    });

    it('kit component deduplication: ignora componente quando kit pai selecionado', () => {
        const order = makeOrderData({
            produtos: [
                {
                    id: 'kit-1',
                    product_id: 10,
                    nome: 'Kit Completo',
                    sku: 'KIT-001',
                    quantidade: 1,
                    preco: '100',
                    isKit: true,
                    kitComponents: [
                        { id: 'comp-1', product_id: 11, nome: 'Componente A', sku: 'COMP-A', quantidade: 1, preco: '50' },
                        { id: 'comp-2', product_id: 12, nome: 'Componente B', sku: 'COMP-B', quantidade: 1, preco: '50' },
                    ],
                },
            ],
            erpPayloadItems: [
                { sku: 'COMP-A', quantity: 1, unit_price: 50, discount_value: 0 },
                { sku: 'COMP-B', quantity: 1, unit_price: 50, discount_value: 0 },
            ],
        });

        // Select kit + component -> component should be deduped
        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({
                produtosReenviar: ['kit-1', 'comp-1'],
                produtosComProblema: ['kit-1'],
                quantidadesReenviar: { 'kit-1': 1 },
            }),
            orderData: order,
        });

        // Only kit SKU should appear, not the component
        expect(result.submissionData.produtoReenviar).toBe('KIT-001 - 1');
    });

    it('kit component: inclui componente quando kit pai NAO selecionado', () => {
        const order = makeOrderData({
            produtos: [
                {
                    id: 'kit-1',
                    product_id: 10,
                    nome: 'Kit Completo',
                    sku: 'KIT-001',
                    quantidade: 1,
                    preco: '100',
                    isKit: true,
                    kitComponents: [
                        { id: 'comp-1', product_id: 11, nome: 'Componente A', sku: 'COMP-A', quantidade: 1, preco: '50' },
                    ],
                },
            ],
            erpPayloadItems: [
                { sku: 'COMP-A', quantity: 1, unit_price: 50, discount_value: 0 },
            ],
        });

        const result = buildSubmissionData({
            formData: makeFormData(),
            step2Data: makeStep2Data({
                produtosReenviar: ['comp-1'],
                produtosComProblema: ['comp-1'],
                quantidadesReenviar: { 'comp-1': 1 },
            }),
            orderData: order,
        });

        expect(result.submissionData.produtoReenviar).toBe('COMP-A - 1');
    });
});

describe('buildSubmissionData — mimo e troca de produto nas marcas sem Cosmos (ADR-016)', () => {
    const pedidoDaShopify = (produtos: NormalizedOrder['produtos']) => makeOrderData({
        source: 'shopify',
        cosmos_id: null,
        order_name: 'SH1629891AP',
        numeroPedido: 'SH1629891AP',
        cdOrigem: 'ES',
        erpPayloadItems: [],
        shippingCost: '0',
        produtos,
    });
    const PEDIDO = pedidoDaShopify([
        { id: 'p1', product_id: 0, nome: 'Shampoo', sku: '20001', quantidade: 2, preco: '49.90', desconto: '0' },
        { id: 'p2', product_id: 0, nome: 'Máscara', sku: '20002', quantidade: 1, preco: '52.90', desconto: '0' },
    ]);
    const mimo = (sku: string, quantidade: number) => ({
        id: Number(sku), sku, name: `Mimo ${sku}`, price: '0.00', is_kit: false, isGift: true, quantidade,
    });
    const montar = (step2: Partial<Step2Data>, marca = 'Ápice', pedido = PEDIDO) => buildSubmissionData({
        formData: makeFormData({ marca }),
        step2Data: makeStep2Data({
            produtosComProblema: ['p2'],
            produtosReenviar: ['p1', 'p2'],
            quantidadesReenviar: { p1: 2, p2: 1 },
            transportadoraReenvio: '',
            ...step2,
        }),
        orderData: pedido,
    }).submissionData;

    it('troca e mimo: SKU do substituto, os mimos depois, o mesmo SKU somado; as notas na frente das observações', () => {
        const dados = montar({
            substituicoes: { p2: { sku: '20009', name: 'Máscara Nova' } },
            itensAdicionais: [mimo('40001', 2), mimo('20009', 1)],
            observacoes: '  Cliente pediu urgência  ',
        });

        expect(dados.produtoReenviar).toBe('20001 - 2;20009 - 2;40001 - 2');
        expect(dados.comentarios).toBe(
            'SKU 20002 sem estoque substituído pelo SKU 20009; SKU 40001 incluído como mimo; SKU 20009 incluído como mimo | Cliente pediu urgência',
        );
        // O produto com problema e o valor seguem os itens ORIGINAIS (o substituto herda o preço; o mimo não entra).
        expect(dados.produtoComProblema).toBe('20002');
        expect(dados.valorReenvio).toBe('152,70');
    });

    it('as notas seguem a ordem de produtosReenviar, e a troca de um item de quantidade 2 leva as 2', () => {
        const dados = montar({
            produtosReenviar: ['p2', 'p1'],
            substituicoes: { p1: { sku: '20011', name: 'Shampoo 1L' }, p2: { sku: '20012', name: 'Máscara 1kg' } },
        });
        expect(dados.produtoReenviar).toBe('20012 - 1;20011 - 2');
        expect(dados.comentarios).toBe('SKU 20002 sem estoque substituído pelo SKU 20012; SKU 20001 sem estoque substituído pelo SKU 20011');
    });

    it('comentarios: só as notas, só as observações (sem espaço nas pontas) ou vazio', () => {
        expect(montar({ itensAdicionais: [mimo('40001', 1)] }).comentarios).toBe('SKU 40001 incluído como mimo');
        expect(montar({ observacoes: ' obs ' }).comentarios).toBe('obs');
        expect(montar({ observacoes: '   ' }).comentarios).toBe('');
    });

    it('sem troca nem mimo, o mesmo SKU em duas linhas do pedido vai somado', () => {
        const pedido = pedidoDaShopify([
            { id: 'p1', product_id: 0, nome: 'Shampoo', sku: 'YE01120', quantidade: 1, preco: '59.90', desconto: '0' },
            { id: 'p2', product_id: 0, nome: 'Shampoo (brinde)', sku: 'YE01120', quantidade: 1, preco: '0.02', desconto: '0' },
        ]);
        expect(montar({ quantidadesReenviar: {} }, 'Yenzah', pedido).produtoReenviar).toBe('YE01120 - 2');
    });

    it('a chave da troca pode ser um componente de kit', () => {
        const pedido = pedidoDaShopify([{
            id: 'k1', product_id: 0, nome: 'Kit', sku: 'KIT-1', quantidade: 1, preco: '100', isKit: true,
            kitComponents: [
                { id: 'c1', product_id: 0, nome: 'A', sku: 'DN-A', quantidade: 1, preco: '50' },
                { id: 'c2', product_id: 0, nome: 'B', sku: 'DN-B', quantidade: 1, preco: '50' },
            ],
        }]);
        const dados = montar({
            produtosComProblema: ['c1'], produtosReenviar: ['c1', 'c2'], quantidadesReenviar: {},
            substituicoes: { c1: { sku: 'DN-Z', name: 'Z' } },
        }, 'Denavita', pedido);
        expect(dados.produtoReenviar).toBe('DN-Z - 1;DN-B - 1');
        expect(dados.comentarios).toBe('SKU DN-A sem estoque substituído pelo SKU DN-Z');
    });

    it('marca do Cosmos: nada muda (substituicoes ignoradas, item adicional como antes, observações como vieram)', () => {
        const result = buildSubmissionData({
            formData: makeFormData({ marca: 'Lescent' }),
            step2Data: makeStep2Data({
                substituicoes: { 'prod-1': { sku: 'OUTRO', name: 'Outro' } },
                itemDiferente: true,
                itensAdicionais: [{ id: 200, sku: 'EXTRA-SKU', name: 'Brinde Extra', price: '0.02', is_kit: false, isGift: true, quantidade: 1 }],
                observacoes: '  obs  ',
            }),
            orderData: makeOrderData(),
        });

        expect(result.submissionData.produtoReenviar).toBe('SKU-001 - 1;EXTRA-SKU - 1');
        expect(result.submissionData.comentarios).toBe('  obs  ');
        // (50 − 5) + 0,02 do brinde extra + 10 de frete
        expect(result.submissionData.valorReenvio).toBe('55,02');
    });
});
