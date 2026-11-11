import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Só a entrega à fila é substituída — e o dedup, para provar que o cancelamento não o consulta. O resto do barrel é o
// real (a fila tem testes próprios em `filaClient.test.ts`).
vi.mock('@shared/lib/fila', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/fila')>()),
    solicitacaoRecenteNoRegistro: vi.fn(),
    enfileirarCasos: vi.fn(),
    prazoDaFila: vi.fn(),
}));
// A linha na planilha (ADR-010) tem testes próprios (`gravarLinha.test.ts`): aqui só importa QUANDO é chamada, com
// qual linha, e o que a resposta diz quando ela falha.
vi.mock('@shared/lib/sheets/gravarLinha', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/sheets/gravarLinha')>()),
    gravarNasPlanilhas: vi.fn(),
}));

import { problemaNoCaso, type CasoCxhub } from '@shared/lib/airflow';
import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro } from '@shared/lib/fila';
import { gravarNasPlanilhas } from '@shared/lib/sheets/gravarLinha';
import { processCancellation } from '@shared/lib/cancellation/processCancellation';
import { buildCancellationRow, prepararCancelamento } from '@shared/lib/cancellation/buildCancellationRow';
import type { CancellationPayload } from '@shared/lib/cancellation';
import { CONFIG_OBRIGATORIA, stubRegistroEnv } from '../helpers/registro-env';

const buscar = vi.mocked(solicitacaoRecenteNoRegistro);
const enfileirar = vi.mocked(enfileirarCasos);
const prazoPadrao = vi.mocked(prazoDaFila);
const planilhas = vi.mocked(gravarNasPlanilhas);

const PAYLOAD: CancellationPayload = {
    brand: 'kokeshi',
    'Responsável': 'Maria Silva',
    'Nome do(a) cliente': 'João Santos',
    'Número do pedido (Shopify)': '220183',
    'Observações': 'Cliente pediu pelo WhatsApp (11) 98888-7777',
    'Número da NF': '123456',
    'CD de origem': 'Unilog SP',
    'Status': 'Realizado',
    'Local da Tratativa': 'Transportador',
    'Tratativa': 'Reenvio',
};

// 27/10/2026 15:00 em SP
const AGORA = new Date(Date.UTC(2026, 9, 27, 18, 0, 0));
const PRAZO_PADRAO = 1_900_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function casoEnfileirado(): CasoCxhub {
    expect(enfileirar).toHaveBeenCalledTimes(1);
    const casos = enfileirar.mock.calls[0][0];
    expect(casos).toHaveLength(1);
    return casos[0];
}

describe('processCancellation (registro na fila do Metabase e na planilha)', () => {
    beforeEach(() => {
        buscar.mockReset().mockResolvedValue(null);
        enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
        prazoPadrao.mockReset().mockReturnValue(PRAZO_PADRAO);
        planilhas.mockReset().mockResolvedValue({ ok: true });
        stubRegistroEnv();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('entrega um caso CANCELAMENTO à fila com o prazo padrão ⇒ 200 SUCCESS com o id do caso', async () => {
        const { body, status } = await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

        const caso = casoEnfileirado();
        expect(status).toBe(200);
        expect(body).toEqual({ code: 'SUCCESS', message: 'Cancelamento registrado com sucesso', idSolicitacao: caso.id_solicitacao });
        expect(caso.tipo).toBe('CANCELAMENTO');
        expect(enfileirar.mock.calls[0][1]).toBe(PRAZO_PADRAO);
    });

    it('o caso leva a tratativa e o pedido, sem o cliente, as observações, o Status e o Local da Tratativa', async () => {
        await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });
        const caso = casoEnfileirado();

        expect(caso).toEqual({
            id_solicitacao: expect.stringMatching(UUID),
            tipo: 'CANCELAMENTO',
            marca: 'kokeshi',
            criado_em: '2026-10-27T18:00:00.000Z',
            numero_pedido: '220183',
            nf: '123456',
            cd_origem: 'Unilog SP',
            responsavel: 'Maria Silva',
            tratativa: 'Reenvio',
        });
        expect(caso).not.toHaveProperty('cliente');
        expect(caso).not.toHaveProperty('observacoes');
        const valores = Object.values(caso);
        for (const fora of [PAYLOAD['Nome do(a) cliente'], PAYLOAD['Observações'], PAYLOAD['Status'], PAYLOAD['Local da Tratativa']]) {
            expect(valores).not.toContain(fora);
        }
        expect(problemaNoCaso(caso)).toBeNull();
    });

    it('do Bot, a tratativa é sempre Reembolso (o Bot só cancela junto de um reembolso)', async () => {
        await processCancellation('kokeshi', { ...PAYLOAD, 'Responsável': 'Bot', 'Tratativa': 'Reenvio' }, { agora: AGORA });

        expect(casoEnfileirado()).toMatchObject({ responsavel: 'Bot', tratativa: 'Reembolso' });
    });

    it('não tem dedup — o workflow também não tinha', async () => {
        await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

        expect(buscar).not.toHaveBeenCalled();
        expect(enfileirar).toHaveBeenCalledTimes(1);
    });

    it('usa o prazoFila de quem chama', async () => {
        await processCancellation('kokeshi', PAYLOAD, { agora: AGORA, prazoFila: 1_800_000_000_000 });

        expect(enfileirar.mock.calls[0][1]).toBe(1_800_000_000_000);
        expect(prazoPadrao).not.toHaveBeenCalled();
    });

    it('fila recusou ⇒ 500 UNKNOWN_ERROR, que o submitCancellation já sabe ler', async () => {
        enfileirar.mockResolvedValue({ status: 'recusado', motivo: 'a fila não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)' });

        const { body, status } = await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

        expect(status).toBe(500);
        expect(body).toEqual({
            code: 'UNKNOWN_ERROR',
            message: 'Erro ao registrar o cancelamento (a fila não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)).',
        });
    });

    // ADR-010 e ADR-012: a planilha anda junto da fila. Ordem: config → fila → planilha.
    describe('linha na planilha (junto da fila)', () => {
        const CARIMBO = '27/10/2026 15:00:00';

        it('depois da fila: a linha do cancelamento, com o MESMO id do caso, e o pedido no aviso', async () => {
            const { body } = await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

            expect(body.code).toBe('SUCCESS');
            expect(planilhas).toHaveBeenCalledTimes(1);
            expect(planilhas).toHaveBeenCalledWith(
                [{
                    fluxo: 'cancelamento',
                    marca: 'kokeshi',
                    linha: buildCancellationRow('kokeshi', prepararCancelamento(PAYLOAD, CARIMBO)),
                    idSolicitacao: casoEnfileirado().id_solicitacao,
                    // O que acha a linha na planilha depois: o pedido e o MESMO instante que foi para a fila.
                    pedido: '220183',
                    criadoEm: AGORA,
                }],
                { numeroPedido: '220183', statusDaFila: 'enfileirado' },
            );
            expect(enfileirar.mock.invocationCallOrder[0]).toBeLessThan(planilhas.mock.invocationCallOrder[0]);
        });

        it('do Bot, a linha leva a tratativa Reembolso (a mesma regra do caso)', async () => {
            await processCancellation('kokeshi', { ...PAYLOAD, 'Responsável': 'Bot', 'Tratativa': 'Reenvio' }, { agora: AGORA });

            expect(planilhas.mock.calls[0][0][0].linha).toContain('Reembolso');
            expect(planilhas.mock.calls[0][0][0].linha).not.toContain('Reenvio');
        });

        it('fila recusou ⇒ a planilha NÃO é gravada (o agente repete, e não haveria linha órfã)', async () => {
            enfileirar.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400' });

            const { status } = await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

            expect(status).toBe(500);
            expect(planilhas).not.toHaveBeenCalled();
        });

        it('fila incerta ⇒ a planilha É gravada, e a resposta é 504 API_TIMEOUT dizendo para NÃO repetir', async () => {
            enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });

            const { body, status } = await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

            expect(planilhas).toHaveBeenCalledTimes(1);
            expect(planilhas.mock.calls[0][1]).toMatchObject({ statusDaFila: 'incerto' });
            expect(status).toBe(504);
            expect(body).toEqual({
                code: 'API_TIMEOUT',
                message: 'O cancelamento foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.',
                idSolicitacao: casoEnfileirado().id_solicitacao,
            });
        });

        it('fila guardou e planilha falhou ⇒ UNKNOWN_ERROR + reason SHEET_WRITE_FAILED: na fila, planilha não, NÃO repita', async () => {
            planilhas.mockResolvedValue({ ok: false, motivo: 'HTTP 403 The caller does not have permission' });

            const { body, status } = await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

            // 200 de propósito: a solicitação ESTÁ registrada, e um 5xx convidaria quem chama a repetir (sem dedup, duplica).
            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'UNKNOWN_ERROR',
                message: 'O cancelamento entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.',
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: casoEnfileirado().id_solicitacao,
            });
        });

        it('fila incerta e planilha falhou ⇒ SHEET_WRITE_FAILED dizendo que PODE ter entrado na fila', async () => {
            enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });
            planilhas.mockResolvedValue({ ok: false, motivo: 'HTTP 403' });

            const { body, status } = await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

            expect(status).toBe(200);
            expect(body).toMatchObject({
                code: 'UNKNOWN_ERROR',
                message: 'O cancelamento pode ter entrado na fila do Metabase (a fila respondeu HTTP 502), mas a planilha não foi atualizada. NÃO repita a solicitação.',
                reason: 'SHEET_WRITE_FAILED',
            });
        });
    });

    describe('configuração do registro: recusa antes de gravar', () => {
        it.each(CONFIG_OBRIGATORIA)('sem %s ⇒ 500 UNKNOWN_ERROR, e nada é gravado', async (nome, citado) => {
            vi.stubEnv(nome, '');

            const { body, status } = await processCancellation('kokeshi', PAYLOAD, { agora: AGORA });

            expect(status).toBe(500);
            expect(body.code).toBe('UNKNOWN_ERROR');
            expect(body.message).toContain(citado);
            expect(enfileirar).not.toHaveBeenCalled();
            expect(planilhas).not.toHaveBeenCalled();
        });
    });
});
