import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as consultarRota } from '../../app/api/registro/route';
import { createRequest } from '../helpers/api-test-utils';

/**
 * `GET /api/registro?ids=`: a tag da lista pergunta onde estão os casos que este navegador enviou (ADR-011 e ADR-012)
 * — `gravado` na raw (pelo Metabase), `recusado` pela DAG (a fila sabe) ou `aguardando` o lote. Exige o token do
 * login (conferido no Cosmos, como a lista de solicitações).
 */

const AUTH = 'Bearer test-token';
const COSMOS = 'https://api.cosmos.test';
const METABASE = 'https://metabase.test';
const FILA = 'https://cx-hub.test';
const A = '6f1c0e2a-1111-4222-8333-444455556666';
const B = '7c23634b-102e-4eec-a69b-d5c6df2f5619';

type RespostaFalsa = [number, unknown] | 'timeout';

interface Chamada { url: string; method: string; corpo?: string }

let tokenCosmos: number | 'timeout';
/** A resposta do `POST /api/dataset`. */
let metabase: RespostaFalsa;
/** A resposta do `GET /api/v1/casos/{id}` da fila, por id. */
let fila: Record<string, RespostaFalsa>;
let chamadas: Chamada[];

/** O que o `fetch` lança quando o `AbortController` do timeout dispara. */
function abortado(): Error {
    const erro = new Error('This operation was aborted');
    erro.name = 'AbortError';
    return erro;
}

function responder(resposta: RespostaFalsa): Response {
    if (resposta === 'timeout') throw abortado();
    return new Response(JSON.stringify(resposta[1]), { status: resposta[0] });
}

const linhas = (ids: string[]): RespostaFalsa => [202, { status: 'completed', data: { rows: ids.map((id) => [id]) } }];

const casoNaFila = (id: string, situacao: string): RespostaFalsa => [200, {
    caso: {
        id_solicitacao: id, tipo: 'REEMBOLSO', marca: 'lescent', numero_pedido: 'SH1', criado_em: '2026-11-04T10:00:00Z',
        responsavel: 'Ana', situacao,
    },
}];

function instalarFetch() {
    chamadas = [];
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        chamadas.push({ url, method, corpo: typeof init?.body === 'string' ? init.body : undefined });
        if (url.startsWith(`${COSMOS}/organizations/`)) {
            if (tokenCosmos === 'timeout') throw abortado();
            return new Response(JSON.stringify(tokenCosmos === 200 ? [] : { error: 'Token inválido' }), { status: tokenCosmos });
        }
        if (url === `${METABASE}/api/dataset` && method === 'POST') return responder(metabase);
        if (url.startsWith(`${FILA}/api/v1/casos/`) && method === 'GET') {
            const id = decodeURIComponent(url.slice(`${FILA}/api/v1/casos/`.length));
            return responder(fila[id] ?? [200, { caso: null }]);
        }
        throw new Error(`fetch inesperado: ${method} ${url}`);
    });
}

const doMetabase = () => chamadas.filter((c) => c.url.startsWith(METABASE));
const daFila = () => chamadas.filter((c) => c.url.startsWith(FILA));
const doCosmos = () => chamadas.filter((c) => c.url.startsWith(COSMOS));

function consultar(query: string, headers: Record<string, string> = { Authorization: AUTH }) {
    return consultarRota(createRequest(`http://localhost/api/registro?${query}`, { headers }));
}

beforeEach(() => {
    vi.stubEnv('COSMOS_API_URL', COSMOS);
    vi.stubEnv('METABASE_URL', METABASE);
    vi.stubEnv('METABASE_API_KEY', 'chave');
    vi.stubEnv('METABASE_DATABASE_ID', '43');
    vi.stubEnv('CXHUB_FILA_URL', FILA);
    vi.stubEnv('CXHUB_FILA_TOKEN', 'token-da-fila');
    tokenCosmos = 200;
    metabase = linhas([]);
    fila = {};
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/registro', () => {
    it('confere o token na org da Lescent, lê a raw numa consulta e pergunta à fila só o que a raw não tem', async () => {
        instalarFetch();
        metabase = linhas([A]);
        fila = { [B]: casoNaFila(B, 'pendente') };

        const res = await consultar(`ids=${A},${B}`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ code: 'SUCCESS', message: '', estados: { [A]: 'gravado', [B]: 'aguardando' } });
        expect(doCosmos().map((c) => c.url)).toEqual([`${COSMOS}/organizations/3/carriers?per_page=1`]);
        expect(doMetabase()).toHaveLength(1);
        expect(JSON.parse(doMetabase()[0].corpo ?? '{}').native.query).toContain(`in ('${A}', '${B}')`);
        expect(daFila().map((c) => c.url)).toEqual([`${FILA}/api/v1/casos/${B}`]);
    });

    it('a DAG recusou o caso (a fila diz recusado) ⇒ recusado', async () => {
        instalarFetch();
        fila = { [A]: casoNaFila(A, 'recusado') };

        expect(await (await consultar(`ids=${A}`)).json()).toEqual({ code: 'SUCCESS', message: '', estados: { [A]: 'recusado' } });
    });

    it('fila fora do ar não muda nada: aguardando', async () => {
        instalarFetch();
        fila = { [A]: [503, { code: 'UNAVAILABLE' }] };

        const res = await consultar(`ids=${A}`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ code: 'SUCCESS', message: '', estados: { [A]: 'aguardando' } });
    });

    it('sem CXHUB_FILA_* a fila não é perguntada: o que a raw não tem segue aguardando', async () => {
        instalarFetch();
        vi.stubEnv('CXHUB_FILA_TOKEN', '');

        expect(await (await consultar(`ids=${A}`)).json()).toEqual({ code: 'SUCCESS', message: '', estados: { [A]: 'aguardando' } });
        expect(daFila()).toHaveLength(0);
    });

    it('sem Authorization recusa antes de qualquer chamada', async () => {
        const fetchSpy = instalarFetch();
        const res = await consultar(`ids=${A}`, {});

        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe('UNAUTHORIZED');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['sem ids', 'marca=lescent'],
        ['o formato antigo (run)', `run=cxhub__${A}`],
        ['id com aspas', `ids=${encodeURIComponent("a'b")}`],
    ])('%s ⇒ 400 sem chamar nada', async (_titulo, query) => {
        const fetchSpy = instalarFetch();
        const res = await consultar(query);

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('INVALID_REQUEST');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        [401, 401, 'UNAUTHORIZED'],
        [403, 403, 'FORBIDDEN'],
        [500, 502, 'UNKNOWN_ERROR'],
        ['timeout', 504, 'API_TIMEOUT'],
    ] as const)('token no Cosmos: %s ⇒ %i %s, sem chegar ao Metabase', async (cosmos, status, code) => {
        instalarFetch();
        tokenCosmos = cosmos;

        const res = await consultar(`ids=${A}`);

        expect(res.status).toBe(status);
        expect((await res.json()).code).toBe(code);
        expect(doMetabase()).toHaveLength(0);
    });

    it('sem COSMOS_API_URL não há como conferir o token ⇒ 502, sem chegar ao Metabase', async () => {
        instalarFetch();
        vi.stubEnv('COSMOS_API_URL', '');

        expect((await consultar(`ids=${A}`)).status).toBe(502);
        expect(doMetabase()).toHaveLength(0);
    });

    it('sem METABASE_* ⇒ 503 indisponível', async () => {
        instalarFetch();
        vi.stubEnv('METABASE_DATABASE_ID', '');

        const res = await consultar(`ids=${A}`);

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ code: 'UNAVAILABLE', message: 'O Metabase não está configurado neste ambiente (METABASE_*).' });
        expect(doMetabase()).toHaveLength(0);
    });

    it('Metabase com erro ⇒ 502', async () => {
        instalarFetch();
        metabase = [502, '<html><title>Bad Gateway</title></html>'];

        const res = await consultar(`ids=${A}`);

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ code: 'UNKNOWN_ERROR', message: 'Não foi possível ler o registro no Metabase.' });
    });

    it('Metabase que não responde a tempo ⇒ 504', async () => {
        instalarFetch();
        metabase = 'timeout';

        const res = await consultar(`ids=${A}`);

        expect(res.status).toBe(504);
        expect(await res.json()).toEqual({ code: 'API_TIMEOUT', message: 'O Metabase não respondeu.' });
    });
});
