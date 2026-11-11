import { describe, it, expect, vi } from 'vitest';
import {
    casoNoRegistro,
    execucaoNaFila,
    listarSolicitacoesNoRegistro,
    type CasoAbertoNaFila,
    type ListaDeps,
    reembolsoMaisRecenteNoRegistro,
    solicitacaoRecenteNoRegistro,
    type AtualizacaoNaFila,
    type CasoNaFila,
    type EstadoDeps,
} from '@shared/lib/fila';
import type { CasoNaRaw, ReembolsoNaRaw, SolicitacaoRecente } from '@shared/lib/airflow/raw';
import type { SolicitacaoListada } from '@shared/lib/solicitacoes/types';

/**
 * O estado com a gravação em lote (ADR-012): raw + fila. O caso existe se está em qualquer uma (menos o recusado pela
 * DAG), e o status é o da atualização mais recente da fila quando há alguma.
 */

const AGORA = Date.parse('2026-11-04T15:00:00Z');

const naFila = (sobre: Partial<CasoNaFila> = {}): CasoNaFila => ({
    idSolicitacao: 'fila-1',
    tipo: 'REEMBOLSO',
    marca: 'lescent',
    numeroPedido: 'SH123',
    criadoEm: '2026-11-04T14:50:00.000Z',
    responsavel: 'Ana',
    situacao: 'pendente',
    ...sobre,
});

const atualizacao = (sobre: Partial<AtualizacaoNaFila> = {}): AtualizacaoNaFila => ({
    idAtualizacao: 'a-1',
    idSolicitacao: 'fila-1',
    atualizadoEm: '2026-11-04T14:55:00.000Z',
    campos: { status_execucao: 'Cancelado', responsavel_execucao: 'Bia' },
    situacao: 'pendente',
    ...sobre,
});

function deps(sobre: Partial<EstadoDeps> = {}): EstadoDeps {
    return {
        solicitacaoRecenteNaRaw: vi.fn(async () => null),
        reembolsoMaisRecenteNaRaw: vi.fn(async () => null),
        casoPorIdNaRaw: vi.fn(async () => null),
        casosDoPedidoNaFila: vi.fn(async () => []),
        casoNaFila: vi.fn(async () => null),
        atualizacoesNaFila: vi.fn(async () => []),
        agora: () => AGORA,
        ...sobre,
    };
}

describe('execucaoNaFila', () => {
    it('a atualização mais recente com status vence; a recusada pela DAG e a sem status não contam', () => {
        const lista = [
            atualizacao({ idAtualizacao: 'velha', atualizadoEm: '2026-11-04T14:51:00Z', campos: { status_execucao: 'Realizado', data_execucao: '04/11/2026', responsavel_execucao: 'Ana' } }),
            atualizacao({ idAtualizacao: 'recusada', atualizadoEm: '2026-11-04T14:59:00Z', situacao: 'recusado' }),
            atualizacao({ idAtualizacao: 'so-valor', atualizadoEm: '2026-11-04T14:58:00Z', campos: { valor: 10 } }),
            atualizacao({ idAtualizacao: 'outro-caso', idSolicitacao: 'x', atualizadoEm: '2026-11-04T14:59:30Z' }),
        ];
        expect(execucaoNaFila(lista, 'fila-1')).toEqual({ status: 'realizado', dataExecucao: '04/11/2026', responsavelExecucao: 'Ana' });
        expect(execucaoNaFila([], 'fila-1')).toBeNull();
    });
});

describe('solicitacaoRecenteNoRegistro (o dedup)', () => {
    const naRaw: SolicitacaoRecente = { idSolicitacao: 'raw-1', pedido: 'SH123', responsavel: 'Caio', solicitadoEm: '2026-11-04T10:00:00Z' };

    it('o caso na fila barra, mesmo antes de chegar à raw', async () => {
        await expect(solicitacaoRecenteNoRegistro('REEMBOLSO', 'lescent', 'SH123', deps({
            casosDoPedidoNaFila: vi.fn(async () => [naFila()]),
        }))).resolves.toEqual({ idSolicitacao: 'fila-1', pedido: 'SH123', responsavel: 'Ana', solicitadoEm: '2026-11-04T14:50:00.000Z' });
    });

    it('sem nada na fila, vale a raw', async () => {
        await expect(solicitacaoRecenteNoRegistro('REEMBOLSO', 'lescent', 'SH123', deps({
            solicitacaoRecenteNaRaw: vi.fn(async () => naRaw),
        }))).resolves.toEqual(naRaw);
    });

    it('fora das 24 h ou recusado pela DAG não barra', async () => {
        await expect(solicitacaoRecenteNoRegistro('REEMBOLSO', 'lescent', 'SH123', deps({
            casosDoPedidoNaFila: vi.fn(async () => [
                naFila({ criadoEm: '2026-11-03T14:00:00Z' }),
                naFila({ idSolicitacao: 'fila-2', situacao: 'recusado' }),
            ]),
        }))).resolves.toBeNull();
    });

    it('um cancelamento ainda na fila libera o pedido, na fila e na raw', async () => {
        await expect(solicitacaoRecenteNoRegistro('REEMBOLSO', 'lescent', 'SH123', deps({
            casosDoPedidoNaFila: vi.fn(async () => [naFila()]),
            solicitacaoRecenteNaRaw: vi.fn(async () => naRaw),
            atualizacoesNaFila: vi.fn(async () => [atualizacao(), atualizacao({ idAtualizacao: 'a-2', idSolicitacao: 'raw-1' })]),
        }))).resolves.toBeNull();
    });

    it('erro da fila sobe (o dedup recusa a solicitação)', async () => {
        await expect(solicitacaoRecenteNoRegistro('REEMBOLSO', 'lescent', 'SH123', deps({
            casosDoPedidoNaFila: vi.fn(async () => { throw new Error('fila fora'); }),
        }))).rejects.toThrow('fila fora');
    });
});

describe('reembolsoMaisRecenteNoRegistro', () => {
    const naRaw: ReembolsoNaRaw = { idSolicitacao: 'raw-1', numeroPedido: 'SH123', status: 'aberto', criadoEm: new Date('2026-11-01T10:00:00Z') };

    it('o da fila é mais novo que o da raw: vale o da fila, ainda sem status', async () => {
        await expect(reembolsoMaisRecenteNoRegistro('lescent', 'SH123', deps({
            casosDoPedidoNaFila: vi.fn(async () => [naFila()]),
            reembolsoMaisRecenteNaRaw: vi.fn(async () => naRaw),
        }))).resolves.toEqual({
            idSolicitacao: 'fila-1', numeroPedido: 'SH123', status: 'aberto', criadoEm: new Date('2026-11-04T14:50:00.000Z'),
        });
    });

    it('o mesmo caso na fila e na raw leva o status da raw, e a atualização da fila por cima', async () => {
        const mesmo = { ...naRaw, idSolicitacao: 'fila-1', status: 'pendente', criadoEm: new Date('2026-11-04T14:50:00.000Z') };
        const d = deps({
            casosDoPedidoNaFila: vi.fn(async () => [naFila({ situacao: 'gravado' })]),
            reembolsoMaisRecenteNaRaw: vi.fn(async () => mesmo),
        });
        await expect(reembolsoMaisRecenteNoRegistro('lescent', 'SH123', d)).resolves.toMatchObject({ idSolicitacao: 'fila-1', status: 'pendente' });

        d.atualizacoesNaFila = vi.fn(async () => [atualizacao()]);
        await expect(reembolsoMaisRecenteNoRegistro('lescent', 'SH123', d)).resolves.toMatchObject({ status: 'cancelado' });
    });

    it('só na raw: o status da raw, com o da fila por cima', async () => {
        await expect(reembolsoMaisRecenteNoRegistro('lescent', 'SH123', deps({
            reembolsoMaisRecenteNaRaw: vi.fn(async () => naRaw),
            atualizacoesNaFila: vi.fn(async () => [atualizacao({ idSolicitacao: 'raw-1', campos: { status_execucao: 'Realizado' } })]),
        }))).resolves.toMatchObject({ idSolicitacao: 'raw-1', status: 'realizado' });
    });

    it('nada em nenhum dos dois, ou só o recusado pela DAG: null', async () => {
        await expect(reembolsoMaisRecenteNoRegistro('lescent', 'SH123', deps({
            casosDoPedidoNaFila: vi.fn(async () => [naFila({ situacao: 'recusado' })]),
        }))).resolves.toBeNull();
    });
});

describe('casoNoRegistro', () => {
    const naRaw: CasoNaRaw = {
        idSolicitacao: 'raw-1', tipo: 'REEMBOLSO', marca: 'lescent', numeroPedido: 'SH123',
        criadoEm: new Date('2026-11-01T10:00:00Z'), status: 'aberto', dataExecucao: null, responsavelExecucao: null,
    };

    it('na raw: com a execução da fila por cima', async () => {
        await expect(casoNoRegistro('raw-1', deps({
            casoPorIdNaRaw: vi.fn(async () => naRaw),
            atualizacoesNaFila: vi.fn(async () => [atualizacao({
                idSolicitacao: 'raw-1', campos: { status_execucao: 'Realizado', data_execucao: '04/11/2026', responsavel_execucao: 'Ana' },
            })]),
        }))).resolves.toEqual({ ...naRaw, status: 'realizado', dataExecucao: '04/11/2026', responsavelExecucao: 'Ana' });
    });

    it('só na fila: o caso com status aberto', async () => {
        await expect(casoNoRegistro('fila-1', deps({ casoNaFila: vi.fn(async () => naFila()) }))).resolves.toEqual({
            idSolicitacao: 'fila-1', tipo: 'REEMBOLSO', marca: 'lescent', numeroPedido: 'SH123',
            criadoEm: new Date('2026-11-04T14:50:00.000Z'), status: 'aberto', dataExecucao: null, responsavelExecucao: null,
        });
    });

    it('recusado pela DAG ou em lugar nenhum: null', async () => {
        await expect(casoNoRegistro('fila-1', deps({ casoNaFila: vi.fn(async () => naFila({ situacao: 'recusado' })) }))).resolves.toBeNull();
        await expect(casoNoRegistro('nada', deps())).resolves.toBeNull();
    });
});

describe('listarSolicitacoesNoRegistro (a lista: raw + fila, paginada)', () => {
    const linha = (sobre: Partial<SolicitacaoListada> = {}): SolicitacaoListada => ({
        idSolicitacao: 'raw-1', tipo: 'REEMBOLSO', marca: 'lescent', numeroPedido: 'SH123', dataSolicitacao: '2026-11-04T09:00:00',
        valor: 10, motivo: 'Avaria', statusExecucao: null, responsavel: 'Ana', maisRecenteDoPedido: false,
        criadoEm: '2026-11-04T12:00:00.000Z', naPlanilha: null, situacaoNaFila: null, ...sobre,
    });
    /** Como o SQL devolve a linha que veio da fila: só id, marca, pedido, data e o mais recente. */
    const linhaDaFilaNoSql = (sobre: Partial<SolicitacaoListada> = {}): SolicitacaoListada => linha({
        idSolicitacao: 'fila-1', dataSolicitacao: '2026-11-04T11:50:00', valor: null, motivo: null, responsavel: null,
        maisRecenteDoPedido: true, criadoEm: '2026-11-04T14:50:00.000Z', ...sobre,
    });
    const aberto = (sobre: Partial<CasoAbertoNaFila> = {}): CasoAbertoNaFila => ({ ...naFila(), valor: 59.9, motivo: 'Extravio', ...sobre });
    const lista = (sobre: Partial<ListaDeps> = {}): ListaDeps => ({
        listarPaginaDaRaw: vi.fn(async () => ({ total: 1, linhas: [{ daFila: false, solicitacao: linha() }] })),
        casosAbertosNaFila: vi.fn(async () => []),
        atualizacoesNaFila: vi.fn(async () => []),
        agora: () => AGORA,
        ...sobre,
    });

    it('passa os casos da fila, a página e o agora para o SQL, e devolve a paginação da lista inteira', async () => {
        const d = lista({
            casosAbertosNaFila: vi.fn(async () => [aberto()]),
            listarPaginaDaRaw: vi.fn(async () => ({ total: 41, linhas: [{ daFila: false, solicitacao: linha() }] })),
        });

        const resultado = await listarSolicitacoesNoRegistro({ tipo: 'REEMBOLSO', marca: 'lescent' }, 3, d);

        expect(d.casosAbertosNaFila).toHaveBeenCalledWith({ tipo: 'REEMBOLSO', marca: 'lescent', pedido: undefined });
        expect(d.listarPaginaDaRaw).toHaveBeenCalledWith({ tipo: 'REEMBOLSO', marca: 'lescent' }, { pagina: 3, daFila: [aberto()], agora: AGORA });
        expect(resultado.paginacao).toEqual({ pagina: 3, porPagina: 20, total: 41, totalPaginas: 3 });
    });

    it('a linha da fila leva valor, motivo, responsável e a situação da fila; a ordem e o mais recente são do SQL', async () => {
        const d = lista({
            casosAbertosNaFila: vi.fn(async () => [aberto()]),
            listarPaginaDaRaw: vi.fn(async () => ({
                total: 2,
                linhas: [{ daFila: true, solicitacao: linhaDaFilaNoSql() }, { daFila: false, solicitacao: linha() }],
            })),
        });

        const { solicitacoes } = await listarSolicitacoesNoRegistro({ tipo: 'REEMBOLSO' }, 1, d);

        expect(solicitacoes.map((s) => [s.idSolicitacao, s.situacaoNaFila, s.maisRecenteDoPedido])).toEqual([
            ['fila-1', 'pendente', true],
            ['raw-1', null, false],
        ]);
        expect(solicitacoes[0]).toMatchObject({ dataSolicitacao: '2026-11-04T11:50:00', valor: 59.9, motivo: 'Extravio', responsavel: 'Ana' });
    });

    it('o gravado que a réplica ainda não trouxe vai sem situação (já está no Metabase)', async () => {
        const d = lista({
            casosAbertosNaFila: vi.fn(async () => [aberto({ situacao: 'gravado' })]),
            listarPaginaDaRaw: vi.fn(async () => ({ total: 1, linhas: [{ daFila: true, solicitacao: linhaDaFilaNoSql() }] })),
        });
        const { solicitacoes } = await listarSolicitacoesNoRegistro({ tipo: 'REEMBOLSO' }, 1, d);
        expect(solicitacoes.map((s) => [s.idSolicitacao, s.situacaoNaFila])).toEqual([['fila-1', null]]);
    });

    it('caso da fila de marca desconhecida nem vai ao SQL', async () => {
        const d = lista({ casosAbertosNaFila: vi.fn(async () => [aberto({ idSolicitacao: 'x', marca: 'gocase' }), aberto()]) });
        await listarSolicitacoesNoRegistro({ tipo: 'REEMBOLSO' }, 1, d);
        expect(vi.mocked(d.listarPaginaDaRaw).mock.calls[0][1].daFila.map((c) => c.idSolicitacao)).toEqual(['fila-1']);
    });

    it('a atualização ainda na fila vai por cima do status da raw, perguntada só pelos ids da página', async () => {
        const d = lista({ atualizacoesNaFila: vi.fn(async () => [atualizacao({ idSolicitacao: 'raw-1' })]) });
        const { solicitacoes: [resultado] } = await listarSolicitacoesNoRegistro({ tipo: 'REEMBOLSO' }, 1, d);
        expect(resultado.statusExecucao).toBe('Cancelado');
        expect(d.atualizacoesNaFila).toHaveBeenCalledWith(['raw-1']);
    });

    it('lista vazia: uma página, vazia, e nada a perguntar à fila das atualizações', async () => {
        const d = lista({ listarPaginaDaRaw: vi.fn(async () => ({ total: 0, linhas: [] })) });
        await expect(listarSolicitacoesNoRegistro({ tipo: 'REEMBOLSO' }, 1, d)).resolves.toEqual({
            solicitacoes: [], paginacao: { pagina: 1, porPagina: 20, total: 0, totalPaginas: 1 },
        });
    });

    it('a fila fora do ar não derruba a lista: sai só a raw', async () => {
        const d = lista({
            casosAbertosNaFila: vi.fn(async () => { throw new Error('fila fora'); }),
            atualizacoesNaFila: vi.fn(async () => { throw new Error('fila fora'); }),
        });
        const resultado = await listarSolicitacoesNoRegistro({ tipo: 'REEMBOLSO' }, 1, d);
        expect(resultado.solicitacoes).toEqual([linha()]);
        expect(vi.mocked(d.listarPaginaDaRaw).mock.calls[0][1].daFila).toEqual([]);
    });

    it('erro da raw sobe', async () => {
        const d = lista({ listarPaginaDaRaw: vi.fn(async () => { throw new Error('metabase fora'); }) });
        await expect(listarSolicitacoesNoRegistro({ tipo: 'REEMBOLSO' }, 1, d)).rejects.toThrow('metabase fora');
    });
});
