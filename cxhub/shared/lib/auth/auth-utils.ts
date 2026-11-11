

const TOKEN_KEY = 'cxhub_auth_token';

export function saveToken(token: string): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem(TOKEN_KEY, token);
    }
}

export function getToken(): string | null {
    if (typeof window !== 'undefined') {
        const token = localStorage.getItem(TOKEN_KEY);
        // Handle edge cases where "undefined" or "null" is stored as string
        if (token === 'undefined' || token === 'null' || token === '') {
            return null;
        }
        return token;
    }
    return null;
}

export function removeToken(): void {
    if (typeof window !== 'undefined') {
        localStorage.removeItem(TOKEN_KEY);
    }
}



export function clearAuth(): void {
    if (typeof window !== 'undefined') {
        localStorage.removeItem(TOKEN_KEY);
    }
}



/**
 * Decodifica um JWT e retorna o payload
 * Retorna null se o token for inválido
 */
function decodeJWT(token: string): { exp?: number;[key: string]: unknown } | null {
    try {
        // JWT format: header.payload.signature
        const parts = token.split('.');
        if (parts.length !== 3) {
            return null;
        }
        // Decode the payload (base64url)
        const payload = parts[1];
        const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

/**
 * Verifica se o token JWT está expirado
 */
function isTokenExpired(token: string): boolean {
    const payload = decodeJWT(token);
    if (!payload || !payload.exp) {
        // Se não conseguir decodificar ou não tiver exp, considera válido
        // (deixa o servidor validar)
        return false;
    }
    // exp é em segundos, Date.now() é em milissegundos
    const expirationTime = payload.exp * 1000;
    const now = Date.now();
    // Considera expirado se faltam menos de 30 segundos
    return now >= (expirationTime - 30000);
}

export function isTokenValid(token: string | null): boolean {
    // Validate token exists and is not an invalid string
    if (!token || token === 'undefined' || token === 'null' || token.trim() === '') {
        return false;
    }

    // Verifica se o token JWT está expirado
    if (isTokenExpired(token)) {
        console.warn('[Auth] Token JWT expirado');
        return false;
    }

    return true;
}

/**
 * Trata resposta 401 (não autorizado) - limpa auth e redireciona para login
 * Retorna true se foi um 401 e o logout foi executado
 */
export function handleUnauthorized(status: number): boolean {
    if (status === 401) {
        console.warn('[Auth] Recebido 401 - token expirado ou inválido, fazendo logout...');
        clearAuth();
        // Redireciona para login
        if (typeof window !== 'undefined') {
            window.location.href = '/';
        }
        return true;
    }
    return false;
}

// Mock credentials for demo purposes


export async function validateCredentials(email: string, password: string): Promise<{ token: string }> {
    // Use internal API route to keep secrets server-side
    // This calls app/api/auth/login/route.ts
    const response = await fetch('/api/auth/login',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password }),
        }
    );
    if (response.ok) {
        const data = await response.json();
        // Token comes from credentials.token, not directly from token
        const token = data.credentials?.token;
        return { token };
    }

    if (response.status === 401) {
        throw new Error('Email ou senha inválidos');
    } else if (response.status === 404) {
        throw new Error('Usuário não encontrado');
    } else if (response.status === 500) {
        throw new Error('Erro interno do servidor');
    }

    throw new Error(`Erro ${response.status}: ${response.statusText}`);

}

export function generateMockToken(): string {
    return `mock_token_${Date.now()}_${Math.random().toString(36).substring(2)}`;
}
