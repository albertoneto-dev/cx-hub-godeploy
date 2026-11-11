import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    MAX_IDS_POR_CONSULTA,
    PAGINA_UNICA,
    VALIDADE_DA_ENVIADA_MS,
    acompanharEnviadas,
    atualizarSolicitacoesEnviadas,
    comoSolicitacaoListada,
    enviadasDaLista,
    enviadasDaPagina,
    esquecerSolicitacoesEnviadas,
    paginaNaTela,
    estadoDoEnvio,
    guardarSolicitacaoEnviada,
    haRegistroEmAndamento,
    lerSolicitacoesEnviadas,
} from '@shared/lib/registro';
import type { EstadoDoRegistro, RegistroResponse, RespostaDoRegistro, SolicitacaoEnviada } from '@shared/lib/registro';

/**
 * As solicitações que o navegador enviou (ADR-011 e ADR-012): guardadas até a raw trazê-las, mostradas na lista com a
 * tag de status e acompanhadas pelo `idSolicitacao` — gravado na raw, aguardando na fila ou recusado pela DAG.
 */

const CHAVE = 'cxhub_solicitacoes_enviadas';
const AGORA = Date.parse('2026-11-03T15:00:00.000Z');
const TOKEN = 'token-do-login';

function armazenamentoFalso(): Storage {
    const dados = new Map<string, string>();
    return {
        getItem: (chave: string) => dados.get(chave) ?? null,
        setItem: (chave: string, valor: string) => { dados.set(chave, String(valor)); },
        removeItem: (chave: string) => { dados.delete(chave); },
        clear: () => dados.clear(),
        key: (i: number) => [...dados.keys()][i] ?? null,
        get length() { return dados.size; },
    };
}

function enviada(id: string, extra: Partial<SolicitacaoEnviada> = {}): SolicitacaoEnviada {
    return {
        idSolicitacao: id,
        tipo: 'REEMBOLSO',
        marca: 'barbours',
        numeroPedido: 'SH2771692BB',
        enviadaEm: new Date(AGORA - 60_000).toISOString(),
        valor: 279.3,
        motivo: 'Cancelamento - Para realizar nova compra',
        responsavel: 'Ana Exemplo',
        estado: 'em_andamento',
        ...extra,
    };
}

function resposta(status: number, body: RegistroResponse): RespostaDoRegistro {
    return { status, body };
}

const estados = (porId: Record<string, EstadoDoRegistro>) => resposta(200, { code: 'SUCCESS', message: '', estados: porId });

describe('o armazenamento das enviadas', () => {
    beforeEach(() => vi.stubGlobal('localStorage', armazenamentoFalso()));
    afterEach(() => vi.unstubAllGlobals());

    it('guarda e lê por tipo, mais recentes primeiro', () => {
        guardarSolicitacaoEnviada(enviada('a', { enviadaEm: new Date(AGORA - 300_000).toISOString() }));
        guardarSolicitacaoEnviada(enviada('b', { enviadaEm: new Date(AGORA - 60_000).toISOString() }));
        guardarSolicitacaoEnviada(enviada('c', { tipo: 'REENVIO' }));

        expect(lerSolicitacoesEnviadas('REEMBOLSO', AGORA).map((e) => e.idSolicitacao)).toEqual(['b', 'a']);
        expect(lerSolicitacoesEnviadas('REENVIO', AGORA).map((e) => e.idSolicitacao)).toEqual(['c']);
    });

    it('a mesma solicitação guardada de novo substitui a anterior', () => {
        guardarSolicitacaoEnviada(enviada('a'));
        guardarSolicitacaoEnviada(enviada('a', { estado: 'sucesso' }));

        expect(lerSolicitacoesEnviadas('REEMBOLSO', AGORA)).toEqual([enviada('a', { estado: 'sucesso' })]);
    });

    it('a vencida (mais de 24 h) some na leitura e sai do armazenamento', () => {
        guardarSolicitacaoEnviada(enviada('velha', { enviadaEm: new Date(AGORA - VALIDADE_DA_ENVIADA_MS).toISOString() }));
        guardarSolicitacaoEnviada(enviada('nova'));

        expect(lerSolicitacoesEnviadas('REEMBOLSO', AGORA).map((e) => e.idSolicitacao)).toEqual(['nova']);
        expect(JSON.parse(localStorage.getItem(CHAVE) ?? '[]')).toHaveLength(1);
    });

    it('atualiza só as que mudaram e esquece as que a raw trouxe', () => {
        guardarSolicitacaoEnviada(enviada('a'));
        guardarSolicitacaoEnviada(enviada('b'));

        atualizarSolicitacoesEnviadas([enviada('a', { estado: 'falhou' })]);
        expect(lerSolicitacoesEnviadas('REEMBOLSO', AGORA).find((e) => e.idSolicitacao === 'a')?.estado).toBe('falhou');

        esquecerSolicitacoesEnviadas(['b']);
        expect(lerSolicitacoesEnviadas('REEMBOLSO', AGORA).map((e) => e.idSolicitacao)).toEqual(['a']);
    });

    it('conteúdo ilegível no armazenamento vale lista vazia, sem lançar', () => {
        localStorage.setItem(CHAVE, '{não é json');
        expect(lerSolicitacoesEnviadas('REEMBOLSO', AGORA)).toEqual([]);
    });

    it('sem localStorage (aba anônima, bloqueado) tudo segue sem lançar', () => {
        vi.stubGlobal('localStorage', undefined);

        expect(() => guardarSolicitacaoEnviada(enviada('a'))).not.toThrow();
        expect(lerSolicitacoesEnviadas('REEMBOLSO', AGORA)).toEqual([]);
    });

    it('armazenamento cheio não derruba o envio: só a tag deixa de aparecer', () => {
        const cheio = armazenamentoFalso();
        cheio.setItem = () => { throw new DOMException('QuotaExceededError'); };
        vi.stubGlobal('localStorage', cheio);

        expect(() => guardarSolicitacaoEnviada(enviada('a'))).not.toThrow();
    });
});

describe('o que a lista mostra', () => {
    it('enviadasDaLista segue o filtro da busca (tipo, marca, dígitos do pedido) e tira as que a raw já tem', () => {
        const enviadas = [
            enviada('na-raw'),
            enviada('outra-marca', { marca: 'lescent' }),
            enviada('outro-pedido', { numeroPedido: 'SH1111111BB' }),
            enviada('reenvio', { tipo: 'REENVIO' }),
            enviada('fica'),
        ];

        const lista = enviadasDaLista(enviadas, { tipo: 'REEMBOLSO', marca: 'barbours', pedido: '#2771692' }, new Set(['na-raw']));

        expect(lista.map((e) => e.idSolicitacao)).toEqual(['fica']);
        expect(enviadasDaLista(enviadas, { tipo: 'REEMBOLSO' }, new Set()).map((e) => e.idSolicitacao))
            .toEqual(['na-raw', 'outra-marca', 'outro-pedido', 'fica']);
    });

    describe('enviadasDaPagina (a lista paginada)', () => {
        /** Uma linha da página, só com o que a regra olha. */
        const linha = (id: string, dataSolicitacao: string) =>
            ({ ...comoSolicitacaoListada(enviada(id)), dataSolicitacao, criadoEm: '2026-11-03T00:00:00.000Z' });
        // AGORA - 1 min = 2026-11-03 11:59 em São Paulo.
        const novas = [enviada('nova'), enviada('antiga', { enviadaEm: '2026-11-03T05:00:00.000Z' })];

        it('primeira página com mais páginas depois: só as enviadas mais novas que a última linha dela', () => {
            const pagina = [linha('r1', '2026-11-03T11:00:00'), linha('r2', '2026-11-03T08:00:00')];
            // A "antiga" (02:00 em SP) é mais velha que a r2: se o registro a tem, ela está numa página seguinte.
            expect(enviadasDaPagina(novas, { tipo: 'REEMBOLSO' }, pagina, { numero: 1, ultima: false }).map((e) => e.idSolicitacao))
                .toEqual(['nova']);
        });

        it('primeira página que também é a última: todas as que a página não traz', () => {
            const pagina = [linha('r1', '2026-11-03T11:00:00'), linha('nova', '2026-11-03T08:00:00')];
            expect(enviadasDaPagina(novas, { tipo: 'REEMBOLSO' }, pagina, PAGINA_UNICA).map((e) => e.idSolicitacao))
                .toEqual(['antiga']);
        });

        it('as outras páginas nunca acrescentam enviadas', () => {
            expect(enviadasDaPagina(novas, { tipo: 'REEMBOLSO' }, [], { numero: 2, ultima: true })).toEqual([]);
        });

        it('segue o filtro da busca, como enviadasDaLista', () => {
            expect(enviadasDaPagina(novas, { tipo: 'REEMBOLSO', marca: 'lescent' }, [], PAGINA_UNICA)).toEqual([]);
        });

        it('paginaNaTela: a última é a que alcança o total de páginas', () => {
            expect(paginaNaTela({ pagina: 1, porPagina: 20, total: 41, totalPaginas: 3 })).toEqual({ numero: 1, ultima: false });
            expect(paginaNaTela({ pagina: 3, porPagina: 20, total: 41, totalPaginas: 3 })).toEqual({ numero: 3, ultima: true });
            // Além da última (a lista encolheu): também é "a última".
            expect(paginaNaTela({ pagina: 5, porPagina: 20, total: 41, totalPaginas: 3 })).toEqual({ numero: 5, ultima: true });
        });
    });

    it('comoSolicitacaoListada põe a data em hora de São Paulo, sem fuso, como a lista', () => {
        const linha = comoSolicitacaoListada(enviada('a', { enviadaEm: '2026-11-03T12:15:01.000Z' }));

        expect(linha).toEqual({
            idSolicitacao: 'a',
            tipo: 'REEMBOLSO',
            marca: 'barbours',
            numeroPedido: 'SH2771692BB',
            dataSolicitacao: '2026-11-03T09:15:01',
            valor: 279.3,
            motivo: 'Cancelamento - Para realizar nova compra',
            statusExecucao: null,
            responsavel: 'Ana Exemplo',
            maisRecenteDoPedido: false,
            // A enviada sabe pelo envio que a planilha gravou; o carimbo não é preciso (não se lê a planilha por ela).
            criadoEm: null,
            naPlanilha: true,
            situacaoNaFila: null,
        });
    });

    it('comoSolicitacaoListada: a planilha que falhou no envio vai como naPlanilha false', () => {
        expect(comoSolicitacaoListada(enviada('a', { semPlanilha: true })).naPlanilha).toBe(false);
    });

    it('estadoDoEnvio: gravado é "Gravado no Metabase", recusado é "Não gravado", aguardando segue aguardando', () => {
        expect(estadoDoEnvio('gravado')).toBe('sucesso');
        expect(estadoDoEnvio('recusado')).toBe('falhou');
        expect(estadoDoEnvio('aguardando')).toBe('em_andamento');
    });
});

describe('o acompanhamento', () => {
    it('haRegistroEmAndamento olha a solicitação, o cancelamento pedido junto e o que já foi deixado de lado', () => {
        const terminada = enviada('a', { estado: 'sucesso' });
        const comCancelamento = enviada('b', { estado: 'sucesso', cancelamento: { idSolicitacao: 'c', estado: 'em_andamento' } });

        expect(haRegistroEmAndamento([terminada], new Set())).toBe(false);
        expect(haRegistroEmAndamento([enviada('a')], new Set())).toBe(true);
        expect(haRegistroEmAndamento([comCancelamento], new Set())).toBe(true);
        expect(haRegistroEmAndamento([comCancelamento], new Set(['c']))).toBe(false);
        expect(haRegistroEmAndamento([enviada('a', { cancelamento: { estado: 'falhou' } })], new Set(['a']))).toBe(false);
    });

    it('pergunta numa consulta só, com os ids e o token, e troca o estado pelo do Metabase', async () => {
        const consultar = vi.fn(async () => estados({ a: 'gravado', b: 'recusado', c: 'aguardando' }));

        const rodada = await acompanharEnviadas([enviada('a'), enviada('b'), enviada('c')], TOKEN, new Set(), consultar);

        expect(consultar).toHaveBeenCalledTimes(1);
        expect(consultar).toHaveBeenCalledWith(['a', 'b', 'c'], TOKEN);
        expect(rodada.enviadas.map((e) => e.estado)).toEqual(['sucesso', 'falhou', 'em_andamento']);
        expect(rodada.semAcompanhamento).toEqual([]);
    });

    it('nada mudou ⇒ a mesma lista (referência), para não regravar à toa', async () => {
        const enviadas = [enviada('a')];
        const rodada = await acompanharEnviadas(enviadas, TOKEN, new Set(), vi.fn(async () => estados({ a: 'aguardando' })));

        expect(rodada.enviadas).toBe(enviadas);
    });

    it('id que a resposta não traz fica como estava', async () => {
        const rodada = await acompanharEnviadas([enviada('a'), enviada('b')], TOKEN, new Set(), vi.fn(async () => estados({ a: 'gravado' })));

        expect(rodada.enviadas.map((e) => e.estado)).toEqual(['sucesso', 'em_andamento']);
    });

    it('acompanha também o cancelamento pedido junto, e não pergunta o que já terminou', async () => {
        const consultar = vi.fn(async () => estados({ c: 'gravado' }));
        const comCancelamento = enviada('a', { estado: 'sucesso', cancelamento: { idSolicitacao: 'c', estado: 'em_andamento' } });

        const rodada = await acompanharEnviadas([comCancelamento], TOKEN, new Set(), consultar);

        expect(consultar).toHaveBeenCalledWith(['c'], TOKEN);
        expect(rodada.enviadas[0].cancelamento).toEqual({ idSolicitacao: 'c', estado: 'sucesso' });
        expect(rodada.enviadas[0].estado).toBe('sucesso');
    });

    it(`pergunta no máximo ${MAX_IDS_POR_CONSULTA} ids por vez, sem repetir`, async () => {
        const consultar = vi.fn(async () => estados({}));
        const muitas = Array.from({ length: MAX_IDS_POR_CONSULTA + 5 }, (_, i) => enviada(`id-${i}`));

        await acompanharEnviadas([...muitas, enviada('id-0')], TOKEN, new Set(), consultar);

        const [ids] = consultar.mock.calls[0] as unknown as [string[], string];
        expect(ids).toHaveLength(MAX_IDS_POR_CONSULTA);
        expect(new Set(ids).size).toBe(MAX_IDS_POR_CONSULTA);
    });

    it.each([400, 401, 403])('HTTP %i ⇒ os ids param de ser perguntados nesta sessão, com o estado como estava', async (status) => {
        const rodada = await acompanharEnviadas(
            [enviada('a'), enviada('b')], TOKEN, new Set(), vi.fn(async () => resposta(status, { code: 'UNAUTHORIZED', message: '' })),
        );

        expect(rodada.semAcompanhamento).toEqual(['a', 'b']);
        expect(rodada.enviadas.map((e) => e.estado)).toEqual(['em_andamento', 'em_andamento']);
    });

    it.each([
        ['rede', resposta(0, { code: 'UNKNOWN_ERROR', message: 'Falha de rede ao chamar o CX Hub.' })],
        ['5xx', resposta(502, { code: 'UNKNOWN_ERROR', message: 'Não foi possível ler o registro no Metabase.' })],
    ])('%s ⇒ estado como estava, e a próxima rodada tenta de novo', async (_, falha) => {
        const enviadas = [enviada('a'), enviada('b')];
        const rodada = await acompanharEnviadas(enviadas, TOKEN, new Set(), vi.fn(async () => falha));

        expect(rodada.enviadas).toBe(enviadas);
        expect(rodada.semAcompanhamento).toEqual([]);
    });

    it('o id deixado de lado não é perguntado, e sem nada a perguntar não há consulta', async () => {
        const consultar = vi.fn(async () => estados({ a: 'gravado' }));

        const rodada = await acompanharEnviadas([enviada('a')], TOKEN, new Set(['a']), consultar);

        expect(consultar).not.toHaveBeenCalled();
        expect(rodada.semAcompanhamento).toEqual([]);
    });
});
