import { NextRequest, NextResponse } from '../../../../../api/next-server';
import {
    mensagemDosReenvios,
    reenviosDoPedido,
    type ReenvioExistenteCode,
    type ReenvioExistenteResponse,
} from '../../../../modules/reenvios/actions/reenviosDoPedido';
import { ehMarcaCxHub } from '../../../../shared/lib/constants';
import { FilaError } from '../../../../shared/lib/fila/index';
import { MetabaseError, metabaseConfigurado } from '../../../../shared/lib/metabase/index';
import { lerNumeroDaLoja, textoDoPedido } from '../../../../shared/lib/pedido/numeroDaLoja';

/** O mesmo formato de pedido do `GET /api/solicitacoes`: letras, dígitos, `#` e `-`, com ao menos um dígito. */
const PEDIDO = /^(?=.*\d)[A-Za-z0-9#-]{1,40}$/;

function resposta(status: number, code: ReenvioExistenteCode, message: string): NextResponse<ReenvioExistenteResponse> {
    return NextResponse.json({ code, message }, { status });
}

/**
 * Os reenvios que o pedido já tem e se um novo seria barrado:
 * `GET /api/reenvio/existente?marca=apice&pedido=SH1607929AP`. Vale para as 10 marcas (`reenviosDoPedido.ts`). Rota
 * deste app (2026-11-24), sem header próprio: basta a `gdk_` do gateway, porque só lê e não devolve dado de cliente.
 */
export async function GET(request: NextRequest): Promise<NextResponse<ReenvioExistenteResponse>> {
    const params = request.nextUrl.searchParams;
    const marca = (params.get('marca') ?? '').trim().toLowerCase();
    if (!marca) return resposta(400, 'INVALID_REQUEST', 'Informe a marca.');
    if (!ehMarcaCxHub(marca)) return resposta(400, 'INVALID_REQUEST', `Marca inválida: ${marca}.`);
    const pedido = (params.get('pedido') ?? '').trim();
    // O GC só vale no formato `GC{n}{sigla}` (ou sem a sigla): o `GC107465BB-R-1` é um reenvio, não um pedido, e cair
    // nos dígitos acharia o `#n` de mesmo número (decisão deste app em 2026-11-27).
    const numero = PEDIDO.test(pedido) ? lerNumeroDaLoja(pedido, marca) : null;
    if (!numero) {
        return resposta(400, 'INVALID_REQUEST', 'Informe o número do pedido: letras, dígitos, # e -, com ao menos um dígito '
            + '(o da Gocreators, como GC107465BB).');
    }

    if (!metabaseConfigurado()) {
        return resposta(503, 'UNAVAILABLE', 'A consulta lê a base do Metabase, que não está configurada neste ambiente (METABASE_*).');
    }

    try {
        const resultado = await reenviosDoPedido(marca, pedido);
        return NextResponse.json({
            code: 'SUCCESS',
            message: mensagemDosReenvios(resultado),
            marca,
            // Os dígitos no SH, como até a v24; o GC inteiro, com a sigla (`GC107465BB`).
            pedido: textoDoPedido(numero),
            ...resultado,
        });
    } catch (erro) {
        console.error(`[Reenvio existente] ${marca} ${pedido}: falha ao ler o registro:`, erro);
        if (erro instanceof MetabaseError && /does not exist|n[aã]o existe/i.test(erro.message)) {
            return resposta(503, 'UNAVAILABLE', 'A base do Metabase ainda não tem a tabela de reenvio e reembolso neste ambiente.');
        }
        if (erro instanceof MetabaseError && erro.status === 0) return resposta(504, 'API_TIMEOUT', 'O Metabase não respondeu.');
        if (erro instanceof FilaError) return resposta(502, 'UNKNOWN_ERROR', 'Não foi possível ler a fila do registro.');
        return resposta(502, 'UNKNOWN_ERROR', 'Não foi possível ler o registro de reenvios.');
    }
}
