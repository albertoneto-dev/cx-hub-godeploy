import { consultarDataMart, literalSql } from '../metabase/index';
import type { ShopifyOrder } from '../../types/index';

/**
 * O pedido da Shopify das marcas que este app lê pelo integrations-gateway (as sem Cosmos e a Rituária,
 * `MarcaNoGateway`), lido no **Data Mart**, pelo Metabase: a reserva do gateway, que só enxerga os últimos 60 dias de
 * pedidos (falta o `read_all_orders` nas lojas). O Data Mart guarda o pedido inteiro, sem janela — em
 * `api.vw_shopify_orders`, com os itens, o frete e os despachos no JSON da própria Shopify. Decisão deste app
 * (`cxhub/ORIGEM.md`, 2026-11-12).
 *
 * Devolve o mesmo `ShopifyOrder` (REST) que o gateway devolve (`pedidoDoGatewayParaShopify`), com os mesmos campos: a
 * tela e o `adaptShopifyOrder` não mudam. A carga do Data Mart atrasa horas, então o pedido de agora pode ainda não
 * estar aqui — é por isso que o gateway vem primeiro (`buscarPedidoNoGatewayOuNoDataMart`).
 *
 * ⚠️ Server-only (lê a `METABASE_API_KEY` pelo cliente do Metabase). O pedido tem nome, telefone e endereço da cliente:
 * nunca vai ao log.
 */

const LOG = '[Pedido no Data Mart]';

/** As lojas que o Data Mart guarda com o nome da marca (`gold.fct_shopify_orders.brand`). A Gobeaute não está lá. */
const MARCAS_NO_DATA_MART: readonly string[] = ['apice', 'yenzah', 'denavita', 'rituaria'];

export type ResultadoDaBuscaNoDataMart =
    | { tipo: 'achado'; pedido: ShopifyOrder }
    | { tipo: 'nao_encontrado' }
    | { tipo: 'falha'; erro: string };

/**
 * O telefone do pedido da Ápice no Tiny: a réplica da Shopify às vezes vem sem nenhum telefone (o #1607929 veio), e o
 * Tiny o tem. O pedido do Tiny é achado pelo `id_pedido` que a Intelipost guarda (`external_erp_id`), no ES ou no RJ,
 * tudo por índice. As outras marcas não têm Tiny: a coluna vem nula.
 */
function sqlDoTelefoneNoTiny(marca: string, numero: string): string {
    if (marca !== 'apice') return 'null';
    return `(select coalesce(nullif(trim(e.fone_cliente), ''), nullif(trim(r.fone_cliente), ''))
     from (select external_erp_id from gold.fct_intelipost_orders where shopify_order_number = ${literalSql(numero)} and brand_code = 'apice' order by created_iso limit 1) i
     left join api.tiny_pedidos_ap_cosmetics_es e on e.id_pedido = i.external_erp_id
     left join api.tiny_pedidos_ap_cosmetics_rj r on r.id_pedido = i.external_erp_id)`;
}

/**
 * O pedido pela marca e pelo número. A visão é lida pela chave (`order_id`), que a `fct_shopify_orders` dá pelo índice
 * de `(brand, order_number)`: a subconsulta fica no WHERE, como nas outras leituras do Data Mart. Na Ápice, a última
 * coluna é o telefone do Tiny. Medido em 2026-11-12 com a chave do CX Hub: de 0,2 a 0,9 s, com o telefone do Tiny.
 * `numero` já vem só com dígitos (no `order_number` vai sem aspas: a coluna é numérica).
 */
export function sqlDoPedidoDaShopify(marca: string, numero: string): string {
    return `select o.order_id::text, o.order_name, o.created_at, coalesce(o.order_email, o.customer_email, o.contact_email) as email,
  o.financial_status, o.current_total_price, o.value_total, o.value_shipment,
  o.customer_name, o.customer_phone, o.order_phone,
  o.shipping_first_name, o.shipping_last_name, o.shipping_address1, o.shipping_address2, o.shipping_city, o.shipping_zip, o.shipping_state,
  o.line_items_data, o.shipping_lines_data, o.fulfillments_data, o.note_attributes_data,
  ${sqlDoTelefoneNoTiny(marca, numero)} as fone_do_tiny
from api.vw_shopify_orders o
where o.order_id = (select order_id from gold.fct_shopify_orders where brand = ${literalSql(marca)} and order_number = ${numero} order by order_id desc limit 1)`;
}

type Objeto = Record<string, unknown>;

/** O `jsonb` como lista de objetos: o Metabase o devolve como texto JSON. Ilegível ou ausente ⇒ lista vazia. */
function lista(valor: unknown): Objeto[] {
    let lido = valor;
    if (typeof lido === 'string') {
        try {
            lido = JSON.parse(lido);
        } catch {
            return [];
        }
    }
    return Array.isArray(lido) ? lido.filter((item): item is Objeto => typeof item === 'object' && item !== null) : [];
}

const texto = (valor: unknown): string => (valor === null || valor === undefined ? '' : String(valor).trim());
const textoOuNulo = (valor: unknown): string | null => texto(valor) || null;

/** Dinheiro como o REST da Shopify o escreve: texto com duas casas. */
function dinheiro(valor: unknown): string {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero.toFixed(2) : '0.00';
}

/**
 * A linha do Data Mart no formato REST que o `adaptShopifyOrder` lê: os mesmos campos que o gateway devolve, e só eles.
 * Dos atributos do pedido só o `nf_number` passa (os outros têm endereço e CPF). O desconto de cada item vai numa
 * alocação só, como no gateway (`totalDiscountSet`): a soma das alocações da Shopify, ou o `total_discount` sem elas.
 * O telefone do Tiny (Ápice) só entra quando a Shopify não tem nenhum. `null` quando a linha não tem o id ou o nome do
 * pedido.
 */
export function pedidoDoDataMartParaShopify(linha: unknown[]): ShopifyOrder | null {
    const [
        orderId, nome, criadoEm, email, situacaoFinanceira, totalAtual, total, frete,
        cliente, telefoneDaCliente, telefoneDoPedido,
        primeiroNome, sobrenome, endereco1, endereco2, cidade, cep, estado,
        itens, fretes, despachos, atributos, telefoneDoTiny,
    ] = linha;
    const id = Number(orderId);
    if (!Number.isFinite(id) || id <= 0 || !texto(nome)) return null;

    // O nome da cliente vem inteiro: o primeiro nome e o resto, como o gateway os separa.
    const [primeiro, ...resto] = texto(cliente).split(/\s+/).filter(Boolean);
    const destinatario = [texto(primeiroNome), texto(sobrenome)].filter(Boolean).join(' ') || texto(cliente);
    const uf = texto(estado);
    const nf = lista(atributos).find((atributo) => atributo.name === 'nf_number');

    const pedido = {
        id,
        name: texto(nome),
        created_at: texto(criadoEm),
        email: texto(email),
        financial_status: textoOuNulo(situacaoFinanceira)?.toLowerCase() ?? null,
        current_total_price: dinheiro(totalAtual ?? total),
        total_price: dinheiro(total),
        total_shipping_price_set: { shop_money: { amount: dinheiro(frete) } },
        customer: primeiro
            ? { first_name: primeiro, last_name: resto.join(' ') || null, phone: textoOuNulo(telefoneDaCliente) }
            : null,
        shipping_address: texto(endereco1) || texto(cidade) || texto(cep)
            ? {
                name: destinatario, address1: texto(endereco1), address2: textoOuNulo(endereco2), city: texto(cidade),
                zip: texto(cep), province: uf,
                // A sigla, quando o estado vem como sigla (o comum no Data Mart); o adapter lê ela antes do nome.
                province_code: /^[A-Za-z]{2}$/.test(uf) ? uf.toUpperCase() : '',
                phone: textoOuNulo(telefoneDoPedido) ?? textoOuNulo(telefoneDaCliente) ?? textoOuNulo(telefoneDoTiny),
            }
            : null,
        shipping_lines: lista(fretes).map((linhaDeFrete) => ({ title: texto(linhaDeFrete.title) })),
        note_attributes: nf && texto(nf.value) ? [{ name: 'nf_number', value: texto(nf.value) }] : [],
        line_items: lista(itens).map((item) => {
            const alocado = lista(item.discount_allocations).reduce((soma, d) => soma + (Number(d.amount) || 0), 0);
            return {
                id: Number(item.id) || 0,
                name: texto(item.name),
                sku: texto(item.sku),
                vendor: texto(item.vendor),
                quantity: Number(item.quantity) || 0,
                price: dinheiro(item.price),
                discount_allocations: [{ amount: dinheiro(alocado > 0 ? alocado : item.total_discount), discount_application_index: 0 }],
            };
        }),
        fulfillments: lista(despachos).map((despacho) => ({
            tracking_company: textoOuNulo(despacho.tracking_company),
            tracking_number: textoOuNulo(despacho.tracking_number),
        })),
    };
    return pedido as unknown as ShopifyOrder;
}

/**
 * O pedido da marca no Data Mart. **Nunca lança**: marca que o Data Mart não tem, número que não é de pedido ou pedido
 * ausente ⇒ `nao_encontrado`; erro do Metabase ⇒ `falha` (sem dado pessoal no motivo).
 */
export async function buscarPedidoDaShopifyNoDataMart(marca: string, orderId: string): Promise<ResultadoDaBuscaNoDataMart> {
    const numero = (orderId ?? '').replace(/\D/g, '');
    if (!MARCAS_NO_DATA_MART.includes(marca) || !/^\d{1,12}$/.test(numero)) return { tipo: 'nao_encontrado' };
    try {
        const linhas = await consultarDataMart(sqlDoPedidoDaShopify(marca, numero));
        const pedido = linhas[0] ? pedidoDoDataMartParaShopify(linhas[0]) : null;
        // A consulta é pelo `order_number`; o nome (`#n` ou `SH{n}{sufixo}`) confirma que é o pedido procurado.
        if (!pedido || pedido.name.replace(/\D/g, '') !== numero) return { tipo: 'nao_encontrado' };
        return { tipo: 'achado', pedido };
    } catch (erro) {
        const motivo = (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
        console.warn(`${LOG} ${marca}: não deu para ler o pedido ${numero} no Data Mart — ${motivo}`);
        return { tipo: 'falha', erro: motivo };
    }
}
