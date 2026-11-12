import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/lib/metabase', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/metabase')>()),
    consultarDataMart: vi.fn(),
}));

import {
    buscarPedidoDaShopifyNoDataMart,
    pedidoDoDataMartParaShopify,
    sqlDoPedidoDaShopify,
} from '@shared/lib/datamart/pedidoDaShopifyServer';
import { consultarDataMart, MetabaseError } from '@shared/lib/metabase';
import { adaptShopifyOrder } from '@shared/lib/shopify/adapter';

/**
 * O pedido da Shopify lido no Data Mart, a reserva do integrations-gateway para o pedido fora dos 60 dias que ele
 * enxerga (decisão deste app, `cxhub/ORIGEM.md`): a consulta, o mapeamento para o formato REST do gateway e o que o
 * `adaptShopifyOrder` faz com ele. Dado pessoal de mentira; os SKUs e o frete são os do pedido #1607929 da Ápice.
 */

const consultar = vi.mocked(consultarDataMart);

const ITENS = [
    {
        id: 18037428879582, sku: '45161', name: 'Kit Cachos - Shampoo, Condicionador e Ativador (3 ITENS)', vendor: 'Apice',
        quantity: 1, current_quantity: 1, price: '110.42', total_discount: '0.00', discount_allocations: [], properties: [],
    },
    {
        id: 18037429043422, sku: '20911', name: 'Óleo Árabe Noor Elixir 60ml', vendor: 'Apice', quantity: 2,
        current_quantity: 2, price: '59.90', total_discount: '0.00',
        discount_allocations: [{ amount: '3.00', discount_application_index: 0 }, { amount: '2.00', discount_application_index: 1 }],
    },
];

/** Uma linha da consulta, na ordem das colunas do SELECT (o `jsonb` vem como texto, como o Metabase devolve). */
function linha(trocas: Record<number, unknown> = {}): unknown[] {
    const base: unknown[] = [
        '7613222846686', '#1607929', '2026-09-09T18:10:22Z', 'cliente@exemplo.com', 'paid', 225.22, 225.22, 0,
        'Cliente Teste da Silva', '+5591999990000', null,
        'Cliente', 'Teste da Silva', 'Rua A, 10', 'Centro', 'Belém', '66000-000', 'PA',
        JSON.stringify(ITENS),
        JSON.stringify([{ title: 'NORMAL_ANJUN_EXPRESS', price: '0.00' }]),
        JSON.stringify([{ tracking_company: null, tracking_number: 'AJ123' }]),
        JSON.stringify([{ name: 'additional_cpf_cnpj', value: '00000000191' }, { name: 'Rua', value: 'Rua A' }]),
        null,
    ];
    for (const [i, valor] of Object.entries(trocas)) base[Number(i)] = valor;
    return base;
}

beforeEach(() => {
    consultar.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('pedidoDoDataMartParaShopify', () => {
    it('monta o mesmo formato REST do gateway, só com os campos que o adapter lê', () => {
        const pedido = pedidoDoDataMartParaShopify(linha());

        expect(pedido).toEqual({
            id: 7613222846686,
            name: '#1607929',
            created_at: '2026-09-09T18:10:22Z',
            email: 'cliente@exemplo.com',
            financial_status: 'paid',
            current_total_price: '225.22',
            total_price: '225.22',
            total_shipping_price_set: { shop_money: { amount: '0.00' } },
            customer: { first_name: 'Cliente', last_name: 'Teste da Silva', phone: '+5591999990000' },
            shipping_address: {
                name: 'Cliente Teste da Silva', address1: 'Rua A, 10', address2: 'Centro', city: 'Belém', zip: '66000-000',
                province: 'PA', province_code: 'PA', phone: '+5591999990000',
            },
            shipping_lines: [{ title: 'NORMAL_ANJUN_EXPRESS' }],
            note_attributes: [],
            line_items: [
                { id: 18037428879582, name: ITENS[0].name, sku: '45161', vendor: 'Apice', quantity: 1, price: '110.42', discount_allocations: [{ amount: '0.00', discount_application_index: 0 }] },
                { id: 18037429043422, name: ITENS[1].name, sku: '20911', vendor: 'Apice', quantity: 2, price: '59.90', discount_allocations: [{ amount: '5.00', discount_application_index: 0 }] },
            ],
            fulfillments: [{ tracking_company: null, tracking_number: 'AJ123' }],
        });
        // Dos atributos, só o nf_number passaria: o CPF e o endereço ficam de fora.
        expect(JSON.stringify(pedido)).not.toContain('00000000191');
    });

    it('o adapter lê o pedido do Data Mart como lê o do gateway', () => {
        const pedido = pedidoDoDataMartParaShopify(linha());
        if (!pedido) throw new Error('esperava o pedido');

        const normalizado = adaptShopifyOrder(pedido, 'apice');

        expect(normalizado).toMatchObject({
            source: 'shopify',
            numeroPedido: '#1607929',
            nomeCliente: 'Cliente Teste da Silva',
            transportadora: 'Anjun',
            cdOrigem: 'ES',
            orderTotal: '225.22',
            shippingCost: '0.00',
            endereco: { cidade: 'Belém', estado: 'PA', cep: '66000-000', bairro: 'Centro' },
        });
        expect(normalizado.produtos.map((p) => [p.sku, p.quantidade, p.preco, p.desconto])).toEqual([
            ['45161', 1, '110.42', '0'],
            ['20911', 2, '59.90', '5'],
        ]);
    });

    it('sem as alocações, o desconto do item é o total_discount; o nf_number passa', () => {
        const itens = [{ ...ITENS[0], total_discount: '4.50', discount_allocations: [] }];
        const pedido = pedidoDoDataMartParaShopify(linha({
            18: JSON.stringify(itens),
            21: JSON.stringify([{ name: 'nf_number', value: '10048484' }]),
        }));

        expect(pedido?.line_items[0].discount_allocations).toEqual([{ amount: '4.50', discount_application_index: 0 }]);
        expect(pedido?.note_attributes).toEqual([{ name: 'nf_number', value: '10048484' }]);
    });

    it('sem telefone na Shopify, vale o do Tiny (Ápice); com telefone na Shopify, o do Tiny é ignorado', () => {
        const semFoneNaShopify = pedidoDoDataMartParaShopify(linha({ 9: null, 10: null, 22: '(91) 99999-0000' }));
        expect(semFoneNaShopify?.shipping_address?.phone).toBe('(91) 99999-0000');
        expect(adaptShopifyOrder(semFoneNaShopify!, 'apice').telefoneCliente).toBe('(91) 99999-0000');

        expect(pedidoDoDataMartParaShopify(linha({ 22: '(91) 99999-0000' }))?.shipping_address?.phone).toBe('+5591999990000');
    });

    it('estado que não é sigla fica só no province; o JSON já lido também serve; o ilegível vira lista vazia', () => {
        const pedido = pedidoDoDataMartParaShopify(linha({ 17: 'Pará', 18: ITENS, 19: '{não é json' }));

        expect(pedido?.shipping_address).toMatchObject({ province: 'Pará', province_code: '' });
        expect(pedido?.line_items).toHaveLength(2);
        expect(pedido?.shipping_lines).toEqual([]);
    });

    it('sem endereço nem nome da cliente: shipping_address e customer nulos; sem id ou nome do pedido: nada', () => {
        const semEndereco = pedidoDoDataMartParaShopify(linha({ 8: null, 13: null, 15: null, 16: null }));
        expect(semEndereco?.shipping_address).toBeNull();
        expect(semEndereco?.customer).toBeNull();

        expect(pedidoDoDataMartParaShopify(linha({ 0: null }))).toBeNull();
        expect(pedidoDoDataMartParaShopify(linha({ 1: '' }))).toBeNull();
    });
});

describe('sqlDoPedidoDaShopify', () => {
    it('lê a visão pela chave, com a subconsulta no WHERE pelo índice de marca e número', () => {
        const sql = sqlDoPedidoDaShopify('apice', '1607929');

        expect(sql).toContain('from api.vw_shopify_orders o');
        expect(sql).toContain("where o.order_id = (select order_id from gold.fct_shopify_orders where brand = 'apice' and order_number = 1607929 order by order_id desc limit 1)");
        // Nada de filtro pela marca ou pelo nome na própria visão (sem índice).
        expect(sql).not.toMatch(/o\.(brand|order_name|order_number)\s*=/);
    });

    it('na Ápice, o telefone do Tiny pelo id que a Intelipost guarda; nas outras marcas, a coluna nula', () => {
        const apice = sqlDoPedidoDaShopify('apice', '1607929');
        expect(apice).toContain("from gold.fct_intelipost_orders where shopify_order_number = '1607929' and brand_code = 'apice'");
        expect(apice).toContain('left join api.tiny_pedidos_ap_cosmetics_es e on e.id_pedido = i.external_erp_id');
        expect(apice).toContain('left join api.tiny_pedidos_ap_cosmetics_rj r on r.id_pedido = i.external_erp_id');

        const yenzah = sqlDoPedidoDaShopify('yenzah', '5478');
        expect(yenzah).toContain('null as fone_do_tiny');
        expect(yenzah).not.toContain('tiny_pedidos');
    });
});

describe('buscarPedidoDaShopifyNoDataMart', () => {
    it('acha pelo número, com ou sem o SH…AP ou o #', async () => {
        consultar.mockResolvedValue([linha()]);

        for (const pedido of ['1607929', 'SH1607929AP', '#1607929']) {
            const r = await buscarPedidoDaShopifyNoDataMart('apice', pedido);
            expect(r.tipo === 'achado' && r.pedido.name).toBe('#1607929');
        }
        expect(consultar.mock.calls.every(([sql]) => sql.includes('order_number = 1607929'))).toBe(true);
    });

    it('a Rituária, que neste app também passa pelo gateway, também tem a reserva', async () => {
        consultar.mockResolvedValue([linha({ 1: '#123456' })]);

        const r = await buscarPedidoDaShopifyNoDataMart('rituaria', '123456');

        expect(r.tipo === 'achado' && r.pedido.name).toBe('#123456');
        expect(consultar.mock.calls[0][0]).toContain("brand = 'rituaria' and order_number = 123456");
    });

    it('sem a linha, ou com um pedido de outro número: não encontrado', async () => {
        consultar.mockResolvedValueOnce([]);
        expect(await buscarPedidoDaShopifyNoDataMart('yenzah', 'SH5478YE')).toEqual({ tipo: 'nao_encontrado' });

        consultar.mockResolvedValueOnce([linha({ 1: '#1607930' })]);
        expect(await buscarPedidoDaShopifyNoDataMart('apice', '1607929')).toEqual({ tipo: 'nao_encontrado' });
    });

    it('a Gobeaute (fora do Data Mart) e o número que não é de pedido nem consultam', async () => {
        expect(await buscarPedidoDaShopifyNoDataMart('gobeaute', 'SH1041GB')).toEqual({ tipo: 'nao_encontrado' });
        expect(await buscarPedidoDaShopifyNoDataMart('apice', 'SH')).toEqual({ tipo: 'nao_encontrado' });
        expect(await buscarPedidoDaShopifyNoDataMart('apice', '1184356468908164')).toEqual({ tipo: 'nao_encontrado' });
        expect(consultar).not.toHaveBeenCalled();
    });

    it('o Metabase com erro vira falha, nunca exceção', async () => {
        consultar.mockRejectedValue(new MetabaseError(0, 'Metabase não respondeu em 5s'));

        expect(await buscarPedidoDaShopifyNoDataMart('denavita', '423209')).toEqual({ tipo: 'falha', erro: 'Metabase não respondeu em 5s' });
    });
});
