import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aplicarConferenciaAoReenvio } from '@modules/reenvios/actions/conferenciaDoReenvio';
import { recusaDoReembolsoGcSemNf } from '@modules/reembolsos/actions/conferenciaDoReembolso';
import { sqlDoReenvioNaIntelipost } from '@modules/reenvios/actions/reenvioRecenteNoCosmos';
import { matchResendsOfOrder } from '@modules/reenvios/actions/resendManagement';
import type { ResendSubmissionData } from '@modules/reenvios/types';
import { derivarContextoDoPedido, motivosDoNaoConferido, notaDeNaoConferido, numeroDasLeituras, pedidoDaPlanilha } from '@shared/lib/datamart/pedido';
import { sqlDaIntelipost, sqlDasExplodidas, sqlDaShopify } from '@shared/lib/datamart/pedidoServer';
import { sqlDaNfNaIntelipost } from '@shared/lib/datamart/nfDaIntelipostServer';
import type { LeiturasDoPedido } from '@shared/lib/datamart/pedidoTipos';
import { pedidoNaIntelipost } from '@shared/lib/intelipost/gateway';
import {
    buscaNoCosmos,
    ehOPedidoNoCosmos,
    ehReenvioDoPedidoNoCosmos,
    lerNumeroDaLoja,
    mesmoPedido,
    sqlDaChaveDoPedido,
    sqlDoMesmoPedido,
    textoDoPedido,
} from '@shared/lib/pedido/numeroDaLoja';
import { escolherPedido, type PedidoDoGateway } from '@shared/lib/shopify/gateway';
import { nomesDoPedidoNaShopify } from '@shared/lib/shopify/nomeDoPedido';

/**
 * Os pedidos da Gocreators (`GC{n}{sigla}`, decisão deste app em 2026-11-27): o GC é sempre o pedido inteiro, e os
 * dígitos dele nunca acham o `#n`/SH de mesmo número, nem o contrário. Os números são os dos pedidos conferidos no Data
 * Mart e na réplica do Cosmos em 26/11: `GC104306BB` (Barbour's; o `#104306` de 2024 está na mesma loja),
 * `GC109828LC` (Lescent; o `#109828` é de 10/2025) e `GC107465BB` com o reenvio `GC107465BB-R-1`. Nenhum dado de cliente.
 */

describe('lerNumeroDaLoja: um leitor só para o número do pedido', () => {
    it.each([
        ['GC104306BB', 'barbours', { prefixo: 'GC', digitos: '104306', sufixo: 'BB' }],
        ['gc109828lc', 'lescent', { prefixo: 'GC', digitos: '109828', sufixo: 'LC' }],
        ['#GC 109828 LC', 'lescent', { prefixo: 'GC', digitos: '109828', sufixo: 'LC' }],
        ['GC104306', 'barbours', { prefixo: 'GC', digitos: '104306', sufixo: 'BB' }],
        ['GC104306LC', 'barbours', { prefixo: 'GC', digitos: '104306', sufixo: 'LC' }],
        ['SH1954655BB', 'barbours', { prefixo: 'SH', digitos: '1954655', sufixo: 'BB' }],
        ['SH1629891AP', 'apice', { prefixo: 'SH', digitos: '1629891', sufixo: 'AP' }],
        ['#1475900', 'apice', { prefixo: 'SH', digitos: '1475900', sufixo: 'AP' }],
        ['1475900', undefined, { prefixo: 'SH', digitos: '1475900', sufixo: '' }],
        ['#SHOPIFY220183', 'lescent', { prefixo: 'SH', digitos: '220183', sufixo: 'LC' }],
    ])('%s (%s)', (texto, marca, esperado) => {
        expect(lerNumeroDaLoja(texto, marca)).toEqual(esperado);
    });

    it('sem dígito, ou com um GC fora do formato (o reenvio GC…-R-1), não há o que buscar', () => {
        for (const texto of ['', 'abc', 'GC', 'GC107465BB-R-1', 'PEDIDOGC104306BB', 'GC104306BBX', null, undefined]) {
            expect(lerNumeroDaLoja(texto, 'barbours'), String(texto)).toBeNull();
        }
    });

    it('o texto para fora: os dígitos no SH (como até a v24) e o GC inteiro', () => {
        expect(textoDoPedido(lerNumeroDaLoja('SH1954655BB')!)).toBe('1954655');
        expect(textoDoPedido(lerNumeroDaLoja('gc107465', 'barbours')!)).toBe('GC107465BB');
    });

    it('mesmoPedido: os dígitos e o lado; a sigla não entra', () => {
        const gc = lerNumeroDaLoja('GC109828LC')!;
        const sh = lerNumeroDaLoja('109828')!;
        expect(mesmoPedido('GC109828LC', gc)).toBe(true);
        expect(mesmoPedido('gc109828', gc)).toBe(true);
        expect(mesmoPedido('#109828', gc)).toBe(false);
        expect(mesmoPedido('SH109828LC', gc)).toBe(false);
        expect(mesmoPedido('GC109828LC-R-1', gc)).toBe(false);
        expect(mesmoPedido('#109828', sh)).toBe(true);
        expect(mesmoPedido('SH109828LC', sh)).toBe(true);
        expect(mesmoPedido('GC109828LC', sh)).toBe(false);
        expect(mesmoPedido('GC109828LC', null)).toBe(false);
    });
});

describe('Shopify: o GC pelo nome inteiro; SH e dígitos nunca escolhem um GC', () => {
    it('os nomes procurados', () => {
        expect(nomesDoPedidoNaShopify('barbours', 'GC104306BB')).toEqual(['GC104306BB']);
        expect(nomesDoPedidoNaShopify('lescent', 'gc109828')).toEqual(['GC109828LC']);
        expect(nomesDoPedidoNaShopify('yenzah', 'GC104306YE')).toEqual(['GC104306YE']);
        expect(nomesDoPedidoNaShopify('lescent', '109828')).toEqual(['109828']);
        // Regressão dos SH: a Ápice procura o SH…AP e depois o #n antigo.
        expect(nomesDoPedidoNaShopify('apice', 'SH1629891AP')).toEqual(['SH1629891AP', '1629891']);
        expect(nomesDoPedidoNaShopify('apice', '#1475900')).toEqual(['SH1475900AP', '1475900']);
        expect(nomesDoPedidoNaShopify('barbours', 'SH1954655BB')).toEqual(['1954655']);
        expect(nomesDoPedidoNaShopify('barbours', 'GC107465BB-R-1')).toEqual([]);
    });

    const p = (name: string): PedidoDoGateway => ({ name });

    it('o GC acha o próprio GC, nunca o #n de mesmos dígitos', () => {
        expect(escolherPedido([p('#109828'), p('GC109828LC')], 'GC109828LC')?.name).toBe('GC109828LC');
        expect(escolherPedido([p('#104306')], 'GC104306BB')).toBeNull();
        expect(escolherPedido([p('GC107465BB-R-1'), p('GC107465BB')], 'GC107465BB')?.name).toBe('GC107465BB');
    });

    it('só os dígitos acham o #n/SH e nunca o GC, venha ele antes ou sozinho', () => {
        expect(escolherPedido([p('GC109828LC'), p('#109828')], '109828')?.name).toBe('#109828');
        expect(escolherPedido([p('GC109828LC')], '109828')).toBeNull();
        expect(escolherPedido([p('SH1475900AP')], '1475900')?.name).toBe('SH1475900AP');
        // O reenvio SH1452727RT-R-1 não passa pelo original.
        expect(escolherPedido([p('SH1452727RT-R-1'), p('SH1452727RT')], '1452727')?.name).toBe('SH1452727RT');
        expect(escolherPedido([p('SH1452727RT-R-1')], '1452727')).toBeNull();
    });
});

describe('Cosmos: o external_id do GC é o nome inteiro', () => {
    const gc = lerNumeroDaLoja('GC107465BB', 'barbours')!;
    const sh = lerNumeroDaLoja('107465', 'barbours')!;

    it('a busca: o GC inteiro; o SH pelos dígitos', () => {
        expect(buscaNoCosmos(gc)).toBe('GC107465BB');
        expect(buscaNoCosmos(sh)).toBe('107465');
    });

    it('o original: o GC só casa o GC; o SH só casa o SH', () => {
        expect(ehOPedidoNoCosmos('GC107465BB', gc)).toBe(true);
        expect(ehOPedidoNoCosmos('GC107465BB-R-1', gc)).toBe(false);
        expect(ehOPedidoNoCosmos('SH107465BB', gc)).toBe(false);
        expect(ehOPedidoNoCosmos('GC107465BB', sh)).toBe(false);
        expect(ehOPedidoNoCosmos('SH107465BB', sh)).toBe(true);
        expect(ehOPedidoNoCosmos('SH107465BB1', sh)).toBe(true);
        expect(ehOPedidoNoCosmos('#SHOPIFY107465', sh)).toBe(true);
        expect(ehOPedidoNoCosmos('SH1074651BB', sh)).toBe(false);
    });

    it('os reenvios: o do GC não conta para o SH de mesmos dígitos, nem o contrário; vale qualquer origem', () => {
        const lista = [
            { external_id: 'GC107465BB', origin: 'gocreators' },
            { external_id: 'GC107465BB-R-1', origin: 'shopify' },
            { external_id: 'GC107465BB-R-2', origin: 'resend' },
            { external_id: 'SH107465BB-R-1', origin: 'resend' },
            { external_id: 'GC1074651BB-R-1', origin: 'resend' },
        ];
        expect(matchResendsOfOrder(lista, 'GC107465BB').map((o) => o.external_id)).toEqual(['GC107465BB-R-1', 'GC107465BB-R-2']);
        expect(matchResendsOfOrder(lista, 'gc107465', 'barbours').map((o) => o.external_id)).toEqual(['GC107465BB-R-1', 'GC107465BB-R-2']);
        expect(matchResendsOfOrder(lista, '107465').map((o) => o.external_id)).toEqual(['SH107465BB-R-1']);
        expect(ehReenvioDoPedidoNoCosmos('GC107465BB-R-1', sh)).toBe(false);
        // Regressão: o reenvio de um SH.
        expect(matchResendsOfOrder([{ external_id: 'SH1452727RT-R-1' }], 'SH1452727RT')).toHaveLength(1);
    });
});

describe('Intelipost: o GC pelo sales_order_number', () => {
    it('o pedido como a Intelipost o guarda', () => {
        expect(pedidoNaIntelipost('barbours', 'GC107465BB')).toBe('GC107465BB');
        expect(pedidoNaIntelipost('barbours', 'gc107465')).toBe('GC107465BB');
        expect(pedidoNaIntelipost('barbours', '107465')).toBe('SH107465BB');
        expect(pedidoNaIntelipost('barbours', 'GC107465BB-R-1')).toBeNull();
    });

    it('a NF do Data Mart: o GC pelo sales_order_number; o SH pelo shopify_order_number, como antes', () => {
        expect(sqlDaNfNaIntelipost('barbours', 'GC107465BB')).toContain("where sales_order_number = 'GC107465BB' and brand_code = 'barbours'");
        expect(sqlDaNfNaIntelipost('barbours', '107465')).toContain("where shopify_order_number = '107465' and brand_code = 'barbours'");
    });

    it('o reenvio no Data Mart: GC…-R-k, sem a forma #SHOPIFY', () => {
        const sql = sqlDoReenvioNaIntelipost('barbours', 'GC107465BB', new Date('2026-11-24T00:00:00Z'));
        expect(sql).toContain("'GC107465BB-R-1'");
        expect(sql).toContain("'GC107465BB-R-10'");
        expect(sql).not.toContain('#SHOPIFY');
        expect(sqlDoReenvioNaIntelipost('barbours', '107465', new Date('2026-11-24T00:00:00Z'))).toContain("'SH107465BB-R-1', '#SHOPIFY107465-R-1'");
    });
});

describe('a conferência da Yenzah (ADR-018) com o GC', () => {
    it('o número das leituras: os dígitos no SH, o GC inteiro com a sigla', () => {
        expect(numeroDasLeituras('SH11249YE', 'yenzah')).toBe('11249');
        expect(numeroDasLeituras('GC104306', 'yenzah')).toBe('GC104306YE');
        expect(numeroDasLeituras('GC104306YE-R-1', 'yenzah')).toBeNull();
        expect(numeroDasLeituras('12', 'yenzah')).toBeNull();
        expect(pedidoDaPlanilha('yenzah', 'GC104306YE')).toBe('GC104306YE');
        expect(pedidoDaPlanilha('yenzah', '11249')).toBe('SH11249YE');
    });

    it('as consultas do Data Mart vão pelo nome do GC; as do SH, como antes', () => {
        expect(sqlDaIntelipost('yenzah', 'GC104306YE')).toContain("where sales_order_number = 'GC104306YE' and brand_code = 'yenzah'");
        expect(sqlDaShopify('yenzah', 'GC104306YE')).toContain("where brand = 'yenzah' and order_name = 'GC104306YE' and created_at >= '2026-09-01'");
        expect(sqlDasExplodidas('yenzah', 'GC104306YE'))
            .toContain("where e.order_id = (select order_id from gold.fct_shopify_orders where brand = 'yenzah' and order_name = 'GC104306YE' and created_at >= '2026-09-01' order by order_id desc limit 1)");
        expect(sqlDaShopify('yenzah', '11249')).toContain("where brand = 'yenzah' and order_number = 11249");
        expect(sqlDaIntelipost('yenzah', '11249')).toContain("where shopify_order_number = '11249'");
    });

    const semNfEmLugarNenhum = (numero: string): LeiturasDoPedido => ({
        marca: 'yenzah',
        numero,
        intelipost: { ok: true, dados: [] },
        shopify: { ok: true, dados: { orderId: '9001', criadoEm: '2026-11-20T10:00:00Z', total: 0, frete: 0, cancelado: false, temRastreio: false } },
        explodidas: { ok: true, dados: [] },
        foraDoDataMart: { shopify: { ok: true, dados: null }, intelipost: { ok: true, dados: null } },
    });

    it('o GC sem NF em fonte nenhuma não é "ausente": desconhecida, com o motivo pedido_gocreators', () => {
        const gc = derivarContextoDoPedido(semNfEmLugarNenhum('GC104306YE'));
        expect(gc.pedido).toBe('GC104306YE');
        expect(gc.nf).toEqual({ estado: 'desconhecida', numero: null, motivo: 'pedido_gocreators' });
        expect(gc.avisos).toContain('Pedido da Gocreators: a NF de venda não está na Intelipost nem na Shopify. O reenvio é registrado sem a NF; o reembolso precisa dela.');
        expect(notaDeNaoConferido(['nf'], motivosDoNaoConferido(gc))).toBe('[NF NÃO CONFERIDA: PEDIDO DA GOCREATORS SEM NF]');
        // O SH nas mesmas condições continua ausente (ADR-018).
        expect(derivarContextoDoPedido(semNfEmLugarNenhum('11249')).nf).toEqual({ estado: 'ausente', numero: null });
    });

    it('o reenvio GC é registrado com a NF que veio e a nota; o do SH sem NF continua recusado', () => {
        const dados = { numeroNF: '-', comentarios: 'Extravio', cdOrigem: 'CD ES' } as unknown as ResendSubmissionData;
        const gc = aplicarConferenciaAoReenvio('yenzah', dados, { tipo: 'lido', contexto: derivarContextoDoPedido(semNfEmLugarNenhum('GC104306YE')) });
        expect(gc.tipo).toBe('aplicado');
        if (gc.tipo === 'aplicado') {
            expect(gc.data.numeroNF).toBe('-');
            expect(gc.data.comentarios).toMatch(/^\[NF NÃO CONFERIDA: PEDIDO DA GOCREATORS SEM NF\]/);
        }
        const sh = aplicarConferenciaAoReenvio('yenzah', dados, { tipo: 'lido', contexto: derivarContextoDoPedido(semNfEmLugarNenhum('11249')) });
        expect(sh.tipo).toBe('recusado');
    });
});

describe('o reembolso GC precisa da NF (decisão do usuário em 2026-11-27)', () => {
    it('GC sem NF: a recusa; GC com NF, ou SH sem NF: nada', () => {
        expect(recusaDoReembolsoGcSemNf('GC104306BB', 'barbours', false)).toBe(
            'O pedido GC104306BB é da Gocreators e está sem NF de venda: ela não veio na solicitação nem foi achada na Intelipost '
            + 'ou na Shopify. O reembolso precisa da NF. Nada foi registrado. Se o pedido já foi faturado, mande o número da NF, ou '
            + 'tente de novo em alguns minutos.',
        );
        expect(recusaDoReembolsoGcSemNf('gc104306', 'barbours', false)).toContain('O pedido GC104306BB é da Gocreators');
        expect(recusaDoReembolsoGcSemNf('GC104306BB', 'barbours', true)).toBeNull();
        expect(recusaDoReembolsoGcSemNf('SH1954655BB', 'barbours', false)).toBeNull();
        expect(recusaDoReembolsoGcSemNf('104306', 'barbours', false)).toBeNull();
    });
});

describe('o predicado SQL num Postgres de verdade (PGlite)', () => {
    let pg: PGlite;
    const VALORES = ['GC109828LC', 'gc109828', '#109828', '109828', 'SH109828LC', '109828 Concluído', 'GC109828LC-R-1', 'GC1098281LC', null];

    beforeAll(async () => {
        pg = new PGlite();
        await pg.exec('create table t (id serial, numero_pedido text)');
        for (const v of VALORES) await pg.query('insert into t (numero_pedido) values ($1)', [v]);
    }, 30_000);

    afterAll(async () => {
        await pg?.close();
    });

    const casam = async (pedido: string) =>
        (await pg.query<{ numero_pedido: string }>(
            `select numero_pedido from t where ${sqlDoMesmoPedido('numero_pedido', lerNumeroDaLoja(pedido, 'lescent'))} order by id`,
        )).rows.map((r) => r.numero_pedido);

    it('o GC acha só os GC de mesmos dígitos; o SH, só os SH', async () => {
        expect(await casam('GC109828LC')).toEqual(['GC109828LC', 'gc109828']);
        expect(await casam('109828')).toEqual(['#109828', '109828', 'SH109828LC', '109828 Concluído']);
        expect(await casam('GC109828LC-R-1')).toEqual([]);
    });

    it('a chave do pedido separa o GC do SH no agrupamento', async () => {
        const grupos = (await pg.query<{ n: number }>(
            `select count(*)::int as n from (select distinct ${sqlDaChaveDoPedido('numero_pedido')} from t where numero_pedido is not null) g`,
        )).rows[0].n;
        // 109828 (SH), 109828 (GC), 1098281 (GC-R-1), 1098281 (GC1098281LC): três chaves.
        expect(grupos).toBe(3);
    });
});
