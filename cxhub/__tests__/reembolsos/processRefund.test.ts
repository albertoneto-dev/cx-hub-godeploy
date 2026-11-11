import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Só o dedup (fila + raw) e a entrega à fila são substituídos: os dois têm testes próprios (`filaEstado.test.ts` e
// `filaClient.test.ts`). O resto do barrel é o real.
vi.mock('@shared/lib/fila', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/fila')>()),
    solicitacaoRecenteNoRegistro: vi.fn(),
    enfileirarCasos: vi.fn(),
    prazoDaFila: vi.fn(),
}));
// A linha na planilha (ADR-010) tem testes próprios (`gravarLinha.test.ts`): aqui só importa QUANDO é chamada, com
// quais linhas, e o que a resposta diz quando ela falha.
vi.mock('@shared/lib/sheets/gravarLinha', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/sheets/gravarLinha')>()),
    gravarNasPlanilhas: vi.fn(),
}));

import { problemaNoCaso, type CasoCxhub } from '@shared/lib/airflow';
import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro } from '@shared/lib/fila';
import { MetabaseError } from '@shared/lib/metabase';
import { gravarNasPlanilhas } from '@shared/lib/sheets/gravarLinha';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import { buildRefundRow, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import { buildCancellationRow, prepararCancelamento } from '@shared/lib/cancellation/buildCancellationRow';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { CONFIG_OBRIGATORIA, stubRegistroEnv } from '../helpers/registro-env';

const buscar = vi.mocked(solicitacaoRecenteNoRegistro);
const enfileirar = vi.mocked(enfileirarCasos);
const prazoPadrao = vi.mocked(prazoDaFila);
const planilhas = vi.mocked(gravarNasPlanilhas);

const DATA: RefundSubmissionData = {
    brand: 'barbours',
    data_criacao: '20/10/2026',
    handledBy: 'Ana',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'T-1',
    originWarehouse: 'SP',
    customerName: 'Cliente Que Não Vai à Gold',
    invoiceNumber: '555',
    nfeAccessKey: 'CHAVE',
    batchNumber: null,
    ecommerceOrderId: '220183',
    policyException: false,
    refundAmount: 99.9,
    refundReason: 'Avaria',
    refundScope: 'SKU01 - 1;Frete',
    requiresReturn: false,
    carrierTicketId: 'TK-1',
    carrierName: 'PAC',
    orderStatus: 'Entregue',
    isFullRefund: true,
    notes: 'Cliente pediu pelo WhatsApp (11) 98888-7777',
};

// 27/10/2026 15:00 em SP
const AGORA = new Date(Date.UTC(2026, 9, 27, 18, 0, 0));
const PRAZO_PADRAO = 1_900_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUCESSO = 'Reembolso registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).';

function casosEnfileirados(): CasoCxhub[] {
    expect(enfileirar).toHaveBeenCalledTimes(1);
    return enfileirar.mock.calls[0][0];
}

describe('processRefund (registro na fila do Metabase e na planilha)', () => {
    beforeEach(() => {
        buscar.mockReset().mockResolvedValue(null);
        enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
        prazoPadrao.mockReset().mockReturnValue(PRAZO_PADRAO);
        planilhas.mockReset().mockResolvedValue({ ok: true });
        stubRegistroEnv();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('campo obrigatório ausente ou nulo ⇒ 400 listando os campos, sem consultar nem registrar nada', async () => {
        const incompleto = { ...DATA, carrierName: null, nfeAccessKey: undefined } as unknown as RefundSubmissionData;

        const { body, status } = await processRefund('barbours', incompleto, { agora: AGORA });

        expect(status).toBe(400);
        expect(body).toEqual({ code: 'UNKNOWN_ERROR', message: 'missing field(s): carrierName, nfeAccessKey' });
        expect(buscar).not.toHaveBeenCalled();
        expect(enfileirar).not.toHaveBeenCalled();
    });

    describe('dedup de 24h (fila e raw)', () => {
        it('reembolso do mesmo pedido nas últimas 24h ⇒ DUPLICATE_REFUND com quem pediu e quando (hora de SP), sem registrar', async () => {
            buscar.mockResolvedValue({ idSolicitacao: 'id-0', pedido: '220183', responsavel: 'Bia', solicitadoEm: '2026-10-27T13:15:00Z' });

            const { body, status } = await processRefund('barbours', DATA, { agora: AGORA });

            expect(buscar).toHaveBeenCalledWith('REEMBOLSO', 'barbours', '220183');
            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'DUPLICATE_REFUND',
                message: 'Já existe um reembolso para o pedido 220183 feito por Bia em 27/10/2026 10:15:00',
            });
            expect(enfileirar).not.toHaveBeenCalled();
            expect(planilhas).not.toHaveBeenCalled();
        });

        it('Metabase ou fila fora ⇒ 503, nada registrado (não arrisca duplicar)', async () => {
            buscar.mockRejectedValue(new MetabaseError(502, 'Metabase HTTP 502: Bad Gateway'));

            const { body, status } = await processRefund('barbours', DATA, { agora: AGORA });

            expect(status).toBe(503);
            expect(body).toEqual({
                code: 'UNKNOWN_ERROR',
                message: 'Não foi possível consultar as solicitações recentes — nada foi registrado. Tente novamente.',
            });
            expect(enfileirar).not.toHaveBeenCalled();
        });
    });

    describe('fila do Metabase', () => {
        it('um caso REEMBOLSO só, com o prazo padrão da fila ⇒ 200 SUCCESS com o id do caso', async () => {
            const { body, status } = await processRefund('barbours', DATA, { agora: AGORA });

            const casos = casosEnfileirados();
            expect(status).toBe(200);
            expect(body).toEqual({ code: 'SUCCESS', message: SUCESSO, idSolicitacao: casos[0].id_solicitacao });

            expect(casos).toHaveLength(1);
            expect(casos[0]).toMatchObject({
                tipo: 'REEMBOLSO',
                marca: 'barbours',
                criado_em: '2026-10-27T18:00:00.000Z',
                numero_pedido: '220183',
                responsavel: 'Ana',
                valor: 99.9,
            });
            expect(casos[0].id_solicitacao).toMatch(UUID);
            expect(enfileirar.mock.calls[0][1]).toBe(PRAZO_PADRAO);
        });

        it('o caso não leva o nome do cliente nem as observações, leva o escopo e o ticket, e passa no contrato da DAG', async () => {
            await processRefund('barbours', DATA, { agora: AGORA });
            const [caso] = casosEnfileirados();

            expect(caso).not.toHaveProperty('cliente');
            expect(caso).not.toHaveProperty('observacoes');
            expect(Object.values(caso)).not.toContain(DATA.customerName);
            expect(Object.values(caso)).not.toContain(DATA.notes);
            expect(caso).toMatchObject({ escopo_reembolso: 'SKU01 - 1;Frete', ticket_transportadora: 'TK-1' });
            expect(problemaNoCaso(caso)).toBeNull();
        });

        it('usa o prazoFila de quem chama', async () => {
            await processRefund('barbours', DATA, { agora: AGORA, prazoFila: 1_800_000_000_000 });

            expect(enfileirar.mock.calls[0][1]).toBe(1_800_000_000_000);
            expect(prazoPadrao).not.toHaveBeenCalled();
        });

        it('recusado ⇒ 200 SHEETS_ERROR (o código do n8n), com o motivo, sem id e sem reason: nada foi gravado', async () => {
            enfileirar.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400 INVALID_REQUEST' });

            const { body, status } = await processRefund('barbours', DATA, { agora: AGORA });

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'SHEETS_ERROR',
                message: 'Erro ao registrar o reembolso (a fila respondeu HTTP 400 INVALID_REQUEST).',
            });
            expect(planilhas).not.toHaveBeenCalled();
        });
    });

    describe('reembolso do Bot', () => {
        const BOT: RefundSubmissionData = { ...DATA, handledBy: 'Bot' };

        it('entrega também o cancelamento, na MESMA chamada à fila, com tratativa "Reembolso"', async () => {
            const { body, status } = await processRefund('barbours', BOT, { agora: AGORA });

            const casos = casosEnfileirados();
            expect(status).toBe(200);
            // A resposta leva o id do reembolso, o primeiro caso.
            expect(body).toEqual({ code: 'SUCCESS', message: SUCESSO, idSolicitacao: casos[0].id_solicitacao });

            expect(casos.map((caso) => caso.tipo)).toEqual(['REEMBOLSO', 'CANCELAMENTO']);
            const [reembolso, cancelamento] = casos;
            expect(cancelamento).toEqual({
                id_solicitacao: expect.stringMatching(UUID),
                tipo: 'CANCELAMENTO',
                marca: 'barbours',
                criado_em: '2026-10-27T18:00:00.000Z',
                numero_pedido: '220183',
                nf: '555',
                cd_origem: 'SP',
                responsavel: 'Bot',
                tratativa: 'Reembolso',
            });
            expect(cancelamento.id_solicitacao).not.toBe(reembolso.id_solicitacao);
            expect(cancelamento).not.toHaveProperty('observacoes');
            expect(Object.values(cancelamento)).not.toContain(BOT.customerName);
            expect(Object.values(cancelamento)).not.toContain(BOT.notes);
            expect(problemaNoCaso(cancelamento)).toBeNull();
        });

        it('fila recusou vale para os dois (uma chamada só): SHEETS_ERROR, nenhuma linha', async () => {
            enfileirar.mockResolvedValue({ status: 'recusado', motivo: 'a fila não está configurada' });

            const { body, status } = await processRefund('barbours', BOT, { agora: AGORA });

            expect(casosEnfileirados()).toHaveLength(2);
            expect(status).toBe(200);
            expect(body.code).toBe('SHEETS_ERROR');
            expect(planilhas).not.toHaveBeenCalled();
        });

        it('fila incerta do Bot ⇒ o id da resposta é o do reembolso, o primeiro caso', async () => {
            enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });

            const { body } = await processRefund('barbours', BOT, { agora: AGORA });

            const [reembolso, cancelamento] = casosEnfileirados();
            expect(reembolso.tipo).toBe('REEMBOLSO');
            expect(cancelamento.tipo).toBe('CANCELAMENTO');
            expect(body.idSolicitacao).toBe(reembolso.id_solicitacao);
        });
    });

    describe('exceção à política', () => {
        it.each([
            ['Ana', true, true],
            ['Ana', false, false],
            ['Bot', true, false],
        ] as const)('%s com policyException %s ⇒ excecao_politica %s', async (quem, policyException, esperado) => {
            await processRefund('barbours', { ...DATA, handledBy: quem, policyException }, { agora: AGORA });

            expect(casosEnfileirados()[0].excecao_politica).toBe(esperado);
        });
    });

    // ADR-010 e ADR-012: a planilha anda junto da fila. Ordem: config → dedup → fila → planilha.
    describe('linha na planilha (junto da fila)', () => {
        const BOT: RefundSubmissionData = { ...DATA, handledBy: 'Bot' };
        const CARIMBO = '27/10/2026 15:00:00';

        it('depois da fila: a linha do reembolso, com o MESMO id do caso, e o que identifica o pedido no aviso', async () => {
            const { body } = await processRefund('barbours', DATA, { agora: AGORA });

            expect(body.code).toBe('SUCCESS');
            expect(planilhas).toHaveBeenCalledTimes(1);
            expect(planilhas).toHaveBeenCalledWith(
                [{
                    fluxo: 'reembolso',
                    marca: 'barbours',
                    linha: buildRefundRow('barbours', prepararReembolso(DATA, CARIMBO)),
                    idSolicitacao: casosEnfileirados()[0].id_solicitacao,
                    // O que acha a linha na planilha depois: o pedido e o MESMO instante que foi para a fila.
                    pedido: '220183',
                    criadoEm: AGORA,
                }],
                { numeroPedido: '220183', idAtendimento: 'T-1', statusDaFila: 'enfileirado' },
            );
            expect(enfileirar.mock.invocationCallOrder[0]).toBeLessThan(planilhas.mock.invocationCallOrder[0]);
        });

        it('a linha leva o carimbo de São Paulo, como o n8n gravava', async () => {
            await processRefund('barbours', DATA, { agora: AGORA });

            expect(planilhas.mock.calls[0][0][0].linha[0]).toBe(CARIMBO);
        });

        it('Bot: DUAS linhas — o reembolso e o cancelamento, cada uma com o id do seu caso', async () => {
            const { body } = await processRefund('barbours', BOT, { agora: AGORA });

            expect(body.code).toBe('SUCCESS');
            const [reembolso, cancelamento] = casosEnfileirados();
            const [linhas, contexto] = planilhas.mock.calls[0];
            expect(planilhas).toHaveBeenCalledTimes(1);
            expect(contexto).toEqual({ numeroPedido: '220183', idAtendimento: 'T-1', statusDaFila: 'enfileirado' });
            expect(linhas.map((l) => [l.fluxo, l.idSolicitacao])).toEqual([
                ['reembolso', reembolso.id_solicitacao],
                ['cancelamento', cancelamento.id_solicitacao],
            ]);
            // As duas linhas são achadas depois pelo pedido e pelo MESMO instante dos dois casos.
            expect(linhas.map((l) => [l.pedido, l.criadoEm])).toEqual([['220183', AGORA], ['220183', AGORA]]);
            expect(casosEnfileirados().map((c) => c.criado_em)).toEqual([AGORA.toISOString(), AGORA.toISOString()]);
            expect(linhas[0].linha).toEqual(buildRefundRow('barbours', prepararReembolso(BOT, CARIMBO)));
            // Tratativa "Reembolso" (regra do Bot) e observações do reembolso, como o n8n mandava ao cancelamento.
            expect(linhas[1].linha).toEqual(buildCancellationRow('barbours', prepararCancelamento({
                brand: 'barbours',
                'Responsável': 'Bot',
                'Nome do(a) cliente': BOT.customerName,
                'Número do pedido (Shopify)': '220183',
                'Observações': BOT.notes ?? '',
                'Número da NF': '555',
                'CD de origem': 'SP',
                'Status': '',
                'Local da Tratativa': '',
                'Tratativa': 'Reembolso',
            }, CARIMBO)));
            expect(linhas[1].linha).toContain('Reembolso');
        });

        it('fora do Bot, só a linha do reembolso (nenhum cancelamento)', async () => {
            await processRefund('barbours', DATA, { agora: AGORA });

            expect(planilhas.mock.calls[0][0].map((l) => l.fluxo)).toEqual(['reembolso']);
        });

        it('fila incerta ⇒ a planilha É gravada, e a resposta é 504 API_TIMEOUT dizendo para NÃO repetir', async () => {
            enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });

            const { body, status } = await processRefund('barbours', DATA, { agora: AGORA });

            expect(planilhas).toHaveBeenCalledTimes(1);
            // o aviso da planilha não pode afirmar "entrou na fila": a fila não se confirmou
            expect(planilhas.mock.calls[0][1]).toMatchObject({ statusDaFila: 'incerto' });
            expect(status).toBe(504);
            expect(body).toEqual({
                code: 'API_TIMEOUT',
                message: 'O reembolso foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.',
                idSolicitacao: casosEnfileirados()[0].id_solicitacao,
            });
        });

        it('fila guardou e planilha falhou ⇒ SHEETS_ERROR + reason SHEET_WRITE_FAILED: na fila, planilha não, NÃO repita', async () => {
            planilhas.mockResolvedValue({ ok: false, motivo: 'HTTP 403 The caller does not have permission' });

            const { body, status } = await processRefund('barbours', DATA, { agora: AGORA });

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'SHEETS_ERROR',
                message: 'O reembolso entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.',
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: casosEnfileirados()[0].id_solicitacao,
            });
        });

        it('fila incerta e planilha falhou ⇒ SHEET_WRITE_FAILED dizendo que PODE ter entrado na fila', async () => {
            enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });
            planilhas.mockResolvedValue({ ok: false, motivo: 'HTTP 403' });

            const { body, status } = await processRefund('barbours', DATA, { agora: AGORA });

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'SHEETS_ERROR',
                message: 'O reembolso pode ter entrado na fila do Metabase (a fila respondeu HTTP 502), mas a planilha não foi atualizada. NÃO repita a solicitação.',
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: casosEnfileirados()[0].id_solicitacao,
            });
        });
    });

    describe('configuração do registro: recusa antes do dedup', () => {
        it.each(CONFIG_OBRIGATORIA)('sem %s ⇒ 503, e nada é consultado nem gravado', async (nome, citado) => {
            vi.stubEnv(nome, '');

            const { body, status } = await processRefund('barbours', DATA, { agora: AGORA });

            expect(status).toBe(503);
            expect(body.code).toBe('UNKNOWN_ERROR');
            expect(body.message).toContain(citado);
            expect(buscar).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
            expect(planilhas).not.toHaveBeenCalled();
        });
    });
});
