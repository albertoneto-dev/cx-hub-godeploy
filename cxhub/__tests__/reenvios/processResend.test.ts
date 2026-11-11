import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Só o dedup (fila + raw) e a entrega à fila são substituídos: os dois têm testes próprios (`filaEstado.test.ts` e
// `filaClient.test.ts`). O resto do barrel é o real.
vi.mock('@shared/lib/fila', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/fila')>()),
    solicitacaoRecenteNoRegistro: vi.fn(),
    enfileirarCasos: vi.fn(),
    prazoDaFila: vi.fn(),
}));
// A linha na planilha (ADR-010) tem testes próprios (`gravarLinha.test.ts`): aqui só importa QUANDO é chamada e o
// que a resposta diz quando ela falha.
vi.mock('@shared/lib/sheets/gravarLinha', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/sheets/gravarLinha')>()),
    gravarNasPlanilhas: vi.fn(),
}));

import { problemaNoCaso, type CasoCxhub } from '@shared/lib/airflow';
import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro, type ResultadoFila } from '@shared/lib/fila';
import { MetabaseError } from '@shared/lib/metabase';
import { gravarNasPlanilhas } from '@shared/lib/sheets/gravarLinha';
import { processResend, type ProcessResendInput } from '@modules/reenvios/actions/processResend';
import { buildCosmosResendBody } from '@modules/reenvios/actions/cosmosResend';
import { buildResendRow } from '@modules/reenvios/actions/buildResendRow';
import type { ResendSubmissionData, SheetsAppendResponse } from '@modules/reenvios/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { CONFIG_OBRIGATORIA, stubRegistroEnv } from '../helpers/registro-env';

const buscar = vi.mocked(solicitacaoRecenteNoRegistro);
const enfileirar = vi.mocked(enfileirarCasos);
const prazoPadrao = vi.mocked(prazoDaFila);
const planilhas = vi.mocked(gravarNasPlanilhas);

// 27/10/2026 15:00 em SP
const AGORA = new Date(Date.UTC(2026, 9, 27, 18, 0, 0));
/** O carimbo das linhas: o `criado_em` do caso (`AGORA`) em hora de São Paulo. */
const CARIMBO = '27/10/2026 15:00:00';
const PRAZO_PADRAO = 1_900_000_000_000;
const COSMOS_URL = 'https://cosmos.test/api/v3';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUCESSO = 'Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).';

/** Um reenvio já registrado há menos de 24h: 12:00 UTC = 09:00 em SP. */
const DUPLICATA = { idSolicitacao: 'id-0', pedido: '220183', responsavel: 'Ana', solicitadoEm: '2026-10-27T12:00:00Z' };

const base: ProcessResendInput = { brand: 'kokeshi', data: RESEND_DATA, token: 'cosmos-token', agora: AGORA };
const SEM_AUTOMACAO: ResendSubmissionData = { ...RESEND_DATA, automacao: '' };

/** O `POST /resend` do Cosmos; por padrão, aceito. */
function espionarCosmos() {
    return vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: 99 }), { status: 201 }));
}

let cosmos: ReturnType<typeof espionarCosmos>;

function cosmosResponde(status: number, corpo?: unknown) {
    cosmos.mockImplementation(async () => new Response(corpo === undefined ? null : JSON.stringify(corpo), { status }));
}

function casoEnfileirado(): CasoCxhub {
    expect(enfileirar).toHaveBeenCalledTimes(1);
    const casos = enfileirar.mock.calls[0][0];
    expect(casos).toHaveLength(1);
    return casos[0];
}

describe('processResend (registro na fila do Metabase e na planilha)', () => {
    beforeEach(() => {
        buscar.mockReset().mockResolvedValue(null);
        enfileirar.mockReset().mockResolvedValue({ status: 'enfileirado' });
        prazoPadrao.mockReset().mockReturnValue(PRAZO_PADRAO);
        planilhas.mockReset().mockResolvedValue({ ok: true });
        cosmos = espionarCosmos();
        stubRegistroEnv();
        vi.stubEnv('COSMOS_API_URL', COSMOS_URL);
        vi.stubEnv('COSMOS_RESEND_SIMULADO', '');
        vi.stubEnv('VERCEL_ENV', '');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    describe('dedup de 24h (fila e raw)', () => {
        it('reenvio do mesmo pedido nas últimas 24h ⇒ DUPLICATE_RESEND com quem pediu e quando (hora de SP), sem Cosmos e sem registro', async () => {
            buscar.mockResolvedValue(DUPLICATA);

            const { body, status } = await processResend(base);

            expect(buscar).toHaveBeenCalledWith('REENVIO', 'kokeshi', '#SHOPIFY220183');
            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'DUPLICATE_RESEND',
                message: 'Já existe um reenvio para o pedido 220183 feito por Ana em 27/10/2026 09:00:00',
                sentToAPI: false,
            });
            expect(cosmos).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
        });

        it('Metabase ou fila fora ⇒ 503 RECORD_UNAVAILABLE, e o Cosmos nunca é chamado', async () => {
            buscar.mockRejectedValue(new MetabaseError(0, 'Metabase não respondeu em 5s'));

            const { body, status } = await processResend(base);

            expect(status).toBe(503);
            expect(body).toEqual({
                code: 'UNKNOWN_ERROR',
                message: 'Não foi possível consultar as solicitações recentes — nada foi registrado nem reenviado. Tente novamente.',
                sentToAPI: false,
                reason: 'RECORD_UNAVAILABLE',
            });
            expect(cosmos).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
        });
    });

    describe('com automação', () => {
        it('dedup → Cosmos → fila ⇒ SUCCESS com o id do caso, marcado como automação', async () => {
            const { body, status } = await processResend({ ...base, idSolicitacao: 'req-1' });

            expect(status).toBe(200);
            expect(body).toEqual({ code: 'SUCCESS', message: SUCESSO, sentToAPI: true, idSolicitacao: 'req-1' });
            expect(casoEnfileirado().automacao).toBe(true);

            const [dedup] = buscar.mock.invocationCallOrder;
            const [post] = cosmos.mock.invocationCallOrder;
            const [fila] = enfileirar.mock.invocationCallOrder;
            expect(dedup).toBeLessThan(post);
            expect(post).toBeLessThan(fila);
        });

        it.each([
            ['kokeshi', '4'],
            ['rituaria', '9'],
        ] as const)('o POST /resend de %s vai à org %s, com o token de quem pediu e o corpo do reenvio', async (brand, org) => {
            await processResend({ ...base, brand });

            expect(cosmos).toHaveBeenCalledTimes(1);
            const [url, init] = cosmos.mock.calls[0];
            expect(url).toBe(`${COSMOS_URL}/organizations/${org}/orders/42/resend`);
            expect(init?.method).toBe('POST');
            expect(init?.headers).toMatchObject({ Authorization: 'Bearer cosmos-token', 'Content-Type': 'application/json' });
            expect(JSON.parse(String(init?.body))).toEqual(buildCosmosResendBody(RESEND_DATA));
        });
    });

    describe('sem automação', () => {
        it('não chama o Cosmos ⇒ SUCCESS_SHEETS_ONLY, com o caso marcado como não automatizado', async () => {
            // O apiData continua preenchido: quem decide é a coluna de automação, não a presença do corpo.
            const { body, status } = await processResend({ ...base, data: SEM_AUTOMACAO, idSolicitacao: 'req-2' });

            expect(status).toBe(200);
            expect(body).toEqual({ code: 'SUCCESS_SHEETS_ONLY', message: SUCESSO, sentToAPI: false, idSolicitacao: 'req-2' });
            expect(cosmos).not.toHaveBeenCalled();
            expect(casoEnfileirado().automacao).toBe(false);
        });
    });

    describe('recusa ou silêncio do Cosmos: volta como o Cosmos respondeu, sem registro (paridade com o n8n)', () => {
        it('422 "sem saldo" ⇒ OUT_OF_STOCK com o SKU', async () => {
            cosmosResponde(422, { error: 'SKU sem saldo: KS03010' });

            const { body, status } = await processResend(base);

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'OUT_OF_STOCK',
                message: 'Não foi possível reenviar: o SKU KS03010 está sem saldo no Cosmos. Verifique o estoque ou solicite reenvio manual.',
                sentToAPI: false,
            });
            expect(enfileirar).not.toHaveBeenCalled();
            expect(planilhas).not.toHaveBeenCalled();
        });

        it('422 com outro motivo ⇒ API_ERROR repetindo o motivo do ERP', async () => {
            cosmosResponde(422, { error: 'Transportadora inválida' });

            const { body, status } = await processResend(base);

            expect(status).toBe(200);
            expect(body).toEqual({ code: 'API_ERROR', message: 'O Cosmos recusou o reenvio: Transportadora inválida', sentToAPI: false });
            expect(enfileirar).not.toHaveBeenCalled();
        });

        it('5xx sem corpo ⇒ API_ERROR genérico, e o POST não é repetido', async () => {
            cosmosResponde(503);

            const { body } = await processResend(base);

            expect(body).toEqual({ code: 'API_ERROR', message: 'Ocorreu um erro ao se conectar ao servidor do Cosmos.', sentToAPI: false });
            expect(cosmos).toHaveBeenCalledTimes(1);
            expect(enfileirar).not.toHaveBeenCalled();
        });

        it('sem resposta ⇒ API_ERROR avisando que o reenvio PODE ter sido criado, sem repetir o POST', async () => {
            cosmos.mockRejectedValue(new TypeError('fetch failed'));

            const { body, status } = await processResend(base);

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'API_ERROR',
                message: 'O Cosmos não respondeu — o reenvio PODE ter sido criado. Confira no Cosmos antes de repetir.',
                sentToAPI: false,
            });
            expect(cosmos).toHaveBeenCalledTimes(1);
            expect(enfileirar).not.toHaveBeenCalled();
        });

        it('o prazo acaba durante o POST ⇒ aborta e avisa que o reenvio PODE ter sido criado', async () => {
            cosmos.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
            }));

            const { body } = await processResend({ ...base, timeoutMs: 30 });

            expect(cosmos.mock.calls[0][1]?.signal?.aborted).toBe(true);
            expect(body).toEqual({
                code: 'API_ERROR',
                message: 'O Cosmos não respondeu — o reenvio PODE ter sido criado. Confira no Cosmos antes de repetir.',
                sentToAPI: false,
            });
            expect(enfileirar).not.toHaveBeenCalled();
        });

        it('prazo já esgotado antes do POST ⇒ API_ERROR sem chamar o Cosmos', async () => {
            const { body } = await processResend({ ...base, timeoutMs: 0 });

            expect(body).toEqual({
                code: 'API_ERROR',
                message: 'O tempo acabou antes de chamar o Cosmos — o reenvio não foi enviado.',
                sentToAPI: false,
            });
            expect(cosmos).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
        });

        it.each([
            ['sem token', { token: undefined }],
            ['sem apiData', { data: { ...RESEND_DATA, apiData: undefined } }],
            ['sem cosmosId', { data: { ...RESEND_DATA, cosmosId: '' } }],
        ])('automação %s ⇒ API_ERROR sem nem chamar o Cosmos', async (_caso, ajuste) => {
            const { body, status } = await processResend({ ...base, ...ajuste });

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'API_ERROR',
                message: 'Os dados da automação estão incompletos — o reenvio não foi enviado ao Cosmos.',
                sentToAPI: false,
            });
            expect(cosmos).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
        });

        it('automação sem COSMOS_API_URL ⇒ API_ERROR sem nem chamar o Cosmos', async () => {
            vi.stubEnv('COSMOS_API_URL', '');

            const { body } = await processResend(base);

            expect(body.code).toBe('API_ERROR');
            expect(body.message).toBe('Os dados da automação estão incompletos — o reenvio não foi enviado ao Cosmos.');
            expect(cosmos).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
        });
    });

    describe('modo de teste', () => {
        it('com a automação preenchida: nem Cosmos nem fila nem planilha ⇒ SUCCESS_TEST_MODE', async () => {
            const { body, status } = await processResend({ ...base, testMode: true });

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'SUCCESS_TEST_MODE',
                message: 'Solicitação de TESTE: nada foi registrado e nenhum reenvio foi executado.',
                sentToAPI: false,
            });
            expect(cosmos).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
            expect(planilhas).not.toHaveBeenCalled();
        });

        it('o dedup roda antes, como no n8n: um reenvio real nas últimas 24h barra o ensaio', async () => {
            buscar.mockResolvedValue(DUPLICATA);

            const { body } = await processResend({ ...base, testMode: true });

            expect(body.code).toBe('DUPLICATE_RESEND');
            expect(cosmos).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
        });
    });

    describe('fila que não guardou com certeza', () => {
        const INCERTO: ResultadoFila = { status: 'incerto', motivo: 'a fila respondeu HTTP 502' };
        const RECUSADO: ResultadoFila = { status: 'recusado', motivo: 'a fila respondeu HTTP 400 INVALID_REQUEST' };
        const ID = 'req-registro';

        it.each<[string, ResultadoFila, ResendSubmissionData, number, SheetsAppendResponse]>([
            [
                'incerto depois do Cosmos ⇒ ROW_UNCERTAIN, dizendo que o reenvio saiu e para NÃO repetir',
                INCERTO,
                RESEND_DATA,
                1,
                {
                    code: 'SHEETS_ERROR',
                    message: 'O reenvio foi processado com sucesso no Cosmos e a solicitação foi registrada na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.',
                    sentToAPI: true,
                    reason: 'ROW_UNCERTAIN',
                    idSolicitacao: ID,
                },
            ],
            [
                'incerto sem automação ⇒ ROW_UNCERTAIN, NÃO repita',
                INCERTO,
                SEM_AUTOMACAO,
                0,
                {
                    code: 'SHEETS_ERROR',
                    message: 'A solicitação foi registrada na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.',
                    sentToAPI: false,
                    reason: 'ROW_UNCERTAIN',
                    idSolicitacao: ID,
                },
            ],
            [
                'recusado depois do Cosmos ⇒ RECORD_UNAVAILABLE, dizendo que o reenvio saiu',
                RECUSADO,
                RESEND_DATA,
                1,
                {
                    code: 'SHEETS_ERROR',
                    message: 'O reenvio foi processado com sucesso no Cosmos, porém houve um erro ao registrar a solicitação (a fila respondeu HTTP 400 INVALID_REQUEST).',
                    sentToAPI: true,
                    reason: 'RECORD_UNAVAILABLE',
                },
            ],
            [
                'recusado sem automação ⇒ RECORD_UNAVAILABLE, pedindo para tentar de novo',
                RECUSADO,
                SEM_AUTOMACAO,
                0,
                {
                    code: 'SHEETS_ERROR',
                    message: 'Houve um erro ao registrar o reenvio (a fila respondeu HTTP 400 INVALID_REQUEST). Tente novamente.',
                    sentToAPI: false,
                    reason: 'RECORD_UNAVAILABLE',
                },
            ],
        ])('%s', async (_titulo, fila, data, chamadasAoCosmos, esperado) => {
            enfileirar.mockResolvedValue(fila);

            const { body, status } = await processResend({ ...base, data, idSolicitacao: ID });

            expect(status).toBe(200);
            expect(body).toEqual(esperado);
            expect(cosmos).toHaveBeenCalledTimes(chamadasAoCosmos);
        });
    });

    describe('COSMOS_RESEND_SIMULADO (teste local)', () => {
        it('"true": o POST não sai, o reenvio conta como aceito e o log não leva dado da cliente', async () => {
            vi.stubEnv('COSMOS_RESEND_SIMULADO', 'true');

            const { body } = await processResend({ ...base, idSolicitacao: 'req-sim' });

            expect(cosmos).not.toHaveBeenCalled();
            expect(body).toEqual({ code: 'SUCCESS', message: SUCESSO, sentToAPI: true, idSolicitacao: 'req-sim' });
            expect(casoEnfileirado().automacao).toBe(true);

            const logs = JSON.stringify(vi.mocked(console.warn).mock.calls);
            expect(logs).toContain('SIMULADO');
            for (const pessoal of ['NOME', '11999990000', 'Rua A', '01001000']) {
                expect(logs).not.toContain(pessoal);
            }
        });

        it('ignorado com VERCEL_ENV=production: o POST sai de verdade', async () => {
            vi.stubEnv('COSMOS_RESEND_SIMULADO', 'true');
            vi.stubEnv('VERCEL_ENV', 'production');

            const { body } = await processResend(base);

            expect(cosmos).toHaveBeenCalledTimes(1);
            expect(body.code).toBe('SUCCESS');
            expect(console.warn).toHaveBeenCalledWith('[Resend Direct] COSMOS_RESEND_SIMULADO ignorado na produção');
        });
    });

    describe('o caso entregue à fila', () => {
        it('sem dado da cliente nem observações, e com o que a planilha guardava e a gold não tinha', async () => {
            await processResend({ ...base, idSolicitacao: 'req-1' });
            const caso = casoEnfileirado();

            expect(caso).toEqual({
                id_solicitacao: 'req-1',
                tipo: 'REENVIO',
                marca: 'kokeshi',
                criado_em: '2026-10-27T18:00:00.000Z',
                numero_pedido: '#SHOPIFY220183',
                data_pedido: '20/10/2026',
                nf: 'NF',
                chave_nf: 'CHAVE',
                valor: 'VALOR',
                motivo: 'PROBLEMA',
                skus: 'PROD_PROB',
                uf: 'UF',
                cd_origem: 'CD',
                status_pedido: 'STATUS_PED',
                transportadora: 'T_ORIG',
                lote: 'LOTE',
                erp: 'ERP',
                pedido_completo: false,
                devolucao: false,
                responsavel: 'RESP',
                origem: 'ORIGEM',
                id_atendimento: 'ID',
                automacao: true,
                produtos_reenvio: 'PROD_REEN',
                transportadora_reenvio: 'T_REEN',
                // 'TIPO' (a fixture) não é Reenvio nem Cashback: a DAG falharia o run, então não vai.
                tipo_solicitacao: undefined,
                ticket_transportadora: 'TICKET',
            });

            for (const campo of ['cliente', 'cidade', 'cep', 'observacoes']) {
                expect(caso).not.toHaveProperty(campo);
            }
            const { nomeCliente, telefoneCliente, enderecoCliente, cep, comentarios } = RESEND_DATA;
            const { street, city, postal_code } = RESEND_DATA.apiData!.shippingAddress;
            const valores = Object.values(caso);
            for (const pessoal of [nomeCliente, telefoneCliente, enderecoCliente, cep, comentarios, street, city, postal_code]) {
                expect(valores).not.toContain(pessoal);
            }
            expect(problemaNoCaso(caso)).toBeNull();
        });

        it('usa o idSolicitacao e o prazoFila de quem chama (o bot)', async () => {
            await processResend({ ...base, idSolicitacao: 'req-123', prazoFila: 1_800_000_000_000 });

            expect(enfileirar).toHaveBeenCalledWith([expect.objectContaining({ id_solicitacao: 'req-123' })], 1_800_000_000_000);
            expect(prazoPadrao).not.toHaveBeenCalled();
        });

        it('sem eles: id novo (UUID) e o prazo padrão da fila', async () => {
            const { body } = await processResend(base);

            const caso = casoEnfileirado();
            expect(caso.id_solicitacao).toMatch(UUID);
            expect(body.idSolicitacao).toBe(caso.id_solicitacao);
            expect(enfileirar.mock.calls[0][1]).toBe(PRAZO_PADRAO);
        });
    });

    // ADR-010 e ADR-012: a planilha anda junto da fila. Ordem: config → dedup → Cosmos → fila → planilha.
    describe('linha na planilha (junto da fila)', () => {
        it('depois da fila: a linha da marca, com o MESMO id do caso, e o que identifica o pedido no aviso', async () => {
            const { body } = await processResend({ ...base, idSolicitacao: 'req-9' });

            expect(body.code).toBe('SUCCESS');
            expect(planilhas).toHaveBeenCalledTimes(1);
            expect(planilhas).toHaveBeenCalledWith(
                [{
                    fluxo: 'reenvio',
                    marca: 'kokeshi',
                    linha: buildResendRow('kokeshi', RESEND_DATA, CARIMBO),
                    idSolicitacao: 'req-9',
                    // O que acha a linha na planilha depois: o pedido e o MESMO instante que foi para a fila.
                    pedido: '#SHOPIFY220183',
                    criadoEm: AGORA,
                }],
                { numeroPedido: '#SHOPIFY220183', idAtendimento: 'ID', statusDaFila: 'enfileirado' },
            );
            expect(casoEnfileirado().id_solicitacao).toBe('req-9');

            const [dedup] = buscar.mock.invocationCallOrder;
            const [post] = cosmos.mock.invocationCallOrder;
            const [fila] = enfileirar.mock.invocationCallOrder;
            const [linha] = planilhas.mock.invocationCallOrder;
            expect(dedup).toBeLessThan(post);
            expect(post).toBeLessThan(fila);
            expect(fila).toBeLessThan(linha);
        });

        it('sem automação a linha também vai ⇒ SUCCESS_SHEETS_ONLY', async () => {
            const { body } = await processResend({ ...base, data: SEM_AUTOMACAO });

            expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
            expect(planilhas).toHaveBeenCalledTimes(1);
            expect(planilhas.mock.calls[0][0][0].linha).toEqual(buildResendRow('kokeshi', SEM_AUTOMACAO, CARIMBO));
        });

        it('fila recusou ⇒ a planilha NÃO é gravada (o agente repete, e não haveria linha órfã)', async () => {
            enfileirar.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400' });

            const { body } = await processResend({ ...base, data: SEM_AUTOMACAO });

            expect(body.reason).toBe('RECORD_UNAVAILABLE');
            expect(planilhas).not.toHaveBeenCalled();
        });

        it('fila incerta ⇒ a planilha É gravada, com o aviso sem afirmar que o caso entrou na fila', async () => {
            enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });

            const { body } = await processResend({ ...base, data: SEM_AUTOMACAO });

            expect(planilhas).toHaveBeenCalledTimes(1);
            expect(planilhas.mock.calls[0][1]).toMatchObject({ statusDaFila: 'incerto' });
            expect(body.reason).toBe('ROW_UNCERTAIN');
        });

        it('fila guardou e planilha falhou ⇒ SHEETS_ERROR / SHEET_WRITE_FAILED: na fila, planilha não, NÃO repita', async () => {
            planilhas.mockResolvedValue({ ok: false, motivo: 'HTTP 403 The caller does not have permission' });

            const { body, status } = await processResend({ ...base, data: SEM_AUTOMACAO, idSolicitacao: 'req-p' });

            expect(status).toBe(200);
            expect(body).toEqual({
                code: 'SHEETS_ERROR',
                message: 'A solicitação entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.',
                sentToAPI: false,
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: 'req-p',
            });
        });

        it('com o reenvio já feito no Cosmos, a resposta diz isso e sentToAPI continua true', async () => {
            planilhas.mockResolvedValue({ ok: false, motivo: 'prazo esgotado' });

            const { body } = await processResend({ ...base, idSolicitacao: 'req-q' });

            expect(body).toEqual({
                code: 'SHEETS_ERROR',
                message: 'O reenvio foi processado com sucesso no Cosmos e a solicitação entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.',
                sentToAPI: true,
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: 'req-q',
            });
        });

        it('fila incerta e planilha falhou ⇒ SHEET_WRITE_FAILED dizendo que PODE ter entrado na fila', async () => {
            enfileirar.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });
            planilhas.mockResolvedValue({ ok: false, motivo: 'HTTP 403' });

            const { body } = await processResend({ ...base, data: SEM_AUTOMACAO, idSolicitacao: 'req-r' });

            expect(body).toEqual({
                code: 'SHEETS_ERROR',
                message: 'A solicitação pode ter entrado na fila do Metabase (a fila respondeu HTTP 502), mas a planilha não foi atualizada. NÃO repita a solicitação.',
                sentToAPI: false,
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: 'req-r',
            });
        });

        it('a resposta da falha não vaza o motivo técnico da planilha nem dado da cliente', async () => {
            planilhas.mockResolvedValue({ ok: false, motivo: 'HTTP 403 The caller does not have permission' });

            const { body } = await processResend(base);
            // O id do caso é um UUID aleatório e às vezes contém "403" (`…-3403-…`): fica fora da comparação.
            const semId = JSON.stringify({ ...body, idSolicitacao: undefined });

            expect(body.idSolicitacao).toBeDefined();
            expect(semId).not.toContain('403');
            for (const pessoal of ['NOME', '(11) 99999-0000', 'END']) {
                expect(semId).not.toContain(pessoal);
            }
        });
    });

    describe('configuração do registro: recusa antes do dedup e do Cosmos', () => {
        it.each(CONFIG_OBRIGATORIA)('sem %s ⇒ 503 RECORD_UNAVAILABLE, e nada é consultado, reenviado nem gravado', async (nome, citado) => {
            vi.stubEnv(nome, '');

            const { body, status } = await processResend(base);

            expect(status).toBe(503);
            expect(body).toMatchObject({ code: 'UNKNOWN_ERROR', sentToAPI: false, reason: 'RECORD_UNAVAILABLE' });
            expect(body.message).toContain(citado);
            expect(body.message).toContain('nada foi registrado nem reenviado');
            expect(buscar).not.toHaveBeenCalled();
            expect(cosmos).not.toHaveBeenCalled();
            expect(enfileirar).not.toHaveBeenCalled();
            expect(planilhas).not.toHaveBeenCalled();
        });

        it('SHEETS_ENV fora de prod/staging também recusa (falha fechada, sem default)', async () => {
            vi.stubEnv('SHEETS_ENV', 'production');

            const { status } = await processResend(base);

            expect(status).toBe(503);
            expect(cosmos).not.toHaveBeenCalled();
        });

        it('o ensaio (modo de teste) não grava em lado nenhum, então não exige a configuração', async () => {
            vi.stubEnv('GOOGLE_PLANILHAS_TOKEN', '');
            vi.stubEnv('CXHUB_FILA_URL', '');

            const { body } = await processResend({ ...base, testMode: true });

            expect(body.code).toBe('SUCCESS_TEST_MODE');
        });
    });
});
