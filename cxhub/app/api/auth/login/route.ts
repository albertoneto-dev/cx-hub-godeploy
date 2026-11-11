import { NextResponse } from '../../../../../api/next-server';

const DEFAULT_TIMEOUT_MS = 10000;

export async function POST(request: Request) {
    const body = await request.json();
    const { email, password } = body;

    // 1. Get environment variables
    const cxHubEmail = process.env.CX_HUB_EMAIL;
    // A senha tem `$` e fica cadastrada na Vercel escapada (`\$`) por causa do P-007. O build da Vercel
    // às vezes remove a contrabarra e às vezes a entrega literal (mudou entre 01/09 e 20/10/2026 — P-008);
    // desfazer o escape aqui deixa o login certo nos dois casos.
    const cxHubPassword = process.env.CX_HUB_PASSWORD?.replace(/\\\$/g, '$');
    const cosmosEmail = process.env.COSMOS_EMAIL;
    const cosmosPassword = process.env.COSMOS_PASSWORD;
    const apiUrl = process.env.COSMOS_API_URL;

    // 2. Validate configuration
    if (!cxHubEmail || !cxHubPassword || !cosmosEmail || !cosmosPassword || !apiUrl) {
        console.error('Missing required environment variables for authentication');
        return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // 3. Verify User Credentials (Step 1)
    if (email !== cxHubEmail || password !== cxHubPassword) {
        return NextResponse.json({ error: 'Credenciais inválidas' }, { status: 401 });
    }

    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;

    // 4. Authenticate with Cosmos (Step 2)
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(`${apiUrl}/auth/signin`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email: cosmosEmail, password: cosmosPassword }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // Tenta parsear o corpo da resposta
        let data;
        try {
            data = await response.json();
        } catch (e) {
            console.error('Error parsing external API response:', e);
            data = { error: 'Invalid response from upstream server' };
        }

        return NextResponse.json(data, { status: response.status });

    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            console.warn(`[Auth Login] Timeout after ${timeoutMs}ms`);
            return NextResponse.json({ error: 'Request timeout' }, { status: 504 });
        }
        console.error('Error upstream login request:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
