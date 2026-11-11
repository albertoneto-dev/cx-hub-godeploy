/**
 * Leitura do Data Mart pela API do Metabase: SQL nativo em `POST /api/dataset`, a partir do SERVIDOR.
 *
 * Mesmo desenho do painel de chargeback (`chargeback-webui/server/metabase.ts`): a chave é do CX Hub e vai no
 * header `X-API-KEY`, e o grupo dela precisa de permissão de SQL nativo no banco. O `/api/dataset` responde
 * 202 mesmo quando a consulta falha — o erro vem no corpo —, por isso o `status` do corpo é conferido, e não
 * só o HTTP.
 *
 * Só leitura, na réplica: `METABASE_DATABASE_ID` é o "Data Mart" (43 em metabase.gobeaute.com.br). A réplica
 * pode ficar minutos atrás do primário, então uma linha gravada agora pode ainda não aparecer.
 *
 * ⚠️ **Server-only**: lê `METABASE_API_KEY`. Só código de rota importa este módulo.
 */

/** Teto de cada consulta, com o corpo lido dentro do mesmo relógio. */
export const METABASE_TIMEOUT_MS = 5_000;

export class MetabaseError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'MetabaseError';
    }

    /**
     * Vale tentar de novo: rede, timeout, 5xx, 429 e consulta interrompida. Chave recusada, falta de permissão
     * e SQL, coluna ou tabela errados não mudam na segunda tentativa.
     */
    get transitorio(): boolean {
        if (this.status >= 400 && this.status < 500 && this.status !== 429) return false;
        return !/does not exist|n[aã]o existe|permission|permiss|syntax|sintaxe/i.test(this.message);
    }
}

/** As três variáveis juntas. Faltou uma ⇒ a leitura fica desligada (ver `agendarAtualizacaoNaGold`). */
export function metabaseConfigurado(): boolean {
    return Boolean(process.env.METABASE_URL && process.env.METABASE_API_KEY && process.env.METABASE_DATABASE_ID);
}

/** Literal de texto para SQL montado no código: aspas dobradas, NUL recusado. */
export function literalSql(valor: string): string {
    if (valor.includes('\0')) throw new Error('valor com NUL');
    return `'${valor.replace(/'/g, "''")}'`;
}

interface RespostaDataset {
    status?: string;
    error?: unknown;
    data?: { rows?: unknown };
}

/**
 * Roda um SELECT no Data Mart e devolve as linhas (`data.rows`). Uma tentativa só: quem chama decide se
 * retenta, pelo `MetabaseError.transitorio`. Nunca lança outra coisa além de `MetabaseError`.
 */
export async function consultarDataMart(sql: string): Promise<unknown[][]> {
    const url = (process.env.METABASE_URL ?? '').replace(/\/$/, '');
    const chave = process.env.METABASE_API_KEY ?? '';
    const banco = Number(process.env.METABASE_DATABASE_ID);
    if (!url || !chave || !Number.isInteger(banco)) {
        throw new MetabaseError(400, 'Metabase sem configuração: METABASE_URL, METABASE_API_KEY e METABASE_DATABASE_ID');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), METABASE_TIMEOUT_MS);
    let status: number;
    let texto: string;
    try {
        const res = await fetch(`${url}/api/dataset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': chave },
            body: JSON.stringify({ database: banco, type: 'native', native: { query: sql } }),
            signal: controller.signal,
        });
        status = res.status;
        texto = await res.text();
    } catch (erro) {
        if (erro instanceof Error && erro.name === 'AbortError') {
            throw new MetabaseError(0, `Metabase não respondeu em ${METABASE_TIMEOUT_MS / 1000}s`);
        }
        throw new MetabaseError(0, `Metabase inalcançável: ${erro instanceof Error ? erro.message : String(erro)}`);
    } finally {
        clearTimeout(timer);
    }

    if (status < 200 || status >= 300) {
        // Página de erro HTML (proxy na frente do Metabase) vira só o <title>.
        const resumo = /<title>([^<]*)<\/title>/i.exec(texto)?.[1]?.trim() ?? texto.slice(0, 300);
        throw new MetabaseError(status, `Metabase HTTP ${status}: ${resumo}`);
    }

    let corpo: RespostaDataset;
    try {
        corpo = JSON.parse(texto) as RespostaDataset;
    } catch {
        throw new MetabaseError(status, 'resposta do Metabase não é JSON');
    }
    if (corpo.status === 'failed' || corpo.error) {
        throw new MetabaseError(status, String(corpo.error ?? 'consulta falhou').slice(0, 500));
    }
    const linhas = corpo.data?.rows;
    if (!Array.isArray(linhas)) {
        throw new MetabaseError(status, 'resposta do Metabase sem data.rows');
    }
    return linhas as unknown[][];
}
