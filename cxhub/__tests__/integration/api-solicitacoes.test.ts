import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A leitura da planilha tem testes próprios (`presencaNaPlanilha.test.ts`); aqui ela fica a real, embrulhada, para o
// teste com a planilha configurada dizer o que ela responde sem falar com o Google.
vi.mock('@shared/lib/sheets/presencaNaPlanilha', async (importOriginal) => {
    const original = await importOriginal<typeof import('@shared/lib/sheets/presencaNaPlanilha')>();
    return { ...original, comPresencaNaPlanilha: vi.fn(original.comPresencaNaPlanilha) };
});

import { GET as listarRota } from '../../app/api/solicitacoes/route';
import { comPresencaNaPlanilha } from '@shared/lib/sheets/presencaNaPlanilha';
import { createRequest } from '../helpers/api-test-utils';

/**
 * `GET /api/solicitacoes`: a lista lê a raw de eventos pelo Metabase, e só para quem tem o token do login (conferido no
 * Cosmos, como nas rotas de gestão). Cada linha vem com o `naPlanilha` (a linha está na planilha da marca?), que a
 * tag do envio mostra.
 */

const AUTH = 'Bearer test-token';
const COSMOS = 'https://api.cosmos.test';
const METABASE = 'https://metabase.test';

let tokenCosmos: number;
let respostaMetabase: () => Response;
let consultas: string[];

function instalarFetch() {
    consultas = [];
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith(`${COSMOS}/organizations/`)) {
            return new Response(JSON.stringify(tokenCosmos === 200 ? [] : { error: 'Token inválido' }), { status: tokenCosmos });
        }
        if (url === `${METABASE}/api/dataset`) {
            consultas.push(JSON.parse(String(init?.body)).native.query);
            return respostaMetabase();
        }
        throw new Error(`fetch inesperado: ${url}`);
    });
}

function linhas(rows: unknown[][]) {
    return () => new Response(JSON.stringify({ status: 'completed', data: { rows } }), { status: 202 });
}

function listar(query: string, headers: Record<string, string> = { Authorization: AUTH }) {
    return listarRota(createRequest(`http://localhost/api/solicitacoes?${query}`, { headers }));
}

beforeEach(() => {
    vi.stubEnv('COSMOS_API_URL', COSMOS);
    vi.stubEnv('METABASE_URL', METABASE);
    vi.stubEnv('METABASE_API_KEY', 'chave');
    vi.stubEnv('METABASE_DATABASE_ID', '43');
    // Sem a configuração do Google: a lista não lê planilha nenhuma, e o naPlanilha vem null.
    vi.stubEnv('GOOGLE_PLANILHAS_EMAIL', '');
    vi.stubEnv('GOOGLE_PLANILHAS_TOKEN', '');
    vi.stubEnv('SHEETS_ENV', '');
    tokenCosmos = 200;
    respostaMetabase = linhas([]);
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/solicitacoes', () => {
    it('confere o token na org da marca e devolve a lista da raw', async () => {
        const fetchSpy = instalarFetch();
        respostaMetabase = linhas([[1, 'abc', 'lescent', 'SH9000105LC', '2026-10-28T21:55:12.000Z', false, true, '59.9', 'Extravio', null, 'Ana', '2026-10-28T21:55:12.000Z']]);

        const res = await listar('tipo=reembolso&marca=lescent&pedido=SH9000105LC');

        expect(res.status).toBe(200);
        const corpo = await res.json();
        expect(corpo.code).toBe('SUCCESS');
        expect(corpo.solicitacoes).toEqual([expect.objectContaining({
            idSolicitacao: 'abc', marca: 'lescent', maisRecenteDoPedido: true, criadoEm: '2026-10-28T21:55:12.000Z',
        })]);
        expect(String(fetchSpy.mock.calls[0][0])).toBe(`${COSMOS}/organizations/3/carriers?per_page=1`);
        expect(consultas[0]).toContain("upper(btrim(e.payload ->> 'tipo')) = 'REEMBOLSO'");
        expect(consultas[0]).toContain("= '9000105'");
    });

    it('marca sem Cosmos (ADR-013): aceita o filtro e confere o token na org da Lescent, nunca em /organizations/apice', async () => {
        const fetchSpy = instalarFetch();
        respostaMetabase = linhas([[1, 'xyz', 'apice', 'SH1629891AP', '2026-11-05T15:00:00.000Z', false, true, '94.82', 'Ruptura de Estoque', null, 'Ana', '2026-11-05T15:00:00.000Z']]);

        const res = await listar('tipo=REEMBOLSO&marca=apice');

        expect(res.status).toBe(200);
        expect((await res.json()).solicitacoes).toEqual([expect.objectContaining({ idSolicitacao: 'xyz', marca: 'apice' })]);
        expect(String(fetchSpy.mock.calls[0][0])).toBe(`${COSMOS}/organizations/3/carriers?per_page=1`);
        expect(consultas[0]).toContain("lower(btrim(e.marca)) = 'apice'");
    });

    it('sem a configuração do Google ⇒ naPlanilha null em cada linha, e o Google não é chamado', async () => {
        const fetchSpy = instalarFetch();
        respostaMetabase = linhas([[1, 'abc', 'lescent', 'SH1LC', '2026-10-28T21:55:12.000Z', false, true, null, null, null, null, '2026-10-28T21:55:12.000Z']]);

        const corpo = await (await listar('tipo=REEMBOLSO')).json();

        expect(corpo.solicitacoes.map((s: { naPlanilha: unknown }) => s.naPlanilha)).toEqual([null]);
        expect(fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('googleapis'))).toEqual([]);
    });

    it('com a planilha: a lista da raw passa pela leitura da planilha, com o prazo dela, e cada linha leva o naPlanilha', async () => {
        instalarFetch();
        respostaMetabase = linhas([
            [2, 'a', 'lescent', 'SH1LC', '2026-10-28T21:55:12.000Z', false, true, null, null, null, null, '2026-10-28T21:55:12.000Z'],
            [2, 'b', 'lescent', 'SH2LC', '2026-10-28T20:00:00.000Z', false, true, null, null, null, null, '2026-10-28T20:00:00.000Z'],
        ]);
        vi.mocked(comPresencaNaPlanilha).mockImplementationOnce(async (lista) =>
            lista.map((item) => ({ ...item, naPlanilha: item.idSolicitacao === 'a' })));
        const antes = Date.now();

        const corpo = await (await listar('tipo=REEMBOLSO&marca=lescent')).json();

        const [daRaw, prazo] = vi.mocked(comPresencaNaPlanilha).mock.lastCall!;
        expect(daRaw.map((item) => [item.idSolicitacao, item.criadoEm])).toEqual([
            ['a', '2026-10-28T21:55:12.000Z'],
            ['b', '2026-10-28T20:00:00.000Z'],
        ]);
        // O prazo da lista na planilha (`JANELA_PRESENCA_MS`, 15 s), contado de agora — não os 25 s da gravação.
        expect(prazo).toBeGreaterThanOrEqual(antes + 14_000);
        expect(prazo).toBeLessThanOrEqual(Date.now() + 15_000);
        expect(corpo.solicitacoes.map((s: { idSolicitacao: string; naPlanilha: unknown }) => [s.idSolicitacao, s.naPlanilha]))
            .toEqual([['a', true], ['b', false]]);
    });

    it('lista vazia vem com mensagem e uma página, vazia', async () => {
        instalarFetch();
        const corpo = await (await listar('tipo=REENVIO')).json();
        expect(corpo).toEqual({
            code: 'SUCCESS',
            message: 'Nenhuma solicitação encontrada.',
            solicitacoes: [],
            paginacao: { pagina: 1, porPagina: 20, total: 0, totalPaginas: 1 },
        });
    });

    it('a página pedida vai ao SQL (20 por vez) e a resposta diz onde ela está na lista inteira', async () => {
        instalarFetch();
        respostaMetabase = linhas([[41, 'abc', 'lescent', 'SH1LC', '2026-10-28T21:55:12.000Z', false, false, null, null, null, null, '2026-10-28T21:55:12.000Z']]);

        const corpo = await (await listar('tipo=REEMBOLSO&pagina=3')).json();

        expect(consultas[0]).toContain('limit 20 offset 40)');
        expect(corpo.paginacao).toEqual({ pagina: 3, porPagina: 20, total: 41, totalPaginas: 3 });
        expect(corpo.solicitacoes.map((s: { idSolicitacao: string }) => s.idSolicitacao)).toEqual(['abc']);
        expect(corpo.message).toBe('');
    });

    it('sem pedido, os últimos 30 dias; com o pedido, todo o histórico dele', async () => {
        instalarFetch();
        await listar('tipo=REEMBOLSO&marca=lescent');
        await listar('tipo=REEMBOLSO&pedido=SH9000105LC');
        expect(consultas[0]).toContain('j.criado collate "C" >=');
        expect(consultas[1]).not.toContain('j.criado collate "C" >=');
    });

    it('página além da última: vazia, com o total e a mensagem de quantas páginas há', async () => {
        instalarFetch();
        respostaMetabase = linhas([[41, ...Array(11).fill(null)]]);
        const corpo = await (await listar('tipo=REEMBOLSO&pagina=7')).json();
        expect(corpo).toEqual({
            code: 'SUCCESS',
            message: 'Esta página não existe mais: a lista tem 3 página(s).',
            solicitacoes: [],
            paginacao: { pagina: 7, porPagina: 20, total: 41, totalPaginas: 3 },
        });
    });

    it('sem Authorization recusa antes de qualquer chamada', async () => {
        const fetchSpy = instalarFetch();
        expect((await listar('tipo=REENVIO', {})).status).toBe(401);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['tipo=CANCELAMENTO', 'tipo deve ser REENVIO ou REEMBOLSO.'],
        ['tipo=REENVIO&marca=gocase', 'Marca inválida: gocase.'],
        ["tipo=REENVIO&pedido=SH1'", 'Número do pedido inválido.'],
        ['tipo=REENVIO&pagina=0', 'pagina deve ser um número inteiro de 1 a 99999.'],
        ['tipo=REENVIO&pagina=-1', 'pagina deve ser um número inteiro de 1 a 99999.'],
        ['tipo=REENVIO&pagina=2.5', 'pagina deve ser um número inteiro de 1 a 99999.'],
        ['tipo=REENVIO&pagina=abc', 'pagina deve ser um número inteiro de 1 a 99999.'],
        ['tipo=REENVIO&pagina=100000', 'pagina deve ser um número inteiro de 1 a 99999.'],
    ])('recusa %s sem chamar nada', async (query, mensagem) => {
        const fetchSpy = instalarFetch();
        const res = await listar(query);
        expect(res.status).toBe(400);
        expect((await res.json()).message).toBe(mensagem);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('token recusado pelo Cosmos não chega ao Metabase', async () => {
        instalarFetch();
        tokenCosmos = 401;
        const res = await listar('tipo=REENVIO');
        expect(res.status).toBe(401);
        expect(consultas).toHaveLength(0);
    });

    it('sem METABASE_* responde indisponível', async () => {
        instalarFetch();
        vi.stubEnv('METABASE_API_KEY', '');
        const res = await listar('tipo=REENVIO');
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe('UNAVAILABLE');
    });

    it('tabela que ainda não existe vira indisponível, com mensagem clara', async () => {
        instalarFetch();
        respostaMetabase = () => new Response(JSON.stringify({
            status: 'failed', error: 'ERROR: relation "raw.cxhub_reenvio_reembolso_eventos" does not exist',
        }), { status: 202 });
        const res = await listar('tipo=REEMBOLSO');
        expect(res.status).toBe(503);
        expect((await res.json()).message).toContain('ainda não tem a tabela');
    });

    it('outro erro do Metabase vira 502', async () => {
        instalarFetch();
        respostaMetabase = () => new Response('<html><title>Bad Gateway</title></html>', { status: 502 });
        const res = await listar('tipo=REEMBOLSO');
        expect(res.status).toBe(502);
        expect((await res.json()).code).toBe('UNKNOWN_ERROR');
    });
});
