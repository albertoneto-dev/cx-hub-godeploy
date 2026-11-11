import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatarCarimboSP } from '@shared/lib/format';
import { cabecalhoDoLayout } from '../helpers/google-sheets-falso';
import { __resetCasoNaPlanilha, type ColunasLidas } from '@shared/lib/sheets/casoNaPlanilha';
import { __resetGoogleTokenCache } from '@shared/lib/sheets/googleAuth';
import {
    JANELA_PRESENCA_MS,
    TTL_DA_PRESENCA_MS,
    __resetPresencaNaPlanilha,
    comPresencaNaPlanilha,
    prazoDaPresenca,
    type PresencaDeps,
} from '@shared/lib/sheets/presencaNaPlanilha';
import { JANELA_PLANILHA_MS } from '@shared/lib/sheets/gravarLinha';
import type { SolicitacaoListada } from '@shared/lib/solicitacoes/types';
import { mockGoogle, stubGoogleEnv } from '../helpers/google-sheets-mock';

/**
 * A tag do envio das linhas que vêm da raw: se a linha da solicitação está na planilha da marca. Uma leitura das duas
 * colunas por tipo e marca (nunca por linha), guardada por 60 s para paginar e filtrar não relerem, e nunca lança: o
 * que não deu para ler fica `null` (sem tag).
 */

const PRAZO = 1_900_000_000_000;
/** O "agora" dos testes que mexem no relógio: uma semana depois dos casos de exemplo. */
const AGORA = new Date('2026-11-04T12:00:00.000Z');

function item(sobre: Partial<SolicitacaoListada> = {}): SolicitacaoListada {
    return {
        idSolicitacao: 'id-1',
        tipo: 'REEMBOLSO',
        marca: 'lescent',
        numeroPedido: 'SH9000105LC',
        dataSolicitacao: '2026-10-28T13:45:00',
        valor: 139.9,
        motivo: 'Produto avariado',
        statusExecucao: null,
        responsavel: 'Ana',
        maisRecenteDoPedido: true,
        criadoEm: '2026-10-28T16:45:00.000Z',
        naPlanilha: null,
        situacaoNaFila: null,
        ...sobre,
    };
}

/** As colunas do carimbo e do pedido de uma aba com a linha de cada solicitação dada (o índice 0 é o cabeçalho). */
function colunasCom(...itens: SolicitacaoListada[]): ColunasLidas {
    return {
        carimbos: ['Carimbo de data/hora', ...itens.map((i) => formatarCarimboSP(new Date(i.criadoEm ?? '')))],
        pedidos: ['Número do pedido', ...itens.map((i) => i.numeroPedido)],
    };
}

function deps(sobre: Partial<PresencaDeps> = {}): PresencaDeps {
    return {
        // Por padrão, a planilha tem a linha da solicitação de exemplo.
        lerColunasDosCasos: vi.fn<PresencaDeps['lerColunasDosCasos']>(async () => colunasCom(item())),
        planilhasConfiguradas: () => true,
        ...sobre,
    };
}

beforeEach(() => {
    __resetPresencaNaPlanilha();
    vi.stubEnv('SHEETS_ENV', 'staging');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('comPresencaNaPlanilha', () => {
    it('achou a linha ⇒ true; não achou ⇒ false', async () => {
        const a = item({ idSolicitacao: 'a', numeroPedido: 'SH1LC' });
        const b = item({ idSolicitacao: 'b', numeroPedido: 'SH2LC' });

        const resultado = await comPresencaNaPlanilha([a, b], PRAZO, deps({ lerColunasDosCasos: vi.fn(async () => colunasCom(a)) }));

        expect(resultado.map((s) => [s.idSolicitacao, s.naPlanilha])).toEqual([['a', true], ['b', false]]);
    });

    it('uma leitura por tipo e marca, com o fluxo da planilha e o prazo, e sem esperar a cota (retentarCota: false)', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>(async () => colunasCom(item()));

        await comPresencaNaPlanilha([
            item({ idSolicitacao: 'le-1' }),
            item({ idSolicitacao: 'bb-1', marca: 'barbours', numeroPedido: 'SH1BB', criadoEm: '2026-10-27T13:00:00.000Z' }),
            item({ idSolicitacao: 'le-2', numeroPedido: 'SH2LC' }),
            item({ idSolicitacao: 're-1', tipo: 'REENVIO' }),
        ], PRAZO, deps({ lerColunasDosCasos: ler }));

        expect(ler).toHaveBeenCalledTimes(3);
        expect(ler.mock.calls).toEqual(expect.arrayContaining([
            ['reembolso', 'lescent', PRAZO, { retentarCota: false }],
            ['reembolso', 'barbours', PRAZO, { retentarCota: false }],
            ['reenvio', 'lescent', PRAZO, { retentarCota: false }],
        ]));
    });

    it('sem criado_em válido não dá para achar a linha: null, não false', async () => {
        const resultado = await comPresencaNaPlanilha(
            [item({ idSolicitacao: 'sem', criadoEm: null }), item({ idSolicitacao: 'ruim', criadoEm: 'ontem' }), item({ idSolicitacao: 'ok' })],
            PRAZO,
            deps(),
        );

        expect(resultado.map((s) => s.naPlanilha)).toEqual([null, null, true]);
    });

    it('a marca cuja planilha não responde fica null, e as outras seguem: nunca lança', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>(async (_fluxo, marca) => {
            if (marca === 'barbours') throw new Error('a planilha não respondeu');
            return colunasCom(item());
        });

        const resultado = await comPresencaNaPlanilha(
            [item({ idSolicitacao: 'bb', marca: 'barbours' }), item({ idSolicitacao: 'le' })],
            PRAZO,
            deps({ lerColunasDosCasos: ler }),
        );

        expect(resultado.map((s) => [s.idSolicitacao, s.naPlanilha])).toEqual([['bb', null], ['le', true]]);
    });

    it('sem a configuração do Google ⇒ tudo null, sem ler nada', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>();

        const resultado = await comPresencaNaPlanilha([item()], PRAZO, deps({ lerColunasDosCasos: ler, planilhasConfiguradas: () => false }));

        expect(resultado.map((s) => s.naPlanilha)).toEqual([null]);
        expect(ler).not.toHaveBeenCalled();
    });

    it('lista vazia ⇒ devolve igual, sem ler nada', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>();
        const vazia: SolicitacaoListada[] = [];

        await expect(comPresencaNaPlanilha(vazia, PRAZO, deps({ lerColunasDosCasos: ler }))).resolves.toBe(vazia);
        expect(ler).not.toHaveBeenCalled();
    });

    it('não muda o resto da linha nem a ordem', async () => {
        const linhas = [item({ idSolicitacao: 'x', valor: 1 }), item({ idSolicitacao: 'y', valor: 2 })];

        const resultado = await comPresencaNaPlanilha(linhas, PRAZO, deps());

        expect(resultado).toEqual(linhas.map((l) => ({ ...l, naPlanilha: true })));
    });

    it('a janela da lista é a dela (15 s), não a da gravação', () => {
        expect(JANELA_PRESENCA_MS).toBe(15_000);
        expect(JANELA_PRESENCA_MS).toBeLessThan(JANELA_PLANILHA_MS);
        const antes = Date.now();
        expect(prazoDaPresenca()).toBeGreaterThanOrEqual(antes + JANELA_PRESENCA_MS);
    });
});

describe('o cache curto das colunas lidas', () => {
    const PAGINA_1 = [item({ idSolicitacao: 'p1', numeroPedido: 'SH1LC', criadoEm: '2026-10-28T16:45:00.000Z' })];
    const PAGINA_2 = [item({ idSolicitacao: 'p2', numeroPedido: 'SH2LC', criadoEm: '2026-10-27T10:00:00.000Z' })];

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(AGORA);
    });

    it('paginar e filtrar não relê a planilha: a segunda carga em menos de 60 s usa as colunas guardadas', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>(async () => colunasCom(...PAGINA_1, ...PAGINA_2));

        const pagina1 = await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        vi.setSystemTime(new Date(AGORA.getTime() + 30_000));
        const pagina2 = await comPresencaNaPlanilha(PAGINA_2, PRAZO, deps({ lerColunasDosCasos: ler }));

        expect(ler).toHaveBeenCalledTimes(1);
        expect(pagina1.map((s) => s.naPlanilha)).toEqual([true]);
        expect(pagina2.map((s) => s.naPlanilha)).toEqual([true]);
    });

    it('depois de 60 s, a planilha é lida de novo', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>(async () => colunasCom(...PAGINA_1));

        await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        vi.setSystemTime(new Date(AGORA.getTime() + TTL_DA_PRESENCA_MS - 1_000));
        await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        expect(ler).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date(AGORA.getTime() + TTL_DA_PRESENCA_MS + 1_000));
        await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        expect(ler).toHaveBeenCalledTimes(2);
    });

    it('nunca serve dado de outra planilha ou aba: com outro SHEETS_ENV (outra planilha), lê de novo', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>(async () => colunasCom(...PAGINA_1));

        await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        vi.stubEnv('SHEETS_ENV', 'prod');
        await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));

        expect(ler).toHaveBeenCalledTimes(2);
    });

    it('nem de outro fluxo ou outra marca', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>(async () => colunasCom(...PAGINA_1));

        await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        await comPresencaNaPlanilha([{ ...PAGINA_1[0], tipo: 'REENVIO' }], PRAZO, deps({ lerColunasDosCasos: ler }));
        await comPresencaNaPlanilha([{ ...PAGINA_1[0], marca: 'kokeshi' }], PRAZO, deps({ lerColunasDosCasos: ler }));

        expect(ler.mock.calls.map(([fluxo, marca]) => `${fluxo}/${marca}`)).toEqual(['reembolso/lescent', 'reenvio/lescent', 'reembolso/kokeshi']);
    });

    it('caso mais novo que a leitura guardada, que ela não acha: lê de novo (a linha pode ter entrado depois) e diz "está"', async () => {
        const novo = item({ idSolicitacao: 'novo', numeroPedido: 'SH3LC', criadoEm: new Date(AGORA.getTime() + 5_000).toISOString() });
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>()
            .mockResolvedValueOnce(colunasCom(...PAGINA_1))
            .mockResolvedValueOnce(colunasCom(...PAGINA_1, novo));

        await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        vi.setSystemTime(new Date(AGORA.getTime() + 10_000));
        const resultado = await comPresencaNaPlanilha([novo, ...PAGINA_1], PRAZO, deps({ lerColunasDosCasos: ler }));

        expect(ler).toHaveBeenCalledTimes(2);
        expect(resultado.map((s) => s.naPlanilha)).toEqual([true, true]);
    });

    it('caso antigo que a leitura guardada não acha: o "não está" vale, sem reler', async () => {
        const antigoSemLinha = item({ idSolicitacao: 'sem-linha', numeroPedido: 'SH4LC', criadoEm: '2026-10-20T10:00:00.000Z' });
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>(async () => colunasCom(...PAGINA_1));

        await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        vi.setSystemTime(new Date(AGORA.getTime() + 10_000));
        const resultado = await comPresencaNaPlanilha([antigoSemLinha, ...PAGINA_1], PRAZO, deps({ lerColunasDosCasos: ler }));

        expect(ler).toHaveBeenCalledTimes(1);
        expect(resultado.map((s) => s.naPlanilha)).toEqual([false, true]);
    });

    it('o que falhou não fica guardado: a próxima carga lê de novo', async () => {
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>()
            .mockRejectedValueOnce(new Error('HTTP 429 Quota exceeded'))
            .mockResolvedValueOnce(colunasCom(...PAGINA_1));

        const primeira = await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));
        const segunda = await comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler }));

        expect(primeira.map((s) => s.naPlanilha)).toEqual([null]);
        expect(segunda.map((s) => s.naPlanilha)).toEqual([true]);
        expect(ler).toHaveBeenCalledTimes(2);
    });

    it('cargas ao mesmo tempo dividem a mesma leitura', async () => {
        let soltar: (colunas: ColunasLidas) => void = () => {};
        const ler = vi.fn<PresencaDeps['lerColunasDosCasos']>(() => new Promise((resolve) => { soltar = resolve; }));

        const cargas = Promise.all([
            comPresencaNaPlanilha(PAGINA_1, PRAZO, deps({ lerColunasDosCasos: ler })),
            comPresencaNaPlanilha(PAGINA_2, PRAZO, deps({ lerColunasDosCasos: ler })),
        ]);
        await vi.waitFor(() => expect(ler).toHaveBeenCalledTimes(1));
        soltar(colunasCom(...PAGINA_1, ...PAGINA_2));
        const [primeira, segunda] = await cargas;

        expect(ler).toHaveBeenCalledTimes(1);
        expect(primeira.map((s) => s.naPlanilha)).toEqual([true]);
        expect(segunda.map((s) => s.naPlanilha)).toEqual([true]);
    });
});

describe('com o Google (falso) e a cota estourada', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        __resetCasoNaPlanilha();
        stubGoogleEnv();
    });

    it('a lista não espera a cota: desiste na primeira recusa (sem tag) e a cota fica para quem grava', async () => {
        const google = mockGoogle({
            leitura: (intervalo) => (intervalo.endsWith('!1:1')
                ? [cabecalhoDoLayout('reembolso', 'lescent')]
                : { status: 429, json: { error: { message: 'Quota exceeded for quota metric Read requests' } } }),
        });

        const resultado = await comPresencaNaPlanilha([item()], Date.now() + 15_000);

        expect(resultado.map((s) => s.naPlanilha)).toEqual([null]);
        // O cabeçalho e UMA leitura das colunas, recusada: nenhuma repetição.
        expect(google.leituras()).toHaveLength(2);
        expect(google.leituras().filter((leitura) => leitura.url.includes('values:batchGet'))).toHaveLength(1);
    });
});
