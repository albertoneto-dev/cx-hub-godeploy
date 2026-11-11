import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { conferirTokenNoCosmos } from '@shared/lib/cosmos/http';

/** A conferência do token que fecha as rotas que não passam pelo Cosmos (reembolso, lista de solicitações). */

describe('conferirTokenNoCosmos', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('lê as transportadoras da org com o token de quem chamou', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
        await expect(conferirTokenNoCosmos('9', 'Bearer tok')).resolves.toBe('ok');
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://api.cosmos.test/organizations/9/carriers?per_page=1');
        expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    });

    it.each([
        [401, 'recusado'],
        [403, 'sem_acesso'],
        [500, 'erro'],
    ])('HTTP %i ⇒ %s', async (status, esperado) => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status }));
        await expect(conferirTokenNoCosmos('3', 'Bearer tok')).resolves.toBe(esperado);
    });

    it('timeout e falta de URL', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        await expect(conferirTokenNoCosmos('3', 'Bearer tok')).resolves.toBe('timeout');

        vi.stubEnv('COSMOS_API_URL', '');
        await expect(conferirTokenNoCosmos('3', 'Bearer tok')).resolves.toBe('sem_url');
    });
});
