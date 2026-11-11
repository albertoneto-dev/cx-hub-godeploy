import { NextRequest, NextResponse } from '../../../../../api/next-server';
import { ehMarcaSemCosmos } from '../../../../shared/lib/constants';

const DEFAULT_TIMEOUT_MS = 10000;

// Map brand names to Cosmos organization IDs
const BRAND_TO_ORG_ID: Record<string, string> = {
    'lescent': '3',
    'kokeshi': '4',
    'bysamia': '5',
    'aua': '6',
    'barbours': '8',
    'rituaria': '9',
};

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const brand = searchParams.get('brand');
    const authHeader = request.headers.get('authorization');

    if (!brand) {
        return NextResponse.json(
            { error: 'Missing brand parameter' },
            { status: 400 }
        );
    }

    if (!authHeader) {
        return NextResponse.json(
            { error: 'Missing authorization header' },
            { status: 401 }
        );
    }

    const apiUrl = process.env.COSMOS_API_URL;
    if (!apiUrl) {
        console.error('[Cosmos API] Missing COSMOS_API_URL env variable');
        return NextResponse.json(
            { error: 'Cosmos API URL not configured' },
            { status: 500 }
        );
    }

    // Marca sem Cosmos (ADR-013) nunca chega ao Cosmos: com o valor cru no lugar da org, o 401 deslogaria a agente.
    if (ehMarcaSemCosmos(brand.toLowerCase())) {
        return NextResponse.json({ error: `A marca ${brand} não tem organização no Cosmos` }, { status: 400 });
    }

    const orgId = BRAND_TO_ORG_ID[brand.toLowerCase()] || brand;

    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        // Fetch products with pagination (up to 10 pages, 100 per page = 1000 products max)
        const sku = searchParams.get('sku');

        // Se tiver SKU, faz busca específica
        if (sku) {
            const url = `${apiUrl}/organizations/${orgId}/products?sku=${encodeURIComponent(sku)}`;
            console.log(`[Cosmos API] Fetching product by SKU:`, url);

            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': authHeader,
                },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!res.ok) {
                const errorText = await res.text().catch(() => '');
                console.error(`[Cosmos API] Error: ${res.status}`, errorText);
                return NextResponse.json(
                    { error: `Cosmos API error: ${res.status}` },
                    { status: res.status }
                );
            }

            const data = await res.json();
            return NextResponse.json(data);
        }

        const allProducts: unknown[] = [];
        const maxPages = 10;
        const perPage = 100;

        for (let page = 1; page <= maxPages; page++) {
            const url = `${apiUrl}/organizations/${orgId}/products?per_page=${perPage}&page=${page}`;
            console.log(`[Cosmos API] Fetching products page ${page}:`, url);

            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': authHeader,
                },
                signal: controller.signal,
            });

            console.log(`[Cosmos API] Response status page ${page}:`, res.status);

            if (!res.ok) {
                clearTimeout(timeoutId);
                const errorText = await res.text().catch(() => '');
                console.error(`[Cosmos API] Error: ${res.status}`, errorText);
                return NextResponse.json(
                    { error: `Cosmos API error: ${res.status}` },
                    { status: res.status }
                );
            }

            const data = await res.json();

            // If no products returned, we've reached the end
            if (!Array.isArray(data) || data.length === 0) {
                break;
            }

            allProducts.push(...data);

            // If less than perPage returned, we've reached the end
            if (data.length < perPage) {
                break;
            }
        }

        clearTimeout(timeoutId);
        console.log(`[Cosmos API] Total products fetched: ${allProducts.length}`);
        return NextResponse.json(allProducts);
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            console.warn(`[Cosmos API] Products timeout after ${timeoutMs}ms`);
            return NextResponse.json({ error: 'Request timeout' }, { status: 504 });
        }
        console.error('[Cosmos API] Fetch error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch from Cosmos' },
            { status: 500 }
        );
    }
}
