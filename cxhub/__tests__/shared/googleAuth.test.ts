import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createVerify } from 'node:crypto';
import {
    GoogleAuthError,
    __resetGoogleTokenCache,
    invalidarTokenDoGoogle,
    planilhasConfiguradas,
    tokenDoGoogle,
} from '@shared/lib/sheets/googleAuth';
import {
    CHAVE_PRIVADA_PEM,
    CHAVE_PUBLICA,
    EMAIL_DA_CONTA,
    URL_DO_TOKEN,
    mockGoogle,
    stubGoogleEnv,
} from '../helpers/google-sheets-mock';

const prazoFolgado = () => Date.now() + 10_000;

/** O JWT que o código mandou como `assertion`, já separado em partes. */
function assertionEnviada(google: ReturnType<typeof mockGoogle>, indice = 0) {
    const corpo = new URLSearchParams(google.tokens()[indice].body as string);
    const jwt = corpo.get('assertion') ?? '';
    const [cabecalho, claims, assinatura] = jwt.split('.');
    return {
        corpo,
        jwt,
        cabecalho: JSON.parse(Buffer.from(cabecalho, 'base64url').toString()),
        claims: JSON.parse(Buffer.from(claims, 'base64url').toString()),
        assinaturaConfere: createVerify('RSA-SHA256')
            .update(`${cabecalho}.${claims}`)
            .verify(CHAVE_PUBLICA, Buffer.from(assinatura, 'base64url')),
    };
}

describe('planilhasConfiguradas', () => {
    beforeEach(() => stubGoogleEnv());
    afterEach(() => vi.unstubAllEnvs());

    it('conta, chave e ambiente presentes ⇒ true', () => {
        expect(planilhasConfiguradas()).toBe(true);
        vi.stubEnv('SHEETS_ENV', 'prod');
        expect(planilhasConfiguradas()).toBe(true);
    });

    it.each(['GOOGLE_PLANILHAS_EMAIL', 'GOOGLE_PLANILHAS_TOKEN', 'SHEETS_ENV'])('sem %s ⇒ false', (nome) => {
        vi.stubEnv(nome, '');
        expect(planilhasConfiguradas()).toBe(false);
    });

    it('valor só de espaços conta como ausente', () => {
        vi.stubEnv('GOOGLE_PLANILHAS_TOKEN', '   ');
        expect(planilhasConfiguradas()).toBe(false);
    });

    it.each(['production', 'PROD', 'sandbox'])('SHEETS_ENV "%s" não é prod nem staging ⇒ false (sem default)', (valor) => {
        vi.stubEnv('SHEETS_ENV', valor);
        expect(planilhasConfiguradas()).toBe(false);
    });
});

describe('tokenDoGoogle', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        stubGoogleEnv();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('assina um JWT RS256 com os claims certos e a assinatura confere com a chave pública', async () => {
        const google = mockGoogle();
        const antes = Math.floor(Date.now() / 1000);

        const token = await tokenDoGoogle(prazoFolgado());

        expect(token).toBe('google-token');
        expect(google.tokens()).toHaveLength(1);
        const [chamada] = google.tokens();
        expect(chamada.url).toBe(URL_DO_TOKEN);
        expect(chamada.method).toBe('POST');
        expect(chamada.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

        const { corpo, cabecalho, claims, assinaturaConfere } = assertionEnviada(google);
        expect(corpo.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(cabecalho).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(claims).toMatchObject({
            iss: EMAIL_DA_CONTA,
            scope: 'https://www.googleapis.com/auth/spreadsheets',
            aud: 'https://oauth2.googleapis.com/token',
        });
        expect(claims.iat).toBeGreaterThanOrEqual(antes);
        expect(claims.iat).toBeLessThanOrEqual(antes + 5);
        expect(claims.exp).toBe(claims.iat + 3600);
        expect(assinaturaConfere).toBe(true);
    });

    it('guarda o token em cache e não pede outro enquanto vale', async () => {
        const google = mockGoogle();

        await tokenDoGoogle(prazoFolgado());
        await tokenDoGoogle(prazoFolgado());
        await tokenDoGoogle(prazoFolgado());

        expect(google.tokens()).toHaveLength(1);
    });

    it('pede outro 60 s antes de o token expirar (o `expires_in` manda)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
        const google = mockGoogle({ token: { json: { access_token: 't1', expires_in: 3600 } } });

        await tokenDoGoogle();
        vi.setSystemTime(new Date('2026-10-30T12:58:00Z')); // 58 min: ainda vale (faltam 2 min)
        await tokenDoGoogle();
        expect(google.tokens()).toHaveLength(1);

        vi.setSystemTime(new Date('2026-10-30T12:59:30Z')); // faltam 30 s: dentro da margem
        await tokenDoGoogle();
        expect(google.tokens()).toHaveLength(2);
    });

    it('duas chamadas ao mesmo tempo (as duas linhas do reembolso do Bot) dividem UM pedido de token', async () => {
        const google = mockGoogle();

        const [a, b] = await Promise.all([tokenDoGoogle(prazoFolgado()), tokenDoGoogle(prazoFolgado())]);

        expect(a).toBe(b);
        expect(google.tokens()).toHaveLength(1);
    });

    it('invalidarTokenDoGoogle faz o próximo pedido buscar outro (o Google respondeu 401)', async () => {
        const google = mockGoogle();
        await tokenDoGoogle(prazoFolgado());

        invalidarTokenDoGoogle();
        await tokenDoGoogle(prazoFolgado());

        expect(google.tokens()).toHaveLength(2);
    });

    describe('a chave chega de três jeitos', () => {
        const miolo = CHAVE_PRIVADA_PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
        const formatos: Array<[string, string]> = [
            ['PEM com quebra de linha de verdade', CHAVE_PRIVADA_PEM],
            ['com `\\n` escrito (o que sai do JSON da conta)', CHAVE_PRIVADA_PEM.trim().replace(/\n/g, '\\n')],
            ['tudo numa linha só, separado por espaço', CHAVE_PRIVADA_PEM.trim().replace(/\n/g, ' ')],
            ['entre aspas, como um .env às vezes guarda', `"${CHAVE_PRIVADA_PEM.trim().replace(/\n/g, '\\n')}"`],
            ['só o miolo, sem os marcadores', miolo],
        ];

        it.each(formatos)('%s', async (_nome, valor) => {
            vi.stubEnv('GOOGLE_PLANILHAS_TOKEN', valor);
            const google = mockGoogle();

            await expect(tokenDoGoogle(prazoFolgado())).resolves.toBe('google-token');

            expect(assertionEnviada(google).assinaturaConfere).toBe(true);
        });
    });

    describe('erros', () => {
        /** Nada da chave nem do JWT pode sobrar em mensagem de erro. */
        function naoVaza(erro: unknown, jwt?: string) {
            const texto = String((erro as Error).message);
            const miolo = CHAVE_PRIVADA_PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
            expect(texto).not.toContain(miolo.slice(0, 40));
            expect(texto).not.toContain(miolo.slice(-40));
            expect(texto).not.toContain('PRIVATE KEY');
            if (jwt) expect(texto).not.toContain(jwt);
        }

        it('sem a chave ⇒ GoogleAuthError, e nenhuma requisição', async () => {
            vi.stubEnv('GOOGLE_PLANILHAS_TOKEN', '');
            const google = mockGoogle();

            const erro = await tokenDoGoogle(prazoFolgado()).catch((e) => e);

            expect(erro).toBeInstanceOf(GoogleAuthError);
            expect(erro.message).toContain('GOOGLE_PLANILHAS_TOKEN');
            expect(google.chamadas).toHaveLength(0);
        });

        it('sem a conta ⇒ GoogleAuthError, e nenhuma requisição', async () => {
            vi.stubEnv('GOOGLE_PLANILHAS_EMAIL', '');
            const google = mockGoogle();

            const erro = await tokenDoGoogle(prazoFolgado()).catch((e) => e);

            expect(erro).toBeInstanceOf(GoogleAuthError);
            expect(erro.message).toContain('GOOGLE_PLANILHAS_EMAIL');
            expect(google.chamadas).toHaveLength(0);
        });

        it('chave ilegível ⇒ mensagem nossa, sem nada do que veio na env, e nenhuma requisição', async () => {
            vi.stubEnv('GOOGLE_PLANILHAS_TOKEN', '-----BEGIN PRIVATE KEY-----\nSEGREDO-QUE-NAO-PODE-VAZAR\n-----END PRIVATE KEY-----');
            const google = mockGoogle();

            const erro = await tokenDoGoogle(prazoFolgado()).catch((e) => e);

            expect(erro).toBeInstanceOf(GoogleAuthError);
            expect(erro.message).toContain('PKCS#8');
            expect(erro.message).not.toContain('SEGREDO-QUE-NAO-PODE-VAZAR');
            naoVaza(erro);
            expect(google.chamadas).toHaveLength(0);
        });

        it('o Google recusa (invalid_grant) ⇒ GoogleAuthError com o status e o motivo, sem a chave nem o JWT', async () => {
            const google = mockGoogle({
                token: { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } },
            });

            const erro = await tokenDoGoogle(prazoFolgado()).catch((e) => e);

            expect(erro).toBeInstanceOf(GoogleAuthError);
            expect(erro.status).toBe(400);
            expect(erro.message).toContain('HTTP 400');
            expect(erro.message).toContain('invalid_grant');
            naoVaza(erro, assertionEnviada(google).jwt);
        });

        it('resposta sem access_token ⇒ GoogleAuthError', async () => {
            mockGoogle({ token: { json: { expires_in: 3600 } } });

            const erro = await tokenDoGoogle(prazoFolgado()).catch((e) => e);

            expect(erro).toBeInstanceOf(GoogleAuthError);
            expect(erro.message).toContain('access_token');
        });

        it('rede caiu ⇒ GoogleAuthError, sem a chave nem o JWT', async () => {
            const google = mockGoogle({ token: { rede: new Error('ECONNRESET') } });

            const erro = await tokenDoGoogle(prazoFolgado()).catch((e) => e);

            expect(erro).toBeInstanceOf(GoogleAuthError);
            expect(erro.message).toContain('ECONNRESET');
            naoVaza(erro, assertionEnviada(google).jwt);
        });

        it('prazo já esgotado ⇒ GoogleAuthError, sem chamar o Google', async () => {
            const google = mockGoogle();

            const erro = await tokenDoGoogle(Date.now() - 1).catch((e) => e);

            expect(erro).toBeInstanceOf(GoogleAuthError);
            expect(google.chamadas).toHaveLength(0);
        });

        it('uma falha não fica em cache: a próxima chamada tenta de novo', async () => {
            mockGoogle({ token: { status: 503 } });
            await expect(tokenDoGoogle(prazoFolgado())).rejects.toBeInstanceOf(GoogleAuthError);
            vi.restoreAllMocks();

            const google = mockGoogle();
            await expect(tokenDoGoogle(prazoFolgado())).resolves.toBe('google-token');
            expect(google.tokens()).toHaveLength(1);
        });
    });
});
