import { linhaDoIntervalo } from './a1';
import { GoogleAuthError, invalidarTokenDoGoogle, tokenDoGoogle } from './googleAuth';
import type { PlanilhaDestino, SheetCell } from './types';

/**
 * Acesso ao Google Sheets a partir do SERVIDOR (ADR-010) — as mesmas chamadas REST que os nodes "HTTP Request"
 * do n8n faziam (`values:append`), sem biblioteca: `fetch` com Bearer token da conta de serviço
 * (`googleAuth.ts`).
 *
 * ⚠️ **Server-only.** NÃO é exportado pelo barrel `shared/lib/sheets/index.ts`, pela mesma razão do
 * `shared/lib/cosmos/server.ts`: o token vem de segredo (`GOOGLE_PLANILHAS_*`) e o barrel pode ser importado por
 * página. Importe pelo caminho completo (`@shared/lib/sheets/server`).
 *
 * **Toda falha sai como `SheetsError`**, que diz a quem chama a única coisa que importa para a resposta: a
 * linha **com certeza não** foi gravada (`incerto: false`) ou **talvez** tenha sido (`incerto: true` —
 * a requisição saiu e a resposta não voltou).
 */

const LOG = '[Google Sheets]';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/*
 * A retentativa mora aqui, numa camada só: cada chamada ao Google repete o que vale repetir, e quem chama não repete de
 * novo o mesmo erro. A única exceção é o append, que não repete nada sozinho: quem o repete é o laço do `gravarLinha.ts`,
 * conferindo antes, com a mesma régua de espera (`esperaAntesDeRepetir`).
 *
 * - **Rede e `5xx`:** até 2 tentativas, 500 ms entre elas (o n8n tinha `retryOnFail` nos appends; aqui é a mesma ideia,
 *   mais curta).
 * - **Cota (`429`):** até 4 tentativas, com espera exponencial e jitter de ±25% (~1 s, ~2 s, ~4 s). A conta de serviço é
 *   uma só para as 9 marcas e todos os ambientes (60 leituras e 60 escritas por minuto), e repetir logo em seguida só
 *   gasta a cota que falta. Com `retentarCota: false` (a lista, que é informativa) a cota estourada falha na hora.
 * - **`Retry-After`**, quando o Google o manda, é o piso da espera.
 * - **Sempre dentro do `prazo`:** a espera que não deixa pelo menos `MIN_JANELA_RETENTATIVA_MS` para a tentativa
 *   seguinte não é feita, e a chamada falha com o último erro.
 */
const MAX_TENTATIVAS = 2;
const BACKOFF_MS = 500;
const MAX_TENTATIVAS_DA_COTA = 4;
const ESPERA_DA_COTA_MS = 1_000;
const JITTER_DA_COTA = 0.25;

/** Não vale retentar se não sobra pelo menos isto do prazo depois da espera. */
const MIN_JANELA_RETENTATIVA_MS = 1_500;

export class SheetsError extends Error {
    constructor(
        message: string,
        /** `true` = a requisição pode ter chegado ao Google (timeout, rede caindo no meio) */
        readonly incerto: boolean,
        readonly status?: number,
        /** O `Retry-After` da resposta, em ms, quando o Google mandou um: o mínimo a esperar antes de repetir */
        readonly retryAfterMs?: number
    ) {
        super(message);
        this.name = 'SheetsError';
    }
}

/** O `Retry-After` em ms (em segundos ou como data HTTP), ou `undefined` quando não veio ou não dá para ler. */
export function lerRetryAfter(valor: string | null | undefined): number | undefined {
    const texto = valor?.trim();
    if (!texto) return undefined;
    if (/^\d+$/.test(texto)) return Number(texto) * 1_000;
    const quando = Date.parse(texto);
    return Number.isNaN(quando) ? undefined : Math.max(0, quando - Date.now());
}

/**
 * A espera antes de repetir uma chamada que a cota recusou, sendo `tentativa` a que acabou de falhar (1, 2, 3…): ~1 s,
 * ~2 s, ~4 s, com jitter de ±25% para as funções que esbarraram juntas na cota não voltarem juntas.
 */
export function esperaDaCota(tentativa: number, aleatorio: () => number = Math.random): number {
    const base = ESPERA_DA_COTA_MS * 2 ** (tentativa - 1);
    return Math.round(base * (1 - JITTER_DA_COTA + 2 * JITTER_DA_COTA * aleatorio()));
}

/**
 * Quanto esperar antes de repetir o que falhou com `erro` na `tentativa` (1, 2, 3…): a escada da cota no `429`, os
 * 500 ms de sempre no resto (rede, `5xx`, `401`), e nunca menos que o `Retry-After` do Google. É a régua do
 * `chamarGoogle` e a do laço do `gravarLinha.ts`, o único que repete o append.
 */
export function esperaAntesDeRepetir(erro: SheetsError | undefined, tentativa: number): number {
    const propria = erro?.status === 429 ? esperaDaCota(tentativa) : BACKOFF_MS;
    return Math.max(propria, erro?.retryAfterMs ?? 0);
}

/** Nome da aba no A1, sempre entre aspas: os nomes têm espaço e acento ("Respostas ao formulário 1"). */
export function abaA1(aba: string): string {
    return `'${aba.replace(/'/g, "''")}'`;
}

function espera(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function mensagemDoGoogle(corpo: unknown): string {
    const erro = (corpo as { error?: unknown } | null)?.error;
    if (typeof erro === 'string') return erro;
    const mensagem = (erro as { message?: unknown } | undefined)?.message;
    return typeof mensagem === 'string' ? mensagem : '';
}

/**
 * Uma chamada ao Google com prazo e a retentativa descrita no topo do arquivo.
 *
 * Por padrão retenta `5xx`, a cota (`429`, em escada; não com `retentarCota: false`) e, só quando `retentarRede`,
 * falha de rede. Escrita **não** retenta falha de rede: a primeira tentativa pode ter gravado, e a segunda duplicaria a
 * linha. `retentarStatus` troca a regra dos status — o `anexarLinha` a restringe, porque um `5xx`/`504` pode vir
 * DEPOIS de o Google gravar a linha. `4xx` (fora o `429`) nunca retenta — permissão e intervalo inválido não melhoram
 * tentando.
 *
 * O corpo é lido com o relógio ainda armado, pela mesma razão do `fetchWithTimeout` do Cosmos: resposta que
 * entrega os headers e trava no corpo não pode ficar fora de qualquer timeout.
 */
async function chamarGoogle<T>(
    url: string,
    init: RequestInit,
    prazo: number,
    opcoes: {
        rotulo: string;
        retentarRede: boolean;
        retentarStatus?: (status: number) => boolean;
        /** Esperar a cota (`429`) em escada. `false`: a cota estourada falha na hora. Padrão: `true`. */
        retentarCota?: boolean;
    }
): Promise<T> {
    const retentarCota = opcoes.retentarCota ?? true;
    const retentarStatus = opcoes.retentarStatus ?? ((status: number) => (status === 429 ? retentarCota : status >= 500));
    let ultimoErro: SheetsError | null = null;

    for (let tentativa = 1; ; tentativa++) {
        const restante = prazo - Date.now();
        if (restante <= 0) break;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), restante);
        let erro: SheetsError;
        let repetir: boolean;
        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            const corpo: unknown = await res.json().catch((falha: unknown) => {
                if (falha instanceof Error && falha.name === 'AbortError') throw falha;
                return null;
            });

            if (res.ok) return corpo as T;

            if (res.status === 401) invalidarTokenDoGoogle();
            erro = new SheetsError(
                `${LOG} ${opcoes.rotulo}: HTTP ${res.status} ${mensagemDoGoogle(corpo)}`.trim(),
                // 5xx pode ter vindo depois de o Google gravar (um gateway devolve 502/504 com a escrita feita).
                res.status >= 500,
                res.status,
                lerRetryAfter(res.headers.get('retry-after'))
            );
            repetir = retentarStatus(res.status);
        } catch (falha) {
            const causa = falha instanceof Error && falha.name === 'AbortError'
                ? 'prazo esgotado'
                : (falha instanceof Error ? falha.message : 'falha de rede');
            erro = new SheetsError(`${LOG} ${opcoes.rotulo}: ${causa}`, true);
            repetir = opcoes.retentarRede;
        } finally {
            clearTimeout(timer);
        }

        ultimoErro = erro;
        const limite = erro.status === 429 ? MAX_TENTATIVAS_DA_COTA : MAX_TENTATIVAS;
        const aguardar = esperaAntesDeRepetir(erro, tentativa);
        if (!repetir || tentativa >= limite || prazo - Date.now() <= aguardar + MIN_JANELA_RETENTATIVA_MS) break;
        console.warn(`${erro.message} — retentando em ${aguardar} ms (${tentativa}/${limite})`);
        await espera(aguardar);
    }

    throw ultimoErro ?? new SheetsError(`${LOG} ${opcoes.rotulo}: prazo esgotado antes de chamar o Google`, false);
}

/**
 * O access token da conta de serviço. Falha aqui é sempre **certa** (`incerto: false`): sem token nenhuma
 * escrita chegou a sair.
 */
async function obterToken(prazo: number): Promise<string> {
    try {
        return await tokenDoGoogle(prazo);
    } catch (erro) {
        if (erro instanceof GoogleAuthError) throw new SheetsError(erro.message, false, erro.status);
        throw erro;
    }
}

/**
 * Lê uma aba a partir de A1. `ate` limita as colunas (`A:ate`); `intervalo` troca o recorte inteiro (ex.: `1:1`
 * para só o cabeçalho, `AR:AR` para uma coluna) — nada de ler a aba toda quando só uma parte importa.
 *
 * Por padrão vem **sem formatação** (`UNFORMATTED_VALUE` + serial de data), que é o que dá para comparar sem
 * depender da máscara da coluna. `formatado: true` pede `FORMATTED_VALUE` (explícito, em vez de confiar no
 * padrão do Google) e devolve o texto como aparece na tela: a data de execução chega como `30/10/2026`, não
 * como o número serial. `retentarCota: false` não espera a cota (ver o topo do arquivo).
 */
export async function lerAba(
    spreadsheetId: string,
    aba: string,
    prazo: number,
    opcoes: { ate?: string; formatado?: boolean; intervalo?: string; retentarCota?: boolean } = {}
): Promise<SheetCell[][]> {
    const token = await obterToken(prazo);
    const recorte = opcoes.intervalo ?? (opcoes.ate ? `A:${opcoes.ate}` : null);
    const intervalo = recorte ? `${abaA1(aba)}!${recorte}` : abaA1(aba);
    const query = opcoes.formatado
        ? `?${new URLSearchParams({ valueRenderOption: 'FORMATTED_VALUE' })}`
        : `?${new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' })}`;
    const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(intervalo)}${query}`;

    const corpo = await chamarGoogle<{ values?: SheetCell[][] } | null>(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, prazo, { rotulo: `leitura de "${aba}"`, retentarRede: true, retentarCota: opcoes.retentarCota });

    return corpo?.values ?? [];
}

/**
 * Lê vários recortes da mesma aba numa requisição só (`values:batchGet`): para a cota do Google é **uma** leitura, não
 * uma por recorte. É como a linha de um caso é achada (`casoNaPlanilha.ts`): as colunas do carimbo e do pedido vêm
 * juntas.
 *
 * Sem formatação, como o `lerAba` por padrão (`UNFORMATTED_VALUE` + serial de data), e com a mesma retentativa (rede,
 * `5xx` e, em escada, a cota; `retentarCota: false` não espera a cota). Devolve uma matriz por recorte, na ordem pedida
 * (recorte vazio ⇒ `[]`). Resposta sem um intervalo por recorte ⇒ `SheetsError`: tratar a falta como coluna vazia
 * faria a conferência "não achar" uma linha que está lá, e a gravação a duplicaria.
 *
 * @param recortes A1 sem a aba (ex.: `A:A`, `G:G`)
 */
export async function lerIntervalos(
    spreadsheetId: string,
    aba: string,
    recortes: string[],
    prazo: number,
    opcoes: { retentarCota?: boolean } = {}
): Promise<SheetCell[][][]> {
    if (recortes.length === 0) return [];
    const token = await obterToken(prazo);
    // `encodeURIComponent` (o espaço vira `%20`) em vez do `URLSearchParams` (que o troca por `+`): o nome da aba tem
    // espaço e acento, e assim ele chega ao Google sem depender de como o `+` é lido.
    const query = [
        ...recortes.map((recorte) => `ranges=${encodeURIComponent(`${abaA1(aba)}!${recorte}`)}`),
        'valueRenderOption=UNFORMATTED_VALUE',
        'dateTimeRenderOption=SERIAL_NUMBER',
    ].join('&');
    const url = `${SHEETS_API}/${spreadsheetId}/values:batchGet?${query}`;

    const corpo = await chamarGoogle<{ valueRanges?: ({ values?: SheetCell[][] } | null)[] } | null>(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, prazo, { rotulo: `leitura de "${aba}" (${recortes.join(', ')})`, retentarRede: true, retentarCota: opcoes.retentarCota });

    const intervalos = corpo?.valueRanges;
    if (!Array.isArray(intervalos) || intervalos.length !== recortes.length) {
        throw new SheetsError(`${LOG} leitura de "${aba}": a resposta não trouxe os ${recortes.length} intervalos pedidos`, false);
    }
    return intervalos.map((intervalo) => intervalo?.values ?? []);
}

/**
 * Como o Google lê o que se escreve: `RAW` grava o valor como veio (o texto que o agente digitou não vira fórmula
 * nem data); `USER_ENTERED` o interpreta como se fosse digitado na célula (`30/10/2026` vira data, `59.9` vira
 * número com o formato da coluna).
 */
export type EntradaDosValores = 'RAW' | 'USER_ENTERED';

/**
 * Reescreve células avulsas (`values:batchUpdate`). Ao contrário do append, repetir é inofensivo — grava os
 * mesmos valores nas mesmas células —, então falha de rede é retentada. `RAW` por padrão, de propósito: o texto
 * que o agente digitou não vira fórmula nem data. Quem precisa de data ou número de verdade pede `USER_ENTERED`,
 * só para essas células (a opção vale para a chamada inteira).
 *
 * @param celulas `intervalo` em A1 com a aba (ex.: `'Respostas ao formulário'!J57`)
 */
export async function atualizarCelulas(
    spreadsheetId: string,
    celulas: Array<{ intervalo: string; valor: SheetCell }>,
    prazo: number,
    opcoes: { entrada?: EntradaDosValores } = {}
): Promise<void> {
    const token = await obterToken(prazo);
    console.log(`${LOG} Atualizando ${celulas.length} célula(s) em ${spreadsheetId}`);
    await chamarGoogle(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({
            valueInputOption: opcoes.entrada ?? 'RAW',
            data: celulas.map(({ intervalo, valor }) => ({ range: intervalo, values: [[valor]] })),
        }),
    }, prazo, { rotulo: 'atualização de células', retentarRede: true });
}

/**
 * Quando o `anexarLinha` repete o `values:append` sozinho:
 * - `padrao` — em `5xx` (o que o n8n fazia) e na cota (`429`, em escada);
 * - `nenhuma` — nunca: quem chama repete, e confere antes se a linha já entrou (`gravarLinha.ts`: um `5xx`/`504` pode
 *   vir depois de o Google gravar, e repetir às cegas duplicaria a linha). O `Retry-After` vai no `SheetsError`, para
 *   quem repete esperar o que o Google pediu.
 */
export type RetentativaDoAppend = 'padrao' | 'nenhuma';

const STATUS_RETENTAVEL_DO_APPEND: Record<RetentativaDoAppend, ((status: number) => boolean) | undefined> = {
    padrao: undefined,
    nenhuma: () => false,
};

/**
 * Grava UMA linha no fim da tabela — o `values:append` com `USER_ENTERED` que os nodes do n8n faziam. Devolve o número
 * da linha gravada (do `updates.updatedRange` da resposta), ou `null` se a resposta não o trouxe: é por ele que as
 * fórmulas da linha são escritas depois (`formulas.ts`).
 */
export async function anexarLinha(
    destino: PlanilhaDestino,
    linha: SheetCell[],
    prazo: number,
    opcoes: { retentar?: RetentativaDoAppend } = {}
): Promise<number | null> {
    const token = await obterToken(prazo);
    const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });
    if (destino.inserirLinhas) params.set('insertDataOption', 'INSERT_ROWS');
    const intervalo = `${abaA1(destino.aba)}!${destino.intervalo}`;
    const url = `${SHEETS_API}/${destino.spreadsheetId}/values/${encodeURIComponent(intervalo)}:append?${params}`;

    console.log(`${LOG} Append em ${destino.spreadsheetId} / "${destino.aba}" (${linha.length} colunas)`);
    const corpo = await chamarGoogle<{ updates?: { updatedRange?: string } } | null>(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ majorDimension: 'ROWS', values: [linha] }),
    }, prazo, {
        rotulo: `append em "${destino.aba}"`,
        retentarRede: false,
        retentarStatus: STATUS_RETENTAVEL_DO_APPEND[opcoes.retentar ?? 'padrao'],
    });
    return linhaDoIntervalo(corpo?.updates?.updatedRange);
}
