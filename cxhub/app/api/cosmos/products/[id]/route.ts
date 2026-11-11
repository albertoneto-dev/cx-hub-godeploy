import { NextRequest, NextResponse } from '../../../../../../api/next-server';
import { ehMarcaSemCosmos } from '../../../../../shared/lib/constants';

const DEFAULT_TIMEOUT_MS = 10000;

// Map brand names to Cosmos organization IDs
// TODO: Centralize this map if reused often
const BRAND_TO_ORG_ID: Record<string, string> = {
    'lescent': '3',
    'kokeshi': '4',
    'bysamia': '5',
    'aua': '6',
    'barbours': '8',
    'rituaria': '9',
    '9': '9', // Allow passing ID directly if needed
    '8': '8',
    '6': '6',
    '5': '5',
    '4': '4',
    '3': '3'
};

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;
    const { id } = await params;
    const productId = id;
    const searchParams = request.nextUrl.searchParams;
    const brand = searchParams.get('brand'); // We need brand to know the Org ID
    const authHeader = request.headers.get('authorization');

    if (!productId) {
        return NextResponse.json(
            { error: 'Missing product ID parameter' },
            { status: 400 }
        );
    }

    if (!brand) {
        return NextResponse.json(
            { error: 'Missing brand parameter (required for Org ID)' },
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

    const url = `${apiUrl}/organizations/${orgId}/products/${productId}`;
    console.log(`[Cosmos API] Fetching product details:`, url);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
            console.error(`[Cosmos API] Error fetching product ${productId}: ${res.status}`, errorText);
            return NextResponse.json(
                { error: `Cosmos API error: ${res.status}` },
                { status: res.status }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            console.warn(`[Cosmos API] Product ${productId} timeout after ${timeoutMs}ms`);
            return NextResponse.json({ error: 'Request timeout' }, { status: 504 });
        }
        console.error('[Cosmos API] Fetch error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch product details from Cosmos' },
            { status: 500 }
        );
    }
}
