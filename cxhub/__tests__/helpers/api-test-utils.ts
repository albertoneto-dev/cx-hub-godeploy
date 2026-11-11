import { NextRequest } from 'next/server';
import { vi } from 'vitest';

interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
}

export function createRequest(url: string, options: RequestOptions = {}): NextRequest {
    const { method = 'GET', headers = {}, body } = options;
    const init: ConstructorParameters<typeof NextRequest>[1] = { method, headers: new Headers(headers) };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
    }
    return new NextRequest(url, init);
}

export function mockFetch(response: { status?: number; json?: unknown; ok?: boolean; jsonThrows?: boolean }) {
    const { status = 200, json: jsonBody = {}, ok, jsonThrows = false } = response;
    const isOk = ok !== undefined ? ok : status >= 200 && status < 300;

    return vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: isOk,
        status,
        statusText: String(status),
        json: () =>
            jsonThrows
                ? Promise.reject(new SyntaxError('Unexpected end of JSON input'))
                : Promise.resolve(jsonBody),
        text: () => Promise.resolve(jsonThrows ? '' : JSON.stringify(jsonBody)),
    } as Response);
}

export function mockFetchError(error: Error) {
    return vi.spyOn(global, 'fetch').mockRejectedValue(error);
}
