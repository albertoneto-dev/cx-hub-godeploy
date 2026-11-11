import { describe, it, expect, afterEach, vi } from 'vitest';
import { cosmosFetch } from '@shared/lib/cosmos/http';
import { mockFetch, mockFetchError } from '../helpers/api-test-utils';

const ORDER_URL = 'https://api.cosmos.test/organizations/3/orders/42';

describe('cosmosFetch', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('devolve status e corpo JSON', async () => {
        mockFetch({ status: 200, json: { id: 42 } });

        await expect(cosmosFetch(ORDER_URL, { method: 'GET', authorization: 'Bearer t' }))
            .resolves.toEqual({ status: 200, data: { id: 42 }, timedOut: false });
    });

    it('repassa o Authorization como veio e serializa o corpo', async () => {
        const fetchSpy = mockFetch({ status: 200, json: {} });

        await cosmosFetch(ORDER_URL, { method: 'PUT', authorization: 'Bearer t', body: { order: { carrier_id: 1 } } });

        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('PUT');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
        expect(init.body).toBe(JSON.stringify({ order: { carrier_id: 1 } }));
    });

    it('GET vai sem corpo', async () => {
        const fetchSpy = mockFetch({ status: 200, json: {} });

        await cosmosFetch(ORDER_URL, { method: 'GET', authorization: 'Bearer t' });

        expect((fetchSpy.mock.calls[0][1] as RequestInit).body).toBeUndefined();
    });

    it('corpo que não é JSON vira data null, mantendo o status', async () => {
        mockFetch({ status: 502, ok: false, jsonThrows: true });

        await expect(cosmosFetch(ORDER_URL, { method: 'GET', authorization: 'Bearer t' }))
            .resolves.toEqual({ status: 502, data: null, timedOut: false });
    });

    it('timeout vira timedOut, sem lançar', async () => {
        mockFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' }));

        await expect(cosmosFetch(ORDER_URL, { method: 'GET', authorization: 'Bearer t' }))
            .resolves.toEqual({ status: 0, data: null, timedOut: true });
    });

    it('falha de rede vira status 0, sem lançar', async () => {
        mockFetchError(new TypeError('fetch failed'));

        await expect(cosmosFetch(ORDER_URL, { method: 'GET', authorization: 'Bearer t' }))
            .resolves.toEqual({ status: 0, data: null, timedOut: false });
    });
});
