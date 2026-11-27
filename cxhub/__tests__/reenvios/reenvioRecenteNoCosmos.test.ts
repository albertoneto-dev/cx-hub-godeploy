import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    reenvioRecenteNoCosmos,
    sqlDoReenvioNaIntelipost,
    notaDoReenvioExistente,
    TETO_DA_CONSULTA_AO_COSMOS_MS,
    type DepsDoReenvioRecente,
} from '@modules/reenvios/actions/reenvioRecenteNoCosmos';

const COSMOS_URL = 'https://cosmos.test/api/v3';
// 19/11/2026 14:32 UTC (11:32 em SP), a hora do 1º timeout do SH1585904KS
const AGORA = new Date('2026-11-19T14:32:22Z');
const PRAZO = AGORA.getTime() + 12_000;

/** Um pedido da listagem do Cosmos, só com o que a consulta lê. */
function pedido(externalId: string, criadoEm: string, extra: Record<string, unknown> = {}) {
    return { id: 1, external_id: externalId, origin: 'resend', status: 'erp', canceled_at: null, created_at: criadoEm, ...extra };
}

function respostaJson(corpo: unknown, status = 200) {
    return new Response(JSON.stringify(corpo), { status });
}

/** Um `fetch` que aborta quando o signal dispara, como o real no timeout. */
function semResposta(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
}

function deps(fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>, linhas: unknown[][] | Error = []) {
    const f = vi.fn(fetchImpl);
    const consultar = vi.fn(async (_sql: string, _opcoes?: { timeoutMs?: number }) => {
        if (linhas instanceof Error) throw linhas;
        return linhas;
    });
    const d: DepsDoReenvioRecente = { fetch: f as unknown as typeof fetch, consultar, agora: () => AGORA.getTime() };
    return { d, f, consultar };
}

describe('reenvioRecenteNoCosmos (o pedido já tem reenvio antes do POST /resend)', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', COSMOS_URL);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    describe('o Cosmos responde', () => {
        it('reenvio do pedido das últimas 24 h ⇒ existe, pela listagem de reenvios da org com o token de quem pediu', async () => {
            const { d, f, consultar } = deps(async () => respostaJson([pedido('SH1585904KS-R-1', '2026-11-19T11:32:33.441-03:00')]));

            const r = await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, d);

            expect(r).toEqual({ tipo: 'existe', externalId: 'SH1585904KS-R-1', criadoEm: '2026-11-19T11:32:33.441-03:00', fonte: 'cosmos' });
            expect(f).toHaveBeenCalledTimes(1);
            const [url, init] = f.mock.calls[0];
            expect(url).toBe(`${COSMOS_URL}/organizations/4/orders?external_id=1585904&per_page=100`);
            expect(init?.method).toBe('GET');
            expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' });
            expect(consultar).not.toHaveBeenCalled();
        });

        it('o número vem só com os dígitos, mesmo no formato da tela (#SHOPIFY…), e casa os dois formatos do Cosmos', async () => {
            const { d, f } = deps(async () => respostaJson([pedido('#SHOPIFY220183-R-1', '2026-11-19T10:00:00-03:00')]));

            const r = await reenvioRecenteNoCosmos('rituaria', '#SHOPIFY220183', 'tok', PRAZO, AGORA, d);

            expect(String(f.mock.calls[0][0])).toContain('/organizations/9/orders?external_id=220183&');
            expect(r).toMatchObject({ tipo: 'existe', externalId: '#SHOPIFY220183-R-1' });
        });

        it('dois reenvios ⇒ vale o mais recente', async () => {
            const { d } = deps(async () => respostaJson([
                pedido('SH1585904KS-R-1', '2026-11-19T11:32:33-03:00'),
                pedido('SH1585904KS-R-2', '2026-11-19T11:33:39-03:00'),
            ]));

            const r = await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, d);

            expect(r).toMatchObject({ tipo: 'existe', externalId: 'SH1585904KS-R-2' });
        });

        it.each([
            ['cancelado pelo status', pedido('SH1585904KS-R-1', '2026-11-19T11:00:00-03:00', { status: 'cancelled' })],
            ['cancelado pela data', pedido('SH1585904KS-R-1', '2026-11-19T11:00:00-03:00', { canceled_at: '2026-11-19T11:05:00-03:00' })],
            ['de mais de 24 h', pedido('SH1585904KS-R-1', '2026-11-18T11:00:00-03:00')],
            ['de outro pedido com número parecido (a busca é ILIKE)', pedido('SH15859041KS-R-1', '2026-11-19T11:00:00-03:00')],
        ])('reenvio %s não conta ⇒ nenhum', async (_caso, item) => {
            const { d, consultar } = deps(async () => respostaJson([item]));

            const r = await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, d);

            expect(r).toEqual({ tipo: 'nenhum' });
            expect(consultar).not.toHaveBeenCalled();
        });

        it('lista vazia ⇒ nenhum', async () => {
            const { d } = deps(async () => respostaJson([]));
            expect(await reenvioRecenteNoCosmos('barbours', '2858486', 'tok', PRAZO, AGORA, d)).toEqual({ tipo: 'nenhum' });
        });
    });

    describe('o Cosmos não responde: tenta de novo, depois o Data Mart', () => {
        it('5xx na 1ª e lista na 2ª ⇒ usa a 2ª', async () => {
            const { d, f } = deps(vi.fn()
                .mockResolvedValueOnce(new Response(null, { status: 503 }))
                .mockResolvedValueOnce(respostaJson([pedido('SH2858486BB-R-1', '2026-11-19T14:31:48-03:00')])));

            const r = await reenvioRecenteNoCosmos('barbours', '2858486', 'tok', PRAZO, AGORA, d);

            expect(f).toHaveBeenCalledTimes(2);
            expect(r).toMatchObject({ tipo: 'existe', externalId: 'SH2858486BB-R-1', fonte: 'cosmos' });
        });

        it('cada tentativa tem teto próprio e aborta nele; sem resposta nas duas e sem o Data Mart ⇒ indefinido', async () => {
            vi.useFakeTimers({ now: AGORA });
            try {
                const { d, f } = deps(semResposta, []);

                const pendente = reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, { ...d, agora: Date.now });
                await vi.advanceTimersByTimeAsync(TETO_DA_CONSULTA_AO_COSMOS_MS);
                expect(f).toHaveBeenCalledTimes(2);
                await vi.advanceTimersByTimeAsync(TETO_DA_CONSULTA_AO_COSMOS_MS);
                const r = await pendente;

                expect(f.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
                expect(r).toEqual({ tipo: 'indefinido', motivo: `o Cosmos não respondeu em ${TETO_DA_CONSULTA_AO_COSMOS_MS} ms` });
            } finally {
                vi.useRealTimers();
            }
        });

        it('o Cosmos calado nas duas e o reenvio no Data Mart ⇒ existe, pelo Data Mart', async () => {
            const { d, consultar } = deps(async () => new Response(null, { status: 502 }), [['SH716185LC-R-1', '2026-11-19T10:05:00-03:00']]);

            const r = await reenvioRecenteNoCosmos('lescent', '716185', 'tok', PRAZO, AGORA, d);

            expect(r).toEqual({ tipo: 'existe', externalId: 'SH716185LC-R-1', criadoEm: '2026-11-19T10:05:00-03:00', fonte: 'datamart' });
            expect(consultar).toHaveBeenCalledTimes(1);
            expect(consultar.mock.calls[0][0]).toBe(sqlDoReenvioNaIntelipost('lescent', '716185', new Date('2026-11-18T14:32:22Z')));
        });

        it('a BySamia é by_samia na Intelipost', async () => {
            const { d, consultar } = deps(async () => new Response(null, { status: 502 }), []);

            await reenvioRecenteNoCosmos('bysamia', '52988', 'tok', PRAZO, AGORA, d);

            expect(consultar.mock.calls[0][0]).toContain("brand_code = 'by_samia'");
        });

        it('o Data Mart sem o reenvio ⇒ indefinido (ele recebe os novos com atraso), com o motivo do Cosmos', async () => {
            const { d } = deps(async () => new Response(null, { status: 503 }), []);

            const r = await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, d);

            expect(r).toEqual({ tipo: 'indefinido', motivo: 'o Cosmos respondeu HTTP 503' });
        });

        it('o Data Mart fora ⇒ indefinido', async () => {
            const { d } = deps(async () => { throw new TypeError('fetch failed'); }, new Error('Metabase não respondeu em 5s'));

            const r = await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, d);

            expect(r).toEqual({ tipo: 'indefinido', motivo: 'o Cosmos ficou inalcançável' });
        });

        it('o Data Mart só conta o reenvio do próprio pedido', async () => {
            const { d } = deps(async () => new Response(null, { status: 503 }), [['SH15859041KS-R-1', '2026-11-19T10:00:00-03:00']]);

            expect(await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, d)).toMatchObject({ tipo: 'indefinido' });
        });

        it('401 não se repete: vai direto ao Data Mart', async () => {
            const { d, f, consultar } = deps(async () => new Response(null, { status: 401 }), []);

            const r = await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, d);

            expect(f).toHaveBeenCalledTimes(1);
            expect(consultar).toHaveBeenCalledTimes(1);
            expect(r).toEqual({ tipo: 'indefinido', motivo: 'o Cosmos respondeu HTTP 401' });
        });

        it('sem prazo ⇒ indefinido sem consultar nada', async () => {
            const { d, f, consultar } = deps(async () => respostaJson([]));

            const r = await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', AGORA.getTime() + 100, AGORA, d);

            expect(r).toEqual({ tipo: 'indefinido', motivo: 'o prazo acabou antes da consulta ao Cosmos' });
            expect(f).not.toHaveBeenCalled();
            expect(consultar).not.toHaveBeenCalled();
        });
    });

    describe('sem o que procurar, fica como antes', () => {
        it.each([
            ['sem token', { token: undefined, pedido: '1585904' }],
            ['sem número de pedido', { token: 'tok', pedido: '' }],
        ])('%s ⇒ nenhum, sem consultar', async (_caso, { token, pedido: numero }) => {
            const { d, f, consultar } = deps(async () => respostaJson([]));

            expect(await reenvioRecenteNoCosmos('kokeshi', numero, token, PRAZO, AGORA, d)).toEqual({ tipo: 'nenhum' });
            expect(f).not.toHaveBeenCalled();
            expect(consultar).not.toHaveBeenCalled();
        });

        it('sem COSMOS_API_URL ⇒ nenhum (o executarNoCosmos recusa sozinho)', async () => {
            vi.stubEnv('COSMOS_API_URL', '');
            const { d, f } = deps(async () => respostaJson([]));

            expect(await reenvioRecenteNoCosmos('kokeshi', '1585904', 'tok', PRAZO, AGORA, d)).toEqual({ tipo: 'nenhum' });
            expect(f).not.toHaveBeenCalled();
        });
    });

    it('a nota da linha segue o formato das notas da conferência', () => {
        expect(notaDoReenvioExistente('SH1585904KS-R-1')).toBe('[REENVIO JÁ EXISTIA NO COSMOS: SH1585904KS-R-1]');
    });

    it('o SQL procura por igualdade (o índice do sales_order_number) os -R-1 a -R-10 nos dois formatos, com marca e data', () => {
        const sql = sqlDoReenvioNaIntelipost('kokeshi', '1585904', new Date('2026-11-18T14:32:22Z'));

        expect(sql).not.toMatch(/\blike\b/i);
        expect(sql).toContain("where sales_order_number in ('SH1585904KS-R-1', '#SHOPIFY1585904-R-1', 'SH1585904KS-R-2', ");
        expect(sql).toContain("'SH1585904KS-R-10', '#SHOPIFY1585904-R-10')");
        expect(sql.match(/'[^']*-R-\d+'/g)).toHaveLength(20);
        expect(sql).toContain("and brand_code = 'kokeshi' and created_iso >= '2026-11-18T14:32:22.000Z'");
    });

    it.each([
        ['lescent', 'SH716185LC-R-1'],
        ['barbours', 'SH716185BB-R-1'],
        ['rituaria', 'SH716185RT-R-1'],
        ['bysamia', 'SH716185BS-R-1'],
        ['aua', 'SH716185AU-R-1'],
    ] as const)('a sigla de %s no SH do reenvio', (marca, sh) => {
        expect(sqlDoReenvioNaIntelipost(marca, '716185', new Date('2026-11-18T00:00:00Z'))).toContain(`'${sh}'`);
    });
});
