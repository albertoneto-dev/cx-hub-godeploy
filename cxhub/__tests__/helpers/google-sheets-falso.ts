import { vi } from 'vitest';
import type { SupportedBrand } from '@shared/lib/constants';
import type { FluxoPlanilha, SheetCell } from '@shared/lib/sheets';
import { COLUNAS_DO_CASO } from '@shared/lib/sheets/casoNaPlanilha';
import { intervaloDaLeitura, intervalosDoLote, responder, URL_DO_TOKEN } from './google-sheets-mock';

/**
 * Um Google Sheets em memória para os testes da idempotência (ADR-010) e da gestão do reembolso: lê o cabeçalho
 * (`1:1`), colunas inteiras (carimbo e pedido, juntas num `values:batchGet` ou uma por vez) e uma linha inteira, anexa
 * linhas e reescreve células (`values:batchUpdate`) — o suficiente para provar que repetir uma gravação não duplica a
 * linha e que a gestão escreve data e número com o tipo certo. **Nenhum teste toca o Google de verdade**: é o `fetch`
 * que é substituído.
 */

/** O que o Google fez com um append: gravou ou não, e como respondeu. */
export type DesfechoDoAppend =
    /**
     * Resposta HTTP. `gravou: true` grava a linha MESMO com status de erro: é o "5xx/504 depois de gravar" (um gateway
     * responde 502/504 com a escrita já feita) — o caso em que repetir o append às cegas duplica a linha. `headers`
     * leva, por exemplo, o `Retry-After` de um 429.
     */
    | { status: number; json?: unknown; gravou?: boolean; headers?: Record<string, string> }
    /** Gravou, mas a resposta se perdeu (rede caiu depois): é o caso que a conferência da linha do caso existe para pegar */
    | { redeDepoisDeGravar: true }
    | { redeSemGravar: true };

/** Um `values:batchUpdate` recebido: como o Google deveria ler os valores e o que foi escrito, célula a célula. */
export interface AtualizacaoRecebida {
    valueInputOption: string;
    celulas: { range: string; valor: SheetCell }[];
}

export interface AbaFalsa {
    cabecalho: SheetCell[];
    /** As linhas de dados: o índice 0 é a linha 2 da planilha (a 1 é o cabeçalho) */
    linhas: SheetCell[][];
    /**
     * Como o Google mostra uma célula que não é texto (`${linha}:${coluna}`, linha 1-based e coluna 0-based): a data lida
     * com `FORMATTED_VALUE` chega como `30/10/2026`, e com `UNFORMATTED_VALUE`, como o número serial que está em `linhas`.
     */
    formatados: Record<string, string>;
    /** Desfechos dos próximos appends, consumidos em ordem; sem mais nenhum, grava */
    appends: DesfechoDoAppend[];
    /** Os `values:batchUpdate` recebidos, na ordem */
    atualizacoes: AtualizacaoRecebida[];
    /** Quantas linhas inteiras foram lidas (`N:N`) */
    leiturasDeLinha: number;
    /** Enquanto `true`, a leitura das colunas do caso (carimbo e pedido) cai com erro de rede */
    leituraDoIdFalha: boolean;
    /** Liga `leituraDoIdFalha` assim que o primeiro append acontece */
    leituraFalhaAposAppend: boolean;
    /**
     * Requisições, que é o que a cota do Google conta: `cabecalho` (a linha 1), `colunas` (as que leram as colunas do
     * caso — o carimbo e o pedido vêm juntos, num `values:batchGet`, então cada uma conta uma vez) e `appends`.
     */
    contagem: { cabecalho: number; colunas: number; appends: number };
    /** Os recortes de cada leitura das colunas do caso, na ordem (`['A:A', 'G:G']`) */
    colunasLidas: string[][];
}

export function criarAbaFalsa(cabecalho: SheetCell[], linhas: SheetCell[][] = []): AbaFalsa {
    return {
        cabecalho,
        linhas,
        formatados: {},
        appends: [],
        atualizacoes: [],
        leiturasDeLinha: 0,
        leituraDoIdFalha: false,
        leituraFalhaAposAppend: false,
        contagem: { cabecalho: 0, colunas: 0, appends: 0 },
        colunasLidas: [],
    };
}

/** O número serial (dias desde 30/12/1899) de uma data `dd/mm/aaaa`. */
export function serialDaData(data: string): number {
    const [dia, mes, ano] = data.split('/').map(Number);
    return (Date.UTC(ano, mes - 1, dia) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const idDaPlanilha = (url: string): string => url.match(/\/spreadsheets\/([^/]+)\//)?.[1] ?? '';
const indiceDaColuna = (letras: string): number => [...letras].reduce((acc, letra) => acc * 26 + letra.charCodeAt(0) - 64, 0) - 1;

const DATA_BR = /^\d{2}\/\d{2}\/\d{4}$/;

/** A linha e a coluna de uma célula do A1 (a linha 7 da coluna F é `F7`: linha 7, coluna 5). */
function celulaDoRange(range: string): { linha: number; coluna: number } {
    const [, letras, linha] = range.match(/!([A-Z]+)(\d+)$/) ?? [];
    if (!letras) throw new Error(`Range inesperado no teste: ${range}`);
    return { linha: Number(linha), coluna: indiceDaColuna(letras) };
}

/** O valor da célula lido pelo Google: texto de tela com `FORMATTED_VALUE`, o valor guardado com `UNFORMATTED_VALUE`. */
function lerCelula(aba: AbaFalsa, linha: number, coluna: number, formatado: boolean): SheetCell {
    const guardado = (linha === 1 ? aba.cabecalho : (aba.linhas[linha - 2] ?? []))[coluna] ?? null;
    if (!formatado) return guardado;
    return aba.formatados[`${linha}:${coluna}`] ?? guardado;
}

/** O que a escrita faz com o valor: `USER_ENTERED` interpreta data e número; `RAW` guarda como veio. */
function escreverCelula(aba: AbaFalsa, linha: number, coluna: number, valor: SheetCell, entrada: string): void {
    const destino = aba.linhas[linha - 2];
    if (!destino) throw new Error(`Linha ${linha} inexistente no teste`);
    while (destino.length <= coluna) destino.push(null);

    const chave = `${linha}:${coluna}`;
    delete aba.formatados[chave];
    if (entrada === 'USER_ENTERED' && typeof valor === 'string' && DATA_BR.test(valor)) {
        destino[coluna] = serialDaData(valor);
        aba.formatados[chave] = valor;
    } else if (entrada === 'USER_ENTERED' && typeof valor === 'number') {
        destino[coluna] = valor;
        aba.formatados[chave] = valor.toFixed(2).replace('.', ',');
    } else {
        destino[coluna] = valor;
    }
}

function instalar(abaDe: (spreadsheetId: string) => AbaFalsa | undefined): void {
    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith(URL_DO_TOKEN)) return responder({ json: { access_token: 'google-token', expires_in: 3600 } });

        const aba = abaDe(idDaPlanilha(url));
        if (!aba) throw new Error(`Planilha inesperada no teste: ${url}`);

        if (url.includes(':append')) {
            aba.contagem.appends++;
            if (aba.leituraFalhaAposAppend) aba.leituraDoIdFalha = true;
            const corpo = JSON.parse(String(init?.body)) as { values: SheetCell[][] };
            const desfecho: DesfechoDoAppend = aba.appends.shift() ?? { status: 200 };
            if ('redeSemGravar' in desfecho) throw new Error('socket hang up');
            if ('redeDepoisDeGravar' in desfecho) {
                aba.linhas.push(corpo.values[0]);
                throw new Error('socket hang up');
            }
            if (desfecho.status < 300 || desfecho.gravou) aba.linhas.push(corpo.values[0]);
            return responder(desfecho);
        }

        if (url.includes('values:batchUpdate')) {
            const corpo = JSON.parse(String(init?.body)) as {
                valueInputOption: string;
                data: { range: string; values: SheetCell[][] }[];
            };
            const celulas = corpo.data.map(({ range, values }) => ({ range, valor: values[0][0] }));
            aba.atualizacoes.push({ valueInputOption: corpo.valueInputOption, celulas });
            for (const { range, valor } of celulas) {
                const { linha, coluna } = celulaDoRange(range);
                escreverCelula(aba, linha, coluna, valor, corpo.valueInputOption);
            }
            return responder({ json: { totalUpdatedCells: celulas.length } });
        }

        // Uma coluna inteira, como o Google a devolve: o recorte `X:X` começa na linha 1, então o cabeçalho vem primeiro.
        const valoresDaColuna = (indice: number): SheetCell[][] =>
            [[aba.cabecalho[indice] ?? ''], ...aba.linhas.map((linha) => [linha[indice] ?? ''])];
        const colunaDoRecorte = (intervalo: string) => intervalo.match(/!([A-Z]+):\1$/)?.[1];

        if (url.includes('values:batchGet')) {
            const intervalos = intervalosDoLote(url);
            const colunas = intervalos.map(colunaDoRecorte);
            if (colunas.some((coluna) => !coluna)) throw new Error(`Lote inesperado no teste: ${intervalos.join(', ')}`);
            aba.contagem.colunas++;
            aba.colunasLidas.push(colunas.map((coluna) => `${coluna}:${coluna}`));
            if (aba.leituraDoIdFalha) throw new Error('ECONNRESET');
            return responder({
                json: {
                    valueRanges: intervalos.map((range, i) => ({
                        range,
                        majorDimension: 'ROWS',
                        values: valoresDaColuna(indiceDaColuna(colunas[i] as string)),
                    })),
                },
            });
        }

        const intervalo = intervaloDaLeitura(url);
        if (intervalo.endsWith('!1:1')) {
            aba.contagem.cabecalho++;
            return responder({ json: { values: [aba.cabecalho] } });
        }
        const coluna = colunaDoRecorte(intervalo);
        if (coluna) {
            aba.contagem.colunas++;
            aba.colunasLidas.push([`${coluna}:${coluna}`]);
            if (aba.leituraDoIdFalha) throw new Error('ECONNRESET');
            return responder({ json: { values: valoresDaColuna(indiceDaColuna(coluna)) } });
        }
        const linha = Number(intervalo.match(/!(\d+):\1$/)?.[1]);
        if (linha) {
            aba.leiturasDeLinha++;
            const formatado = new URL(url).searchParams.get('valueRenderOption') === 'FORMATTED_VALUE';
            const largura = linha === 1 ? aba.cabecalho.length : (aba.linhas[linha - 2]?.length ?? 0);
            const celulas = Array.from({ length: largura }, (_, c) => lerCelula(aba, linha, c, formatado));
            // Como o Google: o fim vazio da linha é cortado, e linha sem nada não traz `values`.
            while (celulas.length > 0 && (celulas[celulas.length - 1] === null || celulas[celulas.length - 1] === '')) celulas.pop();
            return responder({ json: celulas.length > 0 ? { values: [celulas] } : {} });
        }
        throw new Error(`URL inesperada no teste: ${url}`);
    });
}

/** Uma aba só, que responde por qualquer planilha. */
export function instalarGoogleFalso(cabecalho: SheetCell[], linhas: SheetCell[][] = []): AbaFalsa {
    const aba = criarAbaFalsa(cabecalho, linhas);
    instalar(() => aba);
    return aba;
}

/** Uma aba por planilha (`spreadsheetId`): para os fluxos que gravam em duas, como o reembolso do Bot. */
export function instalarGoogleFalsoPorPlanilha(abas: Record<string, AbaFalsa>): void {
    instalar((spreadsheetId) => abas[spreadsheetId]);
}

/**
 * Um cabeçalho que bate com o layout do caso: "Carimbo de data/hora" na coluna do carimbo e "Número do pedido" na do
 * pedido (a conferência de `casoNaPlanilha.ts` exige as duas); as outras colunas têm um nome genérico.
 */
export function cabecalhoDoLayout(fluxo: FluxoPlanilha, marca: SupportedBrand, largura = 12): SheetCell[] {
    const { carimbo, pedido } = COLUNAS_DO_CASO[fluxo][marca];
    return Array.from({ length: Math.max(largura, carimbo + 1, pedido + 1) }, (_, i) =>
        i === carimbo ? 'Carimbo de data/hora' : i === pedido ? 'Número do pedido' : `Coluna ${i}`,
    );
}
