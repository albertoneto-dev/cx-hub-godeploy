// Shopify Order Adapter
// Converts ShopifyOrder to NormalizedOrder

import { ShopifyOrder } from '../../types/index';
import { NormalizedOrder, NormalizedAddress } from '../../types/index';
import { parseAddressStringExtended } from '../cosmos/address-utils';
import { ehMarcaSemCosmos } from '../constants';
import { repartirPeloMaiorResto } from '../centavos';
import { resolveCdOrigem } from './cd-utils';
import { transportadoraNaGrafiaDaPlanilha } from './gateway';

/**
 * Extrai apenas os dígitos do name do pedido Shopify
 * Ex: "#1234" -> "1234"
 */
function extractShopifyId(name: string): string {
    return name.replace(/\D/g, '');
}

/** Valor em reais (texto ou número da Shopify) em centavos inteiros. Ausente ou ilegível ⇒ 0. */
function emCentavos(valor: string | number | null | undefined): number {
    return Math.round((parseFloat(String(valor ?? '')) || 0) * 100);
}

/**
 * O desconto de cada linha do pedido (`produtos[].desconto`, o total da linha em reais), na ordem de `line_items`.
 *
 * Em geral é a soma das `discount_allocations` da linha. Mas o pedido com checkout Yampi chega com os itens a preço
 * cheio e sem allocations: o desconto só aparece no total (incidente: um reembolso da Ápice saiu com R$ 243,76, o
 * preço cheio, em vez dos R$ 196,84 pagos). A regra é a do app que as marcas sem Cosmos usavam:
 * - `pagoProdutos` = `total_price` − frete (`total_shipping_price_set`). É o `total_price` (o total da compra), não o
 *   `current_total_price`, que muda depois de reembolso ou edição;
 * - `bruto` = Σ `price` × `quantity`;
 * - se `bruto − pagoProdutos` passa da soma das allocations em mais de R$ 0,01 e `pagoProdutos > 0`, o desconto da
 *   linha é o bruto dela menos o que ela pagou, com o `pagoProdutos` repartido pelo bruto das linhas
 *   (`repartirPeloMaiorResto`, em centavos: a soma fecha). Senão, valem as allocations, como sempre.
 */
function descontosDasLinhas(order: ShopifyOrder): string[] {
    const linhas = order.line_items ?? [];
    const alocado = linhas.map((item) => (item.discount_allocations ?? []).reduce((sum, d) => sum + (parseFloat(d.amount) || 0), 0));
    const brutos = linhas.map((item) => emCentavos(item.price) * (item.quantity || 0));
    const bruto = brutos.reduce((s, b) => s + b, 0);
    const pagoProdutos = emCentavos(order.total_price) - emCentavos(order.total_shipping_price_set?.shop_money?.amount);
    const alocadoNoPedido = alocado.reduce((s, a) => s + Math.round(a * 100), 0);

    if (pagoProdutos <= 0 || bruto - pagoProdutos <= alocadoNoPedido + 1) {
        return alocado.map((a) => String(a));
    }
    const pagos = repartirPeloMaiorResto(pagoProdutos, brutos);
    return brutos.map((b, i) => String((b - pagos[i]) / 100));
}

export function adaptShopifyOrder(order: ShopifyOrder, brand: string): NormalizedOrder {
    const descontos = descontosDasLinhas(order);

    // Get NF from note_attributes if available
    const nfAttribute = order.note_attributes?.find(attr => attr.name === 'nf_number');

    // Build customer name
    const nomeCliente = order.customer?.first_name && order.customer?.last_name
        ? `${order.customer.first_name} ${order.customer.last_name}`
        : order.shipping_address?.name || order.email;

    const addr = order.shipping_address;

    // Parseia endereço para corrigir casos onde número/complemento estão concatenados no logradouro
    // Shopify address1 geralmente contém logradouro, número e complemento
    // Shopify address2 geralmente contém o BAIRRO (não o complemento!)
    const parsedAddr = addr
        ? parseAddressStringExtended(addr.address1, '', '')  // Não passa address2 como complemento
        : { logradouro: '', numero: '', complemento: '', bairro: '' };

    // Build formatted address string
    let enderecoCliente = '-';
    if (addr) {
        enderecoCliente = `${addr.address1}${addr.address2 ? ', ' + addr.address2 : ''}, ${addr.city}, ${addr.zip} - ${addr.province_code}`;
    }

    // address2 da Shopify é o BAIRRO, não o complemento!
    // Usa address2 como bairro se disponível, senão usa o que foi extraído do address1
    const bairroFinal = addr?.address2 || parsedAddr.bairro || '';

    const endereco: NormalizedAddress = {
        logradouro: parsedAddr.logradouro,
        numero: parsedAddr.numero, // Extraído do address1
        complemento: parsedAddr.complemento, // Extraído do address1 (ex: "Quadra 12", "Apto 5")
        bairro: bairroFinal, // Prioriza address2, senão usa o extraído
        cidade: addr?.city || '',
        estado: addr?.province_code || addr?.province || '',
        cep: addr?.zip || '',
    };

    return {
        source: 'shopify',
        orderTotal: order.current_total_price,
        shippingCost: order.total_shipping_price_set?.shop_money?.amount ?? '0',
        // IDs - quando vem direto da Shopify, não tem cosmos_id
        cosmos_id: null,
        shopify_id: extractShopifyId(order.name),
        order_name: order.name,
        // Dados do pedido
        numeroPedido: order.name,
        numeroNF: nfAttribute?.value || '-',
        invoiceAccessKey: '', // Shopify não possui chave de acesso da NF
        nomeCliente,
        telefoneCliente: order.customer?.phone || order.shipping_address?.phone || '-',
        enderecoCliente,
        endereco,
        // Nas marcas sem Cosmos não há o de-para pelo Cosmos (`getCosmosCarrier`): vale a que despachou
        // (`tracking_company`, quando vem) ou o título do frete, na grafia das planilhas delas (ADR-013).
        transportadora: ehMarcaSemCosmos(brand)
            ? transportadoraNaGrafiaDaPlanilha(
                order.fulfillments?.find((f) => f.tracking_company)?.tracking_company || order.shipping_lines?.[0]?.title,
                brand,
            ) || '-'
            : order.shipping_lines?.[0]?.title || '-',
        cdOrigem: resolveCdOrigem(addr?.province_code || addr?.province || '', brand),
        financialStatus: order.financial_status || undefined,
        produtos: order.line_items?.map((item, i) => ({
            id: item.id.toString(),
            product_id: 0, // Shopify não tem product_id do Cosmos
            nome: item.name,
            sku: item.sku,
            quantidade: item.quantity,
            preco: item.price,
            desconto: descontos[i],
        })) || [],
        createdAt: order.created_at || undefined,
    };
}
