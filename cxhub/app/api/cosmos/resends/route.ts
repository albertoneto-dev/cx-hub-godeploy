import { NextRequest, NextResponse } from '../../../../../api/next-server';
import type { ResendManagementResponse } from '../../../../modules/reenvios/types/index';
import { listResendsOfOrder, resolveCosmosContext } from '../../../../modules/reenvios/actions/resendCosmos';
import { lerNumeroDaLoja } from '../../../../shared/lib/pedido/numeroDaLoja';

/** Reenvios de um pedido original: `GET /api/cosmos/resends?brand=<marca>&orderId=<número do pedido>`. */
export async function GET(request: NextRequest): Promise<NextResponse<ResendManagementResponse>> {
    const searchParams = request.nextUrl.searchParams;

    const context = resolveCosmosContext(searchParams.get('brand'), request.headers.get('authorization'));
    if (!context.ok) {
        return NextResponse.json(context.result.body, { status: context.result.status });
    }

    // O SH continua pelos dígitos; o GC vai inteiro (`GC104306BB`), porque os dígitos dele são os de outro pedido
    // (decisão deste app em 2026-11-27). Sem dígito, ou GC fora do formato, é 400.
    const orderId = (searchParams.get('orderId') ?? '').trim();
    if (!lerNumeroDaLoja(orderId, context.ctx.brand)) {
        return NextResponse.json(
            { code: 'INVALID_REQUEST', message: 'Informe orderId (número do pedido original).' },
            { status: 400 },
        );
    }

    const result = await listResendsOfOrder(context.ctx, orderId);
    return NextResponse.json(result.body, { status: result.status });
}
