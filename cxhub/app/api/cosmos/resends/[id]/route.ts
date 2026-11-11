import { NextRequest, NextResponse } from '../../../../../../api/next-server';
import type { ResendManagementResponse } from '../../../../../modules/reenvios/types/index';
import { parseCosmosOrderId, parseResendUpdateRequest } from '../../../../../modules/reenvios/actions/resendManagement';
import { resolveCosmosContext, updateResend } from '../../../../../modules/reenvios/actions/resendCosmos';
import { atualizacaoGoldDoReenvio } from '../../../../../modules/reenvios/actions/atualizacaoGoldDoReenvio';
import { agendarAtualizacaoNaGold } from '../../../../../shared/lib/airflow/index';

/** A atualização da gold roda depois da resposta (consulta ao Metabase + disparo, com retentativas). */
export const maxDuration = 60;

interface RouteParams {
    params: Promise<{
        id: string;
    }>;
}

/**
 * Edita endereço, transportadora ou cliente de um reenvio:
 * `PATCH /api/cosmos/resends/{id}?brand=<marca>`. Produtos e frete não são editáveis.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse<ResendManagementResponse>> {
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

    const parsed = parseResendUpdateRequest(await request.json().catch(() => null));
    if (!parsed.ok) {
        return NextResponse.json({ code: 'INVALID_REQUEST', message: parsed.message }, { status: 400 });
    }

    const result = await updateResend(context.ctx, orderId, parsed.value);
    // Endereço trocado leva cidade, UF e CEP à gold; transportadora e cliente não têm coluna lá.
    agendarAtualizacaoNaGold(atualizacaoGoldDoReenvio({
        acao: 'editado', brand: context.ctx.brand, resposta: result.body, pedido: parsed.value,
    }));
    return NextResponse.json(result.body, { status: result.status });
}
