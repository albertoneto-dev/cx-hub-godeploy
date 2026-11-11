import { NextRequest, NextResponse } from '../../../../../../../api/next-server';
import type { ResendManagementResponse } from '../../../../../../modules/reenvios/types/index';
import { parseCosmosOrderId, parseResendCancelRequest } from '../../../../../../modules/reenvios/actions/resendManagement';
import { cancelResend, resolveCosmosContext } from '../../../../../../modules/reenvios/actions/resendCosmos';
import { atualizacaoGoldDoReenvio } from '../../../../../../modules/reenvios/actions/atualizacaoGoldDoReenvio';
import { agendarAtualizacaoNaGold } from '../../../../../../shared/lib/airflow/index';

/** A atualização da gold roda depois da resposta (consulta ao Metabase + disparo, com retentativas). */
export const maxDuration = 60;

interface RouteParams {
    params: Promise<{
        id: string;
    }>;
}

/** Cancela um reenvio no Cosmos: `POST /api/cosmos/resends/{id}/cancel?brand=<marca>`. Não tem volta. */
export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse<ResendManagementResponse>> {
    const { id } = await params;

    const context = resolveCosmosContext(request.nextUrl.searchParams.get('brand'), request.headers.get('authorization'));
    if (!context.ok) {
        return NextResponse.json(context.result.body, { status: context.result.status });
    }

    const orderId = parseCosmosOrderId(id);
    if (!orderId) {
        return NextResponse.json(
            { code: 'INVALID_REQUEST', message: 'id deve ser o id numérico do reenvio no Cosmos.' },
            { status: 400 },
        );
    }

    const parsed = parseResendCancelRequest(await request.json().catch(() => null));
    if (!parsed.ok) {
        return NextResponse.json({ code: 'INVALID_REQUEST', message: parsed.message }, { status: 400 });
    }

    const result = await cancelResend(context.ctx, orderId, parsed.value);
    // Só com o Cosmos confirmando: a gold marca o caso como Cancelado na hora.
    agendarAtualizacaoNaGold(atualizacaoGoldDoReenvio({
        acao: 'cancelado', brand: context.ctx.brand, resposta: result.body, handledBy: parsed.value.handledBy,
    }));
    return NextResponse.json(result.body, { status: result.status });
}
