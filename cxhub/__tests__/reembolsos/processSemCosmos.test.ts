import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Como em `processRefund.test.ts` e `processResend.test.ts`: o dedup e a fila têm testes próprios, e a linha na
// planilha também (`gravarLinha*.test.ts`). Aqui importa o que o `process*` faz com as marcas sem Cosmos (ADR-013).
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
// A leitura do Data Mart tem testes próprios (`pedidoNoDataMart.test.ts`, `pedidoSemCosmos.test.ts`); aqui importa o que
// o `process*` faz com o que a conferência devolve (ADR-018). Sem conferência, `nao_se_aplica`: nada muda.
vi.mock('@shared/lib/datamart/conferenciaServer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/datamart/conferenciaServer')>()),
    conferirPedidoNoDataMart: vi.fn(),
}));

import { problemaNoCaso } from '@shared/lib/airflow';
import { conferirPedidoNoDataMart } from '@shared/lib/datamart/conferenciaServer';
import type { ContextoDoPedido } from '@shared/lib/datamart/pedidoTipos';
import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro } from '@shared/lib/fila';
import { gravarNasPlanilhas } from '@shared/lib/sheets/gravarLinha';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import { buildRefundRow, COLUNA_DA_CHAVE_PIX, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import { processResend } from '@modules/reenvios/actions/processResend';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { stubRegistroEnv } from '../helpers/registro-env';

const buscar = vi.mocked(solicitacaoRecenteNoRegistro);
const enfileirar = vi.mocked(enfileirarCasos);
const planilhas = vi.mocked(gravarNasPlanilhas);
const conferir = vi.mocked(conferirPedidoNoDataMart);

/** O pedido SH1731559AP como o Data Mart o tem (NF 10157987, CD ES, Kit Cachos e Kit Brilho), com o que se trocar. */
function contexto(parcial: Partial<ContextoDoPedido> = {}): ContextoDoPedido {
    return {
        marca: 'apice',
        numero: '1731559',
        pedido: 'SH1731559AP',
        nf: { estado: 'achada', numero: '10157987' },
        cd: { valor: 'CD ES', conferido: true },
        statusSugerido: 'Pedido não entregue (em trânsito)',
        avisos: [],
        kits: [
            {
                sku: '40132',
                componentes: ['20683', '20684', '20688', '20690', '20696'].map((sku) => ({ sku, quantidade: 1 })),
            },
            { sku: '46194', componentes: [{ sku: '20910', quantidade: 1 }, { sku: '20911', quantidade: 1 }] },
        ],
        baseDoValor: {
            total: 305.7,
            produtos: 289.8,
            desconto: 0,
            frete: 15.9,
            precos: { '20683': 37.2, '20684': 38.76, '20688': 37.2, '20690': 41.86, '20696': 34.88, '20910': 48.13, '20911': 51.77 },
        },
        baseConferida: true,
        unidadesDoPedido: { '20683': 1, '20684': 1, '20688': 1, '20690': 1, '20696': 1, '20910': 1, '20911': 1 },
        ...parcial,
    };
}

/** O Data Mart fora do ar: nenhuma leitura respondeu. */
const SEM_RESPOSTA: Partial<ContextoDoPedido> = {
    nf: { estado: 'desconhecida', numero: null },
    cd: { valor: null, conferido: false },
    statusSugerido: null,
    kits: [],
    baseDoValor: null,
    baseConferida: false,
    unidadesDoPedido: {},
};

const PIX = 'cliente.secreta@exemplo.com';
const REEMBOLSO: RefundSubmissionData = {
    brand: 'apice',
    data_criacao: '20/10/2026',
    handledBy: 'Ana',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'T-1',
    originWarehouse: 'CD ES',
    customerName: 'Cliente',
    invoiceNumber: '-',
    nfeAccessKey: '',
    batchNumber: 'L1',
    ecommerceOrderId: 'SH1629891AP',
    policyException: false,
    refundAmount: 94.82,
    refundReason: 'Ruptura de Estoque',
    refundScope: 'AP001 - 1',
    requiresReturn: false,
    carrierTicketId: null,
    carrierName: 'J&T Express',
    orderStatus: 'Pedido não foi enviado',
    isFullRefund: false,
    notes: null,
    pixKey: PIX,
};

/** 05/11/2026 15:00 em SP */
const AGORA = new Date(Date.UTC(2026, 10, 5, 18, 0, 0));

beforeEach(() => {
    buscar.mockReset().mockResolvedValue(null);
    enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
    vi.mocked(prazoDaFila).mockReset().mockReturnValue(1_900_000_000_000);
    planilhas.mockReset().mockResolvedValue({ ok: true });
    conferir.mockReset().mockResolvedValue({ tipo: 'nao_se_aplica' });
    stubRegistroEnv();
    // As planilhas das marcas sem Cosmos só existem em produção, por enquanto.
    vi.stubEnv('SHEETS_ENV', 'prod');
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('processRefund — marcas sem Cosmos', () => {
    it('registra na fila e na planilha da marca; a chave Pix vai só para a linha, nunca para a fila', async () => {
        const { body, status } = await processRefund('apice', REEMBOLSO, { agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS');
        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ tipo: 'REEMBOLSO', marca: 'apice', numero_pedido: 'SH1629891AP', valor: 94.82 });
        expect(problemaNoCaso(caso)).toBeNull();
        expect(JSON.stringify(enfileirar.mock.calls)).not.toContain(PIX);

        const [linhas] = planilhas.mock.calls[0];
        expect(linhas).toHaveLength(1);
        expect(linhas[0]).toMatchObject({ fluxo: 'reembolso', marca: 'apice', colunasSensiveis: [COLUNA_DA_CHAVE_PIX.apice] });
        expect(linhas[0].linha).toEqual(buildRefundRow('apice', prepararReembolso(REEMBOLSO, '05/11/2026 15:00:00')));
    });

    it('sem a planilha da marca no ambiente (staging ainda sem cópia) ⇒ 503 antes do dedup e da fila', async () => {
        vi.stubEnv('SHEETS_ENV', 'staging');

        const { body, status } = await processRefund('yenzah', { ...REEMBOLSO, brand: 'yenzah' }, { agora: AGORA });

        expect(status).toBe(503);
        expect(body.message).toContain('não há planilha de reembolso da marca yenzah em staging');
        expect(buscar).not.toHaveBeenCalled();
        expect(enfileirar).not.toHaveBeenCalled();
        expect(planilhas).not.toHaveBeenCalled();
    });

    it('o Bot registra o reembolso dessas marcas com o cancelamento junto, mas o cancelamento vai só à fila (ADR-015)', async () => {
        const { body, status } = await processRefund('denavita', { ...REEMBOLSO, brand: 'denavita', handledBy: 'Bot' }, { agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS');
        const casos = enfileirar.mock.calls[0][0];
        expect(casos.map((c) => c.tipo)).toEqual(['REEMBOLSO', 'CANCELAMENTO']);
        expect(casos[1]).toMatchObject({
            marca: 'denavita', numero_pedido: 'SH1629891AP', responsavel: 'Bot', tratativa: 'Reembolso', cd_origem: 'CD ES',
        });
        for (const caso of casos) expect(problemaNoCaso(caso)).toBeNull();
        // Uma linha só, a do reembolso: não há planilha de cancelamento das marcas sem Cosmos.
        const [linhas] = planilhas.mock.calls[0];
        expect(linhas.map((l) => l.fluxo)).toEqual(['reembolso']);
    });

    it('só as fórmulas faltaram ⇒ SHEET_WRITE_FAILED, dizendo que a linha entrou e para NÃO repetir', async () => {
        planilhas.mockResolvedValueOnce({ ok: false, motivo: 'a linha 12 entrou, mas as fórmulas da operação não', linhasGravadas: true });

        const { body } = await processRefund('apice', REEMBOLSO, { agora: AGORA });

        expect(body).toMatchObject({ code: 'SHEETS_ERROR', reason: 'SHEET_WRITE_FAILED' });
        expect(body.message).toBe('O reembolso entrou na fila do Metabase, mas a linha entrou na planilha sem as fórmulas de prazo e SLA (o suporte foi avisado para completar). NÃO repita a solicitação.');
    });
});

describe('processResend — marcas sem Cosmos', () => {
    const DATA = { ...RESEND_DATA, numeroPedido: 'SH416884DN', cdOrigem: 'CD MG', cosmosId: '' };

    it('nunca chama o Cosmos, nem com automação no corpo: registra sem automação', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch');

        const { body, status } = await processResend({ brand: 'denavita', data: DATA, token: 'tk', agora: AGORA });

        expect(status).toBe(200);
        expect(body).toMatchObject({ code: 'SUCCESS_SHEETS_ONLY', sentToAPI: false });
        expect(fetchSpy).not.toHaveBeenCalled();
        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ marca: 'denavita', automacao: false, cd_origem: 'CD MG' });
        expect(planilhas.mock.calls[0][0][0]).toMatchObject({ fluxo: 'reenvio', marca: 'denavita' });
    });

    it('sem a planilha da marca no ambiente ⇒ 503 RECORD_UNAVAILABLE antes do dedup', async () => {
        vi.stubEnv('SHEETS_ENV', 'staging');

        const { body, status } = await processResend({ brand: 'apice', data: DATA, agora: AGORA });

        expect(status).toBe(503);
        expect(body).toMatchObject({ code: 'UNKNOWN_ERROR', reason: 'RECORD_UNAVAILABLE', sentToAPI: false });
        expect(body.message).toContain('não há planilha de reenvio da marca apice em staging');
        expect(buscar).not.toHaveBeenCalled();
    });
});

describe('processResend — a conferência do pedido no Data Mart (ADR-018)', () => {
    /** Um reenvio do 20688 do Kit Cachos, como a tela manda: NF digitada e o CD que ela fixa na Ápice. */
    const REENVIO = {
        ...RESEND_DATA,
        numeroPedido: 'SH1731559AP',
        cdOrigem: 'CD ES',
        cosmosId: '',
        numeroNF: '10157988',
        produtoReenviar: '20688 - 1',
        itensOriginaisReenviados: [{ sku: '20688', quantidade: 1 }],
        valorReenvio: '35,36',
        comentarios: 'Cliente pediu urgência',
    };

    it('o pedido sem NF de venda é recusado: 422, nada na fila nem na planilha', async () => {
        conferir.mockResolvedValue({ tipo: 'lido', contexto: contexto({ nf: { estado: 'ausente', numero: null } }) });

        const { body, status } = await processResend({ brand: 'apice', data: REENVIO, agora: AGORA });

        expect(status).toBe(422);
        expect(body).toMatchObject({ code: 'UNKNOWN_ERROR', reason: 'ORDER_NOT_INVOICED', sentToAPI: false });
        expect(body.message).toContain('O pedido SH1731559AP não tem NF de venda no Tiny nem na Intelipost');
        expect(body.message).toContain('Nada foi registrado');
        expect(enfileirar).not.toHaveBeenCalled();
        expect(planilhas).not.toHaveBeenCalled();
    });

    it('a NF, o CD e o valor do Data Mart vão para a fila e para a linha; o valor da Ápice vai na coluna AC da operação', async () => {
        conferir.mockResolvedValue({ tipo: 'lido', contexto: contexto({ cd: { valor: 'CD RJ', conferido: true } }) });

        const { body, status } = await processResend({ brand: 'apice', data: REENVIO, agora: AGORA });

        expect(status).toBe(200);
        expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
        expect(conferir).toHaveBeenCalledWith('apice', 'SH1731559AP', expect.any(Number));
        const [caso] = enfileirar.mock.calls[0][0];
        // 37,20 + o frete proporcional (2,04): o caso SH1731559AP
        expect(caso).toMatchObject({ nf: '10157987', cd_origem: 'CD RJ', valor: '39,24' });
        const [linha] = planilhas.mock.calls[0][0];
        expect(linha.valoresDaOperacao).toEqual({ AC: 39.24 });
        expect(linha.linha).toContain('10157987');
        expect(linha.linha).toContain('CD RJ');
        expect(linha.linha).not.toContain('10157988');
        // A NF digitada que diverge vai para o log, com as duas.
        expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toMatch(/10157988.*10157987/);
    });

    it('na Denavita o valor é coluna do formulário: vai na linha pelo valorReenvio, sem coluna da operação', async () => {
        conferir.mockResolvedValue({
            tipo: 'lido',
            contexto: contexto({
                marca: 'denavita',
                pedido: 'SH423209DN',
                cd: { valor: 'CD MG', conferido: true },
                kits: [],
                baseDoValor: { total: 137.93, produtos: 129.03, desconto: 0, frete: 8.9, precos: { DVTRI1: 59.41, Laranjamorodenavita: 69.62 } },
                unidadesDoPedido: { DVTRI1: 1, Laranjamorodenavita: 1 },
            }),
        });
        const data = { ...REENVIO, numeroPedido: 'SH423209DN', produtoReenviar: 'DVTRI1 - 1', itensOriginaisReenviados: [{ sku: 'DVTRI1', quantidade: 1 }] };

        await processResend({ brand: 'denavita', data, agora: AGORA });

        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ cd_origem: 'CD MG', valor: '63,51' });
        const [linha] = planilhas.mock.calls[0][0];
        expect(linha.valoresDaOperacao).toBeUndefined();
        expect(linha.linha).toContain(63.51);
    });

    it('o valor que não dá para calcular fica em branco (o backoffice preenche), na fila e na linha', async () => {
        conferir.mockResolvedValue({ tipo: 'lido', contexto: contexto() });
        // Mimo sem a lista estruturada (a Central, por enquanto): não dá para separar o original do mimo.
        const data = { ...REENVIO, itensOriginaisReenviados: undefined, comentarios: 'SKU 30001 incluído como mimo' };

        await processResend({ brand: 'apice', data, agora: AGORA });

        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso.valor).toBe('');
        expect(planilhas.mock.calls[0][0][0].valoresDaOperacao).toBeUndefined();
    });

    it('o Data Mart sem resposta não impede o registro: vale o que veio, com a nota na frente das observações', async () => {
        conferir.mockResolvedValue({ tipo: 'lido', contexto: contexto(SEM_RESPOSTA) });

        const { status } = await processResend({ brand: 'apice', data: REENVIO, agora: AGORA });

        expect(status).toBe(200);
        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ nf: '10157988', cd_origem: 'CD ES', valor: '35,36' });
        const [linha] = planilhas.mock.calls[0][0];
        expect(linha.valoresDaOperacao).toBeUndefined();
        expect(linha.linha).toContain('[CD/NF/VALOR NÃO CONFERIDOS: DATA MART SEM RESPOSTA] | Cliente pediu urgência');
    });

    it('as marcas do Cosmos e a Gobeaute não passam pela conferência', async () => {
        await processResend({ brand: 'lescent', data: { ...RESEND_DATA, automacao: '' }, agora: AGORA });
        await processResend({ brand: 'gobeaute', data: { ...REENVIO, numeroPedido: 'SH1001GB' }, agora: AGORA });

        expect(conferir).not.toHaveBeenCalled();
    });
});

describe('processRefund — a conferência do pedido no Data Mart e a chave Pix (ADR-018)', () => {
    it('o pedido sem NF de venda é recusado: 422, nada na fila nem na planilha', async () => {
        conferir.mockResolvedValue({ tipo: 'lido', contexto: contexto({ nf: { estado: 'ausente', numero: null } }) });

        const { body, status } = await processRefund('apice', REEMBOLSO, { agora: AGORA });

        expect(status).toBe(422);
        expect(body.code).toBe('UNKNOWN_ERROR');
        expect(body.message).toContain('não dá para solicitar reembolso ainda');
        expect(enfileirar).not.toHaveBeenCalled();
        expect(planilhas).not.toHaveBeenCalled();
    });

    it('a NF e o CD do Data Mart vão para a fila e para a linha', async () => {
        conferir.mockResolvedValue({ tipo: 'lido', contexto: contexto({ cd: { valor: 'CD RJ', conferido: true } }) });

        await processRefund('apice', REEMBOLSO, { agora: AGORA });

        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ nf: '10157987', cd_origem: 'CD RJ' });
        const esperado = prepararReembolso({ ...REEMBOLSO, invoiceNumber: '10157987', originWarehouse: 'CD RJ' }, '05/11/2026 15:00:00');
        expect(planilhas.mock.calls[0][0][0].linha).toEqual(buildRefundRow('apice', esperado));
    });

    it('o Data Mart sem resposta: vale o que veio, e a nota vai nas observações da Ápice', async () => {
        conferir.mockResolvedValue({ tipo: 'lido', contexto: contexto(SEM_RESPOSTA) });

        await processRefund('apice', { ...REEMBOLSO, notes: 'Cliente sem retorno' }, { agora: AGORA });

        const [caso] = enfileirar.mock.calls[0][0];
        expect(caso).toMatchObject({ nf: '-', cd_origem: 'CD ES' });
        expect(planilhas.mock.calls[0][0][0].linha).toContain('[CD/NF NÃO CONFERIDOS: DATA MART SEM RESPOSTA] | Cliente sem retorno');
    });

    it('a chave Pix vai normalizada para a linha, e nunca para a fila', async () => {
        await processRefund('apice', { ...REEMBOLSO, pixKey: '529.982.247-25' }, { agora: AGORA });

        expect(planilhas.mock.calls[0][0][0].linha[COLUNA_DA_CHAVE_PIX.apice]).toBe('52998224725');
        expect(JSON.stringify(enfileirar.mock.calls)).not.toContain('52998224725');
    });

    it('a chave Pix inválida para o tipo é recusada antes de qualquer leitura', async () => {
        const { body, status } = await processRefund('apice', { ...REEMBOLSO, pixKey: '52998224726', pixKeyType: 'cpf' }, { agora: AGORA });

        expect(status).toBe(422);
        expect(body.message).toBe('CPF da chave Pix inválido (confira os 11 dígitos). Nada foi registrado.');
        expect(buscar).not.toHaveBeenCalled();
        expect(conferir).not.toHaveBeenCalled();
        expect(enfileirar).not.toHaveBeenCalled();
    });

    it('sem a chave: passa com CHAVE_PIX_OBRIGATORIA desligada, e é recusada com ela em on', async () => {
        const semChave = { ...REEMBOLSO, pixKey: '' };

        expect((await processRefund('apice', semChave, { agora: AGORA })).status).toBe(200);
        expect(planilhas.mock.calls[0][0][0].linha[COLUNA_DA_CHAVE_PIX.apice]).toBeNull();

        vi.stubEnv('CHAVE_PIX_OBRIGATORIA', 'on');
        const { body, status } = await processRefund('apice', semChave, { agora: AGORA });
        expect(status).toBe(422);
        expect(body.message).toBe('Informe a chave Pix da cliente: o reembolso desta marca é pago por Pix. Nada foi registrado.');
    });
});
