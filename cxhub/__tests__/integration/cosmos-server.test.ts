import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    getCosmosServiceToken,
    fetchNormalizedCosmosOrder,
    __resetCosmosTokenCache,
} from '@shared/lib/cosmos/server';

/**
 * Contrato de `shared/lib/cosmos/server.ts` — o acesso ao Cosmos a partir do SERVIDOR
 * (a porta do bot não tem sessão de agente, então o token é mintado aqui).
 *
 * O que estes testes prendem:
 * - falha fechada de configuração (env faltando ⇒ lança, sem tocar a rede);
 * - cache do token com margem de segurança sobre o `exp` do JWT;
 * - busca do pedido por `external_id` com a MESMA régua do `getCosmosOrder` do cliente;
 * - toda dúvida na busca degrada para `null` (nunca lança), porque a jusante um erro aqui
 *   não pode derrubar a solicitação;
 * - é código de SERVIDOR: URL absoluta sempre, e nenhum fallback Shopify.
 */

const BASE = 'https://api.cosmos.test';

// ─── Fixtures ────────────────────────────────────────────────────────

/** JWT de verdade só no formato: header.payload.assinatura, com `exp` legível no payload. */
function jwt(expEmSegundos: number): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expEmSegundos, sub: 'cxhub' })
    ).toString('base64url');
    return `${header}.${payload}.assinatura-irrelevante`;
}

const LIST_MATCH = [{ id: 999, external_id: 'SH220183BB' }];

const DETAIL = {
    id: 999,
    external_id: 'SH220183BB',
    invoice_number: '123456',
    invoice_access_key: 'chave-123',
    customer: { name: 'Maria Cliente', phone: '11999999999' },
    shipping: {
        name: 'Maria Cliente',
        phone: '11999999999',
        service_name: 'PAC',
        cost: '15.00',
        address: {
            street: 'Rua Teste',
            number: '123',
            complement: '',
            neighborhood: 'Centro',
            city: 'São Paulo',
            state: 'SP',
            postal_code: '01001-000',
        },
    },
    carrier: { id: 161, name: 'Jadlog' },
    line_items: [
        { id: 1, product_id: 5001, sku: 'SKU-KIT', name: 'Kit Teste', quantity: 1, unit_price: '150.00' },
    ],
    erp_payload: {
        items: [{ sku: 'SKU-KIT', quantity: 1, unit_price: 150, discount_value: 0 }],
    },
    distribution_center: { state_code: 'SP' },
    distribution_center_status: 'pending',
    shipping_cost: '15.00',
    discount_amount: '0',
    created_at: '2026-01-01T00:00:00Z',
};

const CATALOGO = [
    { id: 5001, sku: 'SKU-KIT', name: 'Kit Teste', is_kit: true, price: '150.00', active: true, gtin: '', ncm: '', created_at: '', updated_at: '' },
    { id: 5002, sku: 'SKU-COMP', name: 'Componente', is_kit: false, price: '75.00', active: true, gtin: '', ncm: '', created_at: '', updated_at: '' },
];

// ─── Mock de fetch roteado por URL ───────────────────────────────────

interface Reply { status?: number; json?: unknown; ok?: boolean }

function installFetch(handler: (url: string, init?: RequestInit) => Reply) {
    return vi.spyOn(global, 'fetch').mockImplementation((async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const reply = handler(url, init);
        const status = reply.status ?? 200;
        return {
            ok: reply.ok ?? (status >= 200 && status < 300),
            status,
            statusText: String(status),
            json: () => Promise.resolve(reply.json ?? {}),
            text: () => Promise.resolve(JSON.stringify(reply.json ?? {})),
        } as Response;
    }) as unknown as typeof fetch);
}

/** Caminho felizinho: signin ok, lista com 1 casamento, detalhe ok, catálogo com o kit. */
function rotasFelizes(overrides: {
    token?: string;
    lista?: unknown;
    listaStatus?: number;
    detalheStatus?: number;
} = {}) {
    return installFetch((url) => {
        if (url.includes('/auth/signin')) {
            return { json: { credentials: { token: overrides.token ?? jwt(3600) } } };
        }
        if (/\/products\/\d+/.test(url)) {
            return { json: { id: 5001, sku: 'SKU-KIT', kit_skus: ['SKU-COMP', 'SKU-COMP'] } };
        }
        if (url.includes('/products')) {
            return { json: CATALOGO };
        }
        if (/\/orders\/\d+/.test(url)) {
            return { status: overrides.detalheStatus ?? 200, json: DETAIL };
        }
        if (url.includes('/orders')) {
            return { status: overrides.listaStatus ?? 200, json: overrides.lista ?? LIST_MATCH };
        }
        return { status: 404, json: {} };
    });
}

function urlsChamadas(spy: ReturnType<typeof installFetch>): string[] {
    return spy.mock.calls.map((c) => String(c[0]));
}

// ─── Suíte ───────────────────────────────────────────────────────────

describe('shared/lib/cosmos/server — token de serviço', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', BASE);
        vi.stubEnv('COSMOS_EMAIL', 'robo@gocase.com');
        vi.stubEnv('COSMOS_PASSWORD', 'senha-do-robo');
        __resetCosmosTokenCache();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        __resetCosmosTokenCache();
    });

    it('A1. faz POST em /auth/signin com as credenciais do ambiente e devolve credentials.token', async () => {
        const token = jwt(3600);
        const spy = rotasFelizes({ token });

        const resultado = await getCosmosServiceToken();

        expect(resultado).toBe(token);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0][0])).toBe(`${BASE}/auth/signin`);
        const init = spy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
            email: 'robo@gocase.com',
            password: 'senha-do-robo',
        });
    });

    it.each([
        ['COSMOS_API_URL'],
        ['COSMOS_EMAIL'],
        ['COSMOS_PASSWORD'],
    ])('A2. falha fechada: sem %s lança e não toca a rede', async (envAusente) => {
        vi.stubEnv(envAusente, undefined as unknown as string);
        const spy = rotasFelizes();

        await expect(getCosmosServiceToken()).rejects.toThrow();
        expect(spy).not.toHaveBeenCalled();
    });

    it('A3. lança quando o signin responde não-ok', async () => {
        installFetch((url) =>
            url.includes('/auth/signin') ? { status: 401, json: { error: 'nope' } } : { status: 404 }
        );

        await expect(getCosmosServiceToken()).rejects.toThrow();
    });

    it('A4. lança quando o signin responde sem credentials.token', async () => {
        installFetch((url) =>
            url.includes('/auth/signin') ? { status: 200, json: { credentials: {} } } : { status: 404 }
        );

        await expect(getCosmosServiceToken()).rejects.toThrow();
    });

    it('A5. cacheia: duas chamadas dentro da validade fazem UM único signin', async () => {
        const spy = rotasFelizes({ token: jwt(3600) });

        const t1 = await getCosmosServiceToken();
        const t2 = await getCosmosServiceToken();

        expect(t1).toBe(t2);
        expect(spy.mock.calls.filter((c) => String(c[0]).includes('/auth/signin'))).toHaveLength(1);
    });

    it('A6. margem de segurança: token que expira em ~10s é tratado como expirado e renova', async () => {
        const spy = installFetch((url) =>
            url.includes('/auth/signin') ? { json: { credentials: { token: jwt(10) } } } : { status: 404 }
        );

        await getCosmosServiceToken();
        await getCosmosServiceToken();

        expect(spy.mock.calls.filter((c) => String(c[0]).includes('/auth/signin'))).toHaveLength(2);
    });

    it('A7. __resetCosmosTokenCache limpa o cache (isolamento entre testes)', async () => {
        const spy = rotasFelizes({ token: jwt(3600) });

        await getCosmosServiceToken();
        __resetCosmosTokenCache();
        await getCosmosServiceToken();

        expect(spy.mock.calls.filter((c) => String(c[0]).includes('/auth/signin'))).toHaveLength(2);
    });
});

describe('shared/lib/cosmos/server — busca do pedido normalizado', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', BASE);
        vi.stubEnv('COSMOS_EMAIL', 'robo@gocase.com');
        vi.stubEnv('COSMOS_PASSWORD', 'senha-do-robo');
        __resetCosmosTokenCache();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        __resetCosmosTokenCache();
    });

    it('B1. sem token recebido, minta um pelo signin e usa Bearer na listagem', async () => {
        const token = jwt(3600);
        const spy = rotasFelizes({ token });

        await fetchNormalizedCosmosOrder('lescent', '220183');

        const urls = urlsChamadas(spy);
        expect(urls.some((u) => u.includes('/auth/signin'))).toBe(true);

        const idxLista = urls.findIndex((u) => u.includes('external_id='));
        expect(idxLista).toBeGreaterThan(-1);
        const headers = (spy.mock.calls[idxLista][1] as RequestInit).headers as Record<string, string>;
        expect(headers['Authorization']).toBe(`Bearer ${token}`);
    });

    it('B2. com token recebido, NÃO chama o signin', async () => {
        const spy = rotasFelizes();

        await fetchNormalizedCosmosOrder('lescent', '220183', 'token-vindo-de-fora');

        const urls = urlsChamadas(spy);
        expect(urls.some((u) => u.includes('/auth/signin'))).toBe(false);
        const idxLista = urls.findIndex((u) => u.includes('external_id='));
        const headers = (spy.mock.calls[idxLista][1] as RequestInit).headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer token-vindo-de-fora');
    });

    it.each([
        ['lescent', '3'],
        ['kokeshi', '4'],
        ['bysamia', '5'],
        ['aua', '6'],
        ['barbours', '8'],
        ['rituaria', '9'],
    ])('B3. mapeia brand=%s para /organizations/%s/orders', async (brand, orgId) => {
        const spy = rotasFelizes();

        await fetchNormalizedCosmosOrder(brand, '220183', 'tok');

        const lista = urlsChamadas(spy).find((u) => u.includes('external_id='))!;
        expect(lista).toContain(`/organizations/${orgId}/orders`);
    });

    it.each([
        ['#220183'],
        ['SH220183BB'],
        ['220-183'],
    ])('B4. sanitiza o número do pedido (%s) para só dígitos na query', async (sujo) => {
        const spy = rotasFelizes();

        await fetchNormalizedCosmosOrder('lescent', sujo, 'tok');

        const lista = urlsChamadas(spy).find((u) => u.includes('external_id='))!;
        expect(lista).toContain('external_id=220183');
        expect(lista).not.toContain('#');
        expect(lista).not.toMatch(/external_id=[^&]*[A-Za-z-]/);
    });

    it('B5. usa SEMPRE URL absoluta do COSMOS_API_URL — nada de rota relativa', async () => {
        const spy = rotasFelizes();

        await fetchNormalizedCosmosOrder('lescent', '220183');

        const urls = urlsChamadas(spy);
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) {
            expect(u.startsWith(BASE), `URL não absoluta do Cosmos: ${u}`).toBe(true);
        }
    });

    it('B6. não tem fallback Shopify: nenhuma URL da Shopify é chamada', async () => {
        const spy = installFetch((url) => {
            if (url.includes('/auth/signin')) return { json: { credentials: { token: jwt(3600) } } };
            if (url.includes('/orders')) return { status: 200, json: [] };
            return { status: 404 };
        });

        const resultado = await fetchNormalizedCosmosOrder('lescent', '220183');

        expect(resultado).toBeNull();
        for (const u of urlsChamadas(spy)) {
            expect(u.toLowerCase()).not.toContain('shopify.com');
            expect(u.toLowerCase()).not.toContain('/api/shopify');
        }
    });

    it('B7. escolhe o pedido pela régua do external_id: regex ^SH<id>[a-zA-Z]{2}\\d*$', async () => {
        const spy = rotasFelizes({
            lista: [
                { id: 111, external_id: 'SH999999BB' },
                { id: 222, external_id: 'SH220183BB1' },
            ],
        });

        const resultado = await fetchNormalizedCosmosOrder('lescent', '220183', 'tok');

        expect(resultado).not.toBeNull();
        expect(urlsChamadas(spy).some((u) => /\/orders\/222(\?|$)/.test(u))).toBe(true);
    });

    it('B8. aceita também o casamento exato #SHOPIFY<id>', async () => {
        const spy = rotasFelizes({ lista: [{ id: 333, external_id: '#SHOPIFY220183' }] });

        const resultado = await fetchNormalizedCosmosOrder('lescent', '220183', 'tok');

        expect(resultado).not.toBeNull();
        expect(urlsChamadas(spy).some((u) => /\/orders\/333(\?|$)/.test(u))).toBe(true);
    });

    it('B9. devolve null quando a lista vem vazia (sem lançar)', async () => {
        rotasFelizes({ lista: [] });

        await expect(fetchNormalizedCosmosOrder('lescent', '220183', 'tok')).resolves.toBeNull();
    });

    it('B10. devolve null quando nenhum external_id casa a régua', async () => {
        rotasFelizes({ lista: [{ id: 444, external_id: 'SH220183' }, { id: 445, external_id: 'PEDIDO220183' }] });

        await expect(fetchNormalizedCosmosOrder('lescent', '220183', 'tok')).resolves.toBeNull();
    });

    it('B11. devolve null em HTTP 404 na listagem', async () => {
        rotasFelizes({ listaStatus: 404 });

        await expect(fetchNormalizedCosmosOrder('lescent', '220183', 'tok')).resolves.toBeNull();
    });

    it('B12. devolve null (não lança) quando o fetch da listagem explode', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

        await expect(fetchNormalizedCosmosOrder('lescent', '220183', 'tok')).resolves.toBeNull();
    });

    it('B13. devolve null quando o detalhe responde não-ok', async () => {
        rotasFelizes({ detalheStatus: 500 });

        await expect(fetchNormalizedCosmosOrder('lescent', '220183', 'tok')).resolves.toBeNull();
    });

    it('B14. devolve o pedido normalizado (adaptCosmosOrder) do detalhe', async () => {
        rotasFelizes();

        const pedido = await fetchNormalizedCosmosOrder('lescent', '#220183', 'tok');

        expect(pedido).not.toBeNull();
        expect(pedido!.source).toBe('cosmos');
        expect(pedido!.cosmos_id).toBe(999);
        expect(pedido!.numeroPedido).toBe('SH220183BB');
        expect(pedido!.numeroNF).toBe('123456');
        expect(pedido!.carrierId).toBe(161);
        expect(pedido!.carrierServiceName).toBe('PAC');
        expect(pedido!.endereco.cep).toBe('01001-000');
        expect(pedido!.endereco.estado).toBe('SP');
        expect(pedido!.erpPayloadItems).toEqual([
            { sku: 'SKU-KIT', quantity: 1, unit_price: 150, discount_value: 0 },
        ]);
    });

    it('B15. devolve o pedido ENRIQUECIDO: o kit vem com componentes expandidos', async () => {
        rotasFelizes();

        const pedido = await fetchNormalizedCosmosOrder('lescent', '220183', 'tok');

        expect(pedido).not.toBeNull();
        const kit = pedido!.produtos[0];
        expect(kit.isKit).toBe(true);
        expect(kit.kitComponents).toBeDefined();
        expect(kit.kitComponents).toHaveLength(1);
        expect(kit.kitComponents![0].sku).toBe('SKU-COMP');
        expect(kit.kitComponents![0].product_id).toBe(5002);
        expect(kit.kitComponents![0].quantidade).toBe(2);
    });
});

// ─── Retentativa (T3 · ADR-005 §1) ───────────────────────────────────

/**
 * O contorno automático que vem ANTES de qualquer aviso.
 *
 * A razão de existir: até esta fatia não havia uma única retentativa no caminho do bot, então um blip
 * de rede no ERP custava uma tratativa **manual** — trabalho humano para um problema que a máquina
 * resolvia sozinha na segunda tentativa. A régua é retentar só o que é **transitório**: 5xx e falha de
 * rede. Credencial errada (401/403) não melhora tentando de novo, e insistir só queima orçamento.
 */
describe('shared/lib/cosmos/server — retentativa do contorno automático', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', BASE);
        vi.stubEnv('COSMOS_EMAIL', 'robo@gocase.com');
        vi.stubEnv('COSMOS_PASSWORD', 'senha-do-robo');
        __resetCosmosTokenCache();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        __resetCosmosTokenCache();
    });

    it('R1. signin com 503 na 1ª tentativa SUCEDE na 2ª (o que antes degradava para manual)', async () => {
        let tentativas = 0;
        const spy = installFetch((url) => {
            if (url.includes('/auth/signin')) {
                tentativas++;
                return tentativas === 1
                    ? { status: 503, json: {} }
                    : { json: { credentials: { token: jwt(3600) } } };
            }
            return { status: 404, json: {} };
        });

        // Com deadline — é como o route handler chama desde a correção do orçamento agregado. Retentar
        // sem saber quanto tempo resta é o que estourava o `maxDuration` e matava a gravação da linha.
        const token = await getCosmosServiceToken(Date.now() + 20_000);

        expect(token).toBeTruthy();
        expect(urlsChamadas(spy).filter((u) => u.includes('/auth/signin'))).toHaveLength(2);
    });

    it('R2. signin com erro de REDE na 1ª tentativa sucede na 2ª', async () => {
        let tentativas = 0;
        vi.spyOn(global, 'fetch').mockImplementation((async () => {
            tentativas++;
            if (tentativas === 1) throw new Error('ECONNRESET');
            return {
                ok: true,
                status: 200,
                statusText: '200',
                json: () => Promise.resolve({ credentials: { token: jwt(3600) } }),
                text: () => Promise.resolve(''),
            } as Response;
        }) as unknown as typeof fetch);

        await expect(getCosmosServiceToken(Date.now() + 20_000)).resolves.toBeTruthy();
        expect(tentativas).toBe(2);
    });

    it('R3. esgotadas as tentativas, LANÇA — quem chama degrada para registro (INV-05)', async () => {
        const spy = installFetch((url) =>
            url.includes('/auth/signin') ? { status: 503, json: {} } : { status: 404, json: {} }
        );

        await expect(getCosmosServiceToken(Date.now() + 20_000)).rejects.toThrow();
        // Tentou mais de uma vez, e não infinitamente.
        const chamadas = urlsChamadas(spy).filter((u) => u.includes('/auth/signin')).length;
        expect(chamadas).toBeGreaterThan(1);
        expect(chamadas).toBeLessThanOrEqual(3);
    });

    it('R3b. SEM orçamento não retenta — falha fechada, para o retry não competir com a gravação da linha', async () => {
        const spy = installFetch((url) =>
            url.includes('/auth/signin') ? { status: 503, json: {} } : { status: 404, json: {} }
        );

        // Sem deadline o custo do pior caso é desconhecido, e uma 2ª tentativa pode empurrar o handler
        // para além do `maxDuration` — onde a plataforma mata o processo e NENHUM catch roda, levando
        // junto a repostagem que garante a linha. Uma tentativa só, e degrada.
        await expect(getCosmosServiceToken()).rejects.toThrow();
        expect(urlsChamadas(spy).filter((u) => u.includes('/auth/signin'))).toHaveLength(1);
    });

    it('R3c. deadline apertado não retenta — sobra tem que dar para gravar a linha', async () => {
        const spy = installFetch((url) =>
            url.includes('/auth/signin') ? { status: 503, json: {} } : { status: 404, json: {} }
        );

        // 500ms restantes: menos que o backoff + a janela mínima de uma tentativa útil.
        await expect(getCosmosServiceToken(Date.now() + 500)).rejects.toThrow();
        expect(urlsChamadas(spy).filter((u) => u.includes('/auth/signin'))).toHaveLength(1);
    });

    it('R4. NÃO retenta credencial recusada (401) — tentar de novo não conserta senha errada', async () => {
        const spy = installFetch((url) =>
            url.includes('/auth/signin') ? { status: 401, json: {} } : { status: 404, json: {} }
        );

        await expect(getCosmosServiceToken()).rejects.toThrow();
        expect(urlsChamadas(spy).filter((u) => u.includes('/auth/signin'))).toHaveLength(1);
    });

    it('R4b. GUARDA DE REGRESSÃO: 404 chama o fetch UMA única vez (4xx não é transitório)', async () => {
        // Pedido inexistente é resposta legítima do ERP, não blip: retentar só queima orçamento que
        // a gravação da linha vai precisar.
        const spy = rotasFelizes({ listaStatus: 404 });

        await expect(fetchNormalizedCosmosOrder('lescent', '220183', 'tok')).resolves.toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('R5. a busca do pedido também contorna: lista com 500 na 1ª devolve o pedido na 2ª', async () => {
        let tentativasLista = 0;
        installFetch((url) => {
            if (url.includes('/auth/signin')) {
                return { json: { credentials: { token: jwt(3600) } } };
            }
            if (/\/products\/\d+/.test(url)) {
                return { json: { id: 5001, sku: 'SKU-KIT', kit_skus: ['SKU-COMP', 'SKU-COMP'] } };
            }
            if (url.includes('/products')) return { json: CATALOGO };
            if (/\/orders\/\d+/.test(url)) return { json: DETAIL };
            if (url.includes('/orders')) {
                tentativasLista++;
                return tentativasLista === 1 ? { status: 500, json: {} } : { json: LIST_MATCH };
            }
            return { status: 404, json: {} };
        });

        const pedido = await fetchNormalizedCosmosOrder('lescent', '220183', 'tok');

        expect(pedido).not.toBeNull();
        expect(tentativasLista).toBe(2);
    });

    // ─── O corpo descartado da tentativa que falhou ──────────────────
    //
    // Retentar cria uma resposta órfã: os headers chegaram, o corpo não foi lido e ninguém mais vai
    // lê-lo. Em `undici` esse corpo continua preso ao socket até ser consumido ou cancelado — e uma
    // rajada de 5xx (justamente quando o ERP está em sofrimento) empilha conexões presas no pool.
    // Quem descarta a resposta é quem tem que fechá-la.

    /** Resposta com `body.cancel` observável — o `installFetch` acima não modela o `body`. */
    function respostaCom(status: number, json: unknown, cancel: () => Promise<void>) {
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: String(status),
            body: { cancel },
            json: () => Promise.resolve(json),
            text: () => Promise.resolve(JSON.stringify(json)),
        } as unknown as Response;
    }

    it('R6. signin 5xx descartado tem o corpo CANCELADO antes da retentativa', async () => {
        const cancel = vi.fn().mockResolvedValue(undefined);
        let tentativas = 0;

        vi.spyOn(global, 'fetch').mockImplementation((async (input: unknown) => {
            const url = String(input);
            if (url.includes('/auth/signin')) {
                tentativas++;
                return tentativas === 1
                    ? respostaCom(503, {}, cancel)
                    : respostaCom(200, { credentials: { token: jwt(3600) } }, vi.fn());
            }
            return respostaCom(404, {}, vi.fn());
        }) as unknown as typeof fetch);

        await expect(getCosmosServiceToken(Date.now() + 20_000)).resolves.toBeTruthy();

        expect(tentativas).toBe(2);
        expect(cancel, 'o corpo da resposta 503 descartada não foi cancelado').toHaveBeenCalled();
    });

    it('R7. listagem 5xx descartada tem o corpo CANCELADO antes da retentativa', async () => {
        const cancel = vi.fn().mockResolvedValue(undefined);
        let tentativasLista = 0;

        vi.spyOn(global, 'fetch').mockImplementation((async (input: unknown) => {
            const url = String(input);
            if (url.includes('/auth/signin')) {
                return respostaCom(200, { credentials: { token: jwt(3600) } }, vi.fn());
            }
            if (/\/products\/\d+/.test(url)) {
                return respostaCom(200, { id: 5001, sku: 'SKU-KIT', kit_skus: ['SKU-COMP', 'SKU-COMP'] }, vi.fn());
            }
            if (url.includes('/products')) return respostaCom(200, CATALOGO, vi.fn());
            if (/\/orders\/\d+/.test(url)) return respostaCom(200, DETAIL, vi.fn());
            if (url.includes('/orders')) {
                tentativasLista++;
                return tentativasLista === 1
                    ? respostaCom(500, {}, cancel)
                    : respostaCom(200, LIST_MATCH, vi.fn());
            }
            return respostaCom(404, {}, vi.fn());
        }) as unknown as typeof fetch);

        const pedido = await fetchNormalizedCosmosOrder('lescent', '220183', 'tok');

        expect(pedido).not.toBeNull();
        expect(tentativasLista).toBe(2);
        expect(cancel, 'o corpo da resposta 500 descartada não foi cancelado').toHaveBeenCalled();
    });
});

// ─── Servidor que estola NO CORPO (headers na hora, corpo nunca) ─────
//
// O caso que nenhum teste de rede cobre: o ERP aceita a conexão, devolve os headers — o `fetch`
// RESOLVE, e nesse instante o relógio da requisição já cumpriu seu papel — e então trava antes de
// mandar o corpo. Quem lê `res.json()` fica esperando um dado que nunca chega. Não é hipótese
// exótica: é o que um balanceador meio morto, um proxy com keep-alive furado ou um banco travado do
// outro lado produzem. E o custo aqui não é lentidão: o handler passa do `maxDuration`, a plataforma
// mata o processo, NENHUM catch roda — e a solicitação da cliente evapora sem linha e sem aviso.
//
// A régua: a leitura do corpo tem que estar dentro da MESMA janela de tempo da requisição.

/** AbortError como o `fetch` real levanta quando o signal dispara. */
function abortError(): Error {
    return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/**
 * `fetch` que resolve na hora com headers e cujo corpo só se resolve (rejeitando) se o `signal`
 * passado à requisição disparar `abort`. Sem relógio armado no momento da leitura, pendura.
 */
function installFetchQueEstolaNoCorpo() {
    return vi.spyOn(global, 'fetch').mockImplementation((async (_input: unknown, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | null | undefined;
        const corpoQueNuncaChega = () =>
            new Promise<never>((_resolve, reject) => {
                if (!signal) return;
                if (signal.aborted) return reject(abortError());
                signal.addEventListener('abort', () => reject(abortError()));
            });
        return {
            ok: true,
            status: 200,
            statusText: '200',
            body: { cancel: () => Promise.resolve() },
            json: corpoQueNuncaChega,
            text: corpoQueNuncaChega,
        } as unknown as Response;
    }) as unknown as typeof fetch);
}

type Desfecho<T> = { tipo: 'valor'; valor: T } | { tipo: 'erro'; erro: unknown } | { tipo: 'pendurou' };

/**
 * Observa o desfecho SEM deixar a suíte travar. `pendurou` é um desfecho de primeira classe de
 * propósito: se o teste só usasse o timeout do vitest, "travou para sempre" e "rejeitou" ficariam
 * indistinguíveis num `rejects.toThrow()`.
 */
function comGuarda<T>(p: Promise<T>, ms: number): Promise<Desfecho<T>> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ tipo: 'pendurou' }), ms);
        p.then(
            (valor) => { clearTimeout(timer); resolve({ tipo: 'valor', valor }); },
            (erro) => { clearTimeout(timer); resolve({ tipo: 'erro', erro }); }
        );
    });
}

/**
 * Teto MUITO acima da janela configurada (TIMEOUT=400 abaixo). Não é a asserção da janela exata —
 * é só o que separa "se resolveu" de "pendurou para sempre" sem travar a suíte.
 */
const TETO_DA_GUARDA = 10_000;

describe('shared/lib/cosmos/server — corpo que estola depois dos headers', () => {
    beforeEach(() => {
        vi.stubEnv('COSMOS_API_URL', BASE);
        vi.stubEnv('COSMOS_EMAIL', 'robo@gocase.com');
        vi.stubEnv('COSMOS_PASSWORD', 'senha-do-robo');
        vi.stubEnv('TIMEOUT', '400');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        __resetCosmosTokenCache();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        __resetCosmosTokenCache();
    });

    it('C1. getCosmosServiceToken NÃO pendura no corpo do signin — falha dentro da janela', async () => {
        installFetchQueEstolaNoCorpo();

        const desfecho = await comGuarda(getCosmosServiceToken(), TETO_DA_GUARDA);

        expect(
            desfecho.tipo,
            'o signin pendurou na leitura do corpo: o relógio não cobre a resposta'
        ).toBe('erro');
    }, TETO_DA_GUARDA + 5_000);

    it('C2. fetchNormalizedCosmosOrder NÃO pendura no corpo da listagem — degrada para null dentro da janela', async () => {
        installFetchQueEstolaNoCorpo();

        const desfecho = await comGuarda(
            fetchNormalizedCosmosOrder('lescent', '220183', 'tok'),
            TETO_DA_GUARDA
        );

        expect(
            desfecho.tipo,
            'a busca do pedido pendurou na leitura do corpo: o relógio não cobre a resposta'
        ).toBe('valor');
        // Contrato já vigente (B11/B12/B13): dúvida na busca vira `null`, nunca exceção.
        expect((desfecho as { valor: unknown }).valor).toBeNull();
    }, TETO_DA_GUARDA + 5_000);
});
