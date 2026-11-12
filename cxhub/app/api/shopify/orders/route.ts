import { NextRequest, NextResponse } from '../../../../../api/next-server';
import { lePedidoPeloGateway } from '../../../../shared/lib/shopify/gateway';
import { buscarPedidoNoGatewayOuNoDataMart } from '../../../../shared/lib/shopify/buscarPedidoNoGatewayOuNoDataMart';

const DEFAULT_TIMEOUT_MS = 10000;

// Shopify store configuration per brand
interface ShopifyStoreConfig {
    baseUrl: string;
    /** O nome da env do token, lida a cada requisição: no Worker o `process.env` só é preenchido quando ela chega. */
    tokenEnv: string;
}

// Tokens are server-side only - no NEXT_PUBLIC_ prefix needed
// A Rituária não está aqui: neste app o pedido dela vem pelo integrations-gateway (`MarcaNoGateway`), sem
// `SHOPIFY_TOKEN_RITUARIA`.
const SHOPIFY_STORES: Record<string, ShopifyStoreConfig> = {
    'lescent': {
        baseUrl: 'https://568499-ef.myshopify.com/admin/api/2025-01',
        tokenEnv: 'SHOPIFY_TOKEN_LESCENT',
    },
    'kokeshi': {
        baseUrl: 'https://kokeshi-loja.myshopify.com/admin/api/2025-01',
        tokenEnv: 'SHOPIFY_TOKEN_KOKESHI',
    },
    'bysamia': {
        baseUrl: 'https://gcpf8a-ki.myshopify.com/admin/api/2025-01',
        tokenEnv: 'SHOPIFY_TOKEN_BYSAMIA',
    },
    'aua': {
        baseUrl: 'https://ca0rd1-ft.myshopify.com/admin/api/2025-01',
        tokenEnv: 'SHOPIFY_TOKEN_AUA',
    },
    'barbours': {
        baseUrl: 'https://742eae-3.myshopify.com/admin/api/2025-01',
        tokenEnv: 'SHOPIFY_TOKEN_BARBOURS',
    },
};

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

    // Marcas sem Cosmos (ADR-013) e a Rituária (`MarcaNoGateway`): o pedido é lido pelo integrations-gateway
    // (`docs/integrations-gateway-shopify.md`) e, quando ele não o acha (só enxerga 60 dias) ou falha, no Data Mart
    // (decisão deste app, `cxhub/ORIGEM.md`) — sempre no formato REST de sempre, para o navegador e o
    // `adaptShopifyOrder` não mudarem.
    const marca = brand.toLowerCase();
    if (lePedidoPeloGateway(marca)) {
        const timeoutDoGateway = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;
        const busca = await buscarPedidoNoGatewayOuNoDataMart(marca, orderId, timeoutDoGateway);
        if (busca.tipo === 'falha') return NextResponse.json({ error: busca.erro }, { status: busca.status });
        return NextResponse.json({ orders: busca.tipo === 'achado' ? [busca.pedido] : [] });
    }

    const storeConfig = SHOPIFY_STORES[brand.toLowerCase()];

    if (!storeConfig) {
        return NextResponse.json(
            { error: `Unknown brand: ${brand}` },
            { status: 400 }
        );
    }

    const token = process.env[storeConfig.tokenEnv];
    if (!token) {
        console.error(`[Shopify API] Missing token for brand ${brand}`);
        return NextResponse.json(
            { error: 'Shopify token not configured for this brand' },
            { status: 500 }
        );
    }

    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;

    try {
        const url = `${storeConfig.baseUrl}/orders.json?status=any&name=${orderId}`;
        console.log('[Shopify API] Fetching:', url);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': token,
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            console.error(`[Shopify API] Error: ${res.status} ${res.statusText}`);
            return NextResponse.json(
                { error: `Shopify API error: ${res.status}` },
                { status: res.status }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            console.warn(`[Shopify API] Timeout after ${timeoutMs}ms`);
            return NextResponse.json({ error: 'Request timeout' }, { status: 504 });
        }
        console.error('[Shopify API] Fetch error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch from Shopify' },
            { status: 500 }
        );
    }
}
