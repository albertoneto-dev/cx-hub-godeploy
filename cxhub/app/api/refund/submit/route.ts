import { NextRequest, NextResponse } from '../../../../../api/next-server';
import type { RefundSubmissionData, RefundSubmitResponse } from '../../../../modules/reembolsos/types/index';
import { ehMarcaCxHub, type MarcaCxHub } from '../../../../shared/lib/constants';
import { processRefund } from '../../../../modules/reembolsos/actions/processRefund';

/**
 * O dedup, a fila do Metabase (até 16 s, ADR-012) e a linha na planilha (até 15 s, ADR-010), com folga. Literal
 * porque o Next só lê configuração de rota estática.
 */
export const maxDuration = 120;

interface RefundRequestBody {
    brand: MarcaCxHub;
    data: RefundSubmissionData;
}

export async function POST(request: NextRequest): Promise<NextResponse<RefundSubmitResponse>> {
    try {
        const body: RefundRequestBody = await request.json();
        const { brand, data } = body;

        if (!brand || !data) {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Missing brand or data' },
                { status: 400 },
            );
        }

        // As 6 marcas do Cosmos e as 3 sem Cosmos (ADR-013), que só registram.
        if (typeof brand !== 'string' || !ehMarcaCxHub(brand)) {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: `Invalid brand: ${brand}` },
                { status: 400 },
            );
        }

        // ADR-010 e ADR-012 — o CXHub entrega o caso à fila do Metabase e, logo depois, grava a linha na planilha.
        const { body: resultado, status } = await processRefund(brand, data);
        return NextResponse.json(resultado, { status });
    } catch (error) {
        console.error('[Refund Submit API] Error:', error);
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Não foi possível se conectar ao sistema.' },
            { status: 500 },
        );
    }
}
