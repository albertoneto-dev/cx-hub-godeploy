import { describe, expect, it } from 'vitest';
import {
    derivarContextoDoPedido,
    digitosDoPedido,
    itensDoProdutoReenviar,
    itensOriginaisDoReenvio,
    nfDiverge,
    notaDeNaoConferido,
    pedidoDaPlanilha,
    pedidoEscolhidoNoTiny,
    temMimoOuTroca,
    valorDaNfDeReenvio,
    valorNfReenvio,
} from '@shared/lib/datamart/pedido';
import type {
    ContextoDoPedido,
    LeiturasDoPedido,
    LinhaExplodida,
    NotaNoTiny,
    PedidoNaShopify,
    PedidoNoTiny,
    RemessaIntelipost,
} from '@shared/lib/datamart/pedidoTipos';

const FALHA = { ok: false as const, motivo: 'Metabase fora do ar' };

const REMESSA: RemessaIntelipost = {
    nf: '10157987',
    ufOrigem: 'ES',
    idPedidoTiny: '1061809849',
    despachadaEm: '2026-10-27T20:09:43+00:00',
    entregueEm: null,
    temRastreio: true,
};

const SHOPIFY: PedidoNaShopify = {
    orderId: '7001',
    criadoEm: '2026-10-27T11:20:00+00:00',
    total: 305.7,
    frete: 15.9,
    cancelado: false,
    temRastreio: true,
};

const linha = (skuDaLinha: string, sku: string, receita: number, extra: Partial<LinhaExplodida> = {}): LinhaExplodida => ({
    skuDaLinha,
    sku,
    componenteDeKit: true,
    qtdPorKit: 1,
    unidades: 1,
    receita,
    ...extra,
});

const EXPLODIDAS: LinhaExplodida[] = [
    linha('40132', '20683', 31.5),
    linha('40132', '20684', 37.3),
    linha('40132', '20688', 35.36),
    linha('40132', '20690', 54.74),
    linha('40132', '20696', 31),
    linha('46194', '20910', 46.15),
    linha('46194', '20911', 53.75),
];

const TINY: PedidoNoTiny = {
    cd: 'es',
    idPedido: '1061809849',
    idNotaFiscal: '1061811664',
    dataPedido: '2026-10-27',
    temRastreio: true,
    itens: [
        { sku: '40132', descricao: 'Kit Cachos - Shampoo, Condicionador, Gelatina, Máscara e Ativador (5 ITENS)', quantidade: 1 },
        { sku: '46194', descricao: 'KIT BRILHO PERFEITO - Shampoo em óleo e Óleo Árabe', quantidade: 1 },
    ],
};

const NOTA: NotaNoTiny = {
    numero: '10157987',
    situacao: 'Autorizada',
    total: 305.7,
    produtos: 289.8,
    desconto: 0,
    frete: 15.9,
    temRastreio: true,
    itens: [
        ['20683', 37.2],
        ['20684', 38.76],
        ['20688', 37.2],
        ['20690', 41.86],
        ['20696', 34.88],
        ['20910', 48.13],
        ['20911', 51.77],
    ].map(([sku, precoUnitario]) => ({ sku: String(sku), quantidade: 1, precoUnitario: Number(precoUnitario) })),
};

/** O caso real SH1731559AP: tudo respondeu. */
function leiturasApice(sobre: Partial<LeiturasDoPedido> = {}): LeiturasDoPedido {
    return {
        marca: 'apice',
        numero: '1731559',
        intelipost: { ok: true, dados: [REMESSA] },
        shopify: { ok: true, dados: SHOPIFY },
        explodidas: { ok: true, dados: EXPLODIDAS },
        tiny: { ok: true, dados: [TINY] },
        nota: { ok: true, dados: NOTA },
        ...sobre,
    };
}

const DENAVITA_AVULSAS: LinhaExplodida[] = [
    linha('Laranjamorodenavita', 'Laranjamorodenavita', 81.9, { componenteDeKit: false }),
    linha('DVTRI1', 'DVTRI1', 69.9, { componenteDeKit: false }),
];

function leiturasDenavita(sobre: Partial<LeiturasDoPedido> = {}): LeiturasDoPedido {
    return {
        marca: 'denavita',
        numero: '2001234',
        intelipost: { ok: true, dados: [{ ...REMESSA, nf: '555', ufOrigem: 'MG', idPedidoTiny: null }] },
        shopify: { ok: true, dados: { ...SHOPIFY, total: 137.93, frete: 8.9 } },
        explodidas: { ok: true, dados: DENAVITA_AVULSAS },
        ...sobre,
    };
}

describe('digitosDoPedido e pedidoDaPlanilha', () => {
    it('só os dígitos, entre 3 e 9', () => {
        expect(digitosDoPedido('SH1731559AP')).toBe('1731559');
        expect(digitosDoPedido('#1234')).toBe('1234');
        expect(digitosDoPedido('12')).toBeNull();
        expect(digitosDoPedido('1234567890')).toBeNull();
        expect(digitosDoPedido('abc')).toBeNull();
        expect(digitosDoPedido(null)).toBeNull();
        expect(digitosDoPedido(undefined)).toBeNull();
    });

    it('monta o pedido com o sufixo da marca', () => {
        expect(pedidoDaPlanilha('apice', '1731559')).toBe('SH1731559AP');
        expect(pedidoDaPlanilha('yenzah', '55')).toBe('SH55YE');
        expect(pedidoDaPlanilha('denavita', '77')).toBe('SH77DN');
    });
});

describe('pedidoEscolhidoNoTiny', () => {
    it('vale o mais recente, e no empate o primeiro', () => {
        const es = { ...TINY, cd: 'es' as const, dataPedido: '2026-10-01' };
        const rj = { ...TINY, cd: 'rj' as const, dataPedido: '2026-10-05' };
        expect(pedidoEscolhidoNoTiny([es, rj])?.cd).toBe('rj');
        expect(pedidoEscolhidoNoTiny([es, { ...rj, dataPedido: '2026-10-01' }])?.cd).toBe('es');
        expect(pedidoEscolhidoNoTiny([])).toBeNull();
    });
});

describe('derivarContextoDoPedido — o caso real SH1731559AP (Ápice)', () => {
    const contexto = derivarContextoDoPedido(leiturasApice());

    it('NF, CD, status, avisos e kits', () => {
        expect(contexto.pedido).toBe('SH1731559AP');
        expect(contexto.nf).toEqual({ estado: 'achada', numero: '10157987' });
        expect(contexto.cd).toEqual({ valor: 'CD ES', conferido: true });
        expect(contexto.statusSugerido).toBe('Pedido não entregue (em trânsito)');
        expect(contexto.avisos).toEqual([]);
        expect(contexto.kits).toEqual([
            { sku: '40132', componentes: ['20683', '20684', '20688', '20690', '20696'].map((sku) => ({ sku, quantidade: 1 })) },
            { sku: '46194', componentes: ['20910', '20911'].map((sku) => ({ sku, quantidade: 1 })) },
        ]);
        expect(contexto.baseConferida).toBe(true);
        expect(contexto.baseDoValor?.produtos).toBe(289.8);
    });

    it('o reenvio de um item só: 37,20 + a fatia do frete (2,04) = 39,24', () => {
        expect(valorDaNfDeReenvio(contexto, [{ sku: '20688', quantidade: 1 }])).toEqual({ tipo: 'calculado', valor: 39.24 });
    });

    it('o Kit Cachos inteiro, ou os 5 componentes um a um: 189,90 + 10,42 = 200,32', () => {
        expect(valorDaNfDeReenvio(contexto, [{ sku: '40132', quantidade: 1 }])).toEqual({ tipo: 'calculado', valor: 200.32 });
        const componentes = ['20683', '20684', '20688', '20690', '20696'].map((sku) => ({ sku, quantidade: 1 }));
        expect(valorDaNfDeReenvio(contexto, componentes)).toEqual({ tipo: 'calculado', valor: 200.32 });
    });

    it('o pedido completo vale o total da NF', () => {
        const itens = [{ sku: '40132', quantidade: 1 }, { sku: '46194', quantidade: 1 }];
        expect(valorDaNfDeReenvio(contexto, itens)).toEqual({ tipo: 'calculado', valor: 305.7 });
    });

    it('o valor usa os preços da NF, não os da visão da Shopify (que reparte o kit de outro jeito)', () => {
        // Na visão da Shopify o 20688 vale 35,36; na NF, 37,20.
        expect(contexto.baseDoValor?.precos['20688']).toBe(37.2);
        expect(valorDaNfDeReenvio(contexto, [{ sku: '20688', quantidade: 1 }])).not.toEqual({ tipo: 'calculado', valor: 35.36 });
    });
});

describe('derivarContextoDoPedido — NF', () => {
    it('a Intelipost vale antes do Tiny', () => {
        const c = derivarContextoDoPedido(leiturasApice({ nota: { ok: true, dados: { ...NOTA, numero: '999' } } }));
        expect(c.nf.numero).toBe('10157987');
    });

    it('na Ápice, sem NF na Intelipost, vale a do Tiny quando não está cancelada', () => {
        const sem = { ok: true as const, dados: [{ ...REMESSA, nf: null }] };
        expect(derivarContextoDoPedido(leiturasApice({ intelipost: sem })).nf).toEqual({ estado: 'achada', numero: '10157987' });
        const cancelada = derivarContextoDoPedido(leiturasApice({ intelipost: sem, nota: { ok: true, dados: { ...NOTA, situacao: 'Cancelada' } } }));
        expect(cancelada.nf).toEqual({ estado: 'ausente', numero: null });
        expect(cancelada.baseDoValor).toBeNull();
        expect(cancelada.unidadesDoPedido).toEqual({});
    });

    it('ausente quando todas responderam e nenhuma tem NF; desconhecida quando uma falhou', () => {
        const sem = { ok: true as const, dados: [] };
        const base = { intelipost: sem, nota: { ok: true as const, dados: null } };
        const ausente = derivarContextoDoPedido(leiturasApice(base));
        expect(ausente.nf).toEqual({ estado: 'ausente', numero: null });
        expect(ausente.avisos).toContain('O pedido ainda não tem NF de venda autorizada no Tiny nem na Intelipost.');
        expect(derivarContextoDoPedido(leiturasApice({ ...base, nota: FALHA })).nf.estado).toBe('desconhecida');
        expect(derivarContextoDoPedido(leiturasApice({ ...base, tiny: FALHA })).nf.estado).toBe('desconhecida');
        expect(derivarContextoDoPedido(leiturasApice({ ...base, intelipost: FALHA })).nf.estado).toBe('desconhecida');
    });

    it('Yenzah e Denavita: ausente se a Intelipost respondeu, senão desconhecida', () => {
        const ausente = derivarContextoDoPedido(leiturasDenavita({ intelipost: { ok: true, dados: [] } }));
        expect(ausente.nf).toEqual({ estado: 'ausente', numero: null });
        expect(ausente.avisos).toContain('A Intelipost ainda não tem a NF deste pedido (pedido pode não ter sido faturado).');
        expect(derivarContextoDoPedido(leiturasDenavita({ intelipost: FALHA })).nf.estado).toBe('desconhecida');
    });
});

describe('derivarContextoDoPedido — CD', () => {
    it('Denavita é sempre CD MG', () => {
        expect(derivarContextoDoPedido(leiturasDenavita({ intelipost: FALHA })).cd).toEqual({ valor: 'CD MG', conferido: true });
    });

    it('Yenzah usa a UF da Intelipost; sem ela, avisa; com a Intelipost fora, não conferido', () => {
        const base = { marca: 'yenzah' as const, explodidas: { ok: true as const, dados: DENAVITA_AVULSAS } };
        const rem = (ufOrigem: string | null) => ({ ok: true as const, dados: [{ ...REMESSA, ufOrigem }] });
        expect(derivarContextoDoPedido(leiturasDenavita({ ...base, intelipost: rem('rj') })).cd).toEqual({ valor: 'CD RJ', conferido: true });
        const sem = derivarContextoDoPedido(leiturasDenavita({ ...base, intelipost: rem(null) }));
        expect(sem.cd).toEqual({ valor: null, conferido: true });
        expect(sem.avisos).toContain('Não encontrei o CD de origem na Intelipost.');
        expect(derivarContextoDoPedido(leiturasDenavita({ ...base, intelipost: FALHA })).cd).toEqual({ valor: null, conferido: false });
    });

    it('Ápice: a tabela do Tiny manda, a Intelipost é a reserva', () => {
        const rj = { ...TINY, cd: 'rj' as const };
        expect(derivarContextoDoPedido(leiturasApice({ tiny: { ok: true, dados: [rj] } })).cd.valor).toBe('CD RJ');
        const reserva = derivarContextoDoPedido(leiturasApice({ tiny: { ok: true, dados: [] }, intelipost: { ok: true, dados: [{ ...REMESSA, ufOrigem: 'rj' }] } }));
        expect(reserva.cd).toEqual({ valor: 'CD RJ', conferido: true });
        const reservaComTinyFora = derivarContextoDoPedido(leiturasApice({ tiny: FALHA }));
        expect(reservaComTinyFora.cd).toEqual({ valor: 'CD ES', conferido: true });
    });

    it('Ápice: sem Tiny nem UF, avisa se tudo respondeu, e não confere se algo falhou', () => {
        const semUf = { ok: true as const, dados: [{ ...REMESSA, ufOrigem: null }] };
        const aviso = derivarContextoDoPedido(leiturasApice({ tiny: { ok: true, dados: [] }, intelipost: semUf }));
        expect(aviso.cd).toEqual({ valor: null, conferido: true });
        expect(aviso.avisos).toContain('Não encontrei o CD de origem no Tiny nem na Intelipost.');
        expect(derivarContextoDoPedido(leiturasApice({ tiny: FALHA, intelipost: semUf })).cd).toEqual({ valor: null, conferido: false });
        expect(derivarContextoDoPedido(leiturasApice({ tiny: { ok: true, dados: [] }, intelipost: FALHA })).cd).toEqual({ valor: null, conferido: false });
    });

    it('pedido nos dois CDs: usa o mais recente e avisa', () => {
        const es = { ...TINY, cd: 'es' as const, dataPedido: '2026-10-01' };
        const rj = { ...TINY, cd: 'rj' as const, dataPedido: '2026-10-27' };
        const c = derivarContextoDoPedido(leiturasApice({ tiny: { ok: true, dados: [es, rj] } }));
        expect(c.cd.valor).toBe('CD RJ');
        expect(c.avisos).toEqual(['Pedido encontrado em mais de um CD (ES, RJ); usando o CD RJ.']);
    });
});

describe('derivarContextoDoPedido — status sugerido', () => {
    const com = (remessa: Partial<RemessaIntelipost> | null, sobre: Partial<LeiturasDoPedido> = {}) =>
        derivarContextoDoPedido(
            leiturasApice({ intelipost: { ok: true, dados: remessa ? [{ ...REMESSA, ...remessa }] : [] }, ...sobre }),
        ).statusSugerido;

    it('entregue, em trânsito, não enviado', () => {
        expect(com({ entregueEm: '2026-10-30T10:00:00+00:00' })).toBe('Cliente ficou com o pedido');
        expect(com({})).toBe('Pedido não entregue (em trânsito)');
        const semRastreio = { tiny: { ok: true as const, dados: [{ ...TINY, temRastreio: false }] }, nota: { ok: true as const, dados: { ...NOTA, temRastreio: false } } };
        expect(com({ despachadaEm: null, temRastreio: false }, semRastreio)).toBe('Pedido não foi enviado');
        expect(com(null, semRastreio)).toBe('Pedido não foi enviado');
    });

    it('com algum rastreio e sem despacho, não sugere nada', () => {
        expect(com({ despachadaEm: null, temRastreio: false })).toBeNull();
    });

    it('sem a Intelipost, não sugere', () => {
        expect(derivarContextoDoPedido(leiturasApice({ intelipost: FALHA })).statusSugerido).toBeNull();
    });

    it('Yenzah e Denavita olham o rastreio da Shopify', () => {
        const sem = { ok: true as const, dados: [{ ...REMESSA, despachadaEm: null, temRastreio: false }] };
        const semRastreio = { ...SHOPIFY, temRastreio: false };
        expect(derivarContextoDoPedido(leiturasDenavita({ intelipost: sem, shopify: { ok: true, dados: semRastreio } })).statusSugerido).toBe('Pedido não foi enviado');
        expect(derivarContextoDoPedido(leiturasDenavita({ intelipost: sem })).statusSugerido).toBeNull();
    });
});

describe('derivarContextoDoPedido — avisos', () => {
    it('mais de uma remessa na Intelipost', () => {
        const c = derivarContextoDoPedido(leiturasApice({ intelipost: { ok: true, dados: [REMESSA, { ...REMESSA, nf: '10158000' }] } }));
        expect(c.avisos).toEqual(['A Intelipost tem 2 remessas para este pedido; pode já existir um reenvio. Confira antes de solicitar.']);
    });

    it('pedido cancelado e pedido ausente na Shopify', () => {
        const cancelado = derivarContextoDoPedido(leiturasApice({ shopify: { ok: true, dados: { ...SHOPIFY, cancelado: true } } }));
        expect(cancelado.avisos).toEqual(['Este pedido está cancelado na Shopify.']);
        const ausente = derivarContextoDoPedido(leiturasApice({ shopify: { ok: true, dados: null } }));
        expect(ausente.avisos).toEqual(['Não encontrei este pedido na Shopify (Data Mart).']);
        expect(derivarContextoDoPedido(leiturasApice({ shopify: FALHA })).avisos).toEqual([]);
    });

    it('Ápice: kit do Tiny sem composição avisa uma vez só', () => {
        const dois = { ...TINY, itens: [...TINY.itens, { sku: '90001', descricao: 'Kit Mimos de Natal', quantidade: 1 }, { sku: '90002', descricao: 'MIMOS grátis', quantidade: 1 }] };
        const c = derivarContextoDoPedido(leiturasApice({ tiny: { ok: true, dados: [dois] } }));
        const aviso = 'Não encontrei a composição de algum kit; ajuste os itens nas observações se precisar reenviar só parte dele.';
        expect(c.avisos).toEqual([aviso]);
        expect(derivarContextoDoPedido(leiturasApice({ explodidas: FALHA })).avisos).toEqual([]);
    });

    it('Yenzah e Denavita: pedido sem itens no Data Mart', () => {
        const c = derivarContextoDoPedido(leiturasDenavita({ explodidas: { ok: true, dados: [] } }));
        expect(c.avisos).toEqual([
            'Não encontrei os itens deste pedido no Data Mart: a composição dos kits e o valor da NF de reenvio ficam de fora.',
        ]);
        expect(c.baseDoValor).toBeNull();
    });

    it('a ordem: NF, CD, remessas, Shopify', () => {
        const c = derivarContextoDoPedido(
            leiturasApice({
                intelipost: { ok: true, dados: [{ ...REMESSA, nf: null }, { ...REMESSA, nf: null }] },
                nota: { ok: true, dados: null },
                tiny: { ok: true, dados: [{ ...TINY, cd: 'es' as const }, { ...TINY, cd: 'rj' as const }] },
                shopify: { ok: true, dados: null },
            }),
        );
        expect(c.avisos.map((a) => a.slice(0, 22))).toEqual([
            'O pedido ainda não tem',
            'Pedido encontrado em m',
            'A Intelipost tem 2 rem',
            'Não encontrei este ped',
        ]);
    });
});

describe('derivarContextoDoPedido — kits', () => {
    it('sem a leitura das explodidas, não há kits', () => {
        expect(derivarContextoDoPedido(leiturasApice({ explodidas: FALHA })).kits).toEqual([]);
    });

    it('componentes únicos por SKU (vale o primeiro) e quantidade inválida vira 1', () => {
        const linhas = [
            linha('K1', 'A', 10, { qtdPorKit: 2 }),
            linha('K1', 'A', 10, { qtdPorKit: 5 }),
            linha('K1', 'B', 10, { qtdPorKit: 0 }),
            linha('K1', 'C', 10, { qtdPorKit: 1.5 }),
            linha('AVULSO', 'AVULSO', 10, { componenteDeKit: false }),
        ];
        const c = derivarContextoDoPedido(leiturasApice({ explodidas: { ok: true, dados: linhas } }));
        expect(c.kits).toEqual([{ sku: 'K1', componentes: [{ sku: 'A', quantidade: 2 }, { sku: 'B', quantidade: 1 }, { sku: 'C', quantidade: 1 }] }]);
    });
});

describe('derivarContextoDoPedido — base do valor', () => {
    it('Ápice: sem a NF do Tiny, sem base; com a leitura da NF falha, não conferida', () => {
        const semNota = derivarContextoDoPedido(leiturasApice({ nota: { ok: true, dados: null } }));
        expect(semNota.baseDoValor).toBeNull();
        expect(semNota.baseConferida).toBe(true);
        const falha = derivarContextoDoPedido(leiturasApice({ nota: FALHA }));
        expect(falha.baseConferida).toBe(false);
        expect(derivarContextoDoPedido(leiturasApice({ explodidas: FALHA })).baseConferida).toBe(false);
    });

    it('Ápice: NF com produtos zero ou sem itens não dá base', () => {
        expect(derivarContextoDoPedido(leiturasApice({ nota: { ok: true, dados: { ...NOTA, produtos: 0 } } })).baseDoValor).toBeNull();
        expect(derivarContextoDoPedido(leiturasApice({ nota: { ok: true, dados: { ...NOTA, itens: [] } } })).baseDoValor).toBeNull();
    });

    it('Ápice: as unidades somam as quantidades da NF por SKU, e o SKU repetido vale o primeiro preço', () => {
        const nota = { ...NOTA, itens: [...NOTA.itens, { sku: '20683', quantidade: 2, precoUnitario: 99 }] };
        const c = derivarContextoDoPedido(leiturasApice({ nota: { ok: true, dados: nota } }));
        expect(c.unidadesDoPedido['20683']).toBe(3);
        expect(c.baseDoValor?.precos['20683']).toBe(37.2);
    });

    it('Denavita: o pago repartido em centavos que fecham, sem desconto, com o frete à parte', () => {
        const c = derivarContextoDoPedido(leiturasDenavita());
        expect(c.baseDoValor).toEqual({
            total: 137.93,
            produtos: 129.03,
            desconto: 0,
            frete: 8.9,
            // 12903 centavos pelos pesos 8190 e 6990: os dois restos empatam, e o centavo que falta vai à primeira linha
            precos: { Laranjamorodenavita: 69.62, DVTRI1: 59.41 },
        });
        expect(c.unidadesDoPedido).toEqual({ Laranjamorodenavita: 1, DVTRI1: 1 });
        expect(c.baseConferida).toBe(true);
        expect(c.cd.valor).toBe('CD MG');
    });

    it('Denavita: o preço unitário divide pelas unidades da linha; SKU repetido vale a primeira linha', () => {
        const linhas = [
            linha('X', 'X', 100, { componenteDeKit: false, unidades: 4 }),
            linha('X', 'X', 50, { componenteDeKit: false, unidades: 1 }),
        ];
        const c = derivarContextoDoPedido(leiturasDenavita({ explodidas: { ok: true, dados: linhas }, shopify: { ok: true, dados: { ...SHOPIFY, total: 160, frete: 10 } } }));
        // 15000 centavos por 10000 e 5000: 10000 na primeira linha, 4 unidades
        expect(c.baseDoValor?.precos).toEqual({ X: 25 });
        expect(c.unidadesDoPedido).toEqual({ X: 5 });
    });

    it('Denavita: sem pago (total igual ao frete), sem receita ou sem pedido na Shopify, não há base', () => {
        const com = (shopify: LeiturasDoPedido['shopify'], explodidas = { ok: true as const, dados: DENAVITA_AVULSAS }) =>
            derivarContextoDoPedido(leiturasDenavita({ shopify, explodidas })).baseDoValor;
        expect(com({ ok: true, dados: { ...SHOPIFY, total: 8.9, frete: 8.9 } })).toBeNull();
        expect(com({ ok: true, dados: null })).toBeNull();
        expect(com({ ok: true, dados: { ...SHOPIFY, total: 100, frete: 0 } }, { ok: true, dados: [linha('A', 'A', -5, { componenteDeKit: false }), linha('B', 'B', 0, { componenteDeKit: false })] })).toBeNull();
    });

    it('Denavita: a leitura da Shopify ou das explodidas falha, a base fica não conferida', () => {
        expect(derivarContextoDoPedido(leiturasDenavita({ shopify: FALHA })).baseConferida).toBe(false);
        expect(derivarContextoDoPedido(leiturasDenavita({ explodidas: FALHA })).baseConferida).toBe(false);
    });
});

describe('valorNfReenvio', () => {
    const base = { total: 110, produtos: 100, desconto: 10, frete: 20, precos: { A: 40, B: 60 } };

    it('completo vale o total; parcial leva a fatia do desconto e do frete', () => {
        expect(valorNfReenvio(base, [], true)).toBe(110);
        // A: 40 de 100 ⇒ fatia 0,4: 40 − 4 + 8 = 44
        expect(valorNfReenvio(base, [{ sku: 'A', quantidade: 1 }], false)).toBe(44);
    });

    it('SKU sem preço ou produtos zerados dão null', () => {
        expect(valorNfReenvio(base, [{ sku: 'Z', quantidade: 1 }], false)).toBeNull();
        expect(valorNfReenvio({ ...base, produtos: 0 }, [{ sku: 'A', quantidade: 1 }], false)).toBeNull();
    });
});

describe('valorDaNfDeReenvio — Denavita', () => {
    const contexto = derivarContextoDoPedido(leiturasDenavita());

    it('uma linha: o pago dela mais a fatia proporcional do frete', () => {
        // 59,41 + 8,90 × (59,41 ÷ 129,03) = 59,41 + 4,10
        expect(valorDaNfDeReenvio(contexto, [{ sku: 'DVTRI1', quantidade: 1 }])).toEqual({ tipo: 'calculado', valor: 63.51 });
    });

    it('o pedido completo fecha no total pago', () => {
        const itens = [{ sku: 'Laranjamorodenavita', quantidade: 1 }, { sku: 'DVTRI1', quantidade: 1 }];
        expect(valorDaNfDeReenvio(contexto, itens)).toEqual({ tipo: 'calculado', valor: 137.93 });
    });
});

describe('valorDaNfDeReenvio — os casos sem valor', () => {
    const itens = [{ sku: '20688', quantidade: 1 }];

    it('nao_conferido quando uma leitura de que o valor depende falhou', () => {
        const c = derivarContextoDoPedido(leiturasApice({ nota: FALHA }));
        expect(valorDaNfDeReenvio(c, itens)).toEqual({ tipo: 'nao_conferido' });
    });

    it('em_branco: itens que não vieram separados, vazios ou sem quantidade', () => {
        const c = derivarContextoDoPedido(leiturasApice());
        expect(valorDaNfDeReenvio(c, null)).toEqual({
            tipo: 'em_branco',
            motivo: 'não deu para separar os itens originais do reenvio (mimo ou troca sem a lista estruturada, ou "Produto a reenviar" fora do formato)',
        });
        expect(valorDaNfDeReenvio(c, [])).toEqual({ tipo: 'em_branco', motivo: 'nenhum item do pedido no reenvio' });
        expect(valorDaNfDeReenvio(c, [{ sku: '20688', quantidade: 0 }])).toEqual({ tipo: 'em_branco', motivo: 'nenhum item do pedido no reenvio' });
    });

    it('em_branco: sem a base, com o motivo de cada marca', () => {
        const apice = derivarContextoDoPedido(leiturasApice({ nota: { ok: true, dados: null } }));
        expect(valorDaNfDeReenvio(apice, itens)).toEqual({ tipo: 'em_branco', motivo: 'sem a NF original no Tiny' });
        const denavita = derivarContextoDoPedido(leiturasDenavita({ explodidas: { ok: true, dados: [] } }));
        expect(valorDaNfDeReenvio(denavita, itens)).toEqual({ tipo: 'em_branco', motivo: 'sem os valores pagos do pedido' });
    });

    it('em_branco: o SKU que não está na NF', () => {
        const c = derivarContextoDoPedido(leiturasApice());
        expect(valorDaNfDeReenvio(c, [{ sku: '20688', quantidade: 1 }, { sku: '99999', quantidade: 1 }])).toEqual({
            tipo: 'em_branco',
            motivo: 'o SKU 99999 não está na NF original',
        });
    });

    it('em_branco: a NF sem o valor dos produtos', () => {
        const contexto: ContextoDoPedido = {
            ...derivarContextoDoPedido(leiturasApice()),
            baseDoValor: { total: 10, produtos: 0, desconto: 0, frete: 0, precos: { '20688': 5 } },
        };
        expect(valorDaNfDeReenvio(contexto, itens)).toEqual({ tipo: 'em_branco', motivo: 'a NF original não tem o valor dos produtos' });
    });

    it('2 unidades de um kit contra 1 comprado não é o pedido completo', () => {
        const c = derivarContextoDoPedido(leiturasApice());
        const r = valorDaNfDeReenvio(c, [{ sku: '20688', quantidade: 2 }]);
        // 2 × 37,20 = 74,40; fatia 74,40 ÷ 289,80 ⇒ frete 4,08
        expect(r).toEqual({ tipo: 'calculado', valor: 78.48 });
    });
});

describe('itensDoProdutoReenviar', () => {
    it('lê o formato SKU - qtd;SKU - qtd', () => {
        expect(itensDoProdutoReenviar('20688 - 1; 40132 - 2')).toEqual([{ sku: '20688', quantidade: 1 }, { sku: '40132', quantidade: 2 }]);
        expect(itensDoProdutoReenviar('DVTRI1 - 3')).toEqual([{ sku: 'DVTRI1', quantidade: 3 }]);
        expect(itensDoProdutoReenviar('SKU COM-HIFEN - 2')).toEqual([{ sku: 'SKU COM-HIFEN', quantidade: 2 }]);
    });

    it('vazio ou fora do formato dá null', () => {
        for (const v of [null, undefined, '', '   ', '20688', '20688 - x', '20688 - 1;', '20688 - 1; lixo']) {
            expect(itensDoProdutoReenviar(v), String(v)).toBeNull();
        }
    });
});

describe('temMimoOuTroca e itensOriginaisDoReenvio', () => {
    it('reconhece as notas que a tela grava', () => {
        expect(temMimoOuTroca('Batom incluído como mimo (ADR-016)')).toBe(true);
        expect(temMimoOuTroca('SKU 1 sem estoque substituído pelo SKU 2')).toBe(true);
        expect(temMimoOuTroca('Cliente pediu urgência')).toBe(false);
        expect(temMimoOuTroca(null)).toBe(false);
    });

    it('com a lista estruturada, vale ela, só com os itens válidos', () => {
        const r = itensOriginaisDoReenvio({
            itensOriginaisReenviados: [
                { sku: '20688', quantidade: 1 },
                { sku: '  ', quantidade: 1 },
                { sku: '20690', quantidade: 0 },
                { sku: '20696', quantidade: Number.NaN },
            ],
            produtoReenviar: 'outro - 9',
            comentarios: 'incluído como mimo',
        });
        expect(r).toEqual([{ sku: '20688', quantidade: 1 }]);
        expect(itensOriginaisDoReenvio({ itensOriginaisReenviados: [] })).toEqual([]);
    });

    it('item fora do formato (vindo do JSON de quem chama) fica de fora em vez de lançar', () => {
        const doJson = JSON.parse('[null, {"sku": 20688, "quantidade": 1}, {"sku": " 20690 ", "quantidade": "1"}, {"sku": " 20696 ", "quantidade": 2}]');
        expect(itensOriginaisDoReenvio({ itensOriginaisReenviados: doJson })).toEqual([{ sku: '20696', quantidade: 2 }]);
    });

    it('sem a lista, o texto serve só quando não há mimo nem troca', () => {
        expect(itensOriginaisDoReenvio({ produtoReenviar: '20688 - 1' })).toEqual([{ sku: '20688', quantidade: 1 }]);
        expect(itensOriginaisDoReenvio({ itensOriginaisReenviados: null, produtoReenviar: '20688 - 1', comentarios: 'incluído como mimo' })).toBeNull();
        expect(itensOriginaisDoReenvio({ produtoReenviar: '20688 - 1', comentarios: 'x sem estoque substituído pelo SKU y' })).toBeNull();
        expect(itensOriginaisDoReenvio({ produtoReenviar: 'texto livre' })).toBeNull();
        expect(itensOriginaisDoReenvio({})).toBeNull();
    });
});

describe('nfDiverge', () => {
    it('compara só os dígitos, sem zeros à esquerda', () => {
        expect(nfDiverge('10157987', '10157987')).toBe(false);
        expect(nfDiverge(' 010157987 ', '10157987')).toBe(false);
        expect(nfDiverge('10.157.987', '10157987')).toBe(false);
        expect(nfDiverge('10157988', '10157987')).toBe(true);
    });

    it('digitada vazia, só traço ou sem dígitos não diverge', () => {
        for (const v of ['', '  ', '-', null, undefined]) expect(nfDiverge(v, '10157987'), String(v)).toBe(false);
    });
});

describe('notaDeNaoConferido', () => {
    it('o rótulo e a concordância', () => {
        expect(notaDeNaoConferido([])).toBe('');
        expect(notaDeNaoConferido(['nf'])).toBe('[NF NÃO CONFERIDA: DATA MART SEM RESPOSTA]');
        expect(notaDeNaoConferido(['cd'])).toBe('[CD NÃO CONFERIDO: DATA MART SEM RESPOSTA]');
        expect(notaDeNaoConferido(['valor'])).toBe('[VALOR NÃO CONFERIDO: DATA MART SEM RESPOSTA]');
    });

    it('vários, sempre na ordem CD/NF/VALOR e sem repetir', () => {
        expect(notaDeNaoConferido(['nf', 'cd'])).toBe('[CD/NF NÃO CONFERIDOS: DATA MART SEM RESPOSTA]');
        expect(notaDeNaoConferido(['valor', 'nf', 'cd', 'cd'])).toBe('[CD/NF/VALOR NÃO CONFERIDOS: DATA MART SEM RESPOSTA]');
        expect(notaDeNaoConferido(['nf', 'nf'])).toBe('[NF NÃO CONFERIDA: DATA MART SEM RESPOSTA]');
    });
});
