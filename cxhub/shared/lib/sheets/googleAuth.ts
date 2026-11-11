/**
 * Credencial do Google para as planilhas: **conta de serviço**, sem biblioteca nova — o JWT é assinado com o
 * WebCrypto (`crypto.subtle`, que o Worker e o Node têm; o `node:crypto` não existe no Worker) e trocado por um
 * access token (fluxo `jwt-bearer`, o mesmo que o SDK do Google faz).
 *
 * - `GOOGLE_PLANILHAS_EMAIL` — o e-mail da conta (não é segredo);
 * - `GOOGLE_PLANILHAS_TOKEN` — o `private_key` do JSON da conta (**segredo**);
 * - `SHEETS_ENV` — `prod` ou `staging` (ver `targets.ts`).
 *
 * ⚠️ **Server-only**, fora do barrel `shared/lib/sheets/index.ts`: lê segredo. Importe pelo caminho completo.
 *
 * **Nada que carregue a chave ou o token entra em mensagem de erro nem em log.** A chave só é lida aqui, e as
 * falhas do `crypto` (que podem citar o formato) são trocadas por frases nossas.
 */

const LOG = '[Google Auth]';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ESCOPO = 'https://www.googleapis.com/auth/spreadsheets';
const VALIDADE_DO_JWT_S = 3600;
const PRAZO_PADRAO_MS = 10_000;

/** Token que expira "já" é tratado como expirado — a requisição leva tempo. */
const MARGEM_MS = 60_000;

export class GoogleAuthError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'GoogleAuthError';
    }
}

/**
 * `true` quando dá para tentar gravar: conta, chave e ambiente (`prod` ou `staging`) presentes. Só confere
 * **presença** — se a chave é válida só se sabe ao assinar.
 */
export function planilhasConfiguradas(): boolean {
    const ambiente = process.env.SHEETS_ENV;
    return Boolean(
        process.env.GOOGLE_PLANILHAS_EMAIL?.trim()
        && process.env.GOOGLE_PLANILHAS_TOKEN?.trim()
        && (ambiente === 'prod' || ambiente === 'staging')
    );
}

/**
 * A chave privada a partir do que veio na env, que chega de três jeitos: com `\n` escrito, com quebra de linha
 * de verdade, ou tudo numa linha só. Tira os `\n` literais, os marcadores `BEGIN/END PRIVATE KEY` e todo espaço,
 * e o que sobra é o miolo base64 do PKCS#8.
 */
async function chavePrivada(bruto: string): Promise<CryptoKey> {
    const miolo = bruto
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\\n/g, '')
        .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
        .replace(/\s+/g, '');
    try {
        const der = Uint8Array.from(atob(miolo), (c) => c.charCodeAt(0));
        return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    } catch {
        // Sem a mensagem original: ela vem da implementação do crypto e não há por que arriscar que carregue pedaço da chave.
        throw new GoogleAuthError('GOOGLE_PLANILHAS_TOKEN não é uma chave privada PKCS#8 válida');
    }
}

function base64url(dados: string | ArrayBuffer): string {
    const bytes = typeof dados === 'string' ? new TextEncoder().encode(dados) : new Uint8Array(dados);
    let binario = '';
    for (const b of bytes) binario += String.fromCharCode(b);
    return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** O JWT assinado (RS256 = RSASSA-PKCS1-v1_5 com SHA-256) que o Google troca por um access token. */
async function assinarJwt(email: string, chave: CryptoKey, agoraS: number): Promise<string> {
    const cabecalho = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const corpo = base64url(JSON.stringify({
        iss: email,
        scope: ESCOPO,
        aud: TOKEN_URL,
        iat: agoraS,
        exp: agoraS + VALIDADE_DO_JWT_S,
    }));
    const assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(`${cabecalho}.${corpo}`));
    return `${cabecalho}.${corpo}.${base64url(assinatura)}`;
}

let tokenEmCache: { token: string; expiraEm: number } | null = null;
let emVoo: Promise<string> | null = null;

/** Descarta o token em cache — o Google respondeu 401 a ele. */
export function invalidarTokenDoGoogle(): void {
    tokenEmCache = null;
}

/** Só para teste — o cache é estado de módulo e vazaria entre casos. */
export function __resetGoogleTokenCache(): void {
    tokenEmCache = null;
    emVoo = null;
}

async function pedirToken(prazo: number): Promise<string> {
    const email = process.env.GOOGLE_PLANILHAS_EMAIL?.trim();
    const chaveBruta = process.env.GOOGLE_PLANILHAS_TOKEN;
    if (!email) throw new GoogleAuthError('Falta GOOGLE_PLANILHAS_EMAIL');
    if (!chaveBruta?.trim()) throw new GoogleAuthError('Falta GOOGLE_PLANILHAS_TOKEN');

    const restante = prazo - Date.now();
    if (restante <= 0) throw new GoogleAuthError('prazo esgotado antes de pedir o token do Google');

    const jwt = await assinarJwt(email, await chavePrivada(chaveBruta), Math.floor(Date.now() / 1000));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), restante);
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: jwt,
            }).toString(),
            signal: controller.signal,
        });
        const corpo = await res.json().catch((erro: unknown) => {
            if (erro instanceof Error && erro.name === 'AbortError') throw erro;
            return null;
        }) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | null;

        if (!res.ok) {
            const motivo = [corpo?.error, corpo?.error_description]
                .filter((parte): parte is string => typeof parte === 'string')
                .join(': ')
                .slice(0, 200);
            throw new GoogleAuthError(`${LOG} o Google recusou o token: HTTP ${res.status} ${motivo}`.trim(), res.status);
        }
        if (typeof corpo?.access_token !== 'string' || !corpo.access_token) {
            throw new GoogleAuthError(`${LOG} resposta do token sem access_token`);
        }

        const expiraEmS = typeof corpo.expires_in === 'number' ? corpo.expires_in : VALIDADE_DO_JWT_S;
        tokenEmCache = { token: corpo.access_token, expiraEm: Date.now() + expiraEmS * 1000 };
        return corpo.access_token;
    } catch (erro) {
        if (erro instanceof GoogleAuthError) throw erro;
        const causa = erro instanceof Error && erro.name === 'AbortError'
            ? 'prazo esgotado'
            : (erro instanceof Error ? erro.message : 'falha de rede');
        throw new GoogleAuthError(`${LOG} token: ${causa}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Access token da conta de serviço, cacheado em memória até 60 s antes de expirar. Duas chamadas ao mesmo tempo
 * (as duas linhas do reembolso do Bot) dividem o mesmo pedido em vez de assinar dois JWTs.
 *
 * Toda falha sai como `GoogleAuthError` — e falhar aqui é sempre **certo**: nenhuma escrita chegou a sair.
 */
export async function tokenDoGoogle(prazo: number = Date.now() + PRAZO_PADRAO_MS): Promise<string> {
    if (tokenEmCache && tokenEmCache.expiraEm - MARGEM_MS > Date.now()) return tokenEmCache.token;
    if (emVoo) return emVoo;

    emVoo = pedirToken(prazo).finally(() => { emVoo = null; });
    return emVoo;
}
