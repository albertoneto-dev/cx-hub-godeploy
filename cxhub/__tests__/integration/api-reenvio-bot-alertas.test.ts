import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '../../app/api/reenvio/bot/route';
import { createRequest } from '../helpers/api-test-utils';
import { createNormalizedOrder } from '../helpers/factories';
import type { ResendSubmissionData } from '@modules/reenvios/types';

/**
 * O aviso acionável (ADR-005) na rota do bot.
 *
 * Duas réguas, e a segunda é a que protege a operação:
 *
 * 1. **Contorno antes do aviso, aviso só do que é nosso.** Falha de sistema avisa; falha de **dado da
 *    cliente** não avisa — volta ao bot pelo `reason` para ele perguntar de novo. Um grupo que apita a
 *    cada endereço incompleto dessensibiliza quem lê, e aviso que ninguém lê é o silêncio de volta.
 * 2. **O aviso NUNCA altera o desfecho da solicitação.** Webhook do Chat fora do ar tem de dar
 *    exatamente o mesmo resultado que webhook funcionando. Perder a solicitação por causa do mecanismo
 *    que existe para avisar que ela se perdeu seria o pior desfecho possível desta fatia.
 */

// ─── Mocks ───────────────────────────────────────────────────────────

vi.mock('@shared/lib/cosmos/server', () => ({
    getCosmosServiceToken: vi.fn(),
    fetchNormalizedCosmosOrder: vi.fn(),
    __resetCosmosTokenCache: vi.fn(),
}));

vi.mock('@modules/reenvios/actions/buildBotResendData', () => ({
    buildBotResendData: vi.fn(),
    stripAutomation: vi.fn((data: ResendSubmissionData) => {
        const { apiData: _descartado, ...resto } = data;
        return { ...resto, valorReenvio: '', status: '', codNfd: '', automacao: '', erp: '' };
    }),
}));

vi.mock('@modules/reenvios/actions/postResendWebhook', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@modules/reenvios/actions/postResendWebhook')>();
    return { ...actual, postResendWebhook: vi.fn() };
});

vi.mock('@shared/lib/alerts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@shared/lib/alerts')>();
    return { ...actual, sendAlert: vi.fn().mockResolvedValue(true) };
});

import { getCosmosServiceToken, fetchNormalizedCosmosOrder } from '@shared/lib/cosmos/server';
import { buildBotResendData } from '@modules/reenvios/actions/buildBotResendData';
import { postResendWebhook } from '@modules/reenvios/actions/postResendWebhook';
import { sendAlert } from '@shared/lib/alerts';

const mFetchOrder = vi.mocked(fetchNormalizedCosmosOrder);
const mToken = vi.mocked(getCosmosServiceToken);
const mBuild = vi.mocked(buildBotResendData);
const mPost = vi.mocked(postResendWebhook);
const mAlert = vi.mocked(sendAlert);

// ─── Fixtures ────────────────────────────────────────────────────────

const URL = 'http://localhost/api/reenvio/bot';
const BOT_SECRET = 'segredo-do-bot-123';

function post(body: unknown, headers: Record<string, string> = { 'x-bot-secret': BOT_SECRET }) {
    return POST(createRequest(URL, { method: 'POST', body, headers }));
}

const API_DATA = {
    carrierId: 161,
    carrierServiceName: 'PAC',
    shippingCost: '15.00',
    discountAmount: '0',
    resendProducts: [{ product_id: 5001, quantity: 1, unit_price: '150.00' }],
    shippingAddress: {
        street: 'Rua Teste', number: '123', complement: '', neighborhood: 'Centro',
        city: 'São Paulo', state: 'SP', postal_code: '01001-000',
    },
};

function submissionCompleta(overrides: Partial<ResendSubmissionData> = {}): ResendSubmissionData {
    return {
        timestamp: '01/01/2026 10:00:00', dataSolicitacao: '01/01/2026', data_criacao: '01/01/2026',
        tipoSolicitacao: 'Reenvio', responsavel: 'Typebot', origemReclamacao: 'Chat Atendimento',
        idAtendimento: 'TKT-1', cdOrigem: 'SP', nomeCliente: 'Maria Cliente',
        telefoneCliente: '11999999999', enderecoCliente: 'Rua Teste, 123', cep: '01001-000',
        estado: 'SP', numeroPedido: '#220183', numeroNF: '123456', chaveNF: 'chave-123',
        cosmosId: '999', produtoComProblema: 'SKU-A', produtoReenviar: 'SKU-A - 1', loteProduto: '',
        problemaProduto: 'Produto avariado', transportadoraOriginal: 'Jadlog',
        transportadoraReenvio: 'Jadlog', devolucao: 'Não', ticketTransportadora: '',
        statusPedido: 'Pedido não foi enviado', ReenvioCompleto: 'Sim', valorReenvio: '150,00',
        status: 'Realizado', codNfd: 'Pendente', automacao: 'Automação', erp: 'Protheus',
        comentarios: '', apiData: API_DATA, ...overrides,
    };
}

function buildOk(overrides: Partial<ResendSubmissionData> = {}) {
    return { brand: 'lescent' as const, submissionData: submissionCompleta(overrides), shouldSend: true };
}

const REAL_BODY = {
    brand: 'lescent',
    handledBy: 'Typebot',
    sourceChannel: 'CHAT_ATENDIMENTO',
    supportTicketId: 'TKT-1',
    customer: { name: 'Maria Cliente' },
    order: { ecommerceOrderId: '#220183', invoiceNumber: '123456' },
    reshipment: {
        isFullReshipment: true, requiresReturn: false, reason: 'Produto avariado',
        problemItems: [{ sku: 'SKU-A' }], reshipmentItems: [{ sku: 'SKU-A', quantity: 1 }],
        carrier: { name: 'Jadlog' },
    },
};

const SUCESSO_SHEETS = {
    body: { code: 'SUCCESS_SHEETS_ONLY' as const, message: 'Linha registrada', sentToAPI: false },
    status: 200,
};

/** O contexto do único aviso disparado. */
function avisado() {
    expect(mAlert).toHaveBeenCalledTimes(1);
    return mAlert.mock.calls[0][0];
}

// ─── Suíte ───────────────────────────────────────────────────────────

describe('POST /api/reenvio/bot — aviso acionável', () => {
    beforeEach(() => {
        vi.stubEnv('BOT_RESEND_SECRET', BOT_SECRET);
        vi.stubEnv('BOT_RESEND_EXECUTE', 'on');
        mFetchOrder.mockReset();
        mToken.mockReset();
        mBuild.mockReset();
        mPost.mockReset();
        mAlert.mockReset();
        mAlert.mockResolvedValue(true);
        mToken.mockResolvedValue('token-servico');
        mFetchOrder.mockResolvedValue(createNormalizedOrder());
        mPost.mockResolvedValue(SUCESSO_SHEETS);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // ─── O que avisa ──────────────────────────────────────────────────

    it('A1. Cosmos inacessível: grava a linha, avisa, e diz o que já tentou', async () => {
        mToken.mockRejectedValue(new Error('Cosmos signin failed: HTTP 503'));

        const res = await post(REAL_BODY);

        expect(res.status).toBe(200);
        expect(mPost).toHaveBeenCalledTimes(1);

        const ctx = avisado();
        expect(ctx.reason).toBe('COSMOS_UNAVAILABLE');
        expect(ctx.tentativas, 'o card precisa dizer que houve retentativa').toBeTruthy();
        expect(ctx.tentativas).toContain('503');
        expect(ctx.numeroPedido).toBe('#220183');
        expect(ctx.brand).toBe('lescent');
        expect(ctx.requestId).toBeTruthy();
    });

    it('A2. transportadora fora do mapa avisa, com o nome que não casou', async () => {
        mBuild.mockReturnValue({
            brand: 'lescent',
            submissionData: submissionCompleta({ apiData: undefined, automacao: '' }),
            shouldSend: false,
            motivo: 'Transportadora "Anjun Express" não foi reconhecida no mapa da marca e o pedido não trouxe ID',
            // Fiel ao builder real, que classifica na origem — ver o teste "classifica a reprovação da
            // transportadora" em __tests__/reenvios/buildBotResendData.test.ts, que prende esse contrato.
            reason: 'CARRIER_UNRESOLVED',
        } as ReturnType<typeof buildBotResendData>);

        await post(REAL_BODY);

        const ctx = avisado();
        expect(ctx.reason).toBe('CARRIER_UNRESOLVED');
        expect(ctx.motivo).toContain('Anjun Express');
    });

    it('A3. exceção inesperada NÃO virá 500: degrada, grava a linha e avisa (OQ-06)', async () => {
        mBuild.mockImplementation(() => {
            throw new TypeError("Cannot read properties of undefined (reading 'address')");
        });

        const res = await post(REAL_BODY);
        const body = await res.json();

        expect(res.status, 'perder a solicitação num 500 é o desfecho proibido').not.toBe(500);
        expect(mPost).toHaveBeenCalledTimes(1);
        expect(body.reason).toBe('INTERNAL_ERROR');
        expect(avisado().reason).toBe('INTERNAL_ERROR');
    });

    it('A4. ERP recusou: reposta sem automação para GARANTIR a linha, e avisa (ADR-005 §2)', async () => {
        mBuild.mockReturnValue(buildOk() as ReturnType<typeof buildBotResendData>);
        mPost
            .mockResolvedValueOnce({
                body: { code: 'API_ERROR', message: 'Produto sem saldo no estoque', sentToAPI: false },
                status: 200,
            })
            .mockResolvedValueOnce(SUCESSO_SHEETS);

        const res = await post(REAL_BODY);
        const body = await res.json();

        // A 1ª tentou executar; a 2ª garantiu a linha sem automação.
        expect(mPost).toHaveBeenCalledTimes(2);
        expect(mPost.mock.calls[0][0].data.apiData).toBeDefined();
        expect(mPost.mock.calls[1][0].data.apiData).toBeUndefined();
        expect(mPost.mock.calls[1][0].data.automacao).toBe('');

        expect(res.status).toBe(200);
        expect(body.reason).toBe('ERP_REFUSED');

        const ctx = avisado();
        expect(ctx.reason).toBe('ERP_REFUSED');
        expect(ctx.detalhe, 'o erro do ERP é o que torna o card acionável').toContain('sem saldo');
    });

    it('A5. porta fechada (sem segredo no ambiente) avisa — é 503 para todo mundo', async () => {
        vi.stubEnv('BOT_RESEND_SECRET', '');

        const res = await post(REAL_BODY);

        expect(res.status).toBe(503);
        expect(avisado().reason).toBe('GATE_CLOSED');
    });

    it('A6. payload inválido avisa: a solicitação é DESCARTADA no 400', async () => {
        const res = await post({ ...REAL_BODY, brand: 'marca-que-nao-existe' });

        expect(res.status).toBe(400);
        expect(avisado().reason).toBe('INVALID_PAYLOAD');
    });

    it('A7. violação do modo de teste vem do transporte e avisa como crítica', async () => {
        mBuild.mockReturnValue(buildOk() as ReturnType<typeof buildBotResendData>);
        mPost.mockResolvedValue({
            body: {
                code: 'UNKNOWN_ERROR',
                message: 'O modo de teste foi ignorado pelo fluxo',
                sentToAPI: false,
                reason: 'TEST_MODE_VIOLATION',
            },
            status: 502,
        });

        await post({ ...REAL_BODY, testMode: true });

        expect(avisado().reason).toBe('TEST_MODE_VIOLATION');
    });

    // ─── O que NÃO avisa ──────────────────────────────────────────────

    it('A8. endereço novo incompleto NÃO avisa no grupo, mas devolve o reason ao bot', async () => {
        mBuild.mockReturnValue(buildOk() as ReturnType<typeof buildBotResendData>);

        const res = await post({
            ...REAL_BODY,
            addressChange: { enabled: true, address: { street: 'Rua Nova', number: '10', city: 'SP', state: 'SP', postalCode: '01001000' } },
        });
        const body = await res.json();

        expect(mPost).toHaveBeenCalledTimes(1);
        expect(body.reason).toBe('NEW_ADDRESS_INCOMPLETE');
        expect(body.message).toContain('bairro');
        expect(mAlert, 'dado da cliente é conversa do bot com ela, não aviso pro time').not.toHaveBeenCalled();
    });

    it('A9. pedido não encontrado NÃO avisa (número errado é tratativa da planilha)', async () => {
        mFetchOrder.mockResolvedValue(null);

        const res = await post(REAL_BODY);
        const body = await res.json();

        expect(mPost).toHaveBeenCalledTimes(1);
        expect(body.reason).toBe('ORDER_NOT_FOUND');
        expect(mAlert).not.toHaveBeenCalled();
    });

    it('A10. interruptor desligado NÃO avisa — é o sistema obedecendo', async () => {
        vi.stubEnv('BOT_RESEND_EXECUTE', 'off');

        const res = await post(REAL_BODY);
        const body = await res.json();

        expect(body.reason).toBe('AUTOMATION_OFF');
        expect(mAlert).not.toHaveBeenCalled();
    });

    it('A11. sucesso executando não avisa nada', async () => {
        mBuild.mockReturnValue(buildOk() as ReturnType<typeof buildBotResendData>);
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS', message: 'Reenvio executado', sentToAPI: true },
            status: 200,
        });

        await post(REAL_BODY);

        expect(mAlert).not.toHaveBeenCalled();
    });

    // ─── O invariante do aviso (INV-06 candidato) ─────────────────────

    it('A12. aviso falhando NÃO muda o desfecho: a linha é gravada e a resposta é a mesma', async () => {
        mAlert.mockRejectedValue(new Error('Google Chat fora do ar'));
        // Causa AVISÁVEL de propósito: com `ORDER_NOT_FOUND` (severidade `nenhuma`) o `avisar` sai antes
        // de chamar o `sendAlert` e a rejeição nunca rodaria — o teste passaria sem exercitar nada.
        mToken.mockRejectedValue(new Error('Cosmos fora do ar'));

        const res = await post(REAL_BODY);
        const body = await res.json();

        expect(mAlert).toHaveBeenCalled();
        expect(res.status).toBe(200);
        expect(mPost).toHaveBeenCalledTimes(1);
        expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
    });

    it('A13. aviso falhando no caminho da exceção também não vira 500', async () => {
        mAlert.mockRejectedValue(new Error('Google Chat fora do ar'));
        mBuild.mockImplementation(() => { throw new Error('build explodiu'); });

        const res = await post(REAL_BODY);

        expect(res.status).not.toBe(500);
        expect(mPost).toHaveBeenCalledTimes(1);
    });

    // ─── A causa vai para a LINHA, não só para o card (ADR-005 §2 · RF-38) ─────
    //
    // O aviso é falha ABERTA por desenho: sem `SLACK_ALERT_WEBHOOK_URL` nenhum card sai. Se a causa
    // existisse só no Chat, uma recusa do ERP produziria linha muda — sem automação e sem pista — que é
    // metade do valor que a mitigação da OQ-08 promete. Por isso a asserção é sobre o corpo que vai ao
    // n8n, nunca sobre o card.

    it('A14. recusa do ERP: a linha repostada carrega o erro do ERP nos comentários', async () => {
        mBuild.mockReturnValue(buildOk());
        mPost
            .mockResolvedValueOnce({
                body: { code: 'API_ERROR', message: 'SKU sem saldo no estoque', sentToAPI: false },
                status: 200,
            })
            .mockResolvedValueOnce(SUCESSO_SHEETS);

        await post(REAL_BODY);

        expect(mPost).toHaveBeenCalledTimes(2);
        const linhaRepostada = mPost.mock.calls[1][0].data;
        expect(linhaRepostada.comentarios).toContain('SKU sem saldo no estoque');
        expect(linhaRepostada.comentarios).toContain('ERP não confirmou');
        // E continua sendo uma linha SEM automação.
        expect(linhaRepostada.automacao).toBe('');
        expect(linhaRepostada.apiData).toBeUndefined();
    });

    it('A15. o comentário que o bot mandou é PRESERVADO — a causa é anexada, não sobrescreve', async () => {
        mBuild.mockReturnValue(buildOk({ comentarios: 'Cliente relatou caixa amassada' }));
        mPost.mockResolvedValue(SUCESSO_SHEETS);
        mFetchOrder.mockResolvedValue(createNormalizedOrder());
        // Uma guarda qualquer reprovando: o caminho de degradação é o mesmo.
        mBuild.mockReturnValue({
            ...buildOk({ comentarios: 'Cliente relatou caixa amassada' }),
            shouldSend: false,
            motivo: 'Pedido não elegível',
        });

        await post(REAL_BODY);

        const linha = mPost.mock.calls[0][0].data;
        expect(linha.comentarios).toContain('Cliente relatou caixa amassada');
        expect(linha.comentarios).toContain('[CXHub]');
    });

    // ─── A planilha que falhou depois da fila (ADR-010, ADR-012) ───────────────
    //
    // Quem grava a linha (`gravarNasPlanilhas`) já avisou, com o id do caso e a linha no log. A rota só devolve o
    // `reason` ao bot: um segundo card pelo mesmo pedido seria ruído.

    const PLANILHA_FALHOU = {
        body: {
            code: 'SHEETS_ERROR' as const,
            message: 'A solicitação entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.',
            sentToAPI: false,
            reason: 'SHEET_WRITE_FAILED' as const,
            idSolicitacao: 'req-bot',
        },
        status: 200,
    };

    it('A16. planilha falhou depois da fila: o reason volta ao bot e a rota NÃO avisa de novo', async () => {
        mBuild.mockReturnValue(buildOk());
        mPost.mockResolvedValue(PLANILHA_FALHOU);

        const res = await post(REAL_BODY);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ code: 'SHEETS_ERROR', reason: 'SHEET_WRITE_FAILED' });
        expect(mAlert).not.toHaveBeenCalled();
    });

    it('A17. guarda reprovada E planilha falhou: a resposta diz SHEET_WRITE_FAILED, e o único aviso da rota é o da guarda', async () => {
        mBuild.mockReturnValue(buildOk());
        mPost
            .mockResolvedValueOnce({ body: { code: 'API_ERROR', message: 'Produto sem saldo no estoque', sentToAPI: false }, status: 200 })
            .mockResolvedValueOnce(PLANILHA_FALHOU);

        const res = await post(REAL_BODY);
        const body = await res.json();

        expect(mPost).toHaveBeenCalledTimes(2);
        expect(body.reason).toBe('SHEET_WRITE_FAILED');
        expect(avisado().reason).toBe('ERP_REFUSED');
    });
});
