import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    consultarDataMart,
    literalSql,
    metabaseConfigurado,
    MetabaseError,
} from '@shared/lib/metabase';

/**
 * Leitura do Data Mart pelo Metabase. O que importa aqui: o `/api/dataset` responde 202 mesmo quando a
 * consulta falha, e o erro precisa sair como `MetabaseError` com a classificação certa (vale ou não
 * tentar de novo).
 */

const METABASE = 'https://metabase.test';

function resposta(status: number, corpo: unknown): Response {
    const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    return new Response(texto, { status });
}

describe('consultarDataMart', () => {
    beforeEach(() => {
        vi.stubEnv('METABASE_URL', `${METABASE}/`);
        vi.stubEnv('METABASE_API_KEY', 'chave-de-teste');
        vi.stubEnv('METABASE_DATABASE_ID', '43');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('manda o SQL nativo ao banco configurado, com a chave no X-API-KEY, e devolve as linhas', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
            resposta(202, { status: 'completed', data: { rows: [['cxhub|abc']] } }),
        );

        await expect(consultarDataMart('select 1')).resolves.toEqual([['cxhub|abc']]);

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(`${METABASE}/api/dataset`);
        expect((init as RequestInit).headers).toMatchObject({ 'X-API-KEY': 'chave-de-teste' });
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
            database: 43, type: 'native', native: { query: 'select 1' },
        });
    });

    it('consulta sem linha devolve lista vazia', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(resposta(202, { status: 'completed', data: { rows: [] } }));
        await expect(consultarDataMart('select 1')).resolves.toEqual([]);
    });

    it('202 com status failed é erro, e tabela inexistente não é transitório', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(resposta(202, {
            status: 'failed', error: 'ERROR: relation "gold.fct_reenvio_reembolso_gobeaute" does not exist',
        }));

        const erro = await consultarDataMart('select 1').catch(e => e);
        expect(erro).toBeInstanceOf(MetabaseError);
        expect(erro.transitorio).toBe(false);
    });

    it('consulta interrompida na réplica é transitória', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(resposta(202, {
            status: 'failed', error: 'ERROR: canceling statement due to conflict with recovery',
        }));

        const erro = await consultarDataMart('select 1').catch(e => e);
        expect(erro.transitorio).toBe(true);
    });

    it('chave recusada não é transitória; página HTML de erro vira só o título', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValueOnce(resposta(401, 'Unauthenticated'));
        const recusa = await consultarDataMart('select 1').catch(e => e);
        expect(recusa.status).toBe(401);
        expect(recusa.transitorio).toBe(false);

        vi.spyOn(global, 'fetch').mockResolvedValueOnce(
            resposta(502, '<html><head><title>502 Bad Gateway</title></head><body>...</body></html>'),
        );
        const proxy = await consultarDataMart('select 1').catch(e => e);
        expect(proxy.message).toBe('Metabase HTTP 502: 502 Bad Gateway');
        expect(proxy.transitorio).toBe(true);
    });

    it('rede e timeout viram status 0, transitórios', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
        const rede = await consultarDataMart('select 1').catch(e => e);
        expect(rede.status).toBe(0);
        expect(rede.transitorio).toBe(true);

        vi.spyOn(global, 'fetch').mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        const timeout = await consultarDataMart('select 1').catch(e => e);
        expect(timeout.message).toContain('não respondeu');
        expect(timeout.transitorio).toBe(true);
    });

    it('resposta sem data.rows é erro, não lista vazia', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(resposta(202, { status: 'completed' }));
        await expect(consultarDataMart('select 1')).rejects.toThrow('sem data.rows');
    });

    it('sem configuração recusa sem chamar o Metabase', async () => {
        vi.stubEnv('METABASE_API_KEY', '');
        const fetchSpy = vi.spyOn(global, 'fetch');

        expect(metabaseConfigurado()).toBe(false);
        const erro = await consultarDataMart('select 1').catch(e => e);
        expect(erro.transitorio).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('literalSql', () => {
    it('dobra as aspas simples', () => {
        expect(literalSql("Barbour's")).toBe("'Barbour''s'");
        expect(literalSql("x'; drop table t; --")).toBe("'x''; drop table t; --'");
    });

    it('recusa NUL', () => {
        expect(() => literalSql('a\0b')).toThrow('NUL');
    });
});
