import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { vi } from 'vitest';
import type { SheetCell } from '@shared/lib/sheets';

/**
 * Mock de `fetch` para o Google (ADR-010): roteia por URL entre o token da conta de serviço, a leitura de valores (de
 * um intervalo ou de vários, no `values:batchGet`), o `values:append` e o `values:batchUpdate`, e registra cada chamada
 * para o teste conferir. **Nenhum teste toca o
 * Google de verdade**, e a chave é gerada aqui, na hora: nada que pareça segredo real mora no repositório.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** A chave privada em PEM PKCS#8 — o formato do `private_key` do JSON da conta de serviço. */
export const CHAVE_PRIVADA_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** Para conferir a assinatura do JWT que o código mandou. */
export const CHAVE_PUBLICA: KeyObject = publicKey;

export const EMAIL_DA_CONTA = 'cxhub@projeto-teste.iam.gserviceaccount.com';

export const GOOGLE_ENV = {
    GOOGLE_PLANILHAS_EMAIL: EMAIL_DA_CONTA,
    GOOGLE_PLANILHAS_TOKEN: CHAVE_PRIVADA_PEM,
    SHEETS_ENV: 'staging',
};

export function stubGoogleEnv(): void {
    for (const [nome, valor] of Object.entries(GOOGLE_ENV)) vi.stubEnv(nome, valor);
}

export interface RespostaMock {
    status?: number;
    json?: unknown;
    /** Cabeçalhos da resposta (ex.: `Retry-After`) */
    headers?: Record<string, string>;
    /** Simula a requisição falhando sem resposta (rede caiu, timeout) */
    rede?: Error;
}

export interface MockGoogleOptions {
    token?: RespostaMock;
    /**
     * Valores da aba lida, ou uma resposta inteira para simular erro. Função: recebe o intervalo A1 pedido
     * (ex.: `'Respostas ao formulário'!1:1`) e devolve uma das duas formas. No `values:batchGet` vale por intervalo, e
     * uma resposta de erro em qualquer um deles é a resposta da requisição inteira.
     */
    leitura?: SheetCell[][] | RespostaMock | ((intervalo: string) => SheetCell[][] | RespostaMock);
    /** Uma resposta para todos os appends, ou uma lista consumida em ordem */
    append?: RespostaMock | RespostaMock[];
    /** Resposta do `values:batchUpdate` */
    atualizacao?: RespostaMock;
}

export interface ChamadaRegistrada {
    url: string;
    method: string;
    body: unknown;
    headers: Record<string, string>;
}

export function responder(r: RespostaMock): Response {
    if (r.rede) throw r.rede;
    return new Response(JSON.stringify(r.json ?? {}), {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...r.headers },
    });
}

/** O intervalo A1 de uma URL de leitura, decodificado (`'aba'!A:J`). */
export function intervaloDaLeitura(url: string): string {
    return decodeURIComponent(url.split('/values/')[1]?.split('?')[0] ?? '');
}

/** Os intervalos A1 de um `values:batchGet`, decodificados e na ordem (`["'aba'!A:A", "'aba'!G:G"]`). */
export function intervalosDoLote(url: string): string[] {
    return new URL(url).searchParams.getAll('ranges');
}

/** Os intervalos de qualquer leitura: os do `values:batchGet`, ou o da leitura de um intervalo só. */
export function intervalosDaLeitura(url: string): string[] {
    if (url.includes('values:batchGet')) return intervalosDoLote(url);
    const intervalo = intervaloDaLeitura(url);
    return intervalo ? [intervalo] : [];
}

export const URL_DO_TOKEN = 'https://oauth2.googleapis.com/token';

export function mockGoogle(opcoes: MockGoogleOptions = {}) {
    const chamadas: ChamadaRegistrada[] = [];
    let appendsFeitos = 0;

    const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        let body: unknown = init?.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch {
                // corpo form-urlencoded (token) fica como texto
            }
        }
        chamadas.push({ url, method, body, headers: { ...(init?.headers as Record<string, string>) } });

        if (url.startsWith(URL_DO_TOKEN)) {
            return responder(opcoes.token ?? { json: { access_token: 'google-token', expires_in: 3600 } });
        }
        if (url.includes(':append')) {
            const lista = Array.isArray(opcoes.append) ? opcoes.append : [opcoes.append ?? { json: {} }];
            const resposta = lista[Math.min(appendsFeitos, lista.length - 1)];
            appendsFeitos++;
            return responder(resposta);
        }
        if (url.includes('values:batchUpdate')) {
            return responder(opcoes.atualizacao ?? { json: {} });
        }
        if (url.includes('values:batchGet')) {
            const intervalos = intervalosDoLote(url);
            const respostas = intervalos.map((intervalo) =>
                (typeof opcoes.leitura === 'function' ? opcoes.leitura(intervalo) : (opcoes.leitura ?? [])));
            const erro = respostas.find((resposta): resposta is RespostaMock => !Array.isArray(resposta));
            if (erro) return responder(erro);
            return responder({ json: { valueRanges: intervalos.map((range, i) => ({ range, values: respostas[i] })) } });
        }
        if (url.startsWith('https://sheets.googleapis.com/')) {
            const leitura = typeof opcoes.leitura === 'function' ? opcoes.leitura(intervaloDaLeitura(url)) : (opcoes.leitura ?? []);
            return responder(Array.isArray(leitura) ? { json: { values: leitura } } : leitura);
        }
        throw new Error(`URL inesperada no teste: ${method} ${url}`);
    });

    return {
        spy,
        chamadas,
        appends: () => chamadas.filter((c) => c.url.includes(':append')),
        atualizacoes: () => chamadas.filter((c) => c.url.includes('values:batchUpdate')),
        leituras: () => chamadas.filter((c) => c.url.startsWith('https://sheets.googleapis.com/') && c.method === 'GET'),
        tokens: () => chamadas.filter((c) => c.url.startsWith(URL_DO_TOKEN)),
    };
}

/** A linha que foi para a planilha no N-ésimo append. */
export function linhaDoAppend(chamada: ChamadaRegistrada): SheetCell[] {
    return (chamada.body as { values: SheetCell[][] }).values[0];
}

/** Planilha/aba/intervalo de um append, decodificados da URL. */
export function destinoDoAppend(chamada: ChamadaRegistrada): string {
    return decodeURIComponent(chamada.url);
}
