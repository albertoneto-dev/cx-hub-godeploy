import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { consultarRegistro } from '@shared/lib/registro';

/** O cliente do acompanhamento no navegador: pergunta onde estão os casos e nunca lança. */

const IDS = ['7c23634b-102e-4eec-a69b-d5c6df2f5619', '4efd9528-aad6-445b-93f3-9729a1dc9d75'];
const TOKEN = 'token-do-login';

describe('consultarRegistro', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('GET com os ids separados por vírgula na query, e o token do login', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(`{"code":"SUCCESS","message":"","estados":{"${IDS[0]}":"aguardando"}}`, { status: 200 }),
        );

        await expect(consultarRegistro(IDS, TOKEN)).resolves.toEqual({
            status: 200,
            body: { code: 'SUCCESS', message: '', estados: { [IDS[0]]: 'aguardando' } },
        });

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(`/api/registro?${new URLSearchParams({ ids: IDS.join(',') }).toString()}`);
        expect(init).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` }, cache: 'no-store' });
    });

    it('401 volta como veio: o acompanhamento decide, sem deslogar a agente', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response('{"code":"UNAUTHORIZED","message":"Token do Cosmos inválido ou expirado."}', { status: 401 }),
        );

        await expect(consultarRegistro(IDS, TOKEN)).resolves.toEqual({
            status: 401,
            body: { code: 'UNAUTHORIZED', message: 'Token do Cosmos inválido ou expirado.' },
        });
    });

    it('falha de rede e resposta que não é do CX Hub viram UNKNOWN_ERROR, sem lançar', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
        await expect(consultarRegistro(IDS, TOKEN)).resolves.toEqual({
            status: 0,
            body: { code: 'UNKNOWN_ERROR', message: 'Falha de rede ao chamar o CX Hub.' },
        });

        vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('<html>erro</html>', { status: 504 }));
        await expect(consultarRegistro(IDS, TOKEN)).resolves.toEqual({
            status: 504,
            body: { code: 'UNKNOWN_ERROR', message: 'Resposta inesperada do CX Hub (HTTP 504).' },
        });
    });
});
