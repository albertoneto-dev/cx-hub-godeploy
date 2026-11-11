import { NextRequest, NextResponse } from '../../../../../api/next-server';
import type { RefundManagementResponse } from '../../../../modules/reembolsos/types/index';
import { parseRefundExecutionRequest } from '../../../../modules/reembolsos/actions/refundManagement';
import { verificarAcessoCosmos } from '../../../../modules/reembolsos/actions/refundAcesso';
import { sincronizarReembolso } from '../../../../modules/reembolsos/actions/refundExecucao';
import { depsDaGestaoDoReembolso } from '../../../../modules/reembolsos/actions/refundGestaoDeps';

/**
 * A leitura do estado (raw + fila), a fila do Metabase (até 16 s, ADR-012) e a planilha (até 15 s cada etapa,
 * ADR-010), com folga. Literal porque o Next só lê configuração de rota estática.
 */
export const maxDuration = 120;

/**
 * Atualiza o acompanhamento de um reembolso: `POST /api/refund/sync`. Lê o que o backoffice marcou na planilha da
 * marca (`Realizado` ou `Cancelado`) e entrega à fila do Metabase (ADR-012). Sem mudança, não enfileira nada.
 */
export async function POST(request: NextRequest): Promise<NextResponse<RefundManagementResponse>> {
    const authorization = request.headers.get('authorization');
    if (!authorization) {
        return NextResponse.json({ code: 'UNAUTHORIZED', message: 'Header Authorization ausente.' }, { status: 401 });
    }

    const parsed = parseRefundExecutionRequest(await request.json().catch(() => null));
    if (!parsed.ok) {
        return NextResponse.json({ code: 'INVALID_REQUEST', message: parsed.message }, { status: 400 });
    }

    const negado = await verificarAcessoCosmos(parsed.value.brand, authorization);
    if (negado) {
        return NextResponse.json(negado.body, { status: negado.status });
    }

    const result = await sincronizarReembolso(parsed.value, depsDaGestaoDoReembolso());
    return NextResponse.json(result.body, { status: result.status });
}
