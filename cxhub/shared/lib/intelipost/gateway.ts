import { SUFIXO_DO_PEDIDO, type MarcaSemCosmosComPlanilha, type SupportedBrand } from '../constants';
import { normalizarNf } from '../nfDaVenda';

/**
 * A Intelipost ao vivo pelo gateway (2026-11-19), puro: a conta de cada marca, os caminhos e a leitura da resposta. A
 * chamada HTTP é do `nfNaIntelipostServer.ts`, server-only.
 *
 * O Data Mart (`gold.fct_intelipost_orders`) leva cerca de 1 h para receber um envio novo, e nessa janela o pedido já
 * faturado parecia "sem NF". A API da Intelipost tem o envio na hora. As chaves da API por marca respondem 401 desde
 * 01/10/2026; o gateway a lê com uma chave só. Desde 2026-11-23 são a `INTELIPOST_GATEWAY_URL` e a
 * `INTELIPOST_GATEWAY_KEY` (o integrations-gateway, com a `INTEGRATIONS_GATEWAY_WRITE_KEY`, foi descontinuado).
 *
 * Contrato do gateway (o GoAccess, passado pelo usuário em 23/11: "Intelipost: https://api.gogroup.cc/v1/intelipost/
 * {marca}/..., com o caminho igual ao da API"; ver `docs/integrations-gateway-shopify.md`):
 * - `GET {INTELIPOST_GATEWAY_URL}/{marca}/shipment_order/sales_order_number/{SH…}` com `Authorization: Bearer <chave>`:
 *   o envio enxuto do pedido. `GET …/shipment_order/{order_number}`: o envio completo;
 * - a resposta é a da API: `{ status: 'OK', content }`, com o envio direto no `content`, num array ou em
 *   `content.shipment_orders[]`;
 * - envio que não existe: 400 (o da própria Intelipost). Sem chave ou com chave inválida: 401 no gateway antigo e 403
 *   `invalid_key` no novo (visto em 23/11); sem o escopo: 403.
 *
 * O integrations-gateway antigo pedia a **conta** no caminho (`lescent` para Lescent, Kokeshi, BySamia e Auá;
 * `beautyhub` para Barbours, Rituária e Yenzah). O GoAccess diz **marca**, e não deu para conferir sem a chave se ele
 * também conhece as contas. Por isso o caminho vai pela marca e, quando o gateway responde que não conhece a rota (404
 * com o `error` dele), tenta a conta (`segmentosDaMarcaNoGateway`).
 */

/** As marcas com conta na Intelipost: as 6 do Cosmos e as 3 sem Cosmos com planilha (a Gobeaute não tem envio próprio). */
export type MarcaComIntelipost = SupportedBrand | MarcaSemCosmosComPlanilha;

/**
 * A conta da Intelipost de cada marca no gateway: a mesma da Central de Tickets (`src/torre/gateway.ts`) e das
 * `INTELIPOST_ACCOUNTS` do Airflow. A conta da Lescent atende Lescent, Kokeshi, BySamia e Auá; a `beautyhub`, Barbours,
 * Rituária e Yenzah.
 */
export const CONTA_INTELIPOST_NO_GATEWAY: Record<MarcaComIntelipost, string> = {
    lescent: 'lescent',
    kokeshi: 'lescent',
    bysamia: 'lescent',
    aua: 'lescent',
    barbours: 'beautyhub',
    rituaria: 'beautyhub',
    yenzah: 'beautyhub',
    apice: 'apice',
    denavita: 'denavita',
};

/**
 * O que vai depois da base no caminho, em ordem de tentativa: a marca (o contrato do GoAccess) e, se for outra, a conta
 * do integrations-gateway antigo. Ápice, Denavita e Lescent têm um só (a marca é a conta).
 */
export function segmentosDaMarcaNoGateway(marca: MarcaComIntelipost): string[] {
    const conta = CONTA_INTELIPOST_NO_GATEWAY[marca];
    return conta && conta !== marca ? [marca, conta] : [marca];
}

/**
 * A sigla do pedido nas lojas das marcas do Cosmos, a mesma da Central de Tickets (`MARCAS_LOGISTICA`): `SH52988BS`,
 * `SH1452727RT`, `SH712937LC`. As sem Cosmos usam o `SUFIXO_DO_PEDIDO`.
 */
const SIGLA_DO_PEDIDO_NO_COSMOS: Record<SupportedBrand, string> = {
    lescent: 'LC',
    kokeshi: 'KS',
    bysamia: 'BS',
    aua: 'AU',
    barbours: 'BB',
    rituaria: 'RT',
};

function siglaDoPedido(marca: MarcaComIntelipost): string {
    return marca in SIGLA_DO_PEDIDO_NO_COSMOS
        ? SIGLA_DO_PEDIDO_NO_COSMOS[marca as SupportedBrand]
        : SUFIXO_DO_PEDIDO[marca as MarcaSemCosmosComPlanilha];
}

/**
 * O pedido como a Intelipost o guarda no `sales_order_number`: `SH{dígitos}{sigla}`. Só o SH da própria marca, porque
 * a conta atende mais de uma marca e só os dígitos podiam achar o envio de outra. `null` sem dígitos.
 */
export function pedidoNaIntelipost(marca: MarcaComIntelipost, pedido: string | null | undefined): string | null {
    const digitos = (pedido ?? '').replace(/\D/g, '');
    return digitos ? `SH${digitos}${siglaDoPedido(marca)}` : null;
}

/** O caminho da busca pelo pedido (`SH…`): devolve o envio enxuto. */
export function caminhoPeloPedido(pedido: string): string {
    return `shipment_order/sales_order_number/${encodeURIComponent(pedido)}`;
}

/** O caminho do envio completo pelo `order_number` (`SH712937LC001804367`). */
export function caminhoDoEnvio(orderNumber: string): string {
    return `shipment_order/${encodeURIComponent(orderNumber.trim())}`;
}

/** O envio da Intelipost, só com o que a NF usa. */
export interface EnvioIntelipost {
    order_number?: string | null;
    shipment_order_volume_array?: Array<{
        shipment_order_volume_invoice?: { invoice_number?: string | number | null } | null;
    } | null> | null;
}

export type RespostaDaIntelipost =
    | { envio: EnvioIntelipost }
    | { naoAchou: true }
    | { erro: string; rotaDesconhecida?: true };

/**
 * O que a resposta do gateway diz: o envio, "não achou" (o 400 da Intelipost para envio que não existe, o 404 sem o
 * `error` do gateway, ou o `OK` sem envio) ou um erro. 200 sem JSON, ou com outro `status`, também é erro: dizer "não
 * achou" ali deixaria a conferência concluir que o pedido não tem NF sem que a Intelipost tivesse respondido.
 *
 * O 404 com o `error` do próprio gateway (`not_found`, `unknown_store`…) é a rota que ele não conhece, e não o envio que
 * não existe: é erro, com `rotaDesconhecida`, para quem chama tentar a conta. Até a v21 ele valia "não achou", e um
 * caminho errado (a marca no lugar da conta, ou o contrário) daria "sem NF" e a recusa do registro.
 */
export function lerRespostaDaIntelipost(status: number, corpo: unknown): RespostaDaIntelipost {
    if (status === 401) return { erro: 'chave recusada pelo gateway (HTTP 401)' };
    if (status === 403) return { erro: 'chave recusada ou sem permissão de leitura da Intelipost (HTTP 403)' };
    if (status === 429) return { erro: 'limite de consultas do gateway (HTTP 429)' };
    if (status >= 500) return { erro: `gateway ou Intelipost fora do ar (HTTP ${status})` };
    if (status === 404) {
        const erroDoGateway = (corpo as { error?: unknown } | null)?.error;
        return typeof erroDoGateway === 'string' && erroDoGateway
            ? { erro: `o gateway não conhece a rota (HTTP 404 ${erroDoGateway.slice(0, 60)})`, rotaDesconhecida: true }
            : { naoAchou: true };
    }
    if (status === 400) return { naoAchou: true };
    if (status !== 200) return { erro: `HTTP ${status}` };
    const resposta = corpo as { status?: unknown; content?: unknown } | null;
    if (!resposta || typeof resposta !== 'object') return { erro: 'resposta 200 sem JSON' };
    if (resposta.status !== 'OK') return { erro: `resposta 200 com status ${String(resposta.status)}` };
    const c = resposta.content as { shipment_orders?: unknown } | unknown[] | null | undefined;
    const envio = Array.isArray(c) ? c[0] : c && typeof c === 'object' && Array.isArray(c.shipment_orders) ? c.shipment_orders[0] : c;
    if (!envio || typeof envio !== 'object') return { naoAchou: true };
    const e = envio as EnvioIntelipost;
    return e.order_number || Array.isArray(e.shipment_order_volume_array) ? { envio: e } : { naoAchou: true };
}

/** A NF do envio: a do primeiro volume que tiver uma, sem os zeros à esquerda. */
export function nfDoEnvio(envio: EnvioIntelipost): string | null {
    for (const volume of envio.shipment_order_volume_array ?? []) {
        const nf = normalizarNf(volume?.shipment_order_volume_invoice?.invoice_number);
        if (nf) return nf;
    }
    return null;
}
