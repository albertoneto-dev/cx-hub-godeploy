import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@shared/lib/metabase', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/metabase')>()),
    consultarDataMart: vi.fn(),
}));

import { consultarDataMart, MetabaseError } from '@shared/lib/metabase';
import {
    TABELA_RAW,
    buscarReembolsoMaisRecente,
    buscarSolicitacaoRecente,
    sqlDaSolicitacaoRecente,
    sqlDoReembolsoMaisRecente,
    sqlDoCasoPorId,
    buscarCasoPorId,
} from '@shared/lib/airflow/raw';
import type { SupportedBrand } from '@shared/lib/constants';
import type { TipoCasoCxhub } from '@shared/lib/airflow/types';

/**
 * As leituras da raw de eventos do CX Hub pelo Metabase (ADR-008): o dedup de 24h e o reembolso mais recente
 * de um pedido. O SQL é conferido pela estrutura (espaço em branco não importa); as leituras, pelo mapeamento
 * das linhas que o Metabase devolve.
 */

const consultar = vi.mocked(consultarDataMart);

/** O SQL numa linha só, com um espaço entre os tokens: o teste olha a estrutura, não a indentação. */
const plano = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('TABELA_RAW', () => {
    it('é a raw de eventos que a DAG grava', () => {
        expect(TABELA_RAW).toBe('raw.cxhub_reenvio_reembolso_eventos');
    });
});

describe('sqlDaSolicitacaoRecente (o dedup de 24h)', () => {
    const sql = plano(sqlDaSolicitacaoRecente('REENVIO', 'barbours', 'SH9000106BB'));

    it('lê a raw de eventos, só as criações', () => {
        expect(sql).toContain('from raw.cxhub_reenvio_reembolso_eventos e');
        expect(sql).toContain("where e.tipo_evento = 'caso'");
    });

    it('olha só as últimas 24h (com o corte pelo _loaded_at, que é sempre depois do disparo)', () => {
        expect(sql).toContain("and e.disparado_em >= now() - interval '24 hours'");
        expect(sql).toContain("and e._loaded_at >= now() - interval '25 hours'");
    });

    it('compara tipo e marca normalizados', () => {
        expect(sql).toContain("and upper(btrim(e.payload ->> 'tipo')) = 'REENVIO'");
        expect(sql).toContain("and lower(btrim(e.marca)) = 'barbours'");
    });

    it('compara o pedido só pelos dígitos, dos dois lados', () => {
        expect(sql).toContain("and regexp_replace(e.payload ->> 'numero_pedido', '[^0-9]', '', 'g') = '9000106'");
        expect(plano(sqlDaSolicitacaoRecente('REENVIO', 'barbours', '#9000106'))).toBe(sql);
    });

    it('uma linha por caso: a criação mais recente de cada id_solicitacao', () => {
        expect(sql).toContain('select distinct on (e.id_solicitacao)');
        expect(sql).toContain('order by e.id_solicitacao, e.disparado_em desc, e.evento_id desc');
    });

    it('caso cancelado não barra a nova: vale o status_execucao da atualização mais recente', () => {
        expect(sql).toContain('left join lateral (');
        expect(sql).toContain("select lower(btrim(u.payload ->> 'status_execucao')) as status");
        expect(sql).toContain('where u.id_solicitacao = c.id_solicitacao');
        expect(sql).toContain("and u.tipo_evento = 'atualizacao'");
        expect(sql).toContain("and (u.payload -> 'status_execucao') is not null");
        expect(sql).toContain("order by u.payload ->> 'atualizado_em' desc nulls last, u.disparado_em desc, u.evento_id desc limit 1 ) s on true");
        expect(sql).toContain("where s.status is distinct from 'cancelado'");
    });

    it('no lote (ADR-012) as atualizações dividem o run: quem ordena é o atualizado_em do payload, e as antigas (sem ele) ficam por último', () => {
        // Texto ISO do `toISOString()`: tamanho fixo e em UTC, então a ordem do texto é a do tempo.
        expect(sql).toContain("u.payload ->> 'atualizado_em' desc nulls last");
        expect(sql.indexOf("u.payload ->> 'atualizado_em' desc")).toBeLessThan(sql.indexOf('u.disparado_em desc'));
    });

    it('devolve a solicitação mais recente, nas colunas que a leitura espera (pedido, responsável, quando em UTC e o id)', () => {
        expect(sql).toMatch(
            /select c\.numero_pedido, c\.responsavel, to_char\(c\.disparado_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'\) as solicitado_em, c\.id_solicitacao from c /,
        );
        expect(sql).toContain("nullif(btrim(e.payload ->> 'responsavel'), '') as responsavel");
        expect(sql).toMatch(/order by c\.disparado_em desc limit 1$/);
    });

    it.each(['REEMBOLSO', 'CANCELAMENTO'] as const)('o tipo vem de quem chama: %s', (tipo) => {
        expect(plano(sqlDaSolicitacaoRecente(tipo, 'lescent', '1'))).toContain(`= '${tipo}'`);
    });

    it('aspas no tipo ou na marca ficam dentro do literal; do pedido só vão os dígitos', () => {
        const injetado = plano(sqlDaSolicitacaoRecente(
            "REENVIO' or '1'='1" as TipoCasoCxhub,
            "barbours'; drop table x; --" as SupportedBrand,
            "SH9000106'; drop table x; --",
        ));

        expect(injetado).toContain(
            "and upper(btrim(e.payload ->> 'tipo')) = 'REENVIO'' or ''1''=''1' and lower(btrim(e.marca))",
        );
        expect(injetado).toContain(
            "and lower(btrim(e.marca)) = 'barbours''; drop table x; --' and regexp_replace(",
        );
        expect(injetado).toContain("'[^0-9]', '', 'g') = '9000106' order by e.id_solicitacao");
    });
});

describe('sqlDoReembolsoMaisRecente', () => {
    const sql = plano(sqlDoReembolsoMaisRecente('lescent', 'SH9000105LC'));

    it('lê as criações de reembolso da marca e do pedido (pelos dígitos)', () => {
        expect(sql).toContain('from raw.cxhub_reenvio_reembolso_eventos e');
        expect(sql).toContain("where e.tipo_evento = 'caso'");
        expect(sql).toContain("and upper(btrim(e.payload ->> 'tipo')) = 'REEMBOLSO'");
        expect(sql).toContain("and lower(btrim(e.marca)) = 'lescent'");
        expect(sql).toContain("and regexp_replace(e.payload ->> 'numero_pedido', '[^0-9]', '', 'g') = '9000105'");
    });

    it('sem a janela de 24h: vale o reembolso mais recente, de quando for', () => {
        expect(sql).not.toContain('interval');
        expect(sql).toContain('alvo as (select * from c order by disparado_em desc limit 1)');
    });

    it('devolve o caso mesmo cancelado, com o status atual ("aberto" sem atualização de status)', () => {
        expect(sql).not.toContain("is distinct from 'cancelado'");
        expect(sql).toContain("and u.tipo_evento = 'atualizacao'");
        expect(sql).toMatch(
            /select c\.id_solicitacao, c\.numero_pedido, coalesce\(s\.status, 'aberto'\) as status_execucao, c\.criado_em from alvo c left join lateral \(/,
        );
    });

    it('traz o criado_em do caso (o instante que também é o carimbo da linha na planilha), só nesta consulta', () => {
        expect(sql).toContain("e.disparado_em, e.payload ->> 'criado_em' as criado_em from raw.cxhub_reenvio_reembolso_eventos e");
        // O dedup de 24h não precisa dele.
        expect(plano(sqlDaSolicitacaoRecente('REEMBOLSO', 'lescent', 'SH9000105LC'))).not.toContain('criado_em');
    });

    it('aspas na marca ficam dentro do literal; do pedido só vão os dígitos', () => {
        const injetado = plano(sqlDoReembolsoMaisRecente("lescent' or 'x'='x" as SupportedBrand, "SH9000105'; drop table x; --"));

        expect(injetado).toContain("and lower(btrim(e.marca)) = 'lescent'' or ''x''=''x' and regexp_replace(");
        expect(injetado).toContain("'[^0-9]', '', 'g') = '9000105' order by e.id_solicitacao");
        expect(injetado).not.toContain('drop');
    });
});

describe('buscarSolicitacaoRecente', () => {
    beforeEach(() => consultar.mockReset());

    it('consulta com o SQL do dedup e devolve a solicitação que barra a nova, com o id do caso', async () => {
        consultar.mockResolvedValueOnce([['SH9000106BB', 'Ana', '2026-10-29T13:05:00Z', '6f1c0e2a-1111']]);

        await expect(buscarSolicitacaoRecente('REENVIO', 'barbours', '#9000106')).resolves.toEqual({
            idSolicitacao: '6f1c0e2a-1111',
            pedido: 'SH9000106BB',
            responsavel: 'Ana',
            solicitadoEm: '2026-10-29T13:05:00Z',
        });
        expect(consultar).toHaveBeenCalledTimes(1);
        expect(consultar).toHaveBeenCalledWith(sqlDaSolicitacaoRecente('REENVIO', 'barbours', '#9000106'));
    });

    it('nenhuma solicitação nas últimas 24h ⇒ null', async () => {
        consultar.mockResolvedValueOnce([]);

        await expect(buscarSolicitacaoRecente('REEMBOLSO', 'lescent', 'SH9000105LC')).resolves.toBeNull();
    });

    it('coluna nula vira texto vazio (o responsável em branco na solicitação; o id de uma linha sem ele)', async () => {
        consultar.mockResolvedValueOnce([['SH9000105LC', null, '2026-10-29T13:05:00Z']]);

        await expect(buscarSolicitacaoRecente('REEMBOLSO', 'lescent', 'SH9000105LC')).resolves.toEqual({
            idSolicitacao: '',
            pedido: 'SH9000105LC',
            responsavel: '',
            solicitadoEm: '2026-10-29T13:05:00Z',
        });
    });

    it.each(['#ABC', ''])('pedido sem dígito (%j) não é consultado ⇒ null', async (pedido) => {
        await expect(buscarSolicitacaoRecente('REENVIO', 'aua', pedido)).resolves.toBeNull();
        expect(consultar).not.toHaveBeenCalled();
    });

    it('erro do Metabase sobe como veio: quem chama decide o que responder', async () => {
        const erro = new MetabaseError(0, 'Metabase inalcançável: fetch failed');
        consultar.mockRejectedValueOnce(erro);

        await expect(buscarSolicitacaoRecente('REENVIO', 'aua', 'SH1')).rejects.toBe(erro);
    });
});

describe('buscarReembolsoMaisRecente', () => {
    beforeEach(() => consultar.mockReset());

    it('devolve o reembolso mais recente do pedido, com o status atual', async () => {
        consultar.mockResolvedValueOnce([['6f1c0e2a-1111', 'SH9000105LC', 'cancelado', '2026-10-28T13:00:00.123Z']]);

        await expect(buscarReembolsoMaisRecente('lescent', 'SH9000105LC')).resolves.toEqual({
            idSolicitacao: '6f1c0e2a-1111',
            numeroPedido: 'SH9000105LC',
            criadoEm: new Date('2026-10-28T13:00:00.123Z'),
            status: 'cancelado',
        });
        expect(consultar).toHaveBeenCalledWith(sqlDoReembolsoMaisRecente('lescent', 'SH9000105LC'));
    });

    it('criado_em que não é data vira uma data inválida (a busca da linha na planilha a trata como "sem linha")', async () => {
        consultar.mockResolvedValueOnce([['6f1c0e2a-1111', 'SH9000105LC', 'aberto', null]]);

        const reembolso = await buscarReembolsoMaisRecente('lescent', 'SH9000105LC');

        expect(Number.isNaN(reembolso?.criadoEm.getTime())).toBe(true);
    });

    it('status nulo ⇒ "aberto"', async () => {
        consultar.mockResolvedValueOnce([['6f1c0e2a-1111', 'SH9000105LC', null, '2026-10-28T13:00:00.123Z']]);

        await expect(buscarReembolsoMaisRecente('lescent', 'SH9000105LC')).resolves.toMatchObject({ status: 'aberto' });
    });

    it('pedido sem reembolso registrado pelo CX Hub ⇒ null', async () => {
        consultar.mockResolvedValueOnce([]);

        await expect(buscarReembolsoMaisRecente('lescent', 'SH9000105LC')).resolves.toBeNull();
    });

    it('pedido sem dígito não é consultado ⇒ null', async () => {
        await expect(buscarReembolsoMaisRecente('lescent', '#ABC')).resolves.toBeNull();
        expect(consultar).not.toHaveBeenCalled();
    });

    it('erro do Metabase sobe como veio', async () => {
        const erro = new MetabaseError(202, 'relation "raw.cxhub_reenvio_reembolso_eventos" does not exist');
        consultar.mockRejectedValueOnce(erro);

        await expect(buscarReembolsoMaisRecente('lescent', 'SH9000105LC')).rejects.toBe(erro);
    });
});

const ID = '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f';

describe('sqlDoCasoPorId', () => {
    const sql = plano(sqlDoCasoPorId(ID));

    it('lê a criação do caso (tipo, marca e pedido) pelo id, a mais recente', () => {
        expect(sql).toContain('from raw.cxhub_reenvio_reembolso_eventos e');
        expect(sql).toContain(`where e.id_solicitacao = '${ID}'`);
        expect(sql).toContain("and e.tipo_evento = 'caso'");
        expect(sql).toContain('order by e.disparado_em desc, e.evento_id desc limit 1)');
        expect(sql).toContain("upper(btrim(e.payload ->> 'tipo')) as tipo");
        expect(sql).toContain('lower(btrim(e.marca)) as marca');
        expect(sql).toContain("e.payload ->> 'numero_pedido' as numero_pedido, e.payload ->> 'criado_em' as criado_em");
        expect(sql).toContain('select c.id_solicitacao, c.tipo, c.marca, c.numero_pedido, c.criado_em,');
    });

    it('traz o status mais recente, com a data e o responsável da mesma atualização', () => {
        expect(sql).toContain("select lower(btrim(u.payload ->> 'status_execucao')) as status,");
        expect(sql).toContain("nullif(btrim(u.payload ->> 'data_execucao'), '') as data_execucao");
        expect(sql).toContain("nullif(btrim(u.payload ->> 'responsavel_execucao'), '') as responsavel_execucao");
        expect(sql).toContain('where u.id_solicitacao = c.id_solicitacao');
        expect(sql).toContain("and u.tipo_evento = 'atualizacao'");
        expect(sql).toContain("and (u.payload -> 'status_execucao') is not null");
        expect(sql).toContain("order by u.payload ->> 'atualizado_em' desc nulls last, u.disparado_em desc, u.evento_id desc limit 1 ) s on true");
        expect(sql).toContain("coalesce(s.status, 'aberto') as status_execucao, s.data_execucao, s.responsavel_execucao from c");
    });

    it('não usa o operador "?" do jsonb, que o JDBC do Metabase leria como parâmetro', () => {
        expect(sql).not.toContain('?');
    });

    it('escapa o id: aspa simples vira duas, e o valor não sai do literal', () => {
        const hostil = plano(sqlDoCasoPorId("x' or '1'='1"));

        expect(hostil).toContain("where e.id_solicitacao = 'x'' or ''1''=''1' and e.tipo_evento");
        expect(hostil).not.toContain("= 'x' or");
    });

    it('recusa id com NUL em vez de montar o SQL', () => {
        expect(() => sqlDoCasoPorId('a\0b')).toThrow();
    });

    it('as consultas que não precisam da execução seguem sem a data e o responsável', () => {
        expect(plano(sqlDoReembolsoMaisRecente('lescent', 'SH9000105LC'))).not.toContain('data_execucao');
        expect(plano(sqlDaSolicitacaoRecente('REEMBOLSO', 'lescent', 'SH9000105LC'))).not.toContain('responsavel_execucao');
    });
});

describe('buscarCasoPorId', () => {
    beforeEach(() => consultar.mockReset());

    it('devolve tipo, marca, pedido e o status atual, com a data e o responsável da execução', async () => {
        consultar.mockResolvedValueOnce([[ID, 'REEMBOLSO', 'lescent', 'SH9000105LC', '2026-10-28T13:00:00.123Z', 'realizado', '30/10/2026', 'Ana']]);

        await expect(buscarCasoPorId(ID)).resolves.toEqual({
            idSolicitacao: ID,
            tipo: 'REEMBOLSO',
            marca: 'lescent',
            numeroPedido: 'SH9000105LC',
            criadoEm: new Date('2026-10-28T13:00:00.123Z'),
            status: 'realizado',
            dataExecucao: '30/10/2026',
            responsavelExecucao: 'Ana',
        });
        expect(consultar).toHaveBeenCalledWith(sqlDoCasoPorId(ID));
    });

    it('normaliza tipo e marca (maiúsculas, minúsculas e espaços) e o status', async () => {
        consultar.mockResolvedValueOnce([[ID, ' reembolso ', ' Lescent ', 'SH9000105LC', '2026-10-28T13:00:00.123Z', ' CANCELADO ', null, null]]);

        await expect(buscarCasoPorId(ID)).resolves.toMatchObject({ tipo: 'REEMBOLSO', marca: 'lescent', status: 'cancelado' });
    });

    it.each([[null], [''], ['   ']])('status %j na linha ⇒ "aberto"', async (status) => {
        consultar.mockResolvedValueOnce([[ID, 'REEMBOLSO', 'lescent', 'SH9000105LC', '2026-10-28T13:00:00.123Z', status, null, null]]);

        await expect(buscarCasoPorId(ID)).resolves.toMatchObject({ status: 'aberto' });
    });

    it('data e responsável ausentes ou em branco viram null', async () => {
        consultar.mockResolvedValueOnce([[ID, 'REEMBOLSO', 'lescent', 'SH9000105LC', '2026-10-28T13:00:00.123Z', 'realizado', '  ', undefined]]);

        await expect(buscarCasoPorId(ID)).resolves.toMatchObject({ dataExecucao: null, responsavelExecucao: null });
    });

    it('id que a raw não conhece (sem a criação) ⇒ null', async () => {
        consultar.mockResolvedValueOnce([]);

        await expect(buscarCasoPorId(ID)).resolves.toBeNull();
    });

    it('erro do Metabase sobe como veio', async () => {
        const erro = new MetabaseError(0, 'Metabase não respondeu em 5s');
        consultar.mockRejectedValueOnce(erro);

        await expect(buscarCasoPorId(ID)).rejects.toBe(erro);
    });
});
