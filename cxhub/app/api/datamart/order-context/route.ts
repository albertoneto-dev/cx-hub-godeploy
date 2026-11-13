import { NextRequest, NextResponse } from '../../../../../api/next-server';
import { BRAND_TO_ORG_ID, ehMarcaSemCosmosComPlanilha } from '../../../../shared/lib/constants';
import { conferirTokenNoCosmos } from '../../../../shared/lib/cosmos/http';
import { conferirPedidoNoDataMart, prazoDaConferencia } from '../../../../shared/lib/datamart/conferenciaServer';
import { digitosDoPedido } from '../../../../shared/lib/datamart/pedido';
import type { CampoConferido, EstadoDaNf, KitDoPedido } from '../../../../shared/lib/datamart/pedidoTipos';

/** A conferência do token no Cosmos e a leitura do pedido no Data Mart (até `JANELA_CONFERENCIA_MS`, 12 s). */
export const maxDuration = 30;

export interface ContextoDoPedidoNaResposta {
    brand: string;
    /** O número como a planilha o guarda: `SH1731559AP` */
    order: string;
    /** A NF de venda que o servidor grava; `null` quando não há (`nfStatus: 'ausente'`) ou não se sabe */
    nf: string | null;
    /** `ausente`: o Data Mart respondeu e não há NF — o servidor recusa a solicitação. `desconhecida`: não respondeu. */
    nfStatus: EstadoDaNf;
    /** `CD ES`, `CD RJ`, `CD MG`, ou `null` quando não se sabe */
    cd: string | null;
    statusSugerido: string | null;
    avisos: string[];
    /** A composição de cada kit do pedido: os componentes e as unidades de cada um em UM kit */
    kits: KitDoPedido[];
    /** O que o Data Mart não respondeu a tempo: ao gravar, o servidor confere de novo */
    naoConferidos: CampoConferido[];
}

type Resposta = ContextoDoPedidoNaResposta | { error: string };

const erro = (status: number, mensagem: string) => NextResponse.json<Resposta>({ error: mensagem }, { status });

/** "a NF e o CD", "a NF", "o CD": o que ficou sem conferência, para o aviso. */
function oQueNaoFoiConferido(campos: CampoConferido[]): string {
    const nomes = campos.map((c) => (c === 'nf' ? 'a NF' : 'o CD'));
    return nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0];
}

/**
 * O que o servidor vai gravar para o pedido de uma marca sem Cosmos (ADR-018), para a tela mostrar antes de enviar:
 * `GET /api/datamart/order-context?brand=apice&order=SH1731559AP` → NF, CD, status sugerido, avisos e a composição dos
 * kits. As regras e as leituras são as mesmas da gravação (`conferirPedidoNoDataMart`), então a tela do CX Hub, a Central
 * de Tickets e o bot veem o que vai para a planilha. Exige o token do login, conferido no Cosmos como no catálogo (na
 * org da Lescent: a marca não tem org, e nada dela vai ao Cosmos).
 */
export async function GET(request: NextRequest): Promise<NextResponse<Resposta>> {
    const marca = (request.nextUrl.searchParams.get('brand') ?? '').trim().toLowerCase();
    if (!marca) return erro(400, 'Parâmetro brand ausente.');
    if (!ehMarcaSemCosmosComPlanilha(marca)) {
        return erro(400, `A marca ${marca} não tem a conferência do pedido no Data Mart: use apice, yenzah ou denavita.`);
    }
    const numero = digitosDoPedido(request.nextUrl.searchParams.get('order'));
    if (!numero) return erro(400, 'Parâmetro order ausente ou inválido: use o número do pedido (ex.: SH1731559AP).');

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

    const conferencia = await conferirPedidoNoDataMart(marca, numero, prazoDaConferencia());
    if (conferencia.tipo !== 'lido') {
        return erro(502, 'Não foi possível conferir o pedido no Data Mart. Tente de novo em instantes.');
    }
    const { contexto } = conferencia;

    const naoConferidos: CampoConferido[] = [];
    if (contexto.nf.estado === 'desconhecida') naoConferidos.push('nf');
    if (!contexto.cd.conferido) naoConferidos.push('cd');
    const avisos = naoConferidos.length > 0
        ? [...contexto.avisos, `O Data Mart não respondeu a tempo para conferir ${oQueNaoFoiConferido(naoConferidos)}; ao gravar, o servidor confere de novo.`]
        : contexto.avisos;

    return NextResponse.json<Resposta>({
        brand: marca,
        order: contexto.pedido,
        nf: contexto.nf.numero,
        nfStatus: contexto.nf.estado,
        cd: contexto.cd.valor,
        statusSugerido: contexto.statusSugerido,
        avisos,
        kits: contexto.kits,
        naoConferidos,
    });
}
