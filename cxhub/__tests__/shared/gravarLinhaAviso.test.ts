import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetAlertThrottle } from '@shared/lib/alerts';
import { __resetCasoNaPlanilha } from '@shared/lib/sheets/casoNaPlanilha';
import { gravarNasPlanilhas, type GravarDeps } from '@shared/lib/sheets/gravarLinha';
import { __resetGoogleTokenCache } from '@shared/lib/sheets/googleAuth';
import type { SheetCell } from '@shared/lib/sheets';
import { stubGoogleEnv } from '../helpers/google-sheets-mock';
import { instalarGoogleFalso } from '../helpers/google-sheets-falso';

/**
 * O agrupamento dos avisos da planilha, com o `sendAlert` REAL (só o `fetch` é substituído): é ele que decide, pela
 * chave de agrupamento, quantos cards saem. Mockar o `sendAlert` esconderia exatamente o que importa aqui: as duas
 * linhas do reembolso do Bot são do mesmo pedido e teriam a mesma chave — o 2º card era descartado, então há UM aviso
 * por chamada, listando todos os pares (fluxo, id) que falharam.
 */

const WEBHOOK = 'https://hooks.slack.test/services/T000/B000/segredo-de-teste';
const prazoFolgado = () => Date.now() + 10_000;
const semEspera: GravarDeps = { esperar: async () => {} };

const CRIADO_EM = new Date('2026-10-30T18:00:00.000Z');
const CARIMBO = '30/10/2026 15:00:00';
// Barbours: o pedido está na coluna H (7) do reembolso e na D (3) do cancelamento.
const LINHA_REEMBOLSO: SheetCell[] = [CARIMBO, null, 'Agente Teste', 'Origem', 'T-1', 'CD', 'Cliente Teste', '220183'];
const LINHA_CANCELAMENTO: SheetCell[] = [CARIMBO, 'Bot', 'Cliente Teste', '220183', 'Reembolso'];
/** Um cabeçalho que bate com o layout dos dois fluxos da Barbours (o falso responde pelas duas planilhas). */
const CABECALHO: SheetCell[] = ['Carimbo de data/hora', 'B', 'C', 'Número do pedido', 'E', 'F', 'G', 'Número do pedido'];
const ID_REEMBOLSO = 'bbbbbbbb-1111-4222-8333-000000000001';
const ID_CANCELAMENTO = 'bbbbbbbb-1111-4222-8333-000000000002';
const CONTEXTO = { numeroPedido: '220183', idAtendimento: 'T-1', statusDaFila: 'enfileirado' as const };

/** Instala o Google em memória e intercepta o webhook do Chat: devolve o texto de cada card enviado. */
function instalarChatEGoogle(cabecalho: SheetCell[]) {
    const aba = instalarGoogleFalso(cabecalho);
    const google = vi.mocked(global.fetch).getMockImplementation()!;
    const cards: string[] = [];
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
        if (String(input).startsWith(WEBHOOK)) {
            cards.push((JSON.parse(String(init?.body)) as { text: string }).text);
            return new Response('{}', { status: 200 });
        }
        return google(input, init);
    });
    return { aba, cards };
}

const linhasDoBot = () => [
    { fluxo: 'reembolso' as const, marca: 'barbours' as const, linha: LINHA_REEMBOLSO, idSolicitacao: ID_REEMBOLSO, pedido: '220183', criadoEm: CRIADO_EM },
    { fluxo: 'cancelamento' as const, marca: 'barbours' as const, linha: LINHA_CANCELAMENTO, idSolicitacao: ID_CANCELAMENTO, pedido: '220183', criadoEm: CRIADO_EM },
];

describe('aviso da planilha com o agrupamento real do sendAlert', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        __resetCasoNaPlanilha();
        __resetAlertThrottle();
        stubGoogleEnv();
        vi.stubEnv('SLACK_ALERT_WEBHOOK_URL', WEBHOOK);
        for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('reembolso do Bot, as duas linhas falham: sai UM card, e ele lista o reembolso E o cancelamento', async () => {
        const { aba, cards } = instalarChatEGoogle(CABECALHO);
        aba.appends.push({ status: 403 }, { status: 403 });

        const resultado = await gravarNasPlanilhas(linhasDoBot(), CONTEXTO, prazoFolgado(), semEspera);

        expect(resultado.ok).toBe(false);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toContain('não chegou à planilha');
        expect(cards[0]).toContain('A solicitação entrou na fila do Metabase, mas as linhas não entraram na planilha');
        expect(cards[0]).toContain(`reembolso (${ID_REEMBOLSO})`);
        expect(cards[0]).toContain(`cancelamento (${ID_CANCELAMENTO})`);
        expect(cards[0]).toContain('220183');
        // sem dado pessoal
        expect(cards[0]).not.toContain('Cliente Teste');
    });

    it('cabeçalho da aba que não bate com o layout: o card diz qual coluna, e o plano de ação manda desfazer ou ajustar o layout', async () => {
        const { cards } = instalarChatEGoogle(['Carimbo de data/hora', 'B', 'C', 'Observações', 'E', 'F', 'G', 'H']);

        const resultado = await gravarNasPlanilhas(linhasDoBot().slice(0, 1), CONTEXTO, prazoFolgado(), semEspera);

        expect(resultado.ok).toBe(false);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toContain('não bate com o layout de reembolso/barbours');
        expect(cards[0]).toContain('a coluna H (pedido) tem o cabeçalho "H"');
        expect(cards[0]).toContain('alguém moveu ou inseriu colunas');
        expect(cards[0]).not.toContain('Cliente Teste');
    });

    it('com a fila incerta, o card não afirma que a solicitação entrou na fila', async () => {
        const { aba, cards } = instalarChatEGoogle(CABECALHO);
        aba.appends.push({ status: 403 });

        await gravarNasPlanilhas(linhasDoBot().slice(0, 1), { ...CONTEXTO, statusDaFila: 'incerto' }, prazoFolgado(), semEspera);

        expect(cards).toHaveLength(1);
        expect(cards[0]).toContain('Não deu para confirmar a entrada na fila do Metabase, e a linha não entrou na planilha');
        expect(cards[0]).not.toContain('A solicitação entrou na fila');
    });

    it('a mesma causa para o mesmo pedido, repetida na janela, não gera um 2º card', async () => {
        const { aba, cards } = instalarChatEGoogle(CABECALHO);
        aba.appends.push({ status: 403 }, { status: 403 });

        await gravarNasPlanilhas(linhasDoBot().slice(0, 1), CONTEXTO, prazoFolgado(), semEspera);
        await gravarNasPlanilhas(linhasDoBot().slice(0, 1), CONTEXTO, prazoFolgado(), semEspera);

        expect(cards).toHaveLength(1);
    });
});
