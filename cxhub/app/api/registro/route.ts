import { NextRequest, NextResponse } from '../../../../api/next-server';
import { responderRegistro } from '../../../shared/lib/airflow/registro';
import type { RegistroResponse } from '../../../shared/lib/registro/index';

/** A conferência do token no Cosmos, a leitura da raw pelo Metabase e, para o que a raw não tem, a fila. */
export const maxDuration = 60;

/**
 * Onde estão os casos que a lista acompanha (ADR-011 e ADR-012): `GET /api/registro?ids=<id>,<id>` responde, por id,
 * `gravado` (a raw tem), `aguardando` (na fila do Metabase) ou `recusado` (a DAG recusou). Exige o token do login,
 * como a lista de solicitações.
 */
export async function GET(request: NextRequest): Promise<NextResponse<RegistroResponse>> {
    const { status, body } = await responderRegistro({
        authorization: request.headers.get('authorization'),
        ids: request.nextUrl.searchParams.get('ids'),
    });
    return NextResponse.json(body, { status });
}
