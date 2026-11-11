import type { ShopifyOrder } from '../../types/index';
import { ehMarcaSemCosmos, type MarcaSemCosmos } from '../constants';

/**
 * Leitura do pedido das marcas sem Cosmos (ADR-013) e da Rituária (`MarcaNoGateway`) pelo **integrations-gateway**: uma
 * chave só (`INTEGRATIONS_GATEWAY_READ_KEY`) para as lojas, e a Admin API em **GraphQL** (`POST /shopify/{marca}/graphql`),
 * não o REST `orders.json` que as outras 5 marcas do Cosmos usam. Contrato e testes do gateway em
 * `docs/integrations-gateway-shopify.md`.
 *
 * Aqui fica só o que é puro: a consulta, a escolha do pedido certo entre os que o filtro devolve e a tradução do nó
 * GraphQL para o `ShopifyOrder` (REST) que o `adaptShopifyOrder` já lê — o adapter fica como está. A chamada HTTP é do
 * `buscarPedidoNoGateway.ts`, server-only (a chave nunca vai ao navegador), que a rota `/api/shopify/orders` e a rota
 * do bot usam.
 */

export const URL_DO_GATEWAY = 'https://integrations-gateway-prod.rpa-ia.workers.dev';

/**
 * As marcas cujo pedido na Shopify é lido pelo gateway: as sem Cosmos (ADR-013) e a Rituária. A Rituária continua marca
 * do Cosmos em todo o resto (pedido, reenvio automático, cancelamento, e no `adaptShopifyOrder`); só a busca na Shopify,
 * que a tela faz quando o Cosmos não acha o pedido, passa por aqui. Decisão do app `cx-hub` do GoDeploy (2026-11-10):
 * ele não tem o token da loja (`SHOPIFY_TOKEN_RITUARIA`), e a chave do gateway já lê a mesma loja (`uyckuc-fw`,
 * conferida em 2026-11-06). Como nas sem Cosmos, o gateway só enxerga os últimos 60 dias de pedidos.
 */
export type MarcaNoGateway = MarcaSemCosmos | 'rituaria';

/** O pedido desta marca na Shopify é lido pelo gateway (`MarcaNoGateway`), e não pelo REST da loja. */
export function lePedidoPeloGateway(marca: string): marca is MarcaNoGateway {
    return ehMarcaSemCosmos(marca) || marca === 'rituaria';
}

/**
 * Quanto esperar antes da nova tentativa quando o gateway responde `429` (o limite de taxa da chave — visto em
 * 2026-11-06 numa rajada de consultas; o limite não é documentado): o `Retry-After` em segundos, até 3 s. Sem ele, ou
 * em forma de data, 1 s.
 */
export function pausaDepoisDoLimite(retryAfter: string | null): number {
    const segundos = retryAfter?.trim() ? Number(retryAfter) : NaN;
    return Number.isFinite(segundos) && segundos >= 0 ? Math.min(segundos * 1000, 3000) : 1000;
}

/**
 * Os campos que o formulário usa, e só eles. **Fora de propósito:** `tags` (trazem o CPF da cliente), `note`, e
 * `fulfillmentOrders` — o gateway nega esse campo (`ACCESS_DENIED`) e, quando ele vem na consulta, o `data` volta nulo
 * para a consulta inteira. `customAttributes` vem para achar o `nf_number`, mas só ele segue para o navegador.
 */
export const CONSULTA_DO_PEDIDO = `query ($q: String!) {
  orders(first: 5, query: $q) {
    edges { node {
      id legacyResourceId name createdAt email displayFinancialStatus
      currentTotalPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      customer { firstName lastName phone }
      shippingAddress { name address1 address2 city zip province provinceCode phone }
      shippingLines(first: 1) { edges { node { title } } }
      customAttributes { key value }
      lineItems(first: 50) { edges { node {
        id name sku vendor quantity
        originalUnitPriceSet { shopMoney { amount } }
        totalDiscountSet { shopMoney { amount } }
      } } }
      fulfillments(first: 5) { trackingInfo { company number } }
    } }
  }
}`;

type Dinheiro = { shopMoney?: { amount?: string | null } | null } | null | undefined;

/** O nó `Order` que a `CONSULTA_DO_PEDIDO` devolve. Tudo opcional: o GraphQL devolve `null` no que não tem. */
export interface PedidoDoGateway {
    id?: string | null;
    legacyResourceId?: string | null;
    name?: string | null;
    createdAt?: string | null;
    email?: string | null;
    displayFinancialStatus?: string | null;
    currentTotalPriceSet?: Dinheiro;
    /** O total da compra (o `total_price` do REST), que o desconto rateado do adapter usa (ADR-016). */
    totalPriceSet?: Dinheiro;
    totalShippingPriceSet?: Dinheiro;
    customer?: { firstName?: string | null; lastName?: string | null; phone?: string | null } | null;
    shippingAddress?: {
        name?: string | null; address1?: string | null; address2?: string | null; city?: string | null; zip?: string | null;
        province?: string | null; provinceCode?: string | null; phone?: string | null;
    } | null;
    shippingLines?: { edges?: Array<{ node?: { title?: string | null } | null }> | null } | null;
    customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
    lineItems?: {
        edges?: Array<{ node?: {
            id?: string | null; name?: string | null; sku?: string | null; vendor?: string | null; quantity?: number | null;
            originalUnitPriceSet?: Dinheiro; totalDiscountSet?: Dinheiro;
        } | null }> | null;
    } | null;
    fulfillments?: Array<{ trackingInfo?: Array<{ company?: string | null; number?: string | null }> | null }> | null;
}

/**
 * O pedido do nome procurado entre os que o filtro devolveu. O filtro `name:` da Shopify é tolerante (só os dígitos
 * acham o `SH…`), então o resultado é conferido: `SH{n}{sufixo}` casa o nome exato; só dígitos casam os dígitos do nome
 * (`#1475900` ou `SH1475900AP`). Nenhum ⇒ `null`.
 */
export function escolherPedido(pedidos: PedidoDoGateway[], procurado: string): PedidoDoGateway | null {
    const alvo = procurado.trim().toUpperCase();
    const soDigitos = /^\d+$/.test(alvo);
    return pedidos.find((p) => {
        const nome = (p.name ?? '').trim().toUpperCase();
        return soDigitos ? nome.replace(/\D/g, '') === alvo : nome === alvo;
    }) ?? null;
}

const valor = (dinheiro: Dinheiro): string | null => dinheiro?.shopMoney?.amount ?? null;

/** O número no fim de um gid (`gid://shopify/LineItem/123` → 123), ou `NaN`. */
function numeroDoGid(gid: string | null | undefined): number {
    return Number(String(gid ?? '').split('/').pop());
}

/**
 * O nó GraphQL no formato REST que o `adaptShopifyOrder` lê. Leva só os campos que o adapter usa; o resto do
 * `ShopifyOrder` (REST) não existe nesta leitura, e o tipo é afirmado de propósito. Dos atributos do pedido, só o
 * `nf_number` passa (os outros trazem endereço e CPF, que a tela não usa).
 */
export function pedidoDoGatewayParaShopify(p: PedidoDoGateway): ShopifyOrder {
    const endereco = p.shippingAddress;
    const nf = (p.customAttributes ?? []).find((a) => a.key === 'nf_number');
    const pedido = {
        id: Number(p.legacyResourceId ?? numeroDoGid(p.id)),
        name: p.name ?? '',
        created_at: p.createdAt ?? '',
        email: p.email ?? '',
        financial_status: (p.displayFinancialStatus ?? '').toLowerCase() || null,
        current_total_price: valor(p.currentTotalPriceSet) ?? '0',
        total_price: valor(p.totalPriceSet) ?? '0',
        total_shipping_price_set: { shop_money: { amount: valor(p.totalShippingPriceSet) ?? '0' } },
        customer: p.customer
            ? { first_name: p.customer.firstName ?? null, last_name: p.customer.lastName ?? null, phone: p.customer.phone ?? null }
            : null,
        shipping_address: endereco
            ? {
                name: endereco.name ?? '', address1: endereco.address1 ?? '', address2: endereco.address2 ?? null,
                city: endereco.city ?? '', zip: endereco.zip ?? '', province: endereco.province ?? '',
                province_code: endereco.provinceCode ?? '', phone: endereco.phone ?? null,
            }
            : null,
        shipping_lines: (p.shippingLines?.edges ?? []).map((e) => ({ title: e?.node?.title ?? '' })),
        note_attributes: nf?.value ? [{ name: 'nf_number', value: nf.value }] : [],
        line_items: (p.lineItems?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : [])).map((item) => ({
            id: numeroDoGid(item.id),
            name: item.name ?? '',
            sku: item.sku ?? '',
            vendor: item.vendor ?? '',
            quantity: item.quantity ?? 0,
            price: valor(item.originalUnitPriceSet) ?? '0',
            discount_allocations: [{ amount: valor(item.totalDiscountSet) ?? '0', discount_application_index: 0 }],
        })),
        fulfillments: (p.fulfillments ?? []).map((f) => ({
            tracking_company: f?.trackingInfo?.[0]?.company ?? null,
            tracking_number: f?.trackingInfo?.[0]?.number ?? null,
        })),
    };
    return pedido as unknown as ShopifyOrder;
}

/**
 * A transportadora do pedido das marcas sem Cosmos, na grafia das planilhas delas. A Shopify não diz o nome: o título
 * do frete segue o padrão da Intelipost (`NORMAL_J&T`, `NORMAL_LOGAN_EXPRESS`, `EXPRESSO_DIASLOG_STANDARD`,
 * `FRENET_PAC_04510_BACKUP`), e a transportadora do despacho, quando vem (só na Yenzah), tem grafia própria (`DiasLog`,
 * `Logan Express`, `J&T (Expresso)`). Os dois foram lidos nas lojas em 2026-11-06, e o vocabulário das planilhas em
 * 2026-11-05 (a Denavita grava `J&T Express`; Ápice e Yenzah, `J&T`). Fora da lista, fica como veio.
 */
export function transportadoraNaGrafiaDaPlanilha(texto: string | null | undefined, marca: string): string {
    const original = (texto ?? '').trim();
    const t = original.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[_\s]+/g, ' ');
    if (!t) return '';
    if (t.includes('J&T')) return marca === 'denavita' ? 'J&T Express' : 'J&T';
    if (t.includes('DIASLOG')) return 'Diaslog';
    if (t.includes('JADLOG')) return 'Jadlog';
    if (t.includes('LOGGI')) return 'Loggi';
    if (t.includes('LOGAN')) return 'Logan';
    if (t.includes('LOG SERVICOS')) return 'Log Serviços';
    if (t.includes('DIALOGO')) return 'Dialogo';
    if (t.includes('ANJUN')) return 'Anjun';
    if (t.includes('IMILE')) return 'iMile Delivery';
    if (t.includes('DISSUDES')) return 'Dissudes';
    if (/\b(CORREIOS|PAC|SEDEX)\b/.test(t)) return 'Correios';
    return original;
}
