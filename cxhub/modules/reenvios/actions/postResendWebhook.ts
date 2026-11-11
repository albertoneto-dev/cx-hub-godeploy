import { MARCAS_SEM_COSMOS } from '../../../shared/lib/constants';
import type {
    MarcaCxHub,
    ResendSubmissionData,
    SheetsAppendResponse,
    WebhookResponseCode,
} from '../types/index';
import { processResend } from './processResend';

/**
 * As marcas de reenvio que o código sabe registrar: as 6 do Cosmos e as sem Cosmos, que só registram (ADR-013, ADR-014).
 * É o que a tela aceita (`/api/sheets/append`). O bot (`/api/reenvio/bot`) pergunta à rota dados quais delas estão
 * ligadas, e usa esta lista inteira só quando a rota dados não responde (ADR-015, `marcasDoBot.ts`).
 */
export const VALID_RESEND_BRANDS: MarcaCxHub[] = [
    'lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria', ...MARCAS_SEM_COSMOS,
];

/**
 * Códigos de sucesso do fluxo de PRODUÇÃO. Lista positiva de propósito: em modo de teste o
 * único sucesso aceitável é SUCCESS_TEST_MODE, e os códigos de erro seguem passando.
 */
const SUCESSOS_DE_PRODUCAO: WebhookResponseCode[] = ['SUCCESS', 'SUCCESS_SHEETS_ONLY'];

/** Timeout padrão de 10s caso a env var TIMEOUT não esteja definida */
const DEFAULT_TIMEOUT_MS = 10000;

const LOG = '[Resend Webhook]';

export interface PostResendWebhookInput {
    brand: MarcaCxHub;
    data: ResendSubmissionData;
    token?: string;
    /**
     * Modo de teste (QA/homologação). Opcional e opt-in: ausente ⇒ false ⇒ fluxo de produção.
     * Quando true, o Cosmos NÃO é chamado (INV-02). Ver docs/qa-modo-teste.md.
     */
    testMode?: boolean;
    /**
     * Janela desta chamada, em ms. **Ausente ⇒ a env `TIMEOUT`** — que é como o fluxo da TELA continua
     * funcionando sem mudar nada (`app/api/sheets/append/route.ts` não passa este campo).
     *
     * Existe porque a env é **compartilhada** entre a tela e o bot, e o bot roda sob `maxDuration` e não pode
     * depender de uma env global para não estourar. Fecha a OQ-12 sem mexer no relógio do agente.
     */
    timeoutMs?: number;
    /**
     * O id do caso e o instante-limite da entrega à fila do Metabase (ADR-012). O bot passa o `requestId` (que casa
     * com o card do Chat e o log) e um prazo que cabe no `maxDuration` dele; a tela não passa nada (id gerado,
     * `prazoDaFila()`).
     */
    idSolicitacao?: string;
    prazoFila?: number;
}

export interface PostResendWebhookResult {
    body: SheetsAppendResponse;
    status: number;
}

/**
 * Porta única do caminho de reenvio: o `processResend` faz dedup, Cosmos e registro na fila (ADR-012), e a
 * guarda do INV-02 é aplicada aqui por cima — o processResend não chama o Cosmos em teste, e esta função não
 * confia nisso.
 *
 * É a ÚNICA cópia dessa guarda de propósito — código de segurança duplicado divergiria. Quem
 * chama (a rota da UI e a rota do bot) só valida a entrada e repassa o resultado.
 */
export async function postResendWebhook(
    input: PostResendWebhookInput
): Promise<PostResendWebhookResult> {
    const { brand, data, token, testMode } = input;

    // Teto de quem chama tem precedência; sem ele, a env de sempre (ver `timeoutMs` no input).
    const timeoutMs = input.timeoutMs ?? (parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS);

    const resultado = await processResend({
        brand, data, token, testMode, timeoutMs,
        idSolicitacao: input.idSolicitacao,
        prazoFila: input.prazoFila,
    });
    return violacaoDoModoTeste(testMode, resultado.body.code, resultado.body.sentToAPI, brand, resultado.body)
        ?? resultado;
}

/**
 * INV-02 — modo de teste nunca produz efeito irreversível fora do CXHub.
 *
 * Se o fluxo ignorar a flag, ele responde como no fluxo de produção. Devolver isso como 200 verde afirmaria um
 * reenvio que não deveria ter acontecido. Barra em vez de repassar.
 *
 * @param respostaBruta o que o fluxo respondeu, só para o log mostrar os valores como vieram
 */
function violacaoDoModoTeste(
    testMode: boolean | undefined,
    code: WebhookResponseCode,
    sentToAPI: boolean,
    brand: MarcaCxHub,
    respostaBruta: { code?: unknown; sentToAPI?: unknown }
): PostResendWebhookResult | null {
    if (testMode !== true || !(SUCESSOS_DE_PRODUCAO.includes(code) || sentToAPI)) return null;

    console.error(
        `${LOG} INV-02 VIOLADO: pedido com testMode=true recebeu resposta de fluxo real`,
        { brand, code: respostaBruta.code, sentToAPI: respostaBruta.sentToAPI }
    );
    return {
        body: {
            code: 'UNKNOWN_ERROR',
            message: 'O modo de teste foi ignorado pelo fluxo: a resposta indica reenvio real. '
                + 'Um reenvio pode ter sido executado — avise o time antes de repetir.',
            sentToAPI: false,
            reason: 'TEST_MODE_VIOLATION',
        },
        status: 502,
    };
}
