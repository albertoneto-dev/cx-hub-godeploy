import { NextRequest, NextResponse } from '../../../../../api/next-server';
import type { RefundManagementResponse } from '../../../../modules/reembolsos/types/index';
import { parseRefundUpdateRequest } from '../../../../modules/reembolsos/actions/refundManagement';
import { verificarAcessoCosmos } from '../../../../modules/reembolsos/actions/refundAcesso';
import { editarReembolsoNaGold } from '../../../../modules/reembolsos/actions/refundGold';
import { depsDaGestaoDoReembolso } from '../../../../modules/reembolsos/actions/refundGestaoDeps';

/**
 * A leitura do estado (raw + fila), a fila do Metabase (até 16 s, ADR-012) e a planilha (até 15 s cada etapa,
 * ADR-010), com folga. Literal porque o Next só lê configuração de rota estática.
 */
export const maxDuration = 120;

/**
 * Edita valor e motivo da solicitação de reembolso mais recente do pedido: `POST /api/refund/update`. O CX
 * Hub acha a solicitação na raw ou na fila, entrega a alteração à fila do Metabase (ADR-012) e depois a grava na planilha.
 */
export async function POST(request: NextRequest): Promise<NextResponse<RefundManagementResponse>> {
    const authorization = request.headers.get('authorization');
    if (!authorization) {
        return NextResponse.json({ code: 'UNAUTHORIZED', message: 'Header Authorization ausente.' }, { status: 401 });
    }

    const parsed = parseRefundUpdateRequest(await request.json().catch(() => null));
    if (!parsed.ok) {
        return NextResponse.json({ code: 'INVALID_REQUEST', message: parsed.message }, { status: 400 });
    }

    const negado = await verificarAcessoCosmos(parsed.value.brand, authorization);
    if (negado) {
        return NextResponse.json(negado.body, { status: negado.status });
    }

    const result = await editarReembolsoNaGold(parsed.value, depsDaGestaoDoReembolso());
    return NextResponse.json(result.body, { status: result.status });
}
