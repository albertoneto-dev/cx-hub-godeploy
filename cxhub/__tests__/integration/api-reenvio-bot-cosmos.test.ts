import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '../../app/api/reenvio/bot/route';
import { createRequest } from '../helpers/api-test-utils';
import { createNormalizedOrder } from '../helpers/factories';
import { JANELA_FILA_MS } from '@shared/lib/fila';
import { JANELA_PLANILHA_MS } from '@shared/lib/sheets/gravarLinha';
import type { ResendSubmissionData } from '@modules/reenvios/types';

/**
 * O bot EXECUTANDO o reenvio no Cosmos.
 *
 * A régua destes testes é uma só: **toda dúvida degrada para sheets-only** — a linha é gravada
 * (o `postResendWebhook` É chamado), mas com os campos de automação vazios e sem `apiData`, e a
 * resposta carrega o motivo legível. Nunca "executa mesmo assim", e nunca perde a solicitação
 * num erro 500.
 */

// ─── Mocks ───────────────────────────────────────────────────────────

vi.mock('@shared/lib/cosmos/server', () => ({
    getCosmosServiceToken: vi.fn(),
    fetchNormalizedCosmosOrder: vi.fn(),
    __resetCosmosTokenCache: vi.fn(),
}));

vi.mock('@modules/reenvios/actions/buildBotResendData', () => ({
    buildBotResendData: vi.fn(),
    // Implementações fiéis ao contrato: o que está sob teste aqui é a DECISÃO da rota
    // (chamar ou não o strip), não a mecânica do strip.
    stripAutomation: vi.fn((data: ResendSubmissionData) => {
        const { apiData: _descartado, ...resto } = data;
        return { ...resto, valorReenvio: '', status: '', codNfd: '', automacao: '', erp: '' };
    }),
}));

vi.mock('@modules/reenvios/actions/postResendWebhook', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@modules/reenvios/actions/postResendWebhook')>();
    return { ...actual, postResendWebhook: vi.fn() };
});

import { getCosmosServiceToken, fetchNormalizedCosmosOrder } from '@shared/lib/cosmos/server';
import { buildBotResendData, stripAutomation } from '@modules/reenvios/actions/buildBotResendData';
import { postResendWebhook } from '@modules/reenvios/actions/postResendWebhook';

const mFetchOrder = vi.mocked(fetchNormalizedCosmosOrder);
const mToken = vi.mocked(getCosmosServiceToken);
const mBuild = vi.mocked(buildBotResendData);
const mStrip = vi.mocked(stripAutomation);
const mPost = vi.mocked(postResendWebhook);

// ─── Fixtures ────────────────────────────────────────────────────────

const URL = 'http://localhost/api/reenvio/bot';
const BOT_SECRET = 'segredo-do-bot-123';
const SERVICE_TOKEN = 'token-de-servico-mintado-no-servidor';

function post(body: unknown, headers: Record<string, string> = { 'x-bot-secret': BOT_SECRET }) {
    return POST(createRequest(URL, { method: 'POST', body, headers }));
}

const ORDER = createNormalizedOrder();

const API_DATA = {
    carrierId: 161,
    carrierServiceName: 'PAC',
    shippingCost: '15.00',
    discountAmount: '0',
    resendProducts: [{ product_id: 5001, quantity: 1, unit_price: '150.00' }],
    shippingAddress: {
        street: 'Rua Teste',
        number: '123',
        complement: '',
        neighborhood: 'Centro',
        city: 'São Paulo',
        state: 'SP',
        postal_code: '01001-000',
    },
};

function submissionCompleta(overrides: Partial<ResendSubmissionData> = {}): ResendSubmissionData {
    return {
        timestamp: '01/01/2026 10:00:00',
        dataSolicitacao: '01/01/2026',
        data_criacao: '01/01/2026',
        tipoSolicitacao: 'Reenvio',
        responsavel: 'Ana Souza',
        origemReclamacao: 'Chat Atendimento',
        idAtendimento: 'TKT-1',
        cdOrigem: 'SP',
        nomeCliente: 'Maria Cliente',
        telefoneCliente: '11999999999',
        enderecoCliente: 'Rua Teste, 123, Centro, São Paulo, 01001-000 - SP',
        cep: '01001-000',
        estado: 'SP',
        numeroPedido: '#220183',
        numeroNF: '123456',
        chaveNF: 'chave-123',
        cosmosId: '999',
        produtoComProblema: 'SKU-A',
        produtoReenviar: 'SKU-A - 1',
        loteProduto: '',
        problemaProduto: 'Produto avariado',
        transportadoraOriginal: 'Jadlog',
        transportadoraReenvio: 'Jadlog',
        devolucao: 'Não',
        ticketTransportadora: '',
        statusPedido: 'Pedido não foi enviado',
        ReenvioCompleto: 'Sim',
        valorReenvio: '150,00',
        status: 'Realizado',
        codNfd: 'Pendente',
        automacao: 'Automação',
        erp: 'Protheus',
        comentarios: '',
        apiData: API_DATA,
        ...overrides,
    };
}

function buildOk(overrides: Partial<ResendSubmissionData> = {}) {
    return {
        // `as const` para o tipo casar com SupportedBrand (sem ele o literal infere `string`)
        brand: 'lescent' as const,
        submissionData: submissionCompleta(overrides),
        shouldSend: true,
    };
}

const REAL_BODY = {
    brand: 'lescent',
    handledBy: 'Ana Souza',
    sourceChannel: 'CHAT_ATENDIMENTO',
    supportTicketId: 'TKT-1',
    customer: { name: 'Maria Cliente' },
    order: { ecommerceOrderId: '#220183', invoiceNumber: '123456' },
    reshipment: {
        isFullReshipment: true,
        requiresReturn: false,
        reason: 'Produto avariado',
        problemItems: [{ sku: 'SKU-A' }],
        reshipmentItems: [{ sku: 'SKU-A', quantity: 1 }],
        carrier: { name: 'Jadlog' },
    },
};

/** O que foi entregue ao transporte na única chamada. */
function postado() {
    expect(mPost).toHaveBeenCalledTimes(1);
    return mPost.mock.calls[0][0];
}

function esperaSheetsOnly() {
    const arg = postado();
    expect(arg.data.automacao, 'automacao deveria estar vazia no sheets-only').toBe('');
    expect(arg.data.apiData, 'apiData não deveria existir no sheets-only').toBeUndefined();
    expect(arg.data.status).toBe('');
    expect(arg.data.codNfd).toBe('');
    // No caminho de registro não há o que autenticar: token de ERP no envelope seria credencial
    // trafegando sem uso. É promessa explícita do `postarSemAutomacao` — aqui ela tem guarda.
    expect(arg.token, 'nenhum token de ERP deveria acompanhar o envelope no sheets-only').toBeUndefined();
    return arg;
}

function esperaExecutando() {
    const arg = postado();
    expect(arg.data.automacao, 'automacao deveria estar preenchida no caminho executando').toBe('Automação');
    expect(arg.data.apiData, 'apiData deveria acompanhar o caminho executando').toBeDefined();
    return arg;
}

// ─── Suíte ───────────────────────────────────────────────────────────

describe('POST /api/reenvio/bot — execução do reenvio no Cosmos', () => {
    beforeEach(() => {
        vi.stubEnv('TIMEOUT', '10000');
        vi.stubEnv('BOT_RESEND_SECRET', BOT_SECRET);
        vi.stubEnv('BOT_RESEND_EXECUTE', undefined as unknown as string);
        vi.stubEnv('COSMOS_API_URL', 'https://api.cosmos.test');
        vi.stubEnv('COSMOS_EMAIL', 'robo@gocase.com');
        vi.stubEnv('COSMOS_PASSWORD', 'senha-do-robo');

        mToken.mockReset().mockResolvedValue(SERVICE_TOKEN);
        mFetchOrder.mockReset().mockResolvedValue(ORDER);
        mBuild.mockReset().mockReturnValue(buildOk());
        mStrip.mockClear();
        mPost.mockReset().mockResolvedValue({
            body: { code: 'SUCCESS', message: 'reenvio executado', sentToAPI: true },
            status: 200,
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // ─── Caminho executando ──────────────────────────────────────────

    it('1. busca o pedido no Cosmos por brand + número do pedido', async () => {
        await post(REAL_BODY);

        expect(mFetchOrder).toHaveBeenCalledTimes(1);
        expect(mFetchOrder.mock.calls[0][0]).toBe('lescent');
        expect(String(mFetchOrder.mock.calls[0][1])).toContain('220183');
    });

    // O ÚNICO teste que prende o orçamento agregado. Sem ele, apagar o argumento de deadline em
    // qualquer das duas chamadas deixa a suíte inteira verde e ressuscita DUAS regressões silenciosas:
    // (a) signin e busca voltam a ter relógios próprios, os orçamentos somam e o pior caso estoura o
    // `maxDuration` — o que a plataforma corta é a repostagem que garante a linha; e (b) como o
    // `podeRetentar` do `cosmos/server.ts` falha FECHADO sem orçamento, a retentativa do transitório
    // simplesmente desaparece. Nenhum dos dois aparece como teste vermelho; aparecem em produção.
    it('1b. signin e busca compartilham UM prazo absoluto — o orçamento é da fase, não da chamada', async () => {
        const antes = Date.now();
        await post(REAL_BODY);
        const depois = Date.now();

        const deadlineToken = mToken.mock.calls[0][0];
        const deadlineBusca = mFetchOrder.mock.calls[0][3];

        expect(typeof deadlineToken, 'getCosmosServiceToken tem que receber o deadline').toBe('number');
        expect(deadlineBusca, 'fetchNormalizedCosmosOrder tem que receber O MESMO deadline').toBe(deadlineToken);

        // Instante ABSOLUTO no futuro, não uma duração: quem recebe compara com `Date.now()`. Um
        // orçamento relativo passado como absoluto expiraria na hora e degradaria tudo em silêncio.
        expect(deadlineToken as number).toBeGreaterThan(depois);
        // E é o orçamento DERIVADO, não um número solto: com TIMEOUT=10000 a reserva é 2·10000 + 5000 (janela da
        // rota dados, ADR-015) + 16000 (janela da fila, ADR-012) + 25000 (janela da planilha, ADR-010 e ADR-017) + 2500 +
        // 5000 = 73500, então sobram 150000 − 73500 = 76500ms. Como o deadline é cravado entre `antes` e `depois`, os dois
        // lados prendem o valor exato sem tolerância arbitrária — encurtar ou esticar o orçamento quebra aqui.
        expect(deadlineToken as number).toBeGreaterThanOrEqual(antes + 76_500);
        expect(deadlineToken as number).toBeLessThanOrEqual(depois + 76_500);
    });

    it('2. monta o reenvio completo com buildBotResendData({ brand, orderData, botPayload })', async () => {
        await post(REAL_BODY);

        expect(mBuild).toHaveBeenCalledTimes(1);
        const arg = mBuild.mock.calls[0][0];
        expect(arg.brand).toBe('lescent');
        expect(arg.orderData).toBe(ORDER);
        expect(arg.botPayload).toMatchObject({ brand: 'lescent', order: { ecommerceOrderId: '#220183' } });
    });

    it('3. executa: posta com automacao + apiData e com o token mintado no servidor', async () => {
        const res = await post(REAL_BODY);

        const arg = esperaExecutando();
        expect(arg.data.apiData).toEqual(API_DATA);
        expect(arg.token).toBe(SERVICE_TOKEN);
        expect(arg.brand).toBe('lescent');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('SUCCESS');
        expect(body.sentToAPI).toBe(true);
    });

    it('4. nenhuma credencial de ERP vem do corpo: token/cosmosToken do body são ignorados', async () => {
        await post({ ...REAL_BODY, token: 'token-do-corpo', cosmosToken: 'outro-do-corpo' });

        const arg = postado();
        expect(arg.token).toBe(SERVICE_TOKEN);
        expect(arg.token).not.toBe('token-do-corpo');
        expect(arg.token).not.toBe('outro-do-corpo');
    });

    // ─── G2: pedido não encontrado ───────────────────────────────────

    it('5. G2: pedido não encontrado no Cosmos degrada para sheets-only (linha do payload do bot)', async () => {
        mFetchOrder.mockResolvedValue(null);
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        const res = await post(REAL_BODY);

        const arg = esperaSheetsOnly();
        expect(arg.data.numeroPedido).toBe('#220183');
        expect(arg.data.responsavel).toBe('Ana Souza');
        expect(mBuild).not.toHaveBeenCalled();

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
        expect(body.sentToAPI).toBe(false);
        expect(body.message).toMatch(/pedido/i);
        expect(body.message).toMatch(/encontrad/i);
    });

    // ─── G3/G4: shouldSend false ─────────────────────────────────────

    it('6. G3/G4: shouldSend=false degrada para sheets-only com o motivo no message', async () => {
        mBuild.mockReturnValue({
            brand: 'lescent',
            submissionData: submissionCompleta(),
            shouldSend: false,
            motivo: 'Transportadora não resolvida no Cosmos',
        });
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        const res = await post(REAL_BODY);

        esperaSheetsOnly();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
        expect(body.message).toContain('Transportadora não resolvida no Cosmos');
    });

    // ─── G5: apiData incompleto ──────────────────────────────────────

    it.each([
        ['carrierId ausente', { ...API_DATA, carrierId: undefined as unknown as number }],
        ['carrierId = 0', { ...API_DATA, carrierId: 0 }],
        ['item com product_id = 0', { ...API_DATA, resendProducts: [{ product_id: 0, quantity: 1, unit_price: '150.00' }] }],
        ['um item entre vários com product_id = 0', {
            ...API_DATA,
            resendProducts: [
                { product_id: 5001, quantity: 1, unit_price: '150.00' },
                { product_id: 0, quantity: 2, unit_price: '10.00' },
            ],
        }],
        ['postal_code vazio', { ...API_DATA, shippingAddress: { ...API_DATA.shippingAddress, postal_code: '' } }],
    ])('7. G5: apiData incompleto (%s) degrada para sheets-only', async (_caso, apiData) => {
        mBuild.mockReturnValue(buildOk({ apiData: apiData as ResendSubmissionData['apiData'] }));
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        const res = await post(REAL_BODY);

        esperaSheetsOnly();
        expect(res.status).toBe(200);
        expect((await res.json()).sentToAPI).toBe(false);
    });

    // ─── Sem guarda de valor (RF-25/RF-26 revogadas — OQ-05) ─────────

    it.each([['150,00'], ['600,00'], ['R$ 12.345,67'], ['']])(
        '8. valor "%s" NÃO barra a execução: não existe teto nem leitura de valor na rota',
        async (valorReenvio) => {
            mBuild.mockReturnValue(buildOk({ valorReenvio }));

            const res = await post(REAL_BODY);

            esperaExecutando();
            expect((await res.json()).sentToAPI).toBe(true);
        }
    );

    it('9. nenhuma env var de teto é lida (BOT_RESEND_MAX_VALUE ficou sem efeito)', async () => {
        vi.stubEnv('BOT_RESEND_MAX_VALUE', 'quinhentos');
        mBuild.mockReturnValue(buildOk({ valorReenvio: '99.999,99' }));

        const res = await post(REAL_BODY);

        esperaExecutando();
        expect((await res.json()).sentToAPI).toBe(true);
    });

    // ─── G8: interruptor ─────────────────────────────────────────────

    it.each([['off'], ['OFF'], ['Off']])('12. G8: BOT_RESEND_EXECUTE=%s degrada para sheets-only', async (valor) => {
        vi.stubEnv('BOT_RESEND_EXECUTE', valor);
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        const res = await post(REAL_BODY);

        esperaSheetsOnly();
        expect(res.status).toBe(200);
        expect((await res.json()).sentToAPI).toBe(false);
        // O interruptor é avaliado ANTES de qualquer I/O no ERP: desligar a automação porque o Cosmos
        // está em sofrimento não pode custar uma chamada ao Cosmos. Sem esta asserção, mover o G8 para
        // depois da busca deixaria a suíte verde.
        expect(mToken, 'o interruptor não deveria mintar token de serviço').not.toHaveBeenCalled();
        expect(mFetchOrder, 'o interruptor não deveria buscar o pedido no ERP').not.toHaveBeenCalled();
    });

    it('13. G8: "executeResend": false no corpo degrada para sheets-only, sem tocar o ERP', async () => {
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        const res = await post({ ...REAL_BODY, executeResend: false });

        esperaSheetsOnly();
        expect(res.status).toBe(200);
        expect(mToken).not.toHaveBeenCalled();
        expect(mFetchOrder).not.toHaveBeenCalled();
    });

    it('14. G8: sem interruptor nem executeResend no corpo, executa', async () => {
        const res = await post(REAL_BODY);

        esperaExecutando();
        expect((await res.json()).code).toBe('SUCCESS');
    });

    // ─── Falha ao mintar o token ─────────────────────────────────────

    it('15. token de serviço falhando degrada para sheets-only — nunca 500', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mToken.mockRejectedValue(new Error('signin fora do ar'));
        mFetchOrder.mockRejectedValue(new Error('signin fora do ar'));
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        const res = await post(REAL_BODY);

        expect(res.status).not.toBe(500);
        expect(res.status).toBe(200);
        esperaSheetsOnly();
        const body = await res.json();
        expect(body.code).toBe('SUCCESS_SHEETS_ONLY');
        expect(body.sentToAPI).toBe(false);
    });

    // ─── Ensaio (modo de teste) ──────────────────────────────────────

    it('16. testMode=true percorre o MESMO caminho e repassa testMode ao transporte', async () => {
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_TEST_MODE', message: 'ensaio ok', sentToAPI: false },
            status: 200,
        });

        const res = await post({ ...REAL_BODY, testMode: true });

        expect(mFetchOrder).toHaveBeenCalledTimes(1);
        expect(mBuild).toHaveBeenCalledTimes(1);
        const arg = esperaExecutando();
        expect(arg.testMode).toBe(true);
        expect(res.status).toBe(200);
        expect((await res.json()).code).toBe('SUCCESS_TEST_MODE');
    });

    it('17. apiPreview PRESENTE no ensaio, com o apiData + valorReenvio', async () => {
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_TEST_MODE', message: 'ensaio ok', sentToAPI: false },
            status: 200,
        });

        const res = await post({ ...REAL_BODY, testMode: true });
        const body = await res.json();

        expect(body.apiPreview).toBeDefined();
        expect(body.apiPreview).toEqual({ ...API_DATA, valorReenvio: '150,00' });
    });

    it('18. apiPreview AUSENTE quando não há testMode', async () => {
        const res = await post(REAL_BODY);
        const body = await res.json();

        expect(body.apiPreview).toBeUndefined();
    });

    it('19. apiPreview AUSENTE no ensaio quando uma guarda degradou (não há apiData a prever)', async () => {
        mBuild.mockReturnValue({
            brand: 'lescent',
            submissionData: submissionCompleta(),
            shouldSend: false,
            motivo: 'Item inelegível',
        });
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_TEST_MODE', message: 'ensaio ok', sentToAPI: false },
            status: 200,
        });

        const res = await post({ ...REAL_BODY, testMode: true });
        const body = await res.json();

        esperaSheetsOnly();
        expect(body.apiPreview).toBeUndefined();
    });

    // ─── Ordem preservada: validação antes do Cosmos ─────────────────

    it('20. 401 sem credencial: não toca o Cosmos nem o transporte', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await post(REAL_BODY, {});

        expect(res.status).toBe(401);
        expect(mToken).not.toHaveBeenCalled();
        expect(mFetchOrder).not.toHaveBeenCalled();
        expect(mPost).not.toHaveBeenCalled();
    });

    it('21. 400 de marca inválida: não toca o Cosmos nem o transporte', async () => {
        const res = await post({ ...REAL_BODY, brand: 'nivea' });

        expect(res.status).toBe(400);
        expect(mFetchOrder).not.toHaveBeenCalled();
        expect(mPost).not.toHaveBeenCalled();
    });

    it('22. 400 sem número de pedido fora do modo de teste: não toca o Cosmos', async () => {
        const res = await post({ brand: 'lescent', handledBy: 'Ana' });

        expect(res.status).toBe(400);
        expect(mFetchOrder).not.toHaveBeenCalled();
        expect(mPost).not.toHaveBeenCalled();
    });

    // ─── G5b: endereço novo completo (RF-32) ─────────────────────────
    //
    // A régua é a MESMA que `validateSteps.ts:66-85` impõe ao agente na tela — seis campos, complemento
    // opcional. Validar só o CEP deixaria a porta do bot mais PERMISSIVA que a do humano.

    const ENDERECO_NOVO_OK = {
        street: 'Av Nova',
        number: '456',
        complement: 'Apto 10',
        district: 'Vila',
        city: 'Campinas',
        state: 'SP',
        postalCode: '13010-000',
    };

    function comEndereco(address: Record<string, unknown>, enabled = true) {
        return { ...REAL_BODY, addressChange: { enabled, address } };
    }

    it('23. G5b: endereço novo completo com CEP válido ⇒ executa com o endereço novo', async () => {
        const res = await post(comEndereco(ENDERECO_NOVO_OK));

        esperaExecutando();
        expect((await res.json()).code).toBe('SUCCESS');
    });

    it.each([
        ['street', 'logradouro'],
        ['number', 'número'],
        ['district', 'bairro'],
        ['city', 'cidade'],
        ['state', 'estado'],
    ])('24. G5b: sem %s ⇒ sheets-only dizendo QUAL campo faltou', async (campo, rotulo) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        const address = { ...ENDERECO_NOVO_OK, [campo]: '' };
        const res = await post(comEndereco(address));
        const body = await res.json();

        esperaSheetsOnly();
        expect(res.status).toBe(200);
        expect(body.sentToAPI).toBe(false);
        // A operação precisa distinguir "o bot não coletou o dado" de "coletou e é ilegível" (RF-32),
        // e saber QUAL campo — senão o humano relê a conversa inteira para descobrir.
        expect(body.message.toLowerCase()).toContain(rotulo);
    });

    it('25. G5b: CEP ausente ⇒ sheets-only pelo motivo de campo AUSENTE', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        const res = await post(comEndereco({ ...ENDERECO_NOVO_OK, postalCode: '' }));
        const body = await res.json();

        esperaSheetsOnly();
        expect(body.message.toLowerCase()).toContain('cep');
        expect(body.message.toLowerCase()).toContain('ausente');
    });

    it.each([['abc'], ['123'], ['999999999'], ['1301000']])(
        '26. G5b: CEP malformado (%s) ⇒ sheets-only com motivo PRÓPRIO, distinguível de campo ausente',
        async (cepRuim) => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            mPost.mockResolvedValue({
                body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
                status: 200,
            });

            const res = await post(comEndereco({ ...ENDERECO_NOVO_OK, postalCode: cepRuim }));
            const body = await res.json();

            esperaSheetsOnly();
            expect(body.message.toLowerCase()).toContain('cep');
            expect(body.message.toLowerCase()).toContain('malformado');
            expect(body.message.toLowerCase()).not.toContain('ausente');
        }
    );

    it('27. G5b: complemento é opcional — ausência dele não degrada', async () => {
        const semComplemento = { ...ENDERECO_NOVO_OK, complement: '' };
        const res = await post(comEndereco(semComplemento));

        esperaExecutando();
        expect((await res.json()).code).toBe('SUCCESS');
    });

    it('28. G5b: enabled=false não valida endereço nenhum — nenhuma regressão no caminho de produção', async () => {
        const res = await post(comEndereco({ street: '', number: '', postalCode: 'abc' }, false));

        esperaExecutando();
        expect((await res.json()).code).toBe('SUCCESS');
    });

    it('29. G5b: addressChange ausente segue executando, como hoje', async () => {
        const res = await post(REAL_BODY);

        esperaExecutando();
        expect((await res.json()).code).toBe('SUCCESS');
    });

    // ─── Orçamento da fase Cosmos × maxDuration ──────────────────────
    //
    // O orçamento é derivado do TIMEOUT com um PISO. Piso absorve estouro em silêncio: se a reserva
    // (retentativas + folga do transporte) deixar de caber no maxDuration da função, o pior caso
    // volta a estourar a execução — e a solicitação evapora — sem que nada apareça. Uma configuração
    // que não cabe tem que gritar.

    /** Só os avisos que falam do orçamento/reserva contra o maxDuration — o resto do log é ruído aqui. */
    function avisosDeOrcamento(warn: { mock: { calls: unknown[][] } }) {
        return warn.mock.calls.filter((call: unknown[]) =>
            /reserva|or[çc]amento|maxduration|max_duration/i.test(call.map(String).join(' '))
        );
    }

    it('30. avisa em ALTO quando a reserva derivada do TIMEOUT não cabe no maxDuration', async () => {
        // 2 * 60000 + 5000 + 16000 + 25000 + 2500 + 5000 = 173500 > 150000 − 8000: o piso de 8000 mascararia isso.
        vi.stubEnv('TIMEOUT', '60000');
        // `mockClear` obrigatório: este arquivo não restaura spies entre casos, e `spyOn` sobre um
        // método JÁ espionado devolve o MESMO mock — com as chamadas do caso anterior dentro. Sem isto,
        // um caso contaria o `console.warn` do outro.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        warn.mockClear();

        await post(REAL_BODY);

        const avisos = avisosDeOrcamento(warn);
        expect(
            avisos.length,
            'nenhum console.warn identificou que a reserva não cabe no maxDuration'
        ).toBeGreaterThan(0);
    });

    it('31. NÃO avisa com o TIMEOUT do .env.example (12000), que cabe folgado', async () => {
        // 2 * 12000 + 5000 + 16000 + 25000 + 2500 + 5000 = 77500 < 150000 − 8000 (o piso): configuração sã não pode
        // virar ruído no log.
        vi.stubEnv('TIMEOUT', '12000');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        warn.mockClear(); // ver o comentário do caso 30 — sem isto, herdaria o aviso dele.

        await post(REAL_BODY);

        expect(avisosDeOrcamento(warn)).toHaveLength(0);
    });

    // ─── O transporte também cabe no orçamento ───────────────────────
    //
    // O orçamento da fase Cosmos já é contado (caso 1b), mas o POST no n8n é a ÚLTIMA coisa do
    // handler e hoje corre com o relógio da tela. Se ele estourar o `maxDuration`, quem a plataforma
    // mata é justamente o trecho que garante a linha e dispara o aviso — o pior desfecho: a cliente
    // some do sistema sem ninguém saber. Cada chamada tem que declarar quanto tempo pode gastar.

    /**
     * Teto absoluto por chamada ao transporte para o handler inteiro caber no `maxDuration`:
     * (150 000 − 5 000 da rota dados − 16 000 da fila − 25 000 da planilha − 2 500 do aviso − 5 000 de folga − 8 000 do
     * piso do Cosmos) / 2.
     */
    const TETO_DO_TRANSPORTE_MS = 44_250;

    function timeoutDoTransporte() {
        const arg = postado() as unknown as { timeoutMs?: number };
        return arg.timeoutMs;
    }

    it('32. caminho executando: o transporte recebe timeoutMs dentro do teto do maxDuration', async () => {
        await post(REAL_BODY);

        const timeoutMs = timeoutDoTransporte();
        expect(typeof timeoutMs, 'a rota não passou timeoutMs ao transporte').toBe('number');
        expect(timeoutMs as number).toBeGreaterThan(0);
        expect(timeoutMs as number).toBeLessThanOrEqual(TETO_DO_TRANSPORTE_MS);
    });

    it('33. caminho sheets-only: a repostagem que GARANTE a linha também declara seu timeoutMs', async () => {
        mFetchOrder.mockResolvedValue(null);
        mPost.mockResolvedValue({
            body: { code: 'SUCCESS_SHEETS_ONLY', message: 'linha gravada', sentToAPI: false },
            status: 200,
        });

        await post(REAL_BODY);

        esperaSheetsOnly();
        const timeoutMs = timeoutDoTransporte();
        expect(typeof timeoutMs, 'a repostagem sem automação não passou timeoutMs').toBe('number');
        expect(timeoutMs as number).toBeGreaterThan(0);
        expect(timeoutMs as number).toBeLessThanOrEqual(TETO_DO_TRANSPORTE_MS);
    });

    // ─── A fila e a planilha também cabem no orçamento (ADR-010, ADR-012) ────────────────
    //
    // Depois do Cosmos vêm a entrega à fila (até `JANELA_FILA_MS`) e a linha na planilha (`JANELA_PLANILHA_MS`). As
    // duas janelas entram na reserva, senão o pior caso passaria do `maxDuration` — que a plataforma cobra matando o
    // handler, justamente no trecho que garante a linha.

    it('34. o prazo da fila é agora + JANELA_FILA_MS: as duas tentativas da entrega', async () => {
        const antes = Date.now();

        await post(REAL_BODY);

        const { prazoFila } = postado() as unknown as { prazoFila?: number };
        expect(typeof prazoFila, 'a rota não passou o prazo da fila ao transporte').toBe('number');
        expect(prazoFila as number).toBeGreaterThanOrEqual(antes + JANELA_FILA_MS);
        expect(prazoFila as number).toBeLessThanOrEqual(Date.now() + JANELA_FILA_MS);
    });

    it('35. a fila e a planilha entram nas duas contas do bot: com TIMEOUT enorme, o transporte recebe exatamente o teto derivado (44 250 ms)', async () => {
        vi.stubEnv('TIMEOUT', '600000');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        warn.mockClear();

        await post(REAL_BODY);

        expect(timeoutDoTransporte()).toBe(TETO_DO_TRANSPORTE_MS);
        // E a reserva (2 postagens + fila + planilha + aviso + folga) não cabendo, o aviso de orçamento sugere o TIMEOUT
        // máximo já descontando as duas janelas — o mesmo número.
        const sugestao = warn.mock.calls.map((c) => c.map(String).join(' ')).find((t) => t.includes('Reduza TIMEOUT'));
        expect(sugestao).toContain(`Reduza TIMEOUT para ${TETO_DO_TRANSPORTE_MS}ms`);
    });

    it('35b. as janelas usadas na conta são as do código: 16 s da fila e 25 s da planilha (a escada da cota, ADR-017)', () => {
        expect(JANELA_FILA_MS).toBe(16_000);
        expect(JANELA_PLANILHA_MS).toBe(25_000);
    });
});
