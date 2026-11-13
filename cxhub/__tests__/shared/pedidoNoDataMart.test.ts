import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetabaseError } from '@shared/lib/metabase';
import {
    lerPedidoNoDataMart,
    sqlDaIntelipost,
    sqlDaNotaPorFaixa,
    sqlDaNotaPorId,
    sqlDaShopify,
    sqlDasExplodidas,
    sqlDoTinyPorData,
    sqlDoTinyPorId,
} from '@shared/lib/datamart/pedidoServer';

/**
 * A leitura do pedido no Data Mart (ADR-018), sem rede: o `consultar` é falso, responde pelo trecho do SQL e grava cada
 * consulta com o `timeoutMs` que recebeu. O caso real é o pedido 1731559 da Ápice.
 */

type Resposta = unknown[][] | Error;
type Responder = (sql: string, indice: number) => Resposta;

interface Chamada {
    sql: string;
    timeoutMs: number | undefined;
}

/** O Metabase de mentira. `tabelas` responde pela primeira tabela citada no SQL; o resto não existe (lista vazia). */
function mundo(
    tabelas: Partial<Record<'intelipost' | 'shopify' | 'explodidas' | 'tinyPedido' | 'nota', Responder | Resposta>>,
    relogio = { agora: 1_000_000 },
    aoConsultar: () => void = () => {},
) {
    const chamadas: Chamada[] = [];
    const consultar = async (sql: string, opcoes?: { timeoutMs?: number }): Promise<unknown[][]> => {
        chamadas.push({ sql, timeoutMs: opcoes?.timeoutMs });
        aoConsultar();
        const tabela = sql.includes('gold.fct_intelipost_orders') ? 'intelipost'
            : sql.includes('vw_shopify_order_items_exploded') ? 'explodidas'
            : sql.includes('gold.fct_shopify_orders') ? 'shopify'
            : sql.includes('api.tiny_pedidos_') ? 'tinyPedido'
            : 'nota';
        const resposta = tabelas[tabela];
        const resolvida = typeof resposta === 'function' ? resposta(sql, chamadas.filter((c) => c.sql.includes(tabela === 'nota' ? 'tiny_nfe' : '')).length - 1) : resposta;
        if (resolvida instanceof Error) throw resolvida;
        return resolvida ?? [];
    };
    return { chamadas, consultar, relogio, agora: () => relogio.agora };
}

const sobre = (chamadas: Chamada[], trecho: string) => chamadas.filter((c) => c.sql.includes(trecho));

// ── O caso real da Ápice: pedido 1731559 ─────────────────────────────────────────────────────────────────────────────

const INTELIPOST = [['10157987', 'ES', '1061809849', '2026-10-21T10:00:00.000Z', null, true]];
const SHOPIFY = [['6500000000001', '2026-10-20T14:30:00.000Z', 305.7, 15.9, false, true]];
const EXPLODIDAS = [
    ['KIT-1', '20683', true, 1, 2, 74.4],
    ['KIT-1', '20684', true, 1, 2, 77.52],
    ['AVULSO', '20688', false, 1, 1, 37.2],
];
const TINY_ES = [
    ['es', '1061809849', '1061811664', '2026-10-20', true, '40132', 'Kit Hidratação', '1.0'],
    ['es', '1061809849', '1061811664', '2026-10-20', true, '46194', 'Mimo', '1.0'],
];
// No Data Mart os números do Tiny vêm como texto.
const NOTA_ITENS = [
    ['20683', '1.0', '37.2'], ['20684', '1.0', '38.76'], ['20688', '1.0', '37.2'], ['20690', '1.0', '41.86'],
    ['20696', '1.0', '34.88'], ['20910', '1.0', '48.13'], ['20911', '1.0', '51.77'],
];
const notaComItens = (idNota: string, numero: string, situacao: string, total = '305.70') =>
    NOTA_ITENS.map(([sku, quantidade, preco]) => [idNota, numero, situacao, total, '289.80', '0.00', '15.90', false, sku, quantidade, preco]);
const NOTA = notaComItens('1061811664', '10157987', 'Autorizada');

const PRAZO = 1_000_000 + 60_000;

/** O Tiny por data tem uma consulta por CD: o pedido está só no ES, e a do RJ volta vazia. */
const soDoEs: Responder = (sql) => (sql.includes('tiny_pedidos_ap_cosmetics_rj ') ? [] : TINY_ES);

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('lerPedidoNoDataMart — o caso real da Ápice (pedido 1731559)', () => {
    it('lê a Intelipost, a Shopify, as explodidas, o pedido no Tiny pelo id e a NF pelo id da NF', async () => {
        const m = mundo({ intelipost: INTELIPOST, shopify: SHOPIFY, explodidas: EXPLODIDAS, tinyPedido: TINY_ES, nota: NOTA });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.marca).toBe('apice');
        expect(leituras.numero).toBe('1731559');
        expect(leituras.intelipost).toEqual({
            ok: true,
            dados: [{ nf: '10157987', ufOrigem: 'ES', idPedidoTiny: '1061809849', despachadaEm: '2026-10-21T10:00:00.000Z', entregueEm: null, temRastreio: true }],
        });
        expect(leituras.shopify).toEqual({
            ok: true,
            dados: { orderId: '6500000000001', criadoEm: '2026-10-20T14:30:00.000Z', total: 305.7, frete: 15.9, cancelado: false, temRastreio: true },
        });
        expect(leituras.explodidas).toEqual({
            ok: true,
            dados: [
                { skuDaLinha: 'KIT-1', sku: '20683', componenteDeKit: true, qtdPorKit: 1, unidades: 2, receita: 74.4 },
                { skuDaLinha: 'KIT-1', sku: '20684', componenteDeKit: true, qtdPorKit: 1, unidades: 2, receita: 77.52 },
                { skuDaLinha: 'AVULSO', sku: '20688', componenteDeKit: false, qtdPorKit: 1, unidades: 1, receita: 37.2 },
            ],
        });
        expect(leituras.tiny).toEqual({
            ok: true,
            dados: [{
                cd: 'es',
                idPedido: '1061809849',
                idNotaFiscal: '1061811664',
                dataPedido: '2026-10-20',
                temRastreio: true,
                itens: [
                    { sku: '40132', descricao: 'Kit Hidratação', quantidade: 1 },
                    { sku: '46194', descricao: 'Mimo', quantidade: 1 },
                ],
            }],
        });
        expect(leituras.nota).toEqual({
            ok: true,
            dados: {
                numero: '10157987',
                situacao: 'Autorizada',
                total: 305.7,
                produtos: 289.8,
                desconto: 0,
                frete: 15.9,
                temRastreio: false,
                itens: [
                    { sku: '20683', quantidade: 1, precoUnitario: 37.2 },
                    { sku: '20684', quantidade: 1, precoUnitario: 38.76 },
                    { sku: '20688', quantidade: 1, precoUnitario: 37.2 },
                    { sku: '20690', quantidade: 1, precoUnitario: 41.86 },
                    { sku: '20696', quantidade: 1, precoUnitario: 34.88 },
                    { sku: '20910', quantidade: 1, precoUnitario: 48.13 },
                    { sku: '20911', quantidade: 1, precoUnitario: 51.77 },
                ],
            },
        });
    });

    it('faz 5 consultas: 3 em paralelo, o Tiny pelo id (sem a data) e a NF na tabela do CD do pedido', async () => {
        const m = mundo({ intelipost: INTELIPOST, shopify: SHOPIFY, explodidas: EXPLODIDAS, tinyPedido: TINY_ES, nota: NOTA });

        await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(m.chamadas).toHaveLength(5);
        const tiny = sobre(m.chamadas, 'api.tiny_pedidos_')[0].sql;
        expect(tiny).toContain("p.id_pedido = '1061809849'");
        expect(tiny).not.toContain('numero_ecommerce');
        const nota = sobre(m.chamadas, 'api.tiny_nfe_')[0].sql;
        expect(nota).toContain('api.tiny_nfe_ap_cosmetics_es n left join api.tiny_nfe_ap_cosmetics_es_itens i');
        expect(nota).toContain("n.id_nota = '1061811664'");
        // Cada consulta leva o teto de 5 s, porque o prazo sobra.
        expect(m.chamadas.map((c) => c.timeoutMs)).toEqual([5000, 5000, 5000, 5000, 5000]);
    });

    it('loga uma linha por leitura, com a marca, o número e o tempo, sem dado da cliente', async () => {
        const m = mundo({ intelipost: INTELIPOST, shopify: new MetabaseError(0, 'Metabase não respondeu em 5s'), explodidas: EXPLODIDAS, tinyPedido: TINY_ES, nota: NOTA });

        await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        const linhas = vi.mocked(console.log).mock.calls.map((chamada) => chamada.join(' '));
        expect(linhas).toEqual(['[Pedido no Data Mart] apice 1731559: 0 ms; falharam: shopify (Metabase não respondeu em 5s)']);
    });
});

describe('lerPedidoNoDataMart — o pedido no Tiny', () => {
    const SEM_ID = [['10157987', 'ES', null, null, null, true]];

    it('sem o external_erp_id, busca por data (criação −1 dia a +12 dias) e pelo numero_ecommerce, sem o teto de 5 s', async () => {
        const m = mundo({ intelipost: SEM_ID, shopify: SHOPIFY, tinyPedido: soDoEs, nota: NOTA });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        // Duas consultas, uma por CD, cada uma com o mesmo filtro; nenhuma é um union all.
        const tiny = sobre(m.chamadas, 'api.tiny_pedidos_');
        expect(tiny).toHaveLength(2);
        for (const consulta of tiny) {
            expect(consulta.sql).toContain("p.data_pedido >= '2026-10-19' and p.data_pedido <= '2026-11-01' and p.numero_ecommerce = '1731559'");
            expect(consulta.sql).not.toContain('p.id_pedido =');
            expect(consulta.sql).not.toContain('union all');
            // Sem o teto de 5 s: o que sobra do prazo.
            expect(consulta.timeoutMs).toBe(60_000);
        }
        expect(tiny[0].sql).toContain("select 'es' as cd");
        expect(tiny[1].sql).toContain("select 'rj' as cd");
        expect(leituras.tiny?.ok && leituras.tiny.dados.map((p) => p.cd)).toEqual(['es']);
    });

    it('as duas consultas por data saem em paralelo, e juntas na ordem ES e depois RJ', async () => {
        const rj = [['rj', '5', '0', '2026-10-21', false, '40132', 'Kit', '1']];
        let pendentes = 0;
        let simultaneas = 0;
        const consultar = async (sql: string): Promise<unknown[][]> => {
            if (!sql.includes('numero_ecommerce')) return sql.includes('fct_intelipost') ? SEM_ID : sql.includes('fct_shopify_orders\nwhere') ? SHOPIFY : [];
            pendentes++;
            simultaneas = Math.max(simultaneas, pendentes);
            await new Promise((resolve) => setTimeout(resolve, 5));
            pendentes--;
            return sql.includes("select 'rj'") ? rj : TINY_ES;
        };

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, { consultar, agora: () => 1_000_000 });

        expect(simultaneas).toBe(2);
        expect(leituras.tiny?.ok && leituras.tiny.dados.map((p) => p.cd)).toEqual(['es', 'rj']);
    });

    it.each(['es', 'rj'])('uma das duas consultas por data falhando (%s): tiny não é ok, com o motivo, e a NF não é lida', async (cdQueFalha) => {
        const m = mundo({
            intelipost: SEM_ID,
            shopify: SHOPIFY,
            tinyPedido: (sql) => {
                if (sql.includes(`select '${cdQueFalha}'`)) return new MetabaseError(0, 'Metabase não respondeu em 60s');
                return soDoEs(sql, 0);
            },
        });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.tiny).toEqual({ ok: false, motivo: 'Metabase não respondeu em 60s' });
        expect(leituras.nota).toEqual({ ok: false, motivo: 'o pedido do Tiny não foi lido' });
        expect(sobre(m.chamadas, 'api.tiny_nfe_')).toHaveLength(0);
    });

    it('a janela de datas atravessa o mês e o ano, em UTC ao meio-dia', async () => {
        const m = mundo({ intelipost: SEM_ID, shopify: [['1', '2027-01-01T00:30:00-03:00', 1, 0, false, false]] });

        await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(sobre(m.chamadas, 'api.tiny_pedidos_')[0].sql).toContain("p.data_pedido >= '2026-12-31' and p.data_pedido <= '2027-01-13'");
    });

    it('external_erp_id que não é só dígitos conta como ausente: não entra no SQL, e a busca vai por data', async () => {
        const m = mundo({ intelipost: [['10157987', 'ES', "1; drop table x", null, null, true]], shopify: SHOPIFY });

        await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        const tiny = sobre(m.chamadas, 'api.tiny_pedidos_');
        expect(tiny).toHaveLength(2);
        expect(tiny.every((consulta) => !consulta.sql.includes('drop table') && consulta.sql.includes('p.data_pedido >='))).toBe(true);
    });

    it('a Shopify respondeu sem o pedido e não há id: o pedido não está no Data Mart (lista vazia), sem consultar o Tiny', async () => {
        const m = mundo({ intelipost: SEM_ID, shopify: [] });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.shopify).toEqual({ ok: true, dados: null });
        expect(leituras.tiny).toEqual({ ok: true, dados: [] });
        expect(leituras.nota).toEqual({ ok: true, dados: null });
        expect(sobre(m.chamadas, 'api.tiny_')).toHaveLength(0);
    });

    it('a Shopify falhou e não há id: o Tiny não é lido, e a NF diz que depende dele', async () => {
        const m = mundo({ intelipost: SEM_ID, shopify: new MetabaseError(500, 'Metabase HTTP 500') });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.tiny).toEqual({ ok: false, motivo: 'sem o id do Tiny nem a data da Shopify' });
        expect(leituras.nota).toEqual({ ok: false, motivo: 'o pedido do Tiny não foi lido' });
        expect(sobre(m.chamadas, 'api.tiny_')).toHaveLength(0);
    });

    it('a Intelipost falhou: a busca por data cobre, e o resto das leituras segue', async () => {
        const m = mundo({ intelipost: new MetabaseError(0, 'Metabase inalcançável: x'), shopify: SHOPIFY, tinyPedido: soDoEs, nota: NOTA });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.intelipost).toEqual({ ok: false, motivo: 'Metabase inalcançável: x' });
        expect(leituras.tiny?.ok).toBe(true);
        // Sem a Intelipost não há a NF dela, mas o pedido do Tiny tem o id da NF.
        expect(leituras.nota?.ok).toBe(true);
    });

    it('o mesmo pedido nos dois CDs: o ES vem antes do RJ, e a NF é lida no CD do mais recente', async () => {
        const tiny = [
            ['rj', '1061809849', '777', '2026-10-25', false, '40132', 'Kit', '1'],
            ['es', '1061809849', '1061811664', '2026-10-20', true, '40132', 'Kit', '1'],
            ['es', '1061809849', '1061811664', '2026-10-20', true, '46194', 'Mimo', '1'],
        ];
        const m = mundo({ intelipost: INTELIPOST, shopify: SHOPIFY, tinyPedido: tiny, nota: notaComItens('777', '10157987', 'Autorizada') });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.tiny?.ok && leituras.tiny.dados.map((p) => [p.cd, p.itens.length])).toEqual([['es', 2], ['rj', 1]]);
        const nota = sobre(m.chamadas, 'api.tiny_nfe_')[0].sql;
        expect(nota).toContain('api.tiny_nfe_ap_cosmetics_rj n');
        expect(nota).toContain("n.id_nota = '777'");
        expect(nota).not.toContain('cosmetics_es');
    });

    it('id_nota_fiscal 0 ou vazio vira null, e o pedido sem itens (left join) entra com a lista vazia', async () => {
        const tiny = [
            ['es', '10', '0', '2026-10-20', false, null, null, null],
            ['rj', '11', '', '2026-10-21', false, null, null, null],
        ];
        const m = mundo({ intelipost: [['', null, '10', null, null, false]], shopify: SHOPIFY, tinyPedido: tiny });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.tiny?.ok && leituras.tiny.dados.map((p) => [p.cd, p.idNotaFiscal, p.itens])).toEqual([['es', null, []], ['rj', null, []]]);
    });
});

describe('lerPedidoNoDataMart — a NF por faixa', () => {
    // O pedido do Tiny sem o id da NF; a Intelipost dá o número da NF.
    const TINY_SEM_NF = (idPedido: string) => [['es', idPedido, '0', '2026-10-20', false, '40132', 'Kit', '1']];
    const intelipost = (idPedido: string) => [['10157987', 'ES', idPedido, null, null, true]];

    it('procura entre o id do pedido e +1,5 milhão, com o número da NF; achou, não vai a 6 milhões', async () => {
        const m = mundo({ intelipost: intelipost('1061809849'), shopify: SHOPIFY, tinyPedido: TINY_SEM_NF('1061809849'), nota: NOTA });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        const notas = sobre(m.chamadas, 'api.tiny_nfe_');
        expect(notas).toHaveLength(1);
        expect(notas[0].sql).toContain("n.id_nota >= '1061809849' and n.id_nota <= '1063309849' and n.numero_nota = '10157987'");
        // A faixa leva o que sobra do prazo, sem o teto de 5 s (1,5 milhão levou 7,9 s medido).
        expect(notas[0].timeoutMs).toBe(60_000);
        expect(leituras.nota?.ok && leituras.nota.dados?.numero).toBe('10157987');
    });

    it('não achou em 1,5 milhão: tenta 6 milhões, e prefere a NF que não está cancelada', async () => {
        const m = mundo({
            intelipost: intelipost('1061809849'),
            shopify: SHOPIFY,
            tinyPedido: TINY_SEM_NF('1061809849'),
            nota: (_sql, indice) => (indice === 0 ? [] : [...notaComItens('1', '10157987', 'Cancelada'), ...notaComItens('2', '10157987', 'Autorizada')]),
        });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        const notas = sobre(m.chamadas, 'api.tiny_nfe_');
        expect(notas).toHaveLength(2);
        expect(notas[1].sql).toContain("n.id_nota <= '1067809849'");
        expect(leituras.nota?.ok && leituras.nota.dados?.situacao).toBe('Autorizada');
    });

    it('com só NFs canceladas, vale a primeira', async () => {
        const m = mundo({
            intelipost: intelipost('1061809849'), shopify: SHOPIFY, tinyPedido: TINY_SEM_NF('1061809849'),
            nota: [...notaComItens('1', '10157987', 'Cancelada', '100.00'), ...notaComItens('2', '10157987', 'Cancelada', '200.00')],
        });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.nota?.ok && leituras.nota.dados?.total).toBe(100);
    });

    it('não achou em nenhuma das duas: dados null', async () => {
        const m = mundo({ intelipost: intelipost('1061809849'), shopify: SHOPIFY, tinyPedido: TINY_SEM_NF('1061809849'), nota: [] });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(sobre(m.chamadas, 'api.tiny_nfe_')).toHaveLength(2);
        expect(leituras.nota).toEqual({ ok: true, dados: null });
    });

    it('o limite que muda de tamanho não é consultado (o id_nota é texto): conta como "não achou"', async () => {
        // 998000000 + 1,5 milhão = 999500000 (9 dígitos: vale); + 6 milhões = 1004000000 (10 dígitos: não vale).
        const m = mundo({ intelipost: intelipost('998000000'), shopify: SHOPIFY, tinyPedido: TINY_SEM_NF('998000000'), nota: [] });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        const notas = sobre(m.chamadas, 'api.tiny_nfe_');
        expect(notas).toHaveLength(1);
        expect(notas[0].sql).toContain("n.id_nota <= '999500000'");
        expect(leituras.nota).toEqual({ ok: true, dados: null });
    });

    it('se nenhum dos dois limites cabe no tamanho, nada é consultado', async () => {
        const m = mundo({ intelipost: intelipost('999000000'), shopify: SHOPIFY, tinyPedido: TINY_SEM_NF('999000000') });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(sobre(m.chamadas, 'api.tiny_nfe_')).toHaveLength(0);
        expect(leituras.nota).toEqual({ ok: true, dados: null });
    });

    it('sem o id da NF e sem o número da NF da Intelipost, não há o que buscar', async () => {
        const m = mundo({ intelipost: [[null, 'ES', '1061809849', null, null, false]], shopify: SHOPIFY, tinyPedido: TINY_SEM_NF('1061809849') });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(sobre(m.chamadas, 'api.tiny_nfe_')).toHaveLength(0);
        expect(leituras.nota).toEqual({ ok: true, dados: null });
    });

    it('a NF por id que não existe no Data Mart: dados null', async () => {
        const m = mundo({ intelipost: INTELIPOST, shopify: SHOPIFY, tinyPedido: TINY_ES, nota: [] });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(leituras.nota).toEqual({ ok: true, dados: null });
    });
});

describe('lerPedidoNoDataMart — falhas, prazo e entrada', () => {
    it('cada etapa pode falhar sozinha, com o motivo, e nunca lança', async () => {
        const base = { intelipost: INTELIPOST, shopify: SHOPIFY, explodidas: EXPLODIDAS, tinyPedido: TINY_ES, nota: NOTA };

        const semExplodidas = await lerPedidoNoDataMart('apice', '1731559', PRAZO, mundo({ ...base, explodidas: new MetabaseError(0, 'Metabase não respondeu em 5s') }));
        expect(semExplodidas.explodidas).toEqual({ ok: false, motivo: 'Metabase não respondeu em 5s' });
        expect(semExplodidas.nota?.ok).toBe(true);

        const semTiny = await lerPedidoNoDataMart('apice', '1731559', PRAZO, mundo({ ...base, tinyPedido: new MetabaseError(500, 'Metabase HTTP 500: x') }));
        expect(semTiny.tiny).toEqual({ ok: false, motivo: 'Metabase HTTP 500: x' });
        expect(semTiny.nota).toEqual({ ok: false, motivo: 'o pedido do Tiny não foi lido' });
        expect(semTiny.intelipost.ok).toBe(true);

        const semNota = await lerPedidoNoDataMart('apice', '1731559', PRAZO, mundo({ ...base, nota: new MetabaseError(0, 'Metabase não respondeu em 5s') }));
        expect(semNota.nota).toEqual({ ok: false, motivo: 'Metabase não respondeu em 5s' });
        expect(semNota.tiny?.ok).toBe(true);

        // O que não é MetabaseError (um erro de programação, um valor lançado) também vira leitura, e não exceção.
        const estranho = await lerPedidoNoDataMart('apice', '1731559', PRAZO, {
            consultar: async () => { throw 'quebrou'; },
            agora: () => 1_000_000,
        });
        expect(estranho.intelipost).toEqual({ ok: false, motivo: 'quebrou' });
        expect(estranho.tiny).toEqual({ ok: false, motivo: 'sem o id do Tiny nem a data da Shopify' });
    });

    it('o teto de cada consulta é o que sobra do prazo, quando é menos de 5 s', async () => {
        const m = mundo({ intelipost: INTELIPOST, shopify: SHOPIFY, explodidas: EXPLODIDAS, tinyPedido: TINY_ES, nota: NOTA });

        await lerPedidoNoDataMart('apice', '1731559', 1_000_000 + 3_000, m);

        expect(m.chamadas.map((c) => c.timeoutMs)).toEqual([3000, 3000, 3000, 3000, 3000]);
    });

    it('sobrando menos de 500 ms, a consulta não sai: prazo esgotado antes da consulta', async () => {
        const m = mundo({ intelipost: INTELIPOST, shopify: SHOPIFY, explodidas: EXPLODIDAS, tinyPedido: TINY_ES, nota: NOTA });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', 1_000_000 + 499, m);

        const esgotada = { ok: false, motivo: 'prazo esgotado antes da consulta' };
        expect(leituras.intelipost).toEqual(esgotada);
        expect(leituras.shopify).toEqual(esgotada);
        expect(leituras.explodidas).toEqual(esgotada);
        expect(leituras.tiny).toEqual({ ok: false, motivo: 'sem o id do Tiny nem a data da Shopify' });
        expect(leituras.nota).toEqual({ ok: false, motivo: 'o pedido do Tiny não foi lido' });
        expect(m.chamadas).toHaveLength(0);
    });

    it('o prazo que acaba entre as etapas corta a etapa seguinte, e a NF diz que o Tiny não foi lido', async () => {
        const relogio = { agora: 1_000_000 };
        let consultas = 0;
        const m = mundo({ intelipost: INTELIPOST, shopify: SHOPIFY, explodidas: EXPLODIDAS }, relogio, () => { if (++consultas === 3) relogio.agora = 1_000_000 + 59_800; });

        const leituras = await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        expect(m.chamadas).toHaveLength(3);
        expect(leituras.tiny).toEqual({ ok: false, motivo: 'prazo esgotado antes da consulta' });
        expect(leituras.nota).toEqual({ ok: false, motivo: 'o pedido do Tiny não foi lido' });
    });

    it('a consulta do Tiny por data leva o que resta do prazo, mesmo acima de 5 s', async () => {
        const relogio = { agora: 1_000_000 };
        const m = mundo(
            { intelipost: [['10157987', 'ES', null, null, null, true]], shopify: SHOPIFY },
            relogio,
            () => { relogio.agora += 1_000; },
        );

        await lerPedidoNoDataMart('apice', '1731559', PRAZO, m);

        const [intelipost, shopify, explodidas, tinyEs, tinyRj] = m.chamadas;
        // As três da etapa 1 saem juntas, cada uma vendo o relógio que a anterior mexeu; o Tiny sai depois das três.
        expect([intelipost.timeoutMs, shopify.timeoutMs, explodidas.timeoutMs]).toEqual([5000, 5000, 5000]);
        expect(tinyEs.timeoutMs).toBe(PRAZO - 1_003_000);
        // O relógio do teste anda 1 s a cada consulta: a do RJ sai 1 s depois da do ES, e cada uma recebe o que resta, sem teto.
        expect(tinyRj.timeoutMs).toBe(PRAZO - 1_004_000);
    });

    it.each(['', 'SH1731559AP', '12a', '1234567890123', '-1', '1.5'])('número do pedido inválido (%j): nada é consultado', async (numero) => {
        const m = mundo({});

        const apice = await lerPedidoNoDataMart('apice', numero, PRAZO, m);
        const yenzah = await lerPedidoNoDataMart('yenzah', numero, PRAZO, m);

        const invalida = { ok: false, motivo: 'número do pedido inválido' };
        expect(apice).toMatchObject({ intelipost: invalida, shopify: invalida, explodidas: invalida, tiny: invalida, nota: invalida });
        expect(yenzah).toMatchObject({ intelipost: invalida, shopify: invalida, explodidas: invalida });
        expect('tiny' in yenzah).toBe(false);
        expect(m.chamadas).toHaveLength(0);
    });

    it('os 12 dígitos do limite entram', async () => {
        const m = mundo({});

        await lerPedidoNoDataMart('yenzah', '123456789012', PRAZO, m);

        expect(m.chamadas).toHaveLength(3);
    });

    it('número que não é número vira 0, e o texto vazio vira null onde o tipo aceita', async () => {
        const m = mundo({
            intelipost: [['  ', ' ES ', '', '', '', null]],
            shopify: [['1', '', 'x', null, 'sim', 1]],
        });

        const leituras = await lerPedidoNoDataMart('yenzah', '1731559', PRAZO, m);

        expect(leituras.intelipost).toEqual({
            ok: true,
            dados: [{ nf: null, ufOrigem: 'ES', idPedidoTiny: null, despachadaEm: null, entregueEm: null, temRastreio: false }],
        });
        expect(leituras.shopify).toEqual({
            ok: true,
            dados: { orderId: '1', criadoEm: null, total: 0, frete: 0, cancelado: false, temRastreio: false },
        });
    });
});

describe('lerPedidoNoDataMart — Yenzah e Denavita', () => {
    it.each(['yenzah', 'denavita'] as const)('%s: só as 3 leituras da etapa 1, sem as chaves tiny e nota, com a marca no filtro', async (marca) => {
        const m = mundo({ intelipost: [['123', 'MG', null, null, null, false]], shopify: SHOPIFY, explodidas: EXPLODIDAS });

        const leituras = await lerPedidoNoDataMart(marca, '1731559', PRAZO, m);

        expect(Object.keys(leituras).sort()).toEqual(['explodidas', 'intelipost', 'marca', 'numero', 'shopify']);
        expect(leituras.intelipost.ok && leituras.intelipost.dados[0].ufOrigem).toBe('MG');
        expect(m.chamadas).toHaveLength(3);
        expect(sobre(m.chamadas, 'gold.fct_intelipost_orders')[0].sql).toContain(`brand_code = '${marca}'`);
        expect(sobre(m.chamadas, 'from gold.fct_shopify_orders\n')[0].sql).toContain(`brand = '${marca}'`);
        expect(sobre(m.chamadas, 'api.tiny_')).toHaveLength(0);
    });
});

describe('os montadores de SQL', () => {
    it('a Intelipost filtra pela marca como literal e pelo número do pedido, na ordem de criação', () => {
        const sql = sqlDaIntelipost('denavita', '1731559');
        expect(sql).toContain("where shopify_order_number = '1731559' and brand_code = 'denavita'");
        expect(sql).toContain('order by created_iso');
        expect(sql).toContain("coalesce(track_code, '') <> '' as tem_rastreio");
    });

    it('a Shopify filtra pela marca, pega o pedido mais novo e compara o número sem aspas', () => {
        const sql = sqlDaShopify('yenzah', '1731559');
        expect(sql).toContain("where brand = 'yenzah' and order_number = 1731559");
        expect(sql).toContain('order by order_id desc limit 1');
        expect(sql).toContain('cancelled_at is not null as cancelado');
    });

    it('as explodidas filtram por order_id, com a subconsulta no WHERE e nunca no FROM', () => {
        const sql = sqlDasExplodidas('apice', '1731559');
        expect(sql).toContain('from gold.vw_shopify_order_items_exploded_priced_enriched e\nwhere e.order_id = (select order_id from gold.fct_shopify_orders where brand = \'apice\' and order_number = 1731559 order by order_id desc limit 1)');
        expect(sql).not.toMatch(/from\s*\(/i);
        expect(sql).not.toMatch(/e\.(order_name|order_number|brand)\b/);
        expect(sql).toContain('order by e.line_item_id, e.effective_sku');
    });

    it('o Tiny lê o ES e o RJ numa consulta, com o mesmo filtro nos dois, e nunca o _sp', () => {
        const sql = sqlDoTinyPorId('1061809849');
        expect(sql.match(/p\.id_pedido = '1061809849'/g)).toHaveLength(2);
        expect(sql).toContain("select 'es' as cd, p.id_pedido");
        expect(sql).toContain('union all\nselect \'rj\' as cd, p.id_pedido');
        expect(sql).toContain('api.tiny_pedidos_ap_cosmetics_es p left join api.tiny_pedidos_ap_cosmetics_es_itens i on i.id_pedido = p.id_pedido');
        expect(sql).toContain('api.tiny_pedidos_ap_cosmetics_rj p left join api.tiny_pedidos_ap_cosmetics_rj_itens i on i.id_pedido = p.id_pedido');
        expect(sql).not.toContain('_sp');
    });

    it('o Tiny por data leva a janela e o numero_ecommerce, e escapa as aspas', () => {
        const sql = sqlDoTinyPorData('rj', '2026-10-19', '2026-11-01', "17'31");
        expect(sql).toContain("where p.data_pedido >= '2026-10-19' and p.data_pedido <= '2026-11-01' and p.numero_ecommerce = '17''31'");
        expect(sql).toContain('api.tiny_pedidos_ap_cosmetics_rj p left join api.tiny_pedidos_ap_cosmetics_rj_itens i');
        expect(sql).not.toContain('_es');
    });

    it('a NF vem da tabela do CD, por id ou por faixa com o número da NF', () => {
        const porId = sqlDaNotaPorId('rj', '777');
        expect(porId).toContain('from api.tiny_nfe_ap_cosmetics_rj n left join api.tiny_nfe_ap_cosmetics_rj_itens i on i.id_nota = n.id_nota');
        expect(porId).toContain("where n.id_nota = '777'");

        const porFaixa = sqlDaNotaPorFaixa('es', '100', '200', "10'1");
        expect(porFaixa).toContain("where n.id_nota >= '100' and n.id_nota <= '200' and n.numero_nota = '10''1'");
        expect(porFaixa).toContain('api.tiny_nfe_ap_cosmetics_es_itens');
    });
});
