import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/datamart/products/route';
import { esquecerCatalogos } from '@shared/lib/datamart/catalogoServer';
import { fnv1a32 } from '@shared/lib/datamart/catalogo';
import { createRequest } from '../helpers/api-test-utils';

/**
 * `GET /api/datamart/products?brand=`: o catálogo de produtos avulsos das marcas sem Cosmos, do Data Mart (ADR-016).
 * Exige o token do login, conferido no Cosmos (org da Lescent) como na lista de solicitações.
 */

const AUTH = 'Bearer test-token';
const COSMOS = 'https://api.cosmos.test';
const METABASE = 'https://metabase.test';

let tokenCosmos: number;
let respostaMetabase: (sql: string) => Response;
let consultas: string[];
let conferencias: string[];

const linhas = (rows: unknown[][]) => new Response(JSON.stringify({ status: 'completed', data: { rows } }), { status: 202 });

function instalarFetch() {
    consultas = [];
    conferencias = [];
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith(`${COSMOS}/organizations/`)) {
            conferencias.push(url);
            return new Response(JSON.stringify(tokenCosmos === 200 ? [] : { error: 'Token inválido' }), { status: tokenCosmos });
        }
        if (url === `${METABASE}/api/dataset`) {
            const sql = JSON.parse(String(init?.body)).native.query as string;
            consultas.push(sql);
            return respostaMetabase(sql);
        }
        throw new Error(`fetch inesperado: ${url}`);
    });
}

function pedir(query: string, headers: Record<string, string> = { Authorization: AUTH }) {
    return GET(createRequest(`http://localhost/api/datamart/products?${query}`, { headers }));
}

beforeEach(() => {
    esquecerCatalogos();
    vi.stubEnv('COSMOS_API_URL', COSMOS);
    vi.stubEnv('METABASE_URL', METABASE);
    vi.stubEnv('METABASE_API_KEY', 'chave');
    vi.stubEnv('METABASE_DATABASE_ID', '43');
    tokenCosmos = 200;
    respostaMetabase = (sql) => (sql.includes('vw_tiny_cadastro_produtos')
        ? linhas([['30001', 'Escova Polvo', true]])
        : linhas([['20001', '7898953490213 - Shampoo Nutritivo 300ml', true, null, 49.9], ['AP01041', 'Sérum Kokeshi', true, '20014', 99]]));
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/datamart/products', () => {
    it('Ápice: confere o token na org da Lescent e devolve o catálogo do Data Mart com o Tiny', async () => {
        instalarFetch();

        const res = await pedir('brand=apice');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            products: [
                { id: fnv1a32('30001'), sku: '30001', name: 'Escova Polvo', price: '0.00', is_kit: false, ativo: true },
                { id: fnv1a32('20001'), sku: '20001', name: 'Shampoo Nutritivo 300ml', price: '49.90', is_kit: false, ativo: true },
            ],
        });
        expect(conferencias).toEqual([`${COSMOS}/organizations/3/carriers?per_page=1`]);
        expect(consultas).toHaveLength(2);
        expect(consultas[0]).toContain("marca = 'apice' and is_kit = false");
    });

    it('a marca vem em qualquer caixa; Yenzah e Denavita leem só o Data Mart', async () => {
        instalarFetch();

        const res = await pedir('brand=%20Yenzah%20');

        expect(res.status).toBe(200);
        expect(consultas).toHaveLength(1);
        expect(consultas[0]).toContain("marca = 'yenzah' and is_kit = false");
    });

    it('o catálogo fica guardado (6 h): a segunda chamada confere o token de novo, mas não lê o Data Mart', async () => {
        instalarFetch();

        await pedir('brand=denavita');
        const res = await pedir('brand=denavita');

        expect(res.status).toBe(200);
        expect(conferencias).toHaveLength(2);
        expect(consultas).toHaveLength(1);
    });

    it.each([
        ['', 'Parâmetro brand ausente.'],
        ['brand=', 'Parâmetro brand ausente.'],
        ['brand=lescent', 'A marca lescent não é sem Cosmos com catálogo no Data Mart: use apice, yenzah ou denavita.'],
        ['brand=gobeaute', 'A marca gobeaute não é sem Cosmos com catálogo no Data Mart: use apice, yenzah ou denavita.'],
    ])('%s ⇒ 400, sem chamar nada', async (query, mensagem) => {
        const fetchSpy = instalarFetch();

        const res = await pedir(query);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: mensagem });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sem o header Authorization ⇒ 401, sem chamar nada', async () => {
        const fetchSpy = instalarFetch();

        const res = await pedir('brand=apice', {});

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Header Authorization ausente.' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        [401, 401],
        [403, 403],
        [500, 502],
    ])('o Cosmos responde %i na conferência do token ⇒ %i, sem ler o Data Mart', async (cosmos, esperado) => {
        instalarFetch();
        tokenCosmos = cosmos;

        const res = await pedir('brand=apice');

        expect(res.status).toBe(esperado);
        expect(typeof (await res.json()).error).toBe('string');
        expect(consultas).toHaveLength(0);
    });

    it('falha do Metabase ⇒ 502 { error }, e nada fica guardado', async () => {
        instalarFetch();
        respostaMetabase = () => new Response(JSON.stringify({ status: 'failed', error: 'relation does not exist' }), { status: 202 });

        const res = await pedir('brand=yenzah');

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'Não foi possível ler o catálogo de produtos no Data Mart. Tente de novo em instantes.' });

        respostaMetabase = () => linhas([['YE01120', 'Sérum', true, null, 59.9]]);
        const deNovo = await pedir('brand=yenzah');
        expect(deNovo.status).toBe(200);
        expect(consultas).toHaveLength(2);
    });

    it('Metabase sem configuração ⇒ 502', async () => {
        instalarFetch();
        vi.stubEnv('METABASE_API_KEY', '');

        const res = await pedir('brand=denavita');

        expect(res.status).toBe(502);
        expect(consultas).toHaveLength(0);
    });
});
