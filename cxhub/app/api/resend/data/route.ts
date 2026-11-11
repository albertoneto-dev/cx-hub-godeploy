import { NextRequest, NextResponse } from '../../../../../api/next-server';
import { buscarDadosDoFormulario } from '../../../../shared/lib/formDataApi';

const DEFAULT_TIMEOUT_MS = 10000;

/** Os dados dinâmicos do formulário, lidos do app GoDeploy `rota-dados-cxhub` (ADR-009). */
export async function GET(request: NextRequest) {
    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;
    const origin = request.nextUrl.searchParams.get('origin') ?? '';
    const { status, body } = await buscarDadosDoFormulario(origin, timeoutMs);
    return NextResponse.json(body, { status });
}
