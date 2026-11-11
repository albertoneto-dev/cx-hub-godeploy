import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('next/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: vi.fn(),
}));
vi.mock('@shared/lib/alerts', () => ({ sendAlert: vi.fn(async () => true) }));
vi.mock('@shared/lib/fila/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/fila/client')>()),
    enfileirarAtualizacao: vi.fn(),
}));
vi.mock('@shared/lib/metabase', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/metabase')>()),
    consultarDataMart: vi.fn(),
}));

import { after } from 'next/server';
import { sendAlert } from '@shared/lib/alerts';
import { enfileirarAtualizacao } from '@shared/lib/fila/client';
import { consultarDataMart, MetabaseError } from '@shared/lib/metabase';
import {
    agendarAtualizacaoNaGold,
    buscarCasoNaGold,
    registrarAtualizacaoNaGold,
    sqlDoCasoNaGold,
} from '@shared/lib/airflow/atualizarCaso';
import type { AlteracaoGold } from '@shared/lib/airflow/types';

/**
 * Cancelar e editar levam a alteração à gold, pela fila do Metabase (ADR-012). O CX Hub não guarda o id do caso,
 * então ele é lido de volta da própria gold (pelo Metabase) antes de enfileirar. As mesmas promessas da criação:
 * nunca lança, e falha não some (vira aviso no Chat).
 */

const ID = '6f1c0e2a-1111-2222-3333-444455556666';
const AGORA = new Date('2026-10-24T10:15:00.000Z');

const CANCELAR_REENVIO: AlteracaoGold = {
    localizador: { tipo: 'REENVIO', marca: 'barbours', pedidoReenvio: 'SH9000106BB-R-2', reenvioCriadoEm: '2026-10-20T14:05:03-03:00' },
    evento: 'cancelado',
    atualizacao: { status_execucao: 'Cancelado', responsavel_execucao: 'Ana' },
};

const EDITAR_REEMBOLSO: AlteracaoGold = {
    localizador: { tipo: 'REEMBOLSO', marca: 'lescent', numeroPedido: 'SH9000105LC' },
    evento: 'editado',
    atualizacao: { valor: 59.9, motivo: 'Extravio' },
};

const consultar = vi.mocked(consultarDataMart);
const enfileirar = vi.mocked(enfileirarAtualizacao);
const avisar = vi.mocked(sendAlert);
const deps = { esperar: vi.fn<(ms: number) => Promise<void>>(async () => {}), agora: () => AGORA };

describe('sqlDoCasoNaGold', () => {
    it('reembolso: a solicitação mais recente do pedido, só do CX Hub, na sigla da marca e ainda não cancelada', () => {
        const sql = sqlDoCasoNaGold(EDITAR_REEMBOLSO.localizador)!;

        expect(sql).toContain("fonte = 'CX Hub'");
        expect(sql).toContain("tipo = 'REEMBOLSO'");
        expect(sql).toContain("sigla = 'LE'");
        expect(sql).toContain("regexp_replace(numero_pedido, '[^0-9]', '', 'g') = '9000105'");
        expect(sql).toContain("coalesce(status_execucao, '') <> 'Cancelado'");
        expect(sql).toMatch(/order by data_solicitacao desc limit 1$/);
    });

    it('reenvio: tira o -R-n antes dos dígitos e usa a janela do acompanhamento, em hora de Fortaleza', () => {
        const sql = sqlDoCasoNaGold(CANCELAR_REENVIO.localizador)!;

        expect(sql).toContain("tipo = 'REENVIO'");
        expect(sql).toContain("sigla = 'BB'");
        // O 2 do -R-2 não entra no número do pedido.
        expect(sql).toContain("= '9000106'");
        const quando = "(timestamptz '2026-10-20T17:05:03.000Z' at time zone 'America/Fortaleza')";
        expect(sql).toContain(`data_solicitacao > ${quando} - interval '30 days'`);
        expect(sql).toContain(`data_solicitacao <= ${quando} + interval '1 day'`);
        expect(sql).toMatch(/order by abs\(extract\(epoch from data_solicitacao - .+\)\) limit 1$/);
    });

    it('só leva dígitos do pedido para o SQL', () => {
        const sql = sqlDoCasoNaGold({ tipo: 'REEMBOLSO', marca: 'aua', numeroPedido: "SH1'; drop table x; --" })!;
        expect(sql).toContain("= '1'");
        expect(sql).not.toContain('drop');
    });

    it('sem número de pedido ou com data ilegível não tem como casar', () => {
        expect(sqlDoCasoNaGold({ tipo: 'REEMBOLSO', marca: 'aua', numeroPedido: '#ABC' })).toBeNull();
        expect(sqlDoCasoNaGold({ ...CANCELAR_REENVIO.localizador, reenvioCriadoEm: 'ontem' } as AlteracaoGold['localizador']))
            .toBeNull();
    });
});

describe('buscarCasoNaGold', () => {
    beforeEach(() => consultar.mockReset());

    it('devolve o id do caso sem o prefixo cxhub|', async () => {
        consultar.mockResolvedValueOnce([[`cxhub|${ID}`]]);
        await expect(buscarCasoNaGold('select 1')).resolves.toBe(ID);
    });

    it('nada casou, ou a chave não é do CX Hub ⇒ null', async () => {
        consultar.mockResolvedValueOnce([]);
        await expect(buscarCasoNaGold('select 1')).resolves.toBeNull();
        consultar.mockResolvedValueOnce([['Fonte_Lescent|123']]);
        await expect(buscarCasoNaGold('select 1')).resolves.toBeNull();
    });

});

describe('registrarAtualizacaoNaGold', () => {
    beforeEach(() => {
        consultar.mockReset();
        enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
        avisar.mockClear();
        deps.esperar.mockClear();
        for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    });

    afterEach(() => vi.restoreAllMocks());

    it('acha o caso e entrega a atualização à fila, com o id lido da gold e o instante da alteração', async () => {
        consultar.mockResolvedValueOnce([[`cxhub|${ID}`]]);

        await expect(registrarAtualizacaoNaGold(CANCELAR_REENVIO, deps)).resolves.toBe(true);

        expect(enfileirar).toHaveBeenCalledTimes(1);
        const [id, campos, prazo, quando] = enfileirar.mock.calls[0];
        expect(id).toBe(ID);
        expect(campos).toEqual({ status_execucao: 'Cancelado', responsavel_execucao: 'Ana' });
        expect(prazo).toBeGreaterThan(Date.now());
        expect(quando).toEqual(AGORA);
        expect(avisar).not.toHaveBeenCalled();
    });

    it('retenta a consulta quando o Metabase falha de forma transitória', async () => {
        consultar
            .mockRejectedValueOnce(new MetabaseError(0, 'Metabase inalcançável: fetch failed'))
            .mockResolvedValueOnce([[`cxhub|${ID}`]]);

        await expect(registrarAtualizacaoNaGold(EDITAR_REEMBOLSO, deps)).resolves.toBe(true);

        expect(consultar).toHaveBeenCalledTimes(2);
        expect(deps.esperar).toHaveBeenCalledWith(1_000);
    });

    it('consulta recusada (tabela inexistente) não retenta e avisa sem enfileirar', async () => {
        consultar.mockRejectedValue(new MetabaseError(202, 'relation "gold.fct_reenvio_reembolso_gobeaute" does not exist'));

        await expect(registrarAtualizacaoNaGold(EDITAR_REEMBOLSO, deps)).resolves.toBe(false);

        expect(consultar).toHaveBeenCalledTimes(1);
        expect(enfileirar).not.toHaveBeenCalled();
        expect(avisar).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'GOLD_UPDATE_FAILED',
            numeroPedido: 'SH9000105LC',
            tentativas: 'nenhuma retentativa: o Metabase recusou a consulta',
        }));
        expect(avisar.mock.calls[0][0].detalhe).toContain('Metabase');
    });

    it('nenhum caso casou ⇒ aviso agregado, sem enfileirar', async () => {
        consultar.mockResolvedValueOnce([]);

        await expect(registrarAtualizacaoNaGold(CANCELAR_REENVIO, deps)).resolves.toBe(false);

        expect(enfileirar).not.toHaveBeenCalled();
        expect(avisar).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'GOLD_UPDATE_NO_CASE',
            brand: 'barbours',
            numeroPedido: 'SH9000106BB-R-2',
        }));
    });

    it('fila que recusa avisa com o id do caso (para repor à mão), sem outra tentativa aqui', async () => {
        consultar.mockResolvedValueOnce([[`cxhub|${ID}`]]);
        enfileirar.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400 INVALID_REQUEST' });

        await expect(registrarAtualizacaoNaGold(CANCELAR_REENVIO, deps)).resolves.toBe(false);

        expect(enfileirar).toHaveBeenCalledTimes(1);
        expect(deps.esperar).not.toHaveBeenCalled();
        expect(avisar).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'GOLD_UPDATE_FAILED',
            requestId: ID,
            detalhe: 'fila do Metabase: a fila respondeu HTTP 400 INVALID_REQUEST',
            tentativas: 'nenhuma: a fila recusou',
        }));
    });

    it('fila incerta (a retentativa já está no cliente da fila) avisa que pode ter chegado', async () => {
        consultar.mockResolvedValueOnce([[`cxhub|${ID}`]]);
        enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });

        await expect(registrarAtualizacaoNaGold(CANCELAR_REENVIO, deps)).resolves.toBe(false);

        expect(enfileirar).toHaveBeenCalledTimes(1);
        expect(avisar).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'GOLD_UPDATE_FAILED',
            requestId: ID,
            detalhe: 'fila do Metabase: a fila respondeu HTTP 502',
            tentativas: '2 tentativas: pode ter chegado à fila',
        }));
    });

    it('o aviso não leva o que foi editado: só o pedido e o motivo do aviso', async () => {
        consultar.mockResolvedValueOnce([]);
        const editar: AlteracaoGold = {
            ...EDITAR_REEMBOLSO,
            atualizacao: { valor: 987.65, motivo: 'Motivo editado que não vai ao Chat' },
        };

        await registrarAtualizacaoNaGold(editar, deps);

        const card = JSON.stringify(avisar.mock.calls[0][0]);
        expect(card).not.toContain('987.65');
        expect(card).not.toContain('Motivo editado que não vai ao Chat');
    });

    it('nunca lança, nem quando o aviso falha', async () => {
        consultar.mockRejectedValue(new Error('qualquer coisa'));
        avisar.mockRejectedValueOnce(new Error('Chat fora do ar'));

        await expect(registrarAtualizacaoNaGold(EDITAR_REEMBOLSO, deps)).resolves.toBe(false);
    });
});

describe('agendarAtualizacaoNaGold', () => {
    beforeEach(() => {
        vi.mocked(after).mockReset();
        vi.stubEnv('CXHUB_FILA_URL', 'https://cx-hub.test');
        vi.stubEnv('CXHUB_FILA_TOKEN', 'token-da-fila');
        vi.stubEnv('METABASE_URL', 'https://metabase.test');
        vi.stubEnv('METABASE_API_KEY', 'chave');
        vi.stubEnv('METABASE_DATABASE_ID', '43');
        vi.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('agenda para depois da resposta', () => {
        agendarAtualizacaoNaGold(CANCELAR_REENVIO);
        expect(after).toHaveBeenCalledTimes(1);
    });

    it('nada a levar não agenda nada', () => {
        agendarAtualizacaoNaGold(null);
        expect(after).not.toHaveBeenCalled();
    });

    it('sem METABASE_* fica desligado, mesmo com a fila configurada', () => {
        vi.stubEnv('METABASE_API_KEY', '');
        agendarAtualizacaoNaGold(CANCELAR_REENVIO);
        expect(after).not.toHaveBeenCalled();
    });

    it('sem CXHUB_FILA_* fica desligado, mesmo com o Metabase configurado (e sem precisar de AIRFLOW_*)', () => {
        vi.stubEnv('CXHUB_FILA_TOKEN', '');
        agendarAtualizacaoNaGold(CANCELAR_REENVIO);
        expect(after).not.toHaveBeenCalled();

        vi.stubEnv('CXHUB_FILA_TOKEN', 'token-da-fila');
        agendarAtualizacaoNaGold(CANCELAR_REENVIO);
        expect(after).toHaveBeenCalledTimes(1);
    });
});
