import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// A NF fora do Data Mart no registro (2026-11-19), de ponta a ponta no servidor: a conferência e as leituras são as
// REAIS, com o Metabase e o gateway simulados pelo `fetch`. Como em `processSemCosmos.test.ts`, o dedup, a
// fila e a planilha têm testes próprios; aqui importa a NF que vai para a fila, e a recusa.
vi.mock('@shared/lib/fila', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/fila')>()),
    solicitacaoRecenteNoRegistro: vi.fn(),
    enfileirarCasos: vi.fn(),
    prazoDaFila: vi.fn(),
}));
vi.mock('@shared/lib/sheets/gravarLinha', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/sheets/gravarLinha')>()),
    gravarNasPlanilhas: vi.fn(),
}));

import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro } from '@shared/lib/fila';
import { gravarNasPlanilhas } from '@shared/lib/sheets/gravarLinha';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { stubRegistroEnv } from '../helpers/registro-env';

const METABASE = 'https://metabase.test';
const GATEWAY = 'https://api.gateway.test/v1';

const enfileirar = vi.mocked(enfileirarCasos);
const planilhas = vi.mocked(gravarNasPlanilhas);

const linhas = (rows: unknown[][]) => new Response(JSON.stringify({ status: 'completed', data: { rows } }), { status: 202 });
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

/**
 * O Data Mart de um pedido ainda sem a remessa da Intelipost no gold (a hora depois da NF): o pedido na Shopify e os
 * itens, sem NF. Na Ápice, o Tiny não é lido (sem a remessa e com o pedido da Shopify, a busca é por data: aqui, vazia).
 */
function dataMartSemNf(sql: string): Response {
    if (sql.includes('vw_shopify_order_items_exploded_priced_enriched')) return linhas([['YE9001', 'YE9001', false, 1, 1, 89.9]]);
    if (sql.includes('gold.fct_intelipost_orders')) return linhas([]);
    if (sql.includes('gold.fct_shopify_orders')) return linhas([['8001', '2026-11-10T12:00:00+00:00', 89.9, 0, false, true]]);
    if (sql.includes('tiny_pedidos_ap_cosmetics')) return linhas([]);
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
}

/** O gateway de cada caso: o metacampo da Shopify e a Intelipost ao vivo, pela URL. */
let gateway: (url: string, corpo: string) => Response;
const metacampo = (nome: string, nf: string | null) =>
    json({ data: { orders: { edges: [{ node: { name: nome, nf: nf === null ? null : { value: nf } } }] } } });
const intelipostSemEnvio = () => json({ status: 'ERROR' }, 400);

let fetchSpy: MockInstance<typeof fetch>;
const chamadasAoGateway = () => fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(GATEWAY));

function reembolso(brand: RefundSubmissionData['brand'], pedido: string): RefundSubmissionData {
    return {
        brand,
        data_criacao: '19/11/2026',
        handledBy: 'Ana',
        sourceChannel: 'Chat Atendimento',
        supportTicketId: 'T-1',
        originWarehouse: 'CD ES',
        customerName: 'Cliente',
        invoiceNumber: '-',
        nfeAccessKey: '',
        batchNumber: 'L1',
        ecommerceOrderId: pedido,
        policyException: false,
        refundAmount: 89.9,
        refundReason: 'Cancelamento',
        refundScope: 'YE9001 - 1',
        requiresReturn: false,
        carrierTicketId: null,
        carrierName: 'J&T',
        orderStatus: 'Pedido não foi enviado',
        isFullRefund: true,
        notes: null,
        pixKey: null,
    };
}

/** 19/11/2026 10:00 em SP */
const AGORA = new Date(Date.UTC(2026, 10, 19, 13, 0, 0));

beforeEach(() => {
    vi.mocked(solicitacaoRecenteNoRegistro).mockReset().mockResolvedValue(null);
    enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
    vi.mocked(prazoDaFila).mockReset().mockReturnValue(1_900_000_000_000);
    planilhas.mockReset().mockResolvedValue({ ok: true });
    stubRegistroEnv();
    // As planilhas das marcas sem Cosmos só existem em produção, por enquanto.
    vi.stubEnv('SHEETS_ENV', 'prod');
    vi.stubEnv('METABASE_URL', METABASE);
    vi.stubEnv('METABASE_API_KEY', 'chave');
    vi.stubEnv('METABASE_DATABASE_ID', '43');
    vi.stubEnv('SHOPIFY_GATEWAY_URL', `${GATEWAY}/shopify`);
    vi.stubEnv('SHOPIFY_GATEWAY_KEY', 'igw_leitura_de_teste');
    vi.stubEnv('INTELIPOST_GATEWAY_URL', `${GATEWAY}/intelipost`);
    vi.stubEnv('INTELIPOST_GATEWAY_KEY', 'igw_intelipost_de_teste');
    gateway = (url) => (url.includes('/intelipost/') ? intelipostSemEnvio() : json({ data: { orders: { edges: [] } } }));
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === `${METABASE}/api/dataset`) return dataMartSemNf(JSON.parse(String(init?.body)).native.query as string);
        if (url.startsWith(`${GATEWAY}/`)) return gateway(url, String(init?.body ?? ''));
        throw new Error(`fetch inesperado: ${url}`);
    });
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('processRefund — a NF fora do Data Mart', () => {
    it('Yenzah sem NF no Data Mart e com o metacampo: grava com a NF da Shopify, sem 422', async () => {
        gateway = (url) => (url.includes('/shopify/yenzah') ? metacampo('SH11249YE', '001588301') : intelipostSemEnvio());

        const { body, status } = await processRefund('yenzah', reembolso('yenzah', 'SH11249YE'), { agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS');
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ numero_pedido: 'SH11249YE', nf: '1588301' });
        expect(planilhas).toHaveBeenCalledTimes(1);
        // O metacampo achou: a Intelipost ao vivo nem é consultada.
        expect(chamadasAoGateway()).toEqual([`${GATEWAY}/shopify/yenzah`]);
    });

    it('Yenzah sem o metacampo: a NF da Intelipost ao vivo, na conta beautyhub', async () => {
        gateway = (url) => (url.includes('/shopify/')
            ? metacampo('SH11249YE', null)
            : json({ status: 'OK', content: [{ order_number: 'SH11249YE001', shipment_order_volume_array: [{ shipment_order_volume_invoice: { invoice_number: '001588301' } }] }] }));

        const { status } = await processRefund('yenzah', reembolso('yenzah', 'SH11249YE'), { agora: AGORA });

        expect(status).toBe(200);
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ nf: '1588301' });
        expect(chamadasAoGateway()).toEqual([
            `${GATEWAY}/shopify/yenzah`,
            `${GATEWAY}/intelipost/yenzah/shipment_order/sales_order_number/SH11249YE`,
        ]);
    });

    it('Ápice sem NF em nenhuma fonte (Data Mart e Intelipost ao vivo): 422, como hoje, e nada gravado', async () => {
        const { body, status } = await processRefund('apice', { ...reembolso('apice', 'SH1837266AP'), refundScope: 'AP001 - 1' }, { agora: AGORA });

        expect(status).toBe(422);
        expect(body).toMatchObject({ code: 'UNKNOWN_ERROR' });
        expect(body.message).toContain('O pedido SH1837266AP não tem NF de venda no Tiny nem na Intelipost');
        expect(enfileirar).not.toHaveBeenCalled();
        expect(planilhas).not.toHaveBeenCalled();
        // A Ápice não tem o metacampo: só a Intelipost ao vivo.
        expect(chamadasAoGateway()).toEqual([`${GATEWAY}/intelipost/apice/shipment_order/sales_order_number/SH1837266AP`]);
    });

    it('Ápice com a Intelipost ao vivo fora: não recusa; grava a NF que veio com a nota do motivo', async () => {
        gateway = () => json({ error: 'invalid_key' }, 401);

        const { status } = await processRefund('apice', { ...reembolso('apice', 'SH1837266AP'), invoiceNumber: '183916', refundScope: 'AP001 - 1' }, { agora: AGORA });

        expect(status).toBe(200);
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ nf: '183916' });
        const [linhasGravadas] = planilhas.mock.calls[0];
        expect(JSON.stringify(linhasGravadas[0].linha)).toContain('[NF NÃO CONFERIDA: CONSULTA AO VIVO SEM RESPOSTA]');
    });

    describe('pedido da Gocreators: o reembolso só com NF (decisão do usuário em 2026-11-27)', () => {
        const sqlsDoDataMart = () => fetchSpy.mock.calls
            .filter(([url]) => String(url) === `${METABASE}/api/dataset`)
            .map(([, init]) => JSON.parse(String(init?.body)).native.query as string);
        const corposAoGateway = () => fetchSpy.mock.calls
            .filter(([url]) => String(url).startsWith(`${GATEWAY}/shopify/`))
            .map(([, init]) => String(init?.body ?? ''));

        it('Barbour\'s, GC sem NF em fonte nenhuma: 422 e nada gravado; todas as leituras pelo GC inteiro', async () => {
            const { body, status } = await processRefund('barbours', { ...reembolso('barbours', 'GC104306BB'), refundScope: 'BB001 - 1' }, { agora: AGORA });

            expect(status).toBe(422);
            expect(body.message).toContain('O pedido GC104306BB é da Gocreators e está sem NF de venda');
            expect(enfileirar).not.toHaveBeenCalled();
            expect(planilhas).not.toHaveBeenCalled();
            // Nada pelos dígitos: o #104306 de 2024 tem NF e é outro pedido.
            expect(sqlsDoDataMart()).toEqual([expect.stringContaining("where sales_order_number = 'GC104306BB' and brand_code = 'barbours'")]);
            expect(corposAoGateway()).toEqual([expect.stringContaining('"q":"name:GC104306BB"')]);
            expect(chamadasAoGateway()).toEqual([
                `${GATEWAY}/shopify/barbours`,
                `${GATEWAY}/intelipost/barbours/shipment_order/sales_order_number/GC104306BB`,
            ]);
        });

        it('GC com a NF na solicitação: grava, com o GC inteiro, sem procurar a NF', async () => {
            const { status } = await processRefund('barbours', { ...reembolso('barbours', 'GC104306BB'), invoiceNumber: '1905557', refundScope: 'BB001 - 1' }, { agora: AGORA });

            expect(status).toBe(200);
            expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ numero_pedido: 'GC104306BB', nf: '1905557' });
            expect(chamadasAoGateway()).toEqual([]);
        });

        it('GC com a NF no metacampo do próprio GC: grava com ela', async () => {
            gateway = (url) => (url.includes('/shopify/lescent') ? metacampo('GC109828LC', '001905557') : intelipostSemEnvio());

            const { status } = await processRefund('lescent', { ...reembolso('lescent', 'GC109828LC'), refundScope: 'LC001 - 1' }, { agora: AGORA });

            expect(status).toBe(200);
            expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ numero_pedido: 'GC109828LC', nf: '1905557' });
        });

        it('o metacampo que só devolve o #n de mesmos dígitos não vale para o GC: 422', async () => {
            gateway = (url) => (url.includes('/shopify/lescent') ? metacampo('#109828', '001700001') : intelipostSemEnvio());

            const { status } = await processRefund('lescent', { ...reembolso('lescent', 'GC109828LC'), refundScope: 'LC001 - 1' }, { agora: AGORA });

            expect(status).toBe(422);
            expect(enfileirar).not.toHaveBeenCalled();
        });

        it('Yenzah, GC sem NF: a conferência não recusa (o GC não é "ausente"), e a regra do GC recusa o reembolso', async () => {
            const { body, status } = await processRefund('yenzah', reembolso('yenzah', 'GC104306YE'), { agora: AGORA });

            expect(status).toBe(422);
            expect(body.message).toContain('O pedido GC104306YE é da Gocreators e está sem NF de venda');
            expect(enfileirar).not.toHaveBeenCalled();
            const sqls = sqlsDoDataMart();
            expect(sqls).toContainEqual(expect.stringContaining("where sales_order_number = 'GC104306YE' and brand_code = 'yenzah'"));
            expect(sqls).toContainEqual(expect.stringContaining("order_name = 'GC104306YE' and created_at >= '2026-09-01'"));
            expect(chamadasAoGateway()).toEqual([
                `${GATEWAY}/shopify/yenzah`,
                `${GATEWAY}/intelipost/yenzah/shipment_order/sales_order_number/GC104306YE`,
            ]);
        });

        it('regressão: o SH da marca do Cosmos sem NF continua gravando com "-" (a regra é só do GC)', async () => {
            const { status } = await processRefund('barbours', { ...reembolso('barbours', 'SH1954655BB'), refundScope: 'BB001 - 1' }, { agora: AGORA });

            expect(status).toBe(200);
            expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ numero_pedido: 'SH1954655BB' });
            expect(sqlsDoDataMart()).toEqual([expect.stringContaining("where shopify_order_number = '1954655'")]);
        });
    });

    it('marca do Cosmos sem NF no Data Mart: a do metacampo, pelos dígitos (o reenvio SH…-R-1 vem junto e não vale)', async () => {
        gateway = (url) => (url.includes('/shopify/bysamia')
            ? json({ data: { orders: { edges: [
                { node: { name: 'SH52988BS-R-1', nf: { value: '001905557' } } },
                { node: { name: 'SH52988BS', nf: { value: '001834451' } } },
            ] } } })
            : intelipostSemEnvio());

        const { status } = await processRefund('bysamia', { ...reembolso('bysamia', 'SH52988BS'), refundScope: 'BS001 - 1' }, { agora: AGORA });

        expect(status).toBe(200);
        expect(enfileirar.mock.calls[0][0][0]).toMatchObject({ numero_pedido: 'SH52988BS', nf: '1834451' });
    });
});
