import { NextRequest, NextResponse } from '../../../../api/next-server';
import { BRAND_TO_ORG_ID, ehMarcaCxHub, temOrganizacaoNoCosmos, type MarcaCxHub } from '../../../shared/lib/constants';
import { conferirTokenNoCosmos } from '../../../shared/lib/cosmos/http';
import { MetabaseError, metabaseConfigurado } from '../../../shared/lib/metabase/index';
import { listarSolicitacoesNoRegistro } from '../../../shared/lib/fila/index';
import { comPresencaNaPlanilha, prazoDaPresenca } from '../../../shared/lib/sheets/presencaNaPlanilha';
import type {
    ListaSolicitacoesCode,
    ListaSolicitacoesResponse,
    TipoSolicitacaoListada,
} from '../../../shared/lib/solicitacoes/types';

/** A conferência do token no Cosmos, a lista na raw pelo Metabase e a leitura da planilha de cada marca da lista. */
export const maxDuration = 60;

const TIPOS: readonly TipoSolicitacaoListada[] = ['REENVIO', 'REEMBOLSO'];
const PEDIDO = /^(?=.*\d)[A-Za-z0-9#-]{1,40}$/;
/** A partir de 1, até a página 99999 (30 dias de reenvio são ~120 páginas). */
const PAGINA = /^[1-9]\d{0,4}$/;

function resposta(status: number, code: ListaSolicitacoesCode, message: string): NextResponse<ListaSolicitacoesResponse> {
    return NextResponse.json({ code, message }, { status });
}

/**
 * Solicitações do CX Hub, lidas da raw de eventos (Metabase) e da fila do Metabase (ADR-012), mais recentes primeiro,
 * uma página por vez, com o `naPlanilha` de cada uma (a linha está na planilha da marca?):
 * `GET /api/solicitacoes?tipo=REEMBOLSO[&marca=lescent][&pedido=SH9000105LC][&pagina=2]`. Os últimos 30 dias; com o
 * pedido, todo o histórico dele. Exige o token do login, como as rotas de gestão (conferido no Cosmos).
 */
export async function GET(request: NextRequest): Promise<NextResponse<ListaSolicitacoesResponse>> {
    const authorization = request.headers.get('authorization');
    if (!authorization) return resposta(401, 'UNAUTHORIZED', 'Header Authorization ausente.');

    const params = request.nextUrl.searchParams;
    const tipo = (params.get('tipo') ?? '').toUpperCase() as TipoSolicitacaoListada;
    if (!TIPOS.includes(tipo)) return resposta(400, 'INVALID_REQUEST', 'tipo deve ser REENVIO ou REEMBOLSO.');

    const marca = (params.get('marca') ?? '').trim().toLowerCase();
    if (marca && !ehMarcaCxHub(marca)) {
        return resposta(400, 'INVALID_REQUEST', `Marca inválida: ${marca}.`);
    }
    const pedido = (params.get('pedido') ?? '').trim();
    if (pedido && !PEDIDO.test(pedido)) return resposta(400, 'INVALID_REQUEST', 'Número do pedido inválido.');
    const paginaPedida = (params.get('pagina') ?? '1').trim();
    if (!PAGINA.test(paginaPedida)) return resposta(400, 'INVALID_REQUEST', 'pagina deve ser um número inteiro de 1 a 99999.');

    // Sem marca na busca (ou com uma marca sem Cosmos, ADR-013), confere na org da Lescent: o token do CX Hub é o do
    // usuário de serviço, com todas as marcas.
    const org = BRAND_TO_ORG_ID[temOrganizacaoNoCosmos(marca) ? marca : 'lescent'];
    switch (await conferirTokenNoCosmos(org, authorization)) {
        case 'ok':
            break;
        case 'recusado':
            return resposta(401, 'UNAUTHORIZED', 'Token do Cosmos inválido ou expirado.');
        case 'sem_acesso':
            return resposta(403, 'FORBIDDEN', 'O token não tem acesso a esta marca no Cosmos.');
        case 'timeout':
            return resposta(504, 'API_TIMEOUT', 'O Cosmos demorou para conferir o token.');
        default:
            return resposta(502, 'UNKNOWN_ERROR', 'Não foi possível conferir o token no Cosmos.');
    }

    if (!metabaseConfigurado()) {
        return resposta(503, 'UNAVAILABLE', 'A lista lê a base do Metabase, que não está configurada neste ambiente (METABASE_*).');
    }

    try {
        const { solicitacoes: daPagina, paginacao } = await listarSolicitacoesNoRegistro({
            tipo,
            marca: (marca || undefined) as MarcaCxHub | undefined,
            pedido: pedido || undefined,
        }, Number(paginaPedida));
        // Nunca lança: a planilha que não responde deixa a linha sem a tag dela.
        const solicitacoes = await comPresencaNaPlanilha(daPagina, prazoDaPresenca());
        let message = '';
        if (paginacao.total === 0) message = 'Nenhuma solicitação encontrada.';
        else if (solicitacoes.length === 0) message = `Esta página não existe mais: a lista tem ${paginacao.totalPaginas} página(s).`;
        return NextResponse.json({ code: 'SUCCESS', message, solicitacoes, paginacao });
    } catch (erro) {
        if (erro instanceof MetabaseError && /does not exist|n[aã]o existe/i.test(erro.message)) {
            return resposta(503, 'UNAVAILABLE', 'A base do Metabase ainda não tem a tabela de reenvio e reembolso neste ambiente.');
        }
        if (erro instanceof MetabaseError && erro.status === 0) {
            return resposta(504, 'API_TIMEOUT', 'O Metabase não respondeu.');
        }
        console.error('[Solicitações] Falha ao ler a raw:', erro);
        return resposta(502, 'UNKNOWN_ERROR', 'Não foi possível ler a lista de solicitações.');
    }
}
