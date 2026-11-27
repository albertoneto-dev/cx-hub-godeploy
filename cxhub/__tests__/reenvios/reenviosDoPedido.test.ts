import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    LIMITE_DO_HISTORICO,
    mensagemDosReenvios,
    reenviosDoPedido,
    sqlDoHistoricoDeReenvios,
    type DepsDosReenviosDoPedido,
} from '@modules/reenvios/actions/reenviosDoPedido';
import { MetabaseError } from '@shared/lib/metabase/index';
import type { SolicitacaoListada } from '@shared/lib/solicitacoes/types';

/**
 * Os reenvios do pedido (`GET /api/reenvio/existente`): o bloqueio é o mesmo do dedup do POST, o registro do CX Hub e o
 * histórico da gold vêm juntos, e só o histórico pode faltar. Pedidos e nomes fictícios.
 */

function doRegistro(extra: Partial<SolicitacaoListada> = {}): SolicitacaoListada {
    return {
        idSolicitacao: 'caso-1',
        tipo: 'REENVIO',
        marca: 'apice',
        numeroPedido: 'SH1607929AP',
        dataSolicitacao: '2026-11-20T10:00:00',
        criadoEm: '2026-11-20T13:00:00.000Z',
        naPlanilha: null,
        situacaoNaFila: null,
        valor: null,
        motivo: 'Extravio',
        statusExecucao: null,
        responsavel: 'Ana',
        maisRecenteDoPedido: true,
        ...extra,
    };
}

function pagina(solicitacoes: SolicitacaoListada[], numero = 1, totalPaginas = 1) {
    return { solicitacoes, paginacao: { pagina: numero, porPagina: 20, total: solicitacoes.length, totalPaginas } };
}

function deps(extra: Partial<DepsDosReenviosDoPedido> = {}) {
    const d: DepsDosReenviosDoPedido = {
        solicitacaoRecente: vi.fn(async () => null),
        listarRegistro: vi.fn(async () => pagina([])),
        consultar: vi.fn(async () => [] as unknown[][]),
        ...extra,
    };
    return d;
}

beforeEach(() => {
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('reenviosDoPedido', () => {
    it('junta o registro e o histórico, o mais recente primeiro, e o bloqueio vem do dedup', async () => {
        const d = deps({
            solicitacaoRecente: vi.fn(async () => ({
                idSolicitacao: 'caso-2', pedido: 'SH1607929AP', responsavel: 'Bia', solicitadoEm: '2026-11-24T13:02:00Z',
            })),
            listarRegistro: vi.fn(async () => pagina([
                doRegistro({ idSolicitacao: 'caso-2', dataSolicitacao: '2026-11-24T10:02:00', situacaoNaFila: 'pendente', responsavel: 'Bia' }),
                doRegistro({ idSolicitacao: 'caso-1', statusExecucao: 'Cancelado' }),
            ])),
            consultar: vi.fn(async () => [
                ['fonte_historico_reenvio|99', '1607929', '2026-03-02T09:15:00', 'Avaria', 'Realizado', 'Carla'],
            ]),
        });

        const r = await reenviosDoPedido('apice', 'SH1607929AP', d);

        expect(r.bloqueiaNovo).toBe(true);
        expect(r.bloqueadoPor).toEqual({ idSolicitacao: 'caso-2', responsavel: 'Bia', solicitadoEm: '2026-11-24T13:02:00Z' });
        expect(r.historicoLido).toBe(true);
        expect(r.reenvios.map((x) => [x.fonte, x.id, x.situacaoNaFila])).toEqual([
            ['cxhub', 'caso-2', 'pendente'],
            ['cxhub', 'caso-1', null],
            ['historico', 'fonte_historico_reenvio|99', null],
        ]);
        expect(r.reenvios[2]).toEqual({
            fonte: 'historico', id: 'fonte_historico_reenvio|99', numeroPedido: '1607929', dataSolicitacao: '2026-03-02T09:15:00',
            motivo: 'Avaria', statusExecucao: 'Realizado', responsavel: 'Carla', situacaoNaFila: null,
        });
        expect(d.solicitacaoRecente).toHaveBeenCalledWith('apice', 'SH1607929AP');
        expect(d.listarRegistro).toHaveBeenCalledWith({ tipo: 'REENVIO', marca: 'apice', pedido: 'SH1607929AP' }, 1);
    });

    it('o caso que a DAG recusou fica de fora, como no dedup: ele nunca virou reenvio', async () => {
        const d = deps({
            listarRegistro: vi.fn(async () => pagina([
                doRegistro({ idSolicitacao: 'recusado', situacaoNaFila: 'recusado' }),
                doRegistro({ idSolicitacao: 'no-lote', situacaoNaFila: 'enviado' }),
            ])),
        });

        const r = await reenviosDoPedido('apice', '1607929', d);

        expect(r.reenvios.map((x) => [x.id, x.situacaoNaFila])).toEqual([['no-lote', 'enviado']]);
        expect(r.bloqueiaNovo).toBe(false);
        expect(r.bloqueadoPor).toBeNull();
    });

    it('lê as páginas seguintes do registro até a última, e no máximo 5', async () => {
        const listar = vi.fn(async (_filtro: unknown, numero?: number) =>
            pagina([doRegistro({ idSolicitacao: `p${numero}` })], numero, 9));
        const r = await reenviosDoPedido('lescent', 'SH716185LC', deps({ listarRegistro: listar }));

        expect(listar.mock.calls.map(([, numero]) => numero)).toEqual([1, 2, 3, 4, 5]);
        expect(r.reenvios).toHaveLength(5);
    });

    it('a gold que não responde não derruba a resposta: historicoLido false e só o registro', async () => {
        const d = deps({
            listarRegistro: vi.fn(async () => pagina([doRegistro()])),
            consultar: vi.fn(async () => { throw new MetabaseError(0, 'timeout'); }),
        });

        const r = await reenviosDoPedido('apice', '1607929', d);

        expect(r.historicoLido).toBe(false);
        expect(r.reenvios.map((x) => x.id)).toEqual(['caso-1']);
        expect(mensagemDosReenvios(r)).toContain('O histórico de antes do CX Hub (a gold) não respondeu');
    });

    it('o bloqueio ou o registro que falham sobem: sem eles a resposta não diz o que promete', async () => {
        const erro = new MetabaseError(500, 'falhou');
        await expect(reenviosDoPedido('apice', '1607929', deps({ solicitacaoRecente: vi.fn(async () => { throw erro; }) })))
            .rejects.toBe(erro);
        await expect(reenviosDoPedido('apice', '1607929', deps({ listarRegistro: vi.fn(async () => { throw erro; }) })))
            .rejects.toBe(erro);
    });

    it('linha do histórico sem chave ou sem data fica de fora', async () => {
        const d = deps({
            consultar: vi.fn(async () => [
                [null, '1607929', '2026-03-02T09:15:00', null, null, null],
                ['fonte_x|1', '1607929', null, null, null, null],
                ['fonte_x|2', '1607929', '2026-03-01T08:00:00', ' ', '', null],
            ]),
        });

        const r = await reenviosDoPedido('apice', '1607929', d);

        expect(r.reenvios).toEqual([expect.objectContaining({ id: 'fonte_x|2', motivo: null, statusExecucao: null, responsavel: null })]);
    });
});

describe('sqlDoHistoricoDeReenvios', () => {
    it('procura pela sigla da marca e pelos dígitos do pedido, só fora do CX Hub, com limite', () => {
        const sql = sqlDoHistoricoDeReenvios('denavita', '#SH1607929DN');

        expect(sql).toContain('from gold.fct_reenvio_reembolso_gobeaute');
        expect(sql).toContain("tipo = 'REENVIO'");
        // A Denavita é DV na base, embora o sufixo do pedido seja DN.
        expect(sql).toContain("sigla = 'DV'");
        expect(sql).toContain("chave_unica not like 'cxhub|%'");
        expect(sql).toContain("(regexp_replace(coalesce(numero_pedido, ''), '[^0-9]', '', 'g') = '1607929' and not (coalesce(numero_pedido, '') ~* 'GC[0-9]'))");
        expect(sql).toContain(`limit ${LIMITE_DO_HISTORICO}`);
        // Sem `?`: o JDBC do Metabase o leria como parâmetro.
        expect(sql).not.toContain('?');
    });
});

describe('mensagemDosReenvios', () => {
    const base = { bloqueiaNovo: false, bloqueadoPor: null, reenvios: [], historicoLido: true };

    it('sem nenhum reenvio', () => {
        expect(mensagemDosReenvios(base)).toBe('Nenhum reenvio registrado para o pedido.');
    });

    it('com reenvios que não barram um novo', () => {
        const reenvios = [{
            fonte: 'historico' as const, id: 'x', numeroPedido: '1', dataSolicitacao: '2026-03-01T08:00:00',
            motivo: null, statusExecucao: 'Realizado', responsavel: null, situacaoNaFila: null,
        }];
        expect(mensagemDosReenvios({ ...base, reenvios })).toBe(
            'O pedido tem 1 reenvio registrado, e nenhum barra um novo: só barra o reenvio das últimas 24 h que não foi cancelado.');
    });

    it('com o bloqueio: quem e quando, em hora de São Paulo; sem responsável, só quando', () => {
        const bloqueadoPor = { idSolicitacao: 'caso-2', responsavel: 'Bia', solicitadoEm: '2026-11-24T13:02:00Z' };
        expect(mensagemDosReenvios({ ...base, bloqueiaNovo: true, bloqueadoPor })).toBe(
            'Um reenvio novo seria barrado: já existe um reenvio para o pedido feito por Bia em 24/11/2026 10:02:00.');
        expect(mensagemDosReenvios({ ...base, bloqueiaNovo: true, bloqueadoPor: { ...bloqueadoPor, responsavel: null } })).toBe(
            'Um reenvio novo seria barrado: já existe um reenvio para o pedido em 24/11/2026 10:02:00.');
    });
});
