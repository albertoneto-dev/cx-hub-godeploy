import { NextRequest, NextResponse } from '../../../../../api/next-server';
import type { LogisticaSubmitResponse, LogisticaResponseCode } from '../../../../modules/logistica/types/index';
import { WEBHOOK_KNOWN_CODES } from '../../../../modules/logistica/types/index';
import type { LogisticaPayload } from '../../../../modules/logistica/actions/buildLogisticaPayload';
import type { SupportedBrand } from '../../../../shared/lib/constants';

const DEFAULT_TIMEOUT_MS = 10000;

/** Única rota do worker que cria ticket. */
const TICKET_PATH = '/gogroup-tickets-clind';

/**
 * Normaliza a resposta do worker `cx-ticketcreator` para um
 * `LogisticaResponseCode` conhecido pelo app.
 *
 * O desfecho de negócio vem em HTTP 200 com `{ code, message, ... }`.
 *
 * Dois tratamentos especiais:
 *  - `ESCALATE_TO_HUMAN` cobre dois casos distintos no worker ("pedido não
 *    achado" e "prazo vencido"). Separamos pela presença de `ticket_id`:
 *    com ticket → `TICKET_DEADLINE_EXPIRED`, sem → `ORDER_FETCH_FAILED`.
 *    Lido de `code` ou de `status` — o worker já usou as duas formas.
 *  - O typo `"ORDER NO SENT"` (com espaço) → `ORDER_NOT_SENT`.
 */
function mapWebhookCode(webhookBody: Record<string, unknown> | null): LogisticaResponseCode {
    if (!webhookBody) return 'UNKNOWN_ERROR';

    const rawCode = typeof webhookBody.code === 'string' ? webhookBody.code : '';
    const rawStatus = typeof webhookBody.status === 'string' ? webhookBody.status : '';

    if (rawCode === 'ESCALATE_TO_HUMAN' || rawStatus === 'ESCALATE_TO_HUMAN') {
        return webhookBody.ticket_id ? 'TICKET_DEADLINE_EXPIRED' : 'ORDER_FETCH_FAILED';
    }

    // Worker tem typo: "ORDER NO SENT" (com espaço) em vez de underscore
    if (rawCode === 'ORDER NO SENT') return 'ORDER_NOT_SENT';

    if ((WEBHOOK_KNOWN_CODES as readonly string[]).includes(rawCode)) {
        return rawCode as LogisticaResponseCode;
    }

    return 'UNKNOWN_ERROR';
}

export async function POST(request: NextRequest): Promise<NextResponse<LogisticaSubmitResponse>> {
    const baseUrl = process.env.TICKETCREATOR_URL;
    const secret = process.env.TICKETCREATOR_SECRET;
    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;

    if (!baseUrl) {
        console.error('[Logistica Submit API] Missing TICKETCREATOR_URL env variable');
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Ticket creator URL not configured' },
            { status: 500 },
        );
    }

    // Falha fechada: sem segredo o worker responderia 401 de qualquer forma.
    if (!secret) {
        console.error('[Logistica Submit API] Missing TICKETCREATOR_SECRET env variable');
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Ticket creator secret not configured' },
            { status: 500 },
        );
    }

    const ticketUrl = `${baseUrl.replace(/\/+$/, '')}${TICKET_PATH}`;

    try {
        const payload: LogisticaPayload = await request.json();

        if (!payload.orderId || !payload.issue || !payload.brand) {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Missing required fields (orderId, issue, brand)' },
                { status: 400 },
            );
        }

        const validBrands: SupportedBrand[] = ['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria'];
        if (!validBrands.includes(payload.brand as SupportedBrand)) {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: `Invalid brand: ${payload.brand}` },
                { status: 400 },
            );
        }

        console.log('[Logistica Submit API] Posting to ticketcreator:', ticketUrl, 'Brand:', payload.brand, 'Issue:', payload.issue, 'Timeout:', timeoutMs, 'ms');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let res: Response;
        try {
            res = await fetch(ticketUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-webhook-secret': secret,
                },
                // `callerType` é fixo: todo ticket que sai daqui foi aberto por um agente de CX.
                // Vai no forward (e não só no builder) para o worker nunca receber o corpo sem ele.
                body: JSON.stringify({ ...payload, callerType: 'agent' }),
                signal: controller.signal,
            });
        } catch (fetchError: unknown) {
            clearTimeout(timeoutId);
            if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                console.warn(`[Logistica Submit API] Ticketcreator timeout after ${timeoutMs}ms for brand ${payload.brand}`);
                return NextResponse.json(
                    { code: 'API_TIMEOUT', message: `O sistema demorou para responder (timeout de ${timeoutMs / 1000}s).` },
                    { status: 504 },
                );
            }
            throw fetchError;
        }
        clearTimeout(timeoutId);

        // 401 = secret ausente/errado. É falha de configuração nossa, não desfecho
        // de negócio — sai com log explícito para não virar "erro de conexão" genérico.
        if (res.status === 401) {
            console.error('[Logistica Submit API] Ticketcreator rejected the secret (401) — check TICKETCREATOR_SECRET');
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Não foi possível se conectar ao sistema.' },
                { status: 502 },
            );
        }

        const webhookBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;

        if (!webhookBody) {
            console.error('[Logistica Submit API] Ticketcreator error: no response body, HTTP', res.status);
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Não foi possível se conectar ao sistema.' },
                { status: res.status },
            );
        }

        const code = mapWebhookCode(webhookBody);

        // HTTP != 2xx + código desconhecido => falha real de infra ou payload recusado
        if (!res.ok && code === 'UNKNOWN_ERROR') {
            console.error('[Logistica Submit API] Ticketcreator error:', res.status, JSON.stringify(webhookBody));
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Não foi possível se conectar ao sistema.' },
                { status: res.status },
            );
        }

        const webhookMessage = typeof webhookBody.message === 'string' ? webhookBody.message : '';

        const result: LogisticaSubmitResponse = {
            code,
            message: webhookMessage,
        };

        console.log('[Logistica Submit API] Ticketcreator response:', { code: result.code, brand: payload.brand });
        return NextResponse.json(result);
    } catch (error) {
        console.error('[Logistica Submit API] Error:', error);
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Não foi possível se conectar ao sistema.' },
            { status: 500 },
        );
    }
}
