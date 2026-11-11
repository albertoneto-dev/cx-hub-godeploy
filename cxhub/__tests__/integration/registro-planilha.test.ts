import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A fila do Metabase (dedup e entrega) e o Chat são substituídos; a planilha NÃO: o `gravarNasPlanilhas` e o
// `gravarLinhaNaPlanilha` reais rodam contra um Google em memória (`fetch` substituído). É o que prova a ponta inteira
// do ADR-010 com o ADR-012: a ordem (fila antes da planilha), o MESMO id nos dois lados, e o que acontece quando a
// planilha falha.
vi.mock('@shared/lib/fila', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/fila')>()),
    solicitacaoRecenteNoRegistro: vi.fn(),
    enfileirarCasos: vi.fn(),
    prazoDaFila: vi.fn(),
}));
vi.mock('@shared/lib/alerts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/alerts')>()),
    sendAlert: vi.fn(),
}));

import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro } from '@shared/lib/fila';
import { sendAlert } from '@shared/lib/alerts';
import { formatarCarimboSP } from '@shared/lib/format';
import { __resetCasoNaPlanilha, lerCarimbo } from '@shared/lib/sheets/casoNaPlanilha';
import { __resetGoogleTokenCache } from '@shared/lib/sheets/googleAuth';
import { resolverPlanilha } from '@shared/lib/sheets';
import { processResend } from '@modules/reenvios/actions/processResend';
import { buildResendRow } from '@modules/reenvios/actions/buildResendRow';
import { processRefund } from '@modules/reembolsos/actions/processRefund';
import { buildRefundRow, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { processCancellation } from '@shared/lib/cancellation/processCancellation';
import { buildCancellationRow, prepararCancelamento } from '@shared/lib/cancellation/buildCancellationRow';
import type { CancellationPayload } from '@shared/lib/cancellation';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { stubRegistroEnv } from '../helpers/registro-env';
import { stubGoogleEnv } from '../helpers/google-sheets-mock';
import { cabecalhoDoLayout, instalarGoogleFalso, instalarGoogleFalsoPorPlanilha, criarAbaFalsa } from '../helpers/google-sheets-falso';

const buscar = vi.mocked(solicitacaoRecenteNoRegistro);
const enfileirar = vi.mocked(enfileirarCasos);
const alerta = vi.mocked(sendAlert);

const AGORA = new Date(Date.UTC(2026, 9, 30, 18, 0, 0));
const SEM_AUTOMACAO = { ...RESEND_DATA, automacao: '' };
/** O carimbo das linhas: o `criado_em` do caso (`agora`), formatado. */
const CARIMBO = formatarCarimboSP(AGORA);

const REEMBOLSO_DO_BOT: RefundSubmissionData = {
    brand: 'barbours',
    data_criacao: '20/10/2026',
    handledBy: 'Bot',
    sourceChannel: 'Chat Atendimento',
    supportTicketId: 'T-1',
    originWarehouse: 'SP',
    customerName: 'Cliente Teste',
    invoiceNumber: '555',
    nfeAccessKey: 'CHAVE',
    batchNumber: null,
    ecommerceOrderId: '220183',
    policyException: false,
    refundAmount: 99.9,
    refundReason: 'Avaria',
    refundScope: 'Frete',
    requiresReturn: false,
    carrierTicketId: null,
    carrierName: 'PAC',
    orderStatus: 'Entregue',
    isFullRefund: true,
    notes: 'obs',
};

const CANCELAMENTO: CancellationPayload = {
    brand: 'kokeshi',
    'Responsável': 'Agente Teste',
    'Nome do(a) cliente': 'Cliente Teste',
    'Número do pedido (Shopify)': '220183',
    'Observações': 'obs',
    'Número da NF': '123456',
    'CD de origem': 'Unilog SP',
    'Status': '',
    'Local da Tratativa': '',
    'Tratativa': 'Reenvio',
};

/** As chamadas ao Google (qualquer URL do googleapis). */
function chamadasAoGoogle(): string[] {
    return vi.mocked(global.fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.includes('googleapis.com'));
}

describe('o registro de ponta a ponta: fila e planilha andam juntas (ADR-010, ADR-012)', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        __resetCasoNaPlanilha();
        stubRegistroEnv();
        stubGoogleEnv(); // por cima: a chave de verdade (gerada no teste), porque o JWT é assinado; SHEETS_ENV=staging
        buscar.mockReset().mockResolvedValue(null);
        enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
        vi.mocked(prazoDaFila).mockReset().mockReturnValue(Date.now() + 16_000);
        alerta.mockReset().mockResolvedValue(true);
        for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    describe('reenvio', () => {
        it('a fila recebe primeiro; depois a linha entra na planilha da marca, com o MESMO instante do caso (o carimbo é o criado_em)', async () => {
            const linha = buildResendRow('kokeshi', SEM_AUTOMACAO, CARIMBO);
            const aba = instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi', linha.length));

            const { body } = await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA, idSolicitacao: 'req-1' });

            expect(body).toEqual({
                code: 'SUCCESS_SHEETS_ONLY',
                message: 'Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).',
                sentToAPI: false,
                idSolicitacao: 'req-1',
            });
            expect(enfileirar.mock.calls[0][0][0].id_solicitacao).toBe('req-1');
            expect(aba.linhas).toEqual([linha]);

            // a fila antes de qualquer chamada ao Google
            const primeiraChamadaAoGoogle = vi.mocked(global.fetch).mock.invocationCallOrder[0];
            expect(enfileirar.mock.invocationCallOrder[0]).toBeLessThan(primeiraChamadaAoGoogle);
            expect(alerta).not.toHaveBeenCalled();
        });

        it('a planilha falha depois da fila ⇒ SHEET_WRITE_FAILED, aviso com o id (sem dado pessoal) e a linha completa no log', async () => {
            const linha = buildResendRow('kokeshi', SEM_AUTOMACAO, CARIMBO);
            const aba = instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi', linha.length));
            aba.appends.push({ status: 403, json: { error: { message: 'The caller does not have permission' } } });

            const { body, status } = await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA, idSolicitacao: 'req-2' });

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'SHEETS_ERROR',
                message: 'A solicitação entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.',
                sentToAPI: false,
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: 'req-2',
            });
            expect(enfileirar).toHaveBeenCalledTimes(1);

            expect(alerta).toHaveBeenCalledTimes(1);
            expect(alerta.mock.calls[0][0]).toMatchObject({
                reason: 'SHEET_WRITE_FAILED', requestId: 'req-2', brand: 'kokeshi', numeroPedido: '#SHOPIFY220183',
            });
            expect(JSON.stringify(alerta.mock.calls[0][0])).not.toContain('NOME');

            const log = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).find((t) => t.includes('linha não gravada'));
            expect(log).toContain(JSON.stringify(linha));
            expect(log).toContain('req-2');
        });

        it('a rede cai DEPOIS de gravar a linha: a 2ª tentativa acha a linha (pedido e carimbo) e a planilha fica com UMA linha só', async () => {
            const linha = buildResendRow('kokeshi', SEM_AUTOMACAO, CARIMBO);
            const aba = instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi', linha.length));
            aba.appends.push({ redeDepoisDeGravar: true });

            const { body } = await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA, idSolicitacao: 'req-3' });

            expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
            expect(aba.linhas).toHaveLength(1);
            expect(aba.contagem.appends).toBe(1);
        });

        it('o carimbo da linha é o criado_em do caso na fila: o mesmo instante, em hora de São Paulo (e não o timestamp do corpo)', async () => {
            const aba = instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi'));
            // O corpo traz um `timestamp` de outra hora (o do formulário): não é ele que vai para a linha.
            const data = { ...SEM_AUTOMACAO, timestamp: '01/01/2020, 08:00:00' };

            await processResend({ brand: 'kokeshi', data, agora: AGORA, idSolicitacao: 'req-5' });

            const criadoEm = enfileirar.mock.calls[0][0][0].criado_em;
            expect(criadoEm).toBe(AGORA.toISOString());
            expect(aba.linhas[0][0]).toBe(formatarCarimboSP(new Date(criadoEm)));
            expect(aba.linhas[0][0]).toBe('30/10/2026 15:00:00');
            expect(lerCarimbo(aba.linhas[0][0])).toBe(Date.parse(criadoEm));
        });

        it('registrar de novo o MESMO caso (mesmo pedido e mesmo instante) não duplica a linha: ja_existia', async () => {
            const aba = instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi'));

            await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA, idSolicitacao: 'req-6' });
            const { body } = await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA, idSolicitacao: 'req-6' });

            expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
            expect(aba.linhas).toHaveLength(1);
            expect(aba.contagem.appends).toBe(1);
        });

        it('outro caso do mesmo pedido, 10 minutos depois, é outra linha', async () => {
            const aba = instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi'));

            await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA, idSolicitacao: 'req-7' });
            await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: new Date(AGORA.getTime() + 10 * 60_000), idSolicitacao: 'req-8' });

            expect(aba.linhas).toHaveLength(2);
        });

        it('fila recusou ⇒ NENHUMA chamada ao Google', async () => {
            instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi'));
            enfileirar.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400' });

            const { body } = await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA });

            expect(body.reason).toBe('RECORD_UNAVAILABLE');
            expect(chamadasAoGoogle()).toEqual([]);
        });

        it('fila incerta ⇒ a linha É gravada, e a resposta diz para NÃO repetir', async () => {
            const linha = buildResendRow('kokeshi', SEM_AUTOMACAO, CARIMBO);
            const aba = instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi', linha.length));
            enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });

            const { body } = await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA, idSolicitacao: 'req-4' });

            expect(body.reason).toBe('ROW_UNCERTAIN');
            expect(body.message).toContain('NÃO repita');
            expect(aba.linhas).toEqual([linha]);
        });

        it('modo de teste ⇒ nenhuma gravação, nem na fila nem no Google', async () => {
            instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi'));

            const { body } = await processResend({ brand: 'kokeshi', data: SEM_AUTOMACAO, agora: AGORA, testMode: true });

            expect(body.code).toBe('SUCCESS_TEST_MODE');
            expect(enfileirar).not.toHaveBeenCalled();
            expect(chamadasAoGoogle()).toEqual([]);
        });

        it.each(['GOOGLE_PLANILHAS_EMAIL', 'GOOGLE_PLANILHAS_TOKEN', 'SHEETS_ENV', 'CXHUB_FILA_TOKEN'])(
            'sem %s ⇒ recusa ANTES do dedup, do Cosmos e de qualquer gravação',
            async (nome) => {
                instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi'));
                vi.stubEnv(nome, '');
                vi.stubEnv('COSMOS_API_URL', 'https://cosmos.test/api/v3');

                // COM automação: o Cosmos seria chamado se a configuração não barrasse antes.
                const { body, status } = await processResend({ brand: 'kokeshi', data: RESEND_DATA, token: 'cosmos-token', agora: AGORA });

                expect(status).toBe(503);
                expect(body.reason).toBe('RECORD_UNAVAILABLE');
                expect(buscar).not.toHaveBeenCalled();
                expect(enfileirar).not.toHaveBeenCalled();
                // nem o Cosmos nem o Google: nenhuma chamada de rede
                expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
            },
        );
    });

    describe('reembolso do Bot: duas linhas, em duas planilhas', () => {
        it('cada linha entra na sua planilha, com o carimbo igual ao criado_em do seu caso', async () => {
            const reembolso = resolverPlanilha('reembolso', 'barbours');
            const cancelamento = resolverPlanilha('cancelamento', 'barbours');
            const linhaReembolso = buildRefundRow('barbours', prepararReembolso(REEMBOLSO_DO_BOT, CARIMBO));
            const linhaCancelamento = buildCancellationRow('barbours', prepararCancelamento({
                brand: 'barbours', 'Responsável': 'Bot', 'Nome do(a) cliente': 'Cliente Teste', 'Número do pedido (Shopify)': '220183',
                'Observações': 'obs', 'Número da NF': '555', 'CD de origem': 'SP', 'Status': '', 'Local da Tratativa': '', 'Tratativa': 'Reembolso',
            }, CARIMBO));
            const abas = {
                [reembolso.spreadsheetId]: criarAbaFalsa(cabecalhoDoLayout('reembolso', 'barbours', linhaReembolso.length)),
                [cancelamento.spreadsheetId]: criarAbaFalsa(cabecalhoDoLayout('cancelamento', 'barbours', linhaCancelamento.length)),
            };
            instalarGoogleFalsoPorPlanilha(abas);

            const { body } = await processRefund('barbours', REEMBOLSO_DO_BOT, { agora: AGORA });

            const [casoReembolso, casoCancelamento] = enfileirar.mock.calls[0][0];
            expect(body).toEqual({
                code: 'SUCCESS',
                message: 'Reembolso registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).',
                idSolicitacao: casoReembolso.id_solicitacao,
            });
            expect(casoReembolso.tipo).toBe('REEMBOLSO');
            expect(casoCancelamento.tipo).toBe('CANCELAMENTO');
            expect(casoReembolso.id_solicitacao).not.toBe(casoCancelamento.id_solicitacao);

            const gravadaReembolso = abas[reembolso.spreadsheetId].linhas;
            const gravadaCancelamento = abas[cancelamento.spreadsheetId].linhas;
            expect(gravadaReembolso).toHaveLength(1);
            expect(gravadaCancelamento).toHaveLength(1);
            expect(gravadaReembolso[0]).toEqual(linhaReembolso);
            expect(lerCarimbo(gravadaReembolso[0][0])).toBe(Date.parse(casoReembolso.criado_em));
            expect(gravadaCancelamento[0]).toEqual(linhaCancelamento);
            expect(lerCarimbo(gravadaCancelamento[0][0])).toBe(Date.parse(casoCancelamento.criado_em));
            expect(gravadaCancelamento[0]).toContain('Reembolso'); // a tratativa do Bot
        });

        it('só a planilha do cancelamento falha ⇒ SHEETS_ERROR (não repita), e só ela é avisada', async () => {
            const reembolso = resolverPlanilha('reembolso', 'barbours');
            const cancelamento = resolverPlanilha('cancelamento', 'barbours');
            const abaReembolso = criarAbaFalsa(cabecalhoDoLayout('reembolso', 'barbours'));
            const abaCancelamento = criarAbaFalsa(cabecalhoDoLayout('cancelamento', 'barbours'));
            abaCancelamento.appends.push({ status: 403 });
            instalarGoogleFalsoPorPlanilha({ [reembolso.spreadsheetId]: abaReembolso, [cancelamento.spreadsheetId]: abaCancelamento });

            const { body, status } = await processRefund('barbours', REEMBOLSO_DO_BOT, { agora: AGORA });

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'SHEETS_ERROR',
                message: 'O reembolso entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.',
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: enfileirar.mock.calls[0][0][0].id_solicitacao,
            });
            expect(abaReembolso.linhas).toHaveLength(1);
            expect(abaCancelamento.linhas).toHaveLength(0);
            expect(alerta).toHaveBeenCalledTimes(1);
            expect(alerta.mock.calls[0][0]).toMatchObject({
                reason: 'SHEET_WRITE_FAILED', requestId: enfileirar.mock.calls[0][0][1].id_solicitacao, brand: 'barbours',
            });
        });

        it('config ausente ⇒ recusa antes do dedup (503), e nada é gravado', async () => {
            vi.stubEnv('GOOGLE_PLANILHAS_EMAIL', '');

            const { status } = await processRefund('barbours', REEMBOLSO_DO_BOT, { agora: AGORA });

            expect(status).toBe(503);
            expect(buscar).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
        });
    });

    describe('cancelamento', () => {
        it('a linha entra com o carimbo do criado_em do caso; fila recusou ⇒ nenhuma chamada ao Google', async () => {
            const linha = buildCancellationRow('kokeshi', prepararCancelamento(CANCELAMENTO, CARIMBO));
            const aba = instalarGoogleFalso(cabecalhoDoLayout('cancelamento', 'kokeshi', linha.length));

            const { body } = await processCancellation('kokeshi', CANCELAMENTO, { agora: AGORA });

            expect(body.code).toBe('SUCCESS');
            expect(aba.linhas).toHaveLength(1);
            expect(aba.linhas[0]).toEqual(linha);
            expect(lerCarimbo(aba.linhas[0][0])).toBe(Date.parse(enfileirar.mock.calls[0][0][0].criado_em));

            vi.mocked(global.fetch).mockClear();
            enfileirar.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400' });
            const recusado = await processCancellation('kokeshi', CANCELAMENTO, { agora: AGORA });
            expect(recusado.status).toBe(500);
            expect(chamadasAoGoogle()).toEqual([]);
        });
    });
});
