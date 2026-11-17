import { NextRequest, NextResponse } from '../../../../../api/next-server';
import { lePedidoPeloGateway } from '../../../../shared/lib/shopify/gateway';
import { buscarPedidoNoGatewayOuNoDataMart } from '../../../../shared/lib/shopify/buscarPedidoNoGatewayOuNoDataMart';

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * O pedido da marca na Shopify, para a tela (e a Central de Tickets) quando o Cosmos não o acha, e nas marcas sem Cosmos.
 *
 * Toda marca é lida pelo integrations-gateway, com o nome da marca na URL (`docs/integrations-gateway-shopify.md`), e,
 * quando ele não acha o pedido (só enxerga 60 dias) ou falha, pelo Data Mart. Este app não guarda token de loja nenhum
 * (decisão de 2026-11-17, `cxhub/ORIGEM.md`): até ali, Lescent, Kokeshi, BySamia, Auá e Barbours liam o REST
 * `orders.json` da loja com os `SHOPIFY_TOKEN_*`. A resposta segue no formato REST de sempre, com 0 ou 1 pedido e só os
 * campos que o `adaptShopifyOrder` lê, para o navegador não mudar.
 */
export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const brand = searchParams.get('brand');
    const orderId = searchParams.get('orderId');

    if (!brand || !orderId) {
        return NextResponse.json(
            { error: 'Missing brand or orderId parameter' },
            { status: 400 }
        );
    }

    const marca = brand.toLowerCase();
    if (!lePedidoPeloGateway(marca)) {
        return NextResponse.json(
            { error: `Unknown brand: ${brand}` },
            { status: 400 }
        );
    }

    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;
    const busca = await buscarPedidoNoGatewayOuNoDataMart(marca, orderId, timeoutMs);
    if (busca.tipo === 'falha') return NextResponse.json({ error: busca.erro }, { status: busca.status });
    return NextResponse.json({ orders: busca.tipo === 'achado' ? [busca.pedido] : [] });
}
