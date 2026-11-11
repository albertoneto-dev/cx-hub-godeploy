import { validateFormDataShape, type FormDataOrigin } from './fetchFormData';

/**
 * Os dados dinâmicos do formulário (marcas, responsáveis, motivos, transportadoras), lidos do app GoDeploy
 * `rota-dados-cxhub` ([ADR-009](docs/decisions/ADR-009-dados-do-formulario-saem-do-n8n-para-o-app-godeploy.md)) —
 * o que o webhook `/dados` do n8n fazia lendo a planilha "Formulários dinâmicos".
 *
 * Servidor a servidor, com duas credenciais: o `x-form-data-token` é do app, e a chave `gdk_` vai no `Authorization`
 * porque é o gateway do GoDeploy que a confere. Sem a chave (o app rodando local, sem gateway), o `Authorization` não
 * vai. O corpo é repassado sem transformação, depois de conferido com a mesma guarda da tela (INV-01).
 *
 * ⚠️ Server-only: lê os segredos. Importado pela rota `/api/resend/data` e pelo `marcasDoBot` (as marcas que a rota do
 * bot aceita, ADR-015).
 */

const LOG = '[Form Data API]';
const ORIGENS: readonly FormDataOrigin[] = ['reenvio', 'reembolso', 'logistica'];

export interface RespostaDosDadosDoFormulario {
    status: number;
    body: unknown;
}

const falha = (status: number, error: string, code?: string): RespostaDosDadosDoFormulario =>
    ({ status, body: code ? { error, code } : { error } });

export async function buscarDadosDoFormulario(origin: string, timeoutMs: number): Promise<RespostaDosDadosDoFormulario> {
    if (!ORIGENS.includes(origin as FormDataOrigin)) {
        return falha(400, `origin inválido: use ${ORIGENS.join(', ')}`);
    }

    const base = (process.env.FORM_DATA_API_URL ?? '').replace(/\/+$/, '');
    const token = process.env.FORM_DATA_API_TOKEN;
    if (!base || !token) {
        console.error(`${LOG} FORM_DATA_API_URL ou FORM_DATA_API_TOKEN ausente do ambiente`);
        return falha(500, 'App de configuração do formulário não configurado');
    }

    const headers: Record<string, string> = { Accept: 'application/json', 'x-form-data-token': token };
    const chave = process.env.FORM_DATA_GODEPLOY_KEY;
    if (chave) headers.Authorization = `Bearer ${chave}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let corpo: unknown;
    try {
        // `manual`: sem a chave certa o gateway responde 302 para a tela de login, que não pode virar "sucesso".
        const res = await fetch(`${base}/api/v1/form-data?origin=${encodeURIComponent(origin)}`, {
            method: 'GET', headers, redirect: 'manual', signal: controller.signal,
        });
        status = res.status;
        corpo = await res.json().catch(() => null);
    } catch (erro) {
        if (erro instanceof Error && erro.name === 'AbortError') {
            console.warn(`${LOG} o app não respondeu em ${timeoutMs}ms`);
            return falha(504, 'O app de configuração do formulário não respondeu a tempo');
        }
        console.error(`${LOG} app inalcançável:`, erro);
        return falha(502, 'App de configuração do formulário inalcançável');
    } finally {
        clearTimeout(timer);
    }

    const code = typeof (corpo as { code?: unknown } | null)?.code === 'string' ? (corpo as { code: string }).code : undefined;

    if ((status >= 300 && status < 400) || status === 401 || status === 403) {
        console.error(`${LOG} credencial do app de configuração recusada (HTTP ${status}${code ? ` ${code}` : ''}): `
            + 'confira FORM_DATA_GODEPLOY_KEY e FORM_DATA_API_TOKEN');
        return falha(502, 'Credencial do app de configuração do formulário recusada', code);
    }
    if (status === 400 || status === 503) {
        // 503 é o app dizendo o que falta (NOT_CONFIGURED, CONFIG_INCOMPLETE, DB_UNAVAILABLE): o `code` vai junto.
        console.error(`${LOG} o app respondeu HTTP ${status}${code ? ` ${code}` : ''}`);
        return falha(status, `App de configuração do formulário: ${code ?? `HTTP ${status}`}`, code);
    }
    if (status < 200 || status >= 300) {
        console.error(`${LOG} o app respondeu HTTP ${status}${code ? ` ${code}` : ''}`);
        return falha(502, `App de configuração do formulário: HTTP ${status}`, code);
    }

    try {
        return { status: 200, body: validateFormDataShape(corpo) };
    } catch (erro) {
        console.error(`${LOG} resposta fora do contrato: ${erro instanceof Error ? erro.message : String(erro)}`);
        return falha(502, 'Resposta do app de configuração do formulário fora do contrato');
    }
}
