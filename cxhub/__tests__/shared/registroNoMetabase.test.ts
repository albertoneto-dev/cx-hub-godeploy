import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A conferência do token no Cosmos tem testes próprios: aqui só importa o que a resposta faz com cada desfecho.
vi.mock('@shared/lib/cosmos/http', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/cosmos/http')>()),
    conferirTokenNoCosmos: vi.fn(),
}));

import { conferirTokenNoCosmos } from '@shared/lib/cosmos/http';
import {
    MAX_IDS_DO_REGISTRO,
    estadosNoRegistro,
    responderRegistro,
    sqlDosCasosNaRaw,
    type EstadosDeps,
} from '@shared/lib/airflow/registro';
import { FilaError, type CasoNaFila } from '@shared/lib/fila';
import { MetabaseError } from '@shared/lib/metabase';

/**
 * O lado do servidor da tag "Gravado no Metabase" (ADR-011 e ADR-012): onde está cada caso que a lista acompanha —
 * `gravado` na raw, `recusado` pela DAG (a fila sabe) ou `aguardando` o lote.
 */

const conferir = vi.mocked(conferirTokenNoCosmos);

const A = '6f1c0e2a-1111-4222-8333-444455556666';
const B = '7c23634b-102e-4eec-a69b-d5c6df2f5619';
const C = '4efd9528-aad6-445b-93f3-9729a1dc9d75';

const naFila = (id: string, situacao: CasoNaFila['situacao']): CasoNaFila => ({
    idSolicitacao: id,
    tipo: 'REEMBOLSO',
    marca: 'lescent',
    numeroPedido: 'SH123',
    criadoEm: '2026-11-04T14:50:00.000Z',
    responsavel: 'Ana',
    situacao,
});

function deps(sobre: Partial<EstadosDeps> = {}): EstadosDeps {
    return {
        consultar: vi.fn(async () => []),
        casoNaFila: vi.fn(async () => null),
        filaConfigurada: vi.fn(() => true),
        ...sobre,
    };
}

describe('sqlDosCasosNaRaw', () => {
    it('só a criação dos casos perguntados, na raw de eventos', () => {
        const sql = sqlDosCasosNaRaw([A, B]);

        expect(sql).toContain('from raw.cxhub_reenvio_reembolso_eventos e');
        expect(sql).toContain("e.tipo_evento = 'caso'");
        expect(sql).toContain(`e.id_solicitacao in ('${A}', '${B}')`);
        expect(sql).toMatch(/^select distinct e\.id_solicitacao /);
    });

    it('os ids vão como literal escapado', () => {
        expect(sqlDosCasosNaRaw(["x'; drop table y; --"])).toContain("in ('x''; drop table y; --')");
    });
});

describe('estadosNoRegistro', () => {
    it('na raw ⇒ gravado, e a fila só é perguntada pelo que a raw não tem', async () => {
        const d = deps({
            consultar: vi.fn(async () => [[A]]),
            casoNaFila: vi.fn(async (id: string) => (id === B ? naFila(B, 'recusado') : naFila(id, 'pendente'))),
        });

        await expect(estadosNoRegistro([A, B, C], d)).resolves.toEqual({ [A]: 'gravado', [B]: 'recusado', [C]: 'aguardando' });
        expect(d.consultar).toHaveBeenCalledWith(sqlDosCasosNaRaw([A, B, C]));
        expect(d.casoNaFila).toHaveBeenCalledTimes(2);
        expect(d.casoNaFila).not.toHaveBeenCalledWith(A);
    });

    it.each([
        ['enviado', 'aguardando'],
        ['gravado', 'aguardando'],
        ['pendente', 'aguardando'],
        ['recusado', 'recusado'],
    ] as const)('fora da raw, fila %s ⇒ %s (gravado na fila e ainda não na raw é a réplica atrasada)', async (situacao, esperado) => {
        await expect(estadosNoRegistro([A], deps({ casoNaFila: vi.fn(async () => naFila(A, situacao)) })))
            .resolves.toEqual({ [A]: esperado });
    });

    it('caso que a fila não conhece segue aguardando', async () => {
        await expect(estadosNoRegistro([A], deps())).resolves.toEqual({ [A]: 'aguardando' });
    });

    it('fila que não responde não muda nada: aguardando, sem lançar', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(estadosNoRegistro([A], deps({ casoNaFila: vi.fn(async () => { throw new FilaError('a fila está inalcançável', 0); }) })))
            .resolves.toEqual({ [A]: 'aguardando' });
        vi.restoreAllMocks();
    });

    it('sem a fila configurada, não pergunta a ela', async () => {
        const d = deps({ filaConfigurada: vi.fn(() => false) });

        await expect(estadosNoRegistro([A], d)).resolves.toEqual({ [A]: 'aguardando' });
        expect(d.casoNaFila).not.toHaveBeenCalled();
    });

    it('erro do Metabase sobe: quem decide a resposta é a rota', async () => {
        await expect(estadosNoRegistro([A], deps({ consultar: vi.fn(async () => { throw new MetabaseError(502, 'Bad Gateway'); }) })))
            .rejects.toBeInstanceOf(MetabaseError);
    });
});

describe('responderRegistro', () => {
    beforeEach(() => {
        conferir.mockReset().mockResolvedValue('ok');
        vi.stubEnv('METABASE_URL', 'https://metabase.test');
        vi.stubEnv('METABASE_API_KEY', 'chave');
        vi.stubEnv('METABASE_DATABASE_ID', '43');
        for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('confere o token na org da Lescent e devolve o estado de cada id', async () => {
        const d = deps({ consultar: vi.fn(async () => [[A]]) });

        await expect(responderRegistro({ authorization: 'Bearer t', ids: `${A},${B}` }, d)).resolves.toEqual({
            status: 200,
            body: { code: 'SUCCESS', message: '', estados: { [A]: 'gravado', [B]: 'aguardando' } },
        });
        expect(conferir).toHaveBeenCalledWith('3', 'Bearer t');
    });

    it('ids repetidos e com espaço são perguntados uma vez só', async () => {
        const d = deps();
        await responderRegistro({ authorization: 'Bearer t', ids: ` ${A} ,${A},` }, d);

        expect(d.consultar).toHaveBeenCalledWith(sqlDosCasosNaRaw([A]));
    });

    it('sem Authorization ⇒ 401, antes de qualquer coisa', async () => {
        const d = deps();
        const { status, body } = await responderRegistro({ authorization: null, ids: A }, d);

        expect(status).toBe(401);
        expect(body.code).toBe('UNAUTHORIZED');
        expect(conferir).not.toHaveBeenCalled();
        expect(d.consultar).not.toHaveBeenCalled();
    });

    it.each([
        ['sem ids', null],
        ['ids vazios', ' , '],
        ['id com caractere fora do formato', `${A},x'y`],
        ['id longo demais', 'a'.repeat(65)],
        ['ids demais', Array.from({ length: MAX_IDS_DO_REGISTRO + 1 }, (_, i) => `id-${i}`).join(',')],
    ])('%s ⇒ 400, sem conferir o token nem ler a raw', async (_titulo, ids) => {
        const d = deps();
        const { status, body } = await responderRegistro({ authorization: 'Bearer t', ids }, d);

        expect(status).toBe(400);
        expect(body).toEqual({
            code: 'INVALID_REQUEST',
            message: `ids deve ter de 1 a ${MAX_IDS_DO_REGISTRO} ids de solicitação, separados por vírgula.`,
        });
        expect(conferir).not.toHaveBeenCalled();
        expect(d.consultar).not.toHaveBeenCalled();
    });

    it('o máximo de ids passa', async () => {
        const ids = Array.from({ length: MAX_IDS_DO_REGISTRO }, (_, i) => `id-${i}`).join(',');
        expect((await responderRegistro({ authorization: 'Bearer t', ids }, deps())).status).toBe(200);
    });

    it.each([
        ['recusado', 401, 'UNAUTHORIZED'],
        ['sem_acesso', 403, 'FORBIDDEN'],
        ['timeout', 504, 'API_TIMEOUT'],
        ['erro', 502, 'UNKNOWN_ERROR'],
        ['sem_url', 502, 'UNKNOWN_ERROR'],
    ] as const)('token no Cosmos: %s ⇒ %i %s, sem ler a raw', async (conferencia, status, code) => {
        conferir.mockResolvedValue(conferencia);
        const d = deps();

        const resposta = await responderRegistro({ authorization: 'Bearer t', ids: A }, d);

        expect(resposta.status).toBe(status);
        expect(resposta.body.code).toBe(code);
        expect(d.consultar).not.toHaveBeenCalled();
    });

    it('sem METABASE_* ⇒ 503', async () => {
        vi.stubEnv('METABASE_API_KEY', '');
        const d = deps();

        await expect(responderRegistro({ authorization: 'Bearer t', ids: A }, d)).resolves.toEqual({
            status: 503,
            body: { code: 'UNAVAILABLE', message: 'O Metabase não está configurado neste ambiente (METABASE_*).' },
        });
        expect(d.consultar).not.toHaveBeenCalled();
    });

    it('Metabase que não responde (status 0) ⇒ 504', async () => {
        const d = deps({ consultar: vi.fn(async () => { throw new MetabaseError(0, 'Metabase não respondeu em 5s'); }) });

        await expect(responderRegistro({ authorization: 'Bearer t', ids: A }, d)).resolves.toEqual({
            status: 504,
            body: { code: 'API_TIMEOUT', message: 'O Metabase não respondeu.' },
        });
    });

    it.each([
        ['MetabaseError com HTTP', new MetabaseError(502, 'Metabase HTTP 502: Bad Gateway')],
        ['erro qualquer', new Error('inesperado')],
    ])('%s ⇒ 502', async (_titulo, erro) => {
        const d = deps({ consultar: vi.fn(async () => { throw erro; }) });

        await expect(responderRegistro({ authorization: 'Bearer t', ids: A }, d)).resolves.toEqual({
            status: 502,
            body: { code: 'UNKNOWN_ERROR', message: 'Não foi possível ler o registro no Metabase.' },
        });
    });
});
