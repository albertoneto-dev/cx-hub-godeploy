import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SupportedBrand } from '@shared/lib/constants';
import { formatarCarimboSP } from '@shared/lib/format';
import type { FluxoPlanilha, SheetCell } from '@shared/lib/sheets';
import {
    COLUNAS_DO_CASO,
    LayoutDaPlanilhaError,
    TOLERANCIA_CARIMBO_MS,
    __resetCasoNaPlanilha,
    acharLinhaDoCaso,
    acharLinhasDosCasos,
    casoComparavel,
    distanciaAoCaso,
    lerCarimbo,
    lerColunasDosCasos,
    linhasDosCasos,
} from '@shared/lib/sheets/casoNaPlanilha';
import { __resetGoogleTokenCache } from '@shared/lib/sheets/googleAuth';
import { SheetsError } from '@shared/lib/sheets/server';
import { resolverPlanilha } from '@shared/lib/sheets';
import { buildCancellationRow, prepararCancelamento } from '@shared/lib/cancellation';
import { buildRefundRow, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { buildResendRow } from '@modules/reenvios/actions/buildResendRow';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { intervalosDaLeitura, mockGoogle, stubGoogleEnv } from '../helpers/google-sheets-mock';
import { cabecalhoDoLayout, instalarGoogleFalso, serialDaData } from '../helpers/google-sheets-falso';

/**
 * Como o CX Hub acha a linha de um caso na planilha: pelo pedido (só os dígitos) e pelo carimbo, a até 2 min do
 * `criado_em` (ADR-010). Nenhum teste toca o Google: é o `fetch` que é substituído.
 */

const MARCAS: SupportedBrand[] = ['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria'];
const FLUXOS: FluxoPlanilha[] = ['reenvio', 'reembolso', 'cancelamento'];

/** 30/10/2026, 15:04:05 em São Paulo (UTC−3). */
const CRIADO_EM = new Date('2026-10-30T18:04:05.000Z');
const CARIMBO = '30/10/2026 15:04:05';
const PEDIDO = 'SH9000105LC';
const MIN = 60_000;
const em = (ms: number) => new Date(CRIADO_EM.getTime() + ms);

describe('lerCarimbo', () => {
    it.each([
        ['texto dd/mm/aaaa hh:mm:ss', '30/10/2026 15:04:05', Date.UTC(2026, 9, 30, 18, 4, 5)],
        ['com vírgula entre a data e a hora (como o toLocaleString)', '30/10/2026, 15:04:05', Date.UTC(2026, 9, 30, 18, 4, 5)],
        ['sem os segundos', '30/10/2026 15:04', Date.UTC(2026, 9, 30, 18, 4, 0)],
        ['dia, mês e hora sem zero à esquerda', '5/3/2026 9:07:01', Date.UTC(2026, 2, 5, 12, 7, 1)],
        ['só a data: meia-noite de São Paulo', '30/10/2026', Date.UTC(2026, 9, 30, 3, 0, 0)],
        ['com espaços nas pontas', '  30/10/2026 15:04:05  ', Date.UTC(2026, 9, 30, 18, 4, 5)],
        ['número serial (dia e hora de parede em SP)', 46325.5, Date.UTC(2026, 9, 30, 15, 0, 0)],
        ['número serial só do dia', 46325, Date.UTC(2026, 9, 30, 3, 0, 0)],
    ])('lê %s', (_nome, celula, esperado) => {
        expect(lerCarimbo(celula)).toBe(esperado);
    });

    it('o serial de uma data e hora lidas é o mesmo instante do texto', () => {
        const serial = serialDaData('30/10/2026') + (15 * 3600 + 4 * 60 + 5) / 86_400;
        expect(Math.abs((lerCarimbo(serial) ?? 0) - (lerCarimbo(CARIMBO) ?? 0))).toBeLessThan(2);
    });

    it('lê de volta o que o formatarCarimboSP escreveu (até o segundo)', () => {
        for (const instante of [CRIADO_EM, new Date('2026-01-15T02:59:59.999Z'), new Date('2026-12-31T23:59:59.000Z')]) {
            expect(lerCarimbo(formatarCarimboSP(instante))).toBe(Math.floor(instante.getTime() / 1000) * 1000);
        }
    });

    it.each([
        ['vazio', ''],
        ['só espaço', '   '],
        ['texto livre', 'ontem'],
        ['dia que não existe', '31/02/2026 10:00:00'],
        ['mês que não existe', '10/13/2026 10:00:00'],
        ['hora que não existe', '30/10/2026 25:00:00'],
        ['minuto que não existe', '30/10/2026 15:61:00'],
        ['texto depois do carimbo', '30/10/2026 15:04:05 extra'],
        ['formato aaaa-mm-dd', '2026-10-30 15:04:05'],
        ['nulo', null],
        ['ausente', undefined],
        ['booleano', true],
        ['NaN', Number.NaN],
        ['infinito', Number.POSITIVE_INFINITY],
    ])('%s não é um carimbo (null)', (_nome, celula) => {
        expect(lerCarimbo(celula as SheetCell | undefined)).toBeNull();
    });
});

describe('distanciaAoCaso — a linha é a do caso?', () => {
    const caso = { pedido: PEDIDO, criadoEm: CRIADO_EM };

    it('mesmo pedido e mesmo carimbo ⇒ distância zero', () => {
        expect(distanciaAoCaso({ carimbo: CARIMBO, pedido: PEDIDO }, caso)).toBe(0);
    });

    it('devolve a distância em ms, para a mais próxima vencer', () => {
        expect(distanciaAoCaso({ carimbo: '30/10/2026 15:04:35', pedido: PEDIDO }, caso)).toBe(30_000);
        expect(distanciaAoCaso({ carimbo: '30/10/2026 15:03:05', pedido: PEDIDO }, caso)).toBe(60_000);
    });

    it('a tolerância é de 2 minutos para cada lado, inclusive no limite', () => {
        expect(TOLERANCIA_CARIMBO_MS).toBe(120_000);
        expect(distanciaAoCaso({ carimbo: '30/10/2026 15:06:05', pedido: PEDIDO }, caso)).toBe(120_000);
        expect(distanciaAoCaso({ carimbo: '30/10/2026 15:02:05', pedido: PEDIDO }, caso)).toBe(120_000);
        expect(distanciaAoCaso({ carimbo: '30/10/2026 15:06:06', pedido: PEDIDO }, caso)).toBeNull();
        expect(distanciaAoCaso({ carimbo: '30/10/2026 15:02:04', pedido: PEDIDO }, caso)).toBeNull();
    });

    it('o pedido compara só os dígitos, dos dois lados (#SHOPIFY, SH...LC, número puro, número do Sheets)', () => {
        for (const celula of ['9000105', '#9000105', '#SHOPIFY9000105', 'SH9000105LC', 9000105]) {
            expect(distanciaAoCaso({ carimbo: CARIMBO, pedido: celula }, caso)).toBe(0);
        }
        expect(distanciaAoCaso({ carimbo: CARIMBO, pedido: '9000105' }, { pedido: '#SHOPIFY9000105', criadoEm: CRIADO_EM })).toBe(0);
    });

    it('outro pedido não é a linha do caso, mesmo com o mesmo carimbo', () => {
        expect(distanciaAoCaso({ carimbo: CARIMBO, pedido: 'SH9000106LC' }, caso)).toBeNull();
        expect(distanciaAoCaso({ carimbo: CARIMBO, pedido: '90001050' }, caso)).toBeNull();
    });

    it.each([
        ['pedido vazio na linha', { carimbo: CARIMBO, pedido: '' }],
        ['pedido ausente na linha', { carimbo: CARIMBO, pedido: undefined }],
        ['carimbo vazio', { carimbo: '', pedido: PEDIDO }],
        ['carimbo que não é data', { carimbo: 'sem data', pedido: PEDIDO }],
        ['carimbo ausente', { carimbo: undefined, pedido: PEDIDO }],
    ])('%s ⇒ não bate (linha em branco ou torta nunca é duplicata)', (_nome, linha) => {
        expect(distanciaAoCaso(linha, caso)).toBeNull();
    });

    it('caso sem dígito no pedido, ou sem data válida, não casa com nada (nem com linha de pedido vazio)', () => {
        expect(distanciaAoCaso({ carimbo: CARIMBO, pedido: '' }, { pedido: '', criadoEm: CRIADO_EM })).toBeNull();
        expect(distanciaAoCaso({ carimbo: CARIMBO, pedido: '#ABC' }, { pedido: '#ABC', criadoEm: CRIADO_EM })).toBeNull();
        expect(distanciaAoCaso({ carimbo: CARIMBO, pedido: PEDIDO }, { pedido: PEDIDO, criadoEm: new Date('x') })).toBeNull();
    });

    it('lê o carimbo como serial também', () => {
        const serial = serialDaData('30/10/2026') + (15 * 3600 + 4 * 60 + 5) / 86_400;
        expect(distanciaAoCaso({ carimbo: serial, pedido: PEDIDO }, caso)).toBeLessThan(2);
    });
});

describe('COLUNAS_DO_CASO — o layout é o dos builders', () => {
    const PEDIDO_DOS_BUILDERS = '220183';
    const CARIMBO_DOS_BUILDERS = 'CARIMBO-SENTINELA';

    const refundData: RefundSubmissionData = {
        brand: 'lescent',
        data_criacao: '20/10/2026',
        handledBy: 'Ana',
        sourceChannel: 'Chat Atendimento',
        supportTicketId: 'T-1',
        originWarehouse: 'SP',
        customerName: 'Cliente',
        invoiceNumber: '555',
        nfeAccessKey: 'CHAVE',
        batchNumber: 'L1',
        ecommerceOrderId: PEDIDO_DOS_BUILDERS,
        policyException: false,
        refundAmount: 150.5,
        refundReason: 'Avaria',
        refundScope: 'SKU01 - 1;Frete',
        requiresReturn: true,
        carrierTicketId: 'TK',
        carrierName: 'PAC',
        orderStatus: 'Entregue',
        isFullRefund: false,
        notes: 'obs',
    };

    const cancelamento = {
        brand: 'lescent' as const,
        'Responsável': 'Maria',
        'Nome do(a) cliente': 'João',
        'Número do pedido (Shopify)': PEDIDO_DOS_BUILDERS,
        'Observações': 'obs',
        'Número da NF': '123',
        'CD de origem': 'SP',
        'Status': '',
        'Local da Tratativa': '',
        'Tratativa': 'Reenvio',
    };

    const linhaDe = (fluxo: FluxoPlanilha, marca: SupportedBrand): SheetCell[] => {
        if (fluxo === 'reenvio') return buildResendRow(marca, RESEND_DATA, CARIMBO_DOS_BUILDERS);
        if (fluxo === 'reembolso') return buildRefundRow(marca, prepararReembolso(refundData, CARIMBO_DOS_BUILDERS));
        return buildCancellationRow(marca, prepararCancelamento(cancelamento, CARIMBO_DOS_BUILDERS));
    };

    it.each(FLUXOS.flatMap((fluxo) => MARCAS.map((marca) => [fluxo, marca] as const)))(
        '%s/%s: o carimbo e o pedido caem nas colunas do layout',
        (fluxo, marca) => {
            const linha = linhaDe(fluxo, marca);
            const { carimbo, pedido } = COLUNAS_DO_CASO[fluxo][marca];

            expect(linha[carimbo]).toBe(CARIMBO_DOS_BUILDERS);
            expect(linha[pedido]).toBe(PEDIDO_DOS_BUILDERS);
            // E só ali: nenhuma outra coluna da linha tem o carimbo (o layout não adivinha entre duas).
            expect(linha.filter((celula) => celula === CARIMBO_DOS_BUILDERS)).toHaveLength(1);
        },
    );

    it('o carimbo é sempre a coluna A', () => {
        for (const fluxo of FLUXOS) for (const marca of MARCAS) expect(COLUNAS_DO_CASO[fluxo][marca].carimbo).toBe(0);
    });
});

describe('acharLinhaDoCaso', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        __resetCasoNaPlanilha();
        stubGoogleEnv();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    const prazo = () => Date.now() + 10_000;
    const caso = { pedido: PEDIDO, criadoEm: CRIADO_EM };

    /** Uma linha de dados do reembolso da Kokeshi (carimbo em A, pedido em E). */
    const linhaKokeshi = (pedido: SheetCell, carimbo: SheetCell): SheetCell[] => [carimbo, null, 'Ana', 'Cliente', pedido, 'motivo'];
    const abaKokeshi = (linhas: SheetCell[][]) => instalarGoogleFalso(cabecalhoDoLayout('reembolso', 'kokeshi'), linhas);
    const achar = (c = caso) => acharLinhaDoCaso('reembolso', 'kokeshi', c, prazo());

    it('acha a linha do pedido e do carimbo e devolve o número dela (1 = cabeçalho)', async () => {
        abaKokeshi([linhaKokeshi('SH1', '01/10/2026 10:00:00'), linhaKokeshi(PEDIDO, CARIMBO), linhaKokeshi('SH2', '02/10/2026 10:00:00')]);

        await expect(achar()).resolves.toBe(3);
    });

    it('lê o carimbo como serial (a coluna é de data) e como texto', async () => {
        const serial = serialDaData('30/10/2026') + (15 * 3600 + 4 * 60 + 5) / 86_400;
        abaKokeshi([linhaKokeshi(PEDIDO, serial)]);
        await expect(achar()).resolves.toBe(2);

        abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);
        await expect(achar()).resolves.toBe(2);
    });

    it('o pedido da planilha pode ser número (o Sheets converte "9000105" em número)', async () => {
        abaKokeshi([linhaKokeshi(9000105, CARIMBO)]);

        await expect(achar()).resolves.toBe(2);
    });

    it('duas linhas do mesmo pedido com carimbos diferentes ⇒ escolhe a do carimbo certo', async () => {
        abaKokeshi([
            linhaKokeshi(PEDIDO, formatarCarimboSP(em(-10 * MIN))), // um caso antigo do mesmo pedido
            linhaKokeshi(PEDIDO, CARIMBO),
            linhaKokeshi(PEDIDO, formatarCarimboSP(em(15 * MIN))), // e um posterior
        ]);

        await expect(achar()).resolves.toBe(3);
    });

    it('duas linhas dentro da janela ⇒ vale a de carimbo mais próximo', async () => {
        abaKokeshi([
            linhaKokeshi(PEDIDO, formatarCarimboSP(em(-100_000))),
            linhaKokeshi(PEDIDO, formatarCarimboSP(em(25_000))),
            linhaKokeshi(PEDIDO, formatarCarimboSP(em(90_000))),
        ]);

        await expect(achar()).resolves.toBe(3);
    });

    it.each([
        ['3 min depois', em(3 * MIN)],
        ['3 min antes', em(-3 * MIN)],
        ['1 dia depois', em(24 * 60 * MIN)],
    ])('carimbo fora da tolerância (%s) ⇒ null', async (_nome, criadoEm) => {
        abaKokeshi([linhaKokeshi(PEDIDO, formatarCarimboSP(criadoEm))]);

        await expect(achar()).resolves.toBeNull();
    });

    it('pedido diferente com o mesmo carimbo ⇒ null', async () => {
        abaKokeshi([linhaKokeshi('SH9000106LC', CARIMBO)]);

        await expect(achar()).resolves.toBeNull();
    });

    it('aba só com o cabeçalho, ou com linhas em branco no meio ⇒ null, sem errar o número da linha seguinte', async () => {
        abaKokeshi([]);
        await expect(achar()).resolves.toBeNull();

        abaKokeshi([[], [], linhaKokeshi(PEDIDO, CARIMBO)]);
        await expect(achar()).resolves.toBe(4);
    });

    it('caso sem dígito no pedido ou sem data válida ⇒ null, sem nem ler a planilha', async () => {
        const google = abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);

        await expect(achar({ pedido: '#ABC', criadoEm: CRIADO_EM })).resolves.toBeNull();
        await expect(achar({ pedido: PEDIDO, criadoEm: new Date('x') })).resolves.toBeNull();

        expect(google.contagem).toEqual({ cabecalho: 0, colunas: 0, appends: 0 });
    });

    it('lê só o cabeçalho e as duas colunas (carimbo e pedido), as duas numa requisição só — nunca a aba inteira (nome e endereço de toda cliente)', async () => {
        abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);

        await achar();

        const leituras = vi.mocked(global.fetch).mock.calls
            .map(([url]) => String(url))
            .filter((url) => url.startsWith('https://sheets.googleapis.com/'))
            .map(intervalosDaLeitura);
        const { aba } = resolverPlanilha('reembolso', 'kokeshi');
        // Duas requisições: o cabeçalho (conferido antes de olhar as colunas) e o `values:batchGet` com as duas colunas.
        expect(leituras).toEqual([[`'${aba}'!1:1`], [`'${aba}'!A:A`, `'${aba}'!E:E`]]);
    });

    it('usa o layout de cada fluxo e marca (a coluna do pedido muda: reenvio da Rituária é a J)', async () => {
        const cabecalho = cabecalhoDoLayout('reenvio', 'rituaria');
        const linha: SheetCell[] = Array.from({ length: 12 }, () => null);
        linha[0] = CARIMBO;
        linha[9] = PEDIDO;
        instalarGoogleFalso(cabecalho, [linha]);

        await expect(acharLinhaDoCaso('reenvio', 'rituaria', caso, prazo())).resolves.toBe(2);

        const colunas = vi.mocked(global.fetch).mock.calls.flatMap(([url]) => intervalosDaLeitura(String(url)));
        expect(colunas.some((c) => c.endsWith('!J:J'))).toBe(true);
    });

    describe('o cabeçalho é conferido contra o layout', () => {
        it.each([
            ['Carimbo de data/hora'],
            ['carimbo de data/hora'],
            ['CARIMBO'],
            ['Timestamp'],
            ['Data/Hora'],
        ])('aceita %j na coluna do carimbo', async (nome) => {
            const cabecalho = cabecalhoDoLayout('reembolso', 'kokeshi');
            cabecalho[0] = nome;
            instalarGoogleFalso(cabecalho, [linhaKokeshi(PEDIDO, CARIMBO)]);

            await expect(achar()).resolves.toBe(2);
        });

        it.each([
            ['Número do pedido'],
            ['Número do pedido (Shopify)'],
            ['NÚMERO DO PEDIDO'],
            ['Pedido'],
        ])('aceita %j na coluna do pedido, sem diferenciar caixa nem acento', async (nome) => {
            const cabecalho = cabecalhoDoLayout('reembolso', 'kokeshi');
            cabecalho[4] = nome;
            instalarGoogleFalso(cabecalho, [linhaKokeshi(PEDIDO, CARIMBO)]);

            await expect(achar()).resolves.toBe(2);
        });

        it('alguém inseriu uma coluna: o pedido deixa de estar onde o layout diz ⇒ erro claro, em vez de olhar a coluna errada', async () => {
            const cabecalho = cabecalhoDoLayout('reembolso', 'kokeshi');
            cabecalho.splice(4, 1, 'Observações', 'Número do pedido'); // o pedido foi para a F
            instalarGoogleFalso(cabecalho, [linhaKokeshi(PEDIDO, CARIMBO)]);

            const erro = await achar().catch((e) => e);

            expect(erro).toBeInstanceOf(LayoutDaPlanilhaError);
            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.incerto).toBe(false);
            expect(erro.message).toContain('não bate com o layout de reembolso/kokeshi');
            expect(erro.message).toContain('a coluna E (pedido) tem o cabeçalho "Observações"');
        });

        it('a coluna do carimbo sem cara de carimbo também falha, e as duas divergências aparecem juntas', async () => {
            const cabecalho = cabecalhoDoLayout('reembolso', 'kokeshi');
            cabecalho[0] = 'ID';
            cabecalho[4] = 'Cliente';
            instalarGoogleFalso(cabecalho, [linhaKokeshi(PEDIDO, CARIMBO)]);

            const erro = await achar().catch((e) => e);

            expect(erro.message).toContain('a coluna A (carimbo) tem o cabeçalho "ID"');
            expect(erro.message).toContain('a coluna E (pedido) tem o cabeçalho "Cliente"');
        });

        it('cabeçalho vazio (aba sem nada) falha, não vira "sem linha"', async () => {
            instalarGoogleFalso([], []);

            await expect(achar()).rejects.toBeInstanceOf(LayoutDaPlanilhaError);
        });

        it('o que não confere NÃO fica guardado: arrumado o cabeçalho, a busca funciona na hora', async () => {
            const cabecalho = cabecalhoDoLayout('reembolso', 'kokeshi');
            cabecalho[4] = 'Observações';
            const google = instalarGoogleFalso(cabecalho, [linhaKokeshi(PEDIDO, CARIMBO)]);
            await expect(achar()).rejects.toBeInstanceOf(LayoutDaPlanilhaError);

            google.cabecalho[4] = 'Número do pedido';

            await expect(achar()).resolves.toBe(2);
        });
    });

    describe('cache do cabeçalho conferido', () => {
        it('a segunda busca não lê a linha 1 de novo, mas lê as colunas (a planilha muda a cada solicitação)', async () => {
            const google = abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);

            await achar();
            await achar();

            expect(google.contagem.cabecalho).toBe(1);
            // Uma requisição das duas colunas por busca.
            expect(google.contagem.colunas).toBe(2);
        });

        it('expira em ~10 min: o cabeçalho é lido de novo (o backoffice pode ter mexido nas colunas)', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
            const google = abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);

            await achar();
            vi.setSystemTime(new Date('2026-10-30T12:09:00Z'));
            await achar();
            expect(google.contagem.cabecalho).toBe(1);

            vi.setSystemTime(new Date('2026-10-30T12:11:00Z'));
            await achar();
            expect(google.contagem.cabecalho).toBe(2);
        });

        it('é por fluxo, marca, planilha e aba', async () => {
            const google = abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);
            google.cabecalho = cabecalhoDoLayout('reembolso', 'kokeshi');

            await acharLinhaDoCaso('reembolso', 'kokeshi', caso, prazo());
            await acharLinhaDoCaso('reembolso', 'lescent', caso, prazo()); // mesma aba falsa, outra marca (pedido em E também)

            expect(google.contagem.cabecalho).toBe(2);
        });
    });

    it('erro do Google sobe como SheetsError — "não consegui olhar" não é "não achei"', async () => {
        abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);
        vi.mocked(global.fetch).mockImplementation(async (input) => {
            if (String(input).startsWith('https://oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
            return new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status: 403 });
        });

        const erro = await achar().catch((e) => e);

        expect(erro).toBeInstanceOf(SheetsError);
        expect(erro.status).toBe(403);
    });
});

describe('acharLinhasDosCasos — vários casos da marca com uma leitura só (a lista)', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        __resetCasoNaPlanilha();
        stubGoogleEnv();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    const prazo = () => Date.now() + 10_000;
    const linhaKokeshi = (pedido: SheetCell, carimbo: SheetCell): SheetCell[] => [carimbo, null, 'Ana', 'Cliente', pedido, 'motivo'];
    const abaKokeshi = (linhas: SheetCell[][]) => instalarGoogleFalso(cabecalhoDoLayout('reembolso', 'kokeshi'), linhas);

    it('um número de linha (ou null) por caso, na ordem, lendo o cabeçalho e as duas colunas uma vez só', async () => {
        const google = abaKokeshi([
            linhaKokeshi('SH1', '01/10/2026 10:00:00'),
            linhaKokeshi(PEDIDO, CARIMBO),
            linhaKokeshi('SH2KS', formatarCarimboSP(em(10 * MIN))),
        ]);

        const linhas = await acharLinhasDosCasos('reembolso', 'kokeshi', [
            { pedido: 'SH2KS', criadoEm: em(10 * MIN) },
            { pedido: 'SH3KS', criadoEm: CRIADO_EM },
            { pedido: PEDIDO, criadoEm: CRIADO_EM },
        ], prazo());

        expect(linhas).toEqual([4, null, 3]);
        expect(google.contagem.cabecalho).toBe(1);
        expect(google.contagem.colunas).toBe(1);
        expect(google.colunasLidas).toEqual([['A:A', 'E:E']]);
    });

    it('o caso sem dígito no pedido ou sem data válida dá null, e os outros ainda são achados', async () => {
        abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);

        await expect(acharLinhasDosCasos('reembolso', 'kokeshi', [
            { pedido: '#ABC', criadoEm: CRIADO_EM },
            { pedido: PEDIDO, criadoEm: new Date('x') },
            { pedido: PEDIDO, criadoEm: CRIADO_EM },
        ], prazo())).resolves.toEqual([null, null, 2]);
    });

    it('nenhum caso comparável (ou nenhum caso) ⇒ todos null, sem nem ler a planilha', async () => {
        const google = abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO)]);

        await expect(acharLinhasDosCasos('reembolso', 'kokeshi', [{ pedido: '#ABC', criadoEm: CRIADO_EM }], prazo()))
            .resolves.toEqual([null]);
        await expect(acharLinhasDosCasos('reembolso', 'kokeshi', [], prazo())).resolves.toEqual([]);

        expect(google.contagem).toEqual({ cabecalho: 0, colunas: 0, appends: 0 });
    });

    it('o mesmo que o acharLinhaDoCaso para um caso só: ele delega a esta', async () => {
        abaKokeshi([linhaKokeshi(PEDIDO, CARIMBO), linhaKokeshi(PEDIDO, formatarCarimboSP(em(MIN)))]);
        const caso = { pedido: PEDIDO, criadoEm: em(50_000) };

        const [emLote] = await acharLinhasDosCasos('reembolso', 'kokeshi', [caso], prazo());
        await expect(acharLinhaDoCaso('reembolso', 'kokeshi', caso, prazo())).resolves.toBe(emLote);
        expect(emLote).toBe(3);
    });

    it('cabeçalho que não confere com o layout sobe (LayoutDaPlanilhaError): quem chama decide', async () => {
        instalarGoogleFalso(['Coluna 0', 'Coluna 1', 'Coluna 2', 'Coluna 3', 'Coluna 4'], [linhaKokeshi(PEDIDO, CARIMBO)]);

        await expect(acharLinhasDosCasos('reembolso', 'kokeshi', [{ pedido: PEDIDO, criadoEm: CRIADO_EM }], prazo()))
            .rejects.toBeInstanceOf(LayoutDaPlanilhaError);
    });
});

describe('lerColunasDosCasos — as duas colunas numa requisição só', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        __resetCasoNaPlanilha();
        stubGoogleEnv();
        for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    const prazo = () => Date.now() + 10_000;

    it('confere o cabeçalho e lê o carimbo e o pedido num values:batchGet; a linha vazia (`[]`) vira null', async () => {
        const { aba } = resolverPlanilha('reembolso', 'kokeshi');
        const google = mockGoogle({
            leitura: (intervalo) => {
                if (intervalo.endsWith('!1:1')) return [cabecalhoDoLayout('reembolso', 'kokeshi')];
                // Como o Google: a linha vazia no meio vem `[]`, e o fim vazio da coluna é cortado.
                if (intervalo.endsWith('!A:A')) return [['Carimbo de data/hora'], [CARIMBO], [], ['30/10/2026 16:00:00']];
                return [['Número do pedido'], [PEDIDO]];
            },
        });

        const colunas = await lerColunasDosCasos('reembolso', 'kokeshi', prazo());

        expect(colunas).toEqual({
            carimbos: ['Carimbo de data/hora', CARIMBO, null, '30/10/2026 16:00:00'],
            pedidos: ['Número do pedido', PEDIDO],
        });
        expect(google.leituras().map((leitura) => intervalosDaLeitura(leitura.url))).toEqual([
            [`'${aba}'!1:1`],
            [`'${aba}'!A:A`, `'${aba}'!E:E`],
        ]);
    });

    it('cabeçalho que não bate: falha antes de ler as colunas (não se olha a coluna errada)', async () => {
        const cabecalho = cabecalhoDoLayout('reembolso', 'kokeshi');
        cabecalho[4] = 'Observações';
        const google = instalarGoogleFalso(cabecalho, [[CARIMBO, null, 'Ana', 'Cliente', PEDIDO]]);

        await expect(lerColunasDosCasos('reembolso', 'kokeshi', prazo())).rejects.toBeInstanceOf(LayoutDaPlanilhaError);

        expect(google.contagem.colunas).toBe(0);
    });
});

describe('linhasDosCasos — a parte pura da busca, que a lista aplica ao que guardou', () => {
    /** As colunas de uma aba: o índice 0 é o cabeçalho, a linha 1. */
    const colunas = (...linhas: [SheetCell, SheetCell][]) => ({
        carimbos: ['Carimbo de data/hora', ...linhas.map(([carimbo]) => carimbo)],
        pedidos: ['Número do pedido', ...linhas.map(([, pedido]) => pedido)],
    });

    it('a linha de cada caso (1 = cabeçalho), na ordem dos casos; o cabeçalho nunca casa', () => {
        const lidas = colunas([CARIMBO, 'SH1'], [CARIMBO, PEDIDO], [formatarCarimboSP(em(10 * MIN)), PEDIDO]);

        expect(linhasDosCasos(lidas, [
            { pedido: PEDIDO, criadoEm: em(10 * MIN) },
            { pedido: 'SH9', criadoEm: CRIADO_EM },
            { pedido: PEDIDO, criadoEm: CRIADO_EM },
        ])).toEqual([4, null, 3]);
    });

    it('duas linhas na janela: a de carimbo mais próximo; no empate, a de cima', () => {
        const lidas = colunas(
            [formatarCarimboSP(em(-60_000)), PEDIDO],
            [formatarCarimboSP(em(20_000)), PEDIDO],
            [formatarCarimboSP(em(-20_000)), PEDIDO],
        );

        expect(linhasDosCasos(lidas, [{ pedido: PEDIDO, criadoEm: CRIADO_EM }])).toEqual([3]);
    });

    it('caso sem o que comparar ⇒ null (casoComparavel)', () => {
        const lidas = colunas([CARIMBO, PEDIDO]);

        expect(casoComparavel({ pedido: '#ABC', criadoEm: CRIADO_EM })).toBe(false);
        expect(casoComparavel({ pedido: PEDIDO, criadoEm: new Date('x') })).toBe(false);
        expect(casoComparavel({ pedido: PEDIDO, criadoEm: CRIADO_EM })).toBe(true);
        expect(linhasDosCasos(lidas, [{ pedido: '#ABC', criadoEm: CRIADO_EM }, { pedido: PEDIDO, criadoEm: CRIADO_EM }])).toEqual([null, 2]);
    });

    it('colunas de tamanhos diferentes (o Google corta o fim vazio de cada uma) não erram o número da linha', () => {
        const lidas = { carimbos: ['Carimbo de data/hora', 'x', CARIMBO], pedidos: ['Número do pedido', 'SH1', PEDIDO, 'SH3'] };

        expect(linhasDosCasos(lidas, [{ pedido: PEDIDO, criadoEm: CRIADO_EM }])).toEqual([3]);
    });
});
