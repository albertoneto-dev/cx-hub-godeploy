import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/resend/data/route';
import { createRequest } from '../helpers/api-test-utils';

/**
 * `GET /api/resend/data` lê os dropdowns do app GoDeploy `rota-dados-cxhub` (ADR-009), no contrato da seção 12 de
 * docs/prompt-godeploy-dados-formulario.md: o corpo do app passa sem transformação, e cada falha do app ou do caminho
 * vira um status que a tela já sabe mostrar (erro visível + "Tentar novamente", RF-02).
 */

const APP = 'https://rota-dados-cxhub.test';
const DADOS = {
    marcas: ['lescent', 'kokeshi'],
    'responsáveis': ['Ana Souza'],
    motivos: ['Avaria informada pelo cliente'],
    transportadoras_reenvio: [{ CD: 'SP', 'Transportadoras de Reenvio': 'J&T Express, PAC, Sedex' }],
};

const pedir = (origin = 'reenvio') => GET(createRequest(`http://localhost/api/resend/data?origin=${origin}`));
const resposta = (status: number, corpo?: unknown) =>
    new Response(corpo === undefined ? null : JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.stubEnv('FORM_DATA_API_URL', APP);
    vi.stubEnv('FORM_DATA_API_TOKEN', 'token-do-app');
    vi.stubEnv('FORM_DATA_GODEPLOY_KEY', 'gdk_chave');
    vi.stubEnv('TIMEOUT', '10000');
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(resposta(200, DADOS));
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/resend/data — o pedido ao app', () => {
    it('pede ao app a origem certa, com o token do app e a chave do gateway, sem seguir redirecionamento', async () => {
        await pedir('reembolso');

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${APP}/api/v1/form-data?origin=reembolso`);
        expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
        // Sem a opção cache: o runtime do Worker pode recusá-la (no app GoDeploy cx-hub não existe o cache do Next).
        expect(init).not.toHaveProperty('cache');
        expect(init.headers).toMatchObject({ 'x-form-data-token': 'token-do-app', Authorization: 'Bearer gdk_chave' });
    });

    it('sem a chave gdk_ (o app rodando local, sem gateway), o Authorization não vai', async () => {
        vi.stubEnv('FORM_DATA_GODEPLOY_KEY', '');
        await pedir();

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(init.headers).not.toHaveProperty('Authorization');
        expect(init.headers).toHaveProperty('x-form-data-token', 'token-do-app');
    });

    it('barra no fim da URL base não vira barra dupla', async () => {
        vi.stubEnv('FORM_DATA_API_URL', `${APP}/`);
        await pedir();
        expect(fetchSpy.mock.calls[0][0]).toBe(`${APP}/api/v1/form-data?origin=reenvio`);
    });

    it.each(['', 'outra', 'REENVIO'])('origin %j é recusada com 400, sem chamar o app', async (origin) => {
        const res = await pedir(origin);
        expect(res.status).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each(['FORM_DATA_API_URL', 'FORM_DATA_API_TOKEN'])('sem %s responde 500 sem chamar o app (falha fechada)', async (env) => {
        vi.stubEnv(env, '');
        const res = await pedir();
        expect(res.status).toBe(500);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('GET /api/resend/data — o que volta para a tela', () => {
    it('200 do app passa sem transformação', async () => {
        const res = await pedir();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(DADOS);
    });

    it('200 fora do contrato (sem marcas) vira 502, em vez de dropdown vazio', async () => {
        fetchSpy.mockResolvedValue(resposta(200, { ...DADOS, marcas: [] }));
        const res = await pedir();
        expect(res.status).toBe(502);
    });

    it('200 que não é JSON vira 502', async () => {
        fetchSpy.mockResolvedValue(new Response('<html>login</html>', { status: 200 }));
        expect((await pedir()).status).toBe(502);
    });

    it.each([302, 401, 403])('HTTP %i (credencial do gateway ou do app recusada) vira 502, com log da causa', async (status) => {
        fetchSpy.mockResolvedValue(resposta(status, status === 302 ? undefined : { error: 'x', code: 'UNAUTHORIZED' }));
        const res = await pedir();

        expect(res.status).toBe(502);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('credencial do app de configuração recusada'));
    });

    it.each(['NOT_CONFIGURED', 'CONFIG_INCOMPLETE', 'DB_UNAVAILABLE'])('503 %s do app passa como 503, com o code', async (code) => {
        fetchSpy.mockResolvedValue(resposta(503, { error: 'x', code }));
        const res = await pedir();

        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ code });
    });

    it('400 do app passa como 400', async () => {
        fetchSpy.mockResolvedValue(resposta(400, { error: 'x', code: 'INVALID_ORIGIN' }));
        expect((await pedir()).status).toBe(400);
    });

    it.each([404, 405, 500])('HTTP %i do app vira 502', async (status) => {
        fetchSpy.mockResolvedValue(resposta(status, { error: 'x', code: 'INTERNAL' }));
        expect((await pedir()).status).toBe(502);
    });

    it('app que não responde no TIMEOUT vira 504', async () => {
        fetchSpy.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        expect((await pedir()).status).toBe(504);
    });

    it('erro de rede vira 502', async () => {
        fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
        expect((await pedir()).status).toBe(502);
    });
});
