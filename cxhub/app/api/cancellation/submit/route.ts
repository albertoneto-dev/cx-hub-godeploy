import { NextRequest, NextResponse } from '../../../../../api/next-server';
import type { CancellationPayload, CancellationResponse } from '../../../../shared/lib/cancellation/index';
import type { SupportedBrand } from '../../../../shared/lib/constants';
import { processCancellation } from '../../../../shared/lib/cancellation/processCancellation';

/**
 * A fila do Metabase (até 16 s, ADR-012) e a linha na planilha (até 15 s, ADR-010), com folga. Literal porque o Next
 * só lê configuração de rota estática.
 */
export const maxDuration = 120;

interface CancellationRequestBody {
    brand: SupportedBrand;
    data: CancellationPayload;
}

export async function POST(request: NextRequest): Promise<NextResponse<CancellationResponse>> {
    try {
        const body: CancellationRequestBody = await request.json();
        const { brand, data } = body;

        if (!brand || !data) {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Missing brand or data' },
                { status: 400 },
            );
        }

        const validBrands: SupportedBrand[] = ['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria'];
        if (!validBrands.includes(brand)) {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: `Invalid brand: ${brand}` },
                { status: 400 },
            );
        }

        // ADR-010 e ADR-012 — o CXHub entrega o caso à fila do Metabase e, logo depois, grava a linha na planilha.
        const { body: resultado, status } = await processCancellation(brand, data);
        return NextResponse.json(resultado, { status });
    } catch (error) {
        console.error('[Cancellation Submit API] Error:', error);
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Não foi possível se conectar ao sistema.' },
            { status: 500 },
        );
    }
}
