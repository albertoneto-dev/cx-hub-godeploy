import { NextRequest, NextResponse } from '../../../../../api/next-server';
import { BRAND_TO_ORG_ID } from '../../../../shared/lib/constants';
import { conferirTokenNoCosmos } from '../../../../shared/lib/cosmos/http';
import { ehMarcaDoCatalogo, type CatalogoItem } from '../../../../shared/lib/datamart/catalogo';
import { catalogoDaMarca } from '../../../../shared/lib/datamart/catalogoServer';
import { MetabaseError } from '../../../../shared/lib/metabase/index';

/** A conferência do token no Cosmos e as duas consultas ao Metabase (em paralelo). */
export const maxDuration = 30;

type Resposta = { products: CatalogoItem[] } | { error: string };

const erro = (status: number, mensagem: string) => NextResponse.json<Resposta>({ error: mensagem }, { status });

/**
 * O catálogo de produtos avulsos de uma marca sem Cosmos, do Data Mart (ADR-016): `GET /api/datamart/products?brand=apice`
 * → `{ products }`, no formato dos produtos do Cosmos. É de onde a tela do reenvio tira o mimo e o produto substituto
 * da Ápice, da Yenzah e da Denavita. Exige o token do login, conferido no Cosmos como na lista de solicitações (na org
 * da Lescent: a marca não tem org, e nada da marca vai ao Cosmos).
 */
export async function GET(request: NextRequest): Promise<NextResponse<Resposta>> {
    const marca = (request.nextUrl.searchParams.get('brand') ?? '').trim().toLowerCase();
    if (!marca) return erro(400, 'Parâmetro brand ausente.');
    if (!ehMarcaDoCatalogo(marca)) {
        return erro(400, `A marca ${marca} não é sem Cosmos com catálogo no Data Mart: use apice, yenzah ou denavita.`);
    }

    const authorization = request.headers.get('authorization');
    if (!authorization) return erro(401, 'Header Authorization ausente.');
    switch (await conferirTokenNoCosmos(BRAND_TO_ORG_ID.lescent, authorization)) {
        case 'ok':
            break;
        case 'recusado':
            return erro(401, 'Token do Cosmos inválido ou expirado.');
        case 'sem_acesso':
            return erro(403, 'O token não tem acesso ao Cosmos.');
        case 'timeout':
            return erro(504, 'O Cosmos demorou para conferir o token.');
        default:
            return erro(502, 'Não foi possível conferir o token no Cosmos.');
    }

    try {
        return NextResponse.json<Resposta>({ products: await catalogoDaMarca(marca) });
    } catch (falha) {
        if (!(falha instanceof MetabaseError)) throw falha;
        console.error(`[Catálogo] Falha ao ler o catálogo da ${marca} no Metabase:`, falha.message);
        return erro(502, 'Não foi possível ler o catálogo de produtos no Data Mart. Tente de novo em instantes.');
    }
}
