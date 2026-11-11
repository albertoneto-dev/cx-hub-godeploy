import type { MarcaCxHub } from '../constants';
import { sendAlert, type AlertContext } from '../alerts/index';
import { LayoutDaPlanilhaError, acharLinhaDoCaso, type CasoNaPlanilha } from './casoNaPlanilha';
import { FORMULAS_DA_LINHA, formulasDaLinha } from './formulas';
import { abaA1, anexarLinha, atualizarCelulas, esperaAntesDeRepetir, SheetsError } from './server';
import { resolverPlanilha } from './targets';
import type { FluxoPlanilha, PlanilhaDestino, SheetCell } from './types';

/**
 * A linha da solicitação na planilha da marca, gravada **depois** da gold e junto dela (ADR-010). Duas peças:
 *
 * - `gravarLinhaNaPlanilha` — UMA linha, idempotente: antes de cada tentativa confere se a linha do caso já está lá
 *   (pelo pedido e pelo carimbo, `casoNaPlanilha.ts`), e **nunca lança**;
 * - `gravarNasPlanilhas` — o que os `process*` chamam: grava as linhas do caso (o reembolso do Bot leva duas) e,
 *   se alguma falhar, deixa a linha **inteira** no log e avisa no Chat. É isso que permite repor à mão sem perder
 *   a solicitação: a gold já a tem, e o agente é orientado a não repetir.
 *
 * ⚠️ Server-only, fora do barrel — lê segredo (via `server.ts`) e manda aviso.
 */

const LOG = '[Planilha]';

/**
 * Quanto a gravação das linhas da criação pode levar, contado do fim da fila do Metabase: 25 s. É o espaço para a
 * conferência esperar a cota em escada (`server.ts`: até 4 leituras, com ~1 + 2 + 4 s de espera, ±25%), anexar, e ainda
 * repetir o append uma vez (~1 s de espera, conferindo antes) se a cota o recusou. Com 15 s a escada era cortada no meio.
 *
 * A conta (pior caso, com o `TIMEOUT` de 12 s do `.env.example`):
 * - **rotas de 120 s:** `/api/sheets/append` = o dedup (fila e raw, ~32 s) ou o Cosmos (`TIMEOUT`, contado do início),
 *   o que for maior, + a fila (`JANELA_FILA_MS`, 16 s) + esta janela ≈ 73 s; `/api/refund/submit` ≈ 73 s;
 *   `/api/cancellation/submit` ≈ 41 s. Abaixo dos 120 s e dos 125 s do proxy da Central de Tickets.
 * - **bot (150 s):** a rota desconta esta janela do orçamento da fase Cosmos e do teto do transporte
 *   (`app/api/reenvio/bot/route.ts`): 150 − (2 × 12 + 5 da rota dados + 16 da fila + 25 + 2,5 do aviso + 5 de folga) =
 *   72,5 s para o Cosmos (eram 82,5 s); o teto do transporte cai de 49,25 s para 44,25 s, e o aviso de orçamento só
 *   aparece com `TIMEOUT` acima disso.
 * - O `REGISTRO_TIMEOUT_MS` (a janela da gold que esta conta já descontou) não existe mais: a gold é a fila (ADR-012).
 *
 * A gestão do reembolso (duas etapas por ação) e a lista (rota de 60 s) **não** usam esta janela: cada uma tem a dela, de
 * 15 s (`refundGestaoDeps.ts` e `presencaNaPlanilha.ts`).
 */
export const JANELA_PLANILHA_MS = 25_000;

/** Tentativas por linha (total). Antes de cada uma, a linha do caso é procurada — nunca se repete um append às cegas. */
const MAX_TENTATIVAS = 2;
/** Não vale uma nova tentativa se sobra menos que isto depois da espera: a conferência e o append precisam de tempo. */
const MIN_JANELA_RETENTATIVA_MS = 3_000;

export interface ResultadoDaPlanilha {
    /**
     * `gravado` — a linha entrou (ou a conferência achou a linha de uma tentativa anterior);
     * `ja_existia` — a linha do caso já estava lá, então nada foi anexado;
     * `sem_formulas` — a linha entrou, mas as fórmulas da operação não (só nas planilhas que têm molde, `formulas.ts`):
     *   ela fica sem prazo e sem SLA até alguém completar à mão;
     * `falhou` — não entrou, ou não deu para confirmar. O `motivo` é legível e **sem dado pessoal**.
     */
    status: 'gravado' | 'ja_existia' | 'sem_formulas' | 'falhou';
    motivo?: string;
}

export interface GravarDeps {
    esperar: (ms: number) => Promise<void>;
}

const PADRAO: GravarDeps = { esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** Instante-limite da gravação das linhas da criação, contado de agora (`JANELA_PLANILHA_MS`). */
export function prazoDaPlanilha(): number {
    return Date.now() + JANELA_PLANILHA_MS;
}

/**
 * O caso de uma linha: o que a identifica na planilha (o pedido e o `criado_em`, que é também o carimbo da linha) e
 * o `id_solicitacao`, que só serve para o log e o aviso casarem com a gold.
 */
export interface CasoDaLinha extends CasoNaPlanilha {
    idSolicitacao: string;
}

function descrever(erro: unknown): string {
    return (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
}

/**
 * Vale tentar de novo? Permissão e intervalo inválido (4xx) não melhoram tentando, nem um cabeçalho que não bate com
 * o layout; rede, 5xx e 401 sim. A cota (429) só vale depois do **append**, que não repete nada sozinho: a
 * **conferência** já esperou a cota em escada dentro do `chamarGoogle` (até onde o prazo deixou), e repeti-la aqui
 * multiplicaria as leituras justo com a cota estourada. Cada camada repete o seu, uma vez só.
 */
function retentavel(erro: unknown, etapa: 'conferencia' | 'append'): boolean {
    if (erro instanceof LayoutDaPlanilhaError || !(erro instanceof SheetsError)) return false;
    if (erro.status === 429) return etapa === 'append';
    return erro.status === undefined || erro.status === 401 || erro.status >= 500;
}

/**
 * O aviso nunca altera o desfecho (INV-06): o `sendAlert` já promete não lançar, e este `catch` é redundante de
 * propósito — uma exceção daqui transformaria uma solicitação já registrada num 500.
 */
async function avisar(ctx: AlertContext): Promise<void> {
    try {
        await sendAlert(ctx);
    } catch (erro) {
        console.error(`${LOG} Falha ao avisar (ignorada de propósito):`, erro);
    }
}

/**
 * Grava a linha da solicitação na planilha da marca, sem duplicar.
 *
 * **Antes de cada tentativa** procura a linha do caso (`acharLinhaDoCaso`: o mesmo pedido e um carimbo a até 2 min do
 * `criado_em`). Achou ⇒ já está gravada (`ja_existia` na 1ª tentativa; `gravado` depois, é a nossa tentativa anterior
 * que chegou). Não achou ⇒ anexa. Falhou de um jeito que vale repetir (rede, `429`, `5xx`) ⇒ até 2 tentativas, **sempre
 * procurando de novo antes de anexar**, depois da espera do `esperaAntesDeRepetir` (500 ms; na cota, ~1 s ou o
 * `Retry-After`). O `anexarLinha` roda com `retentar: 'nenhuma'`: quem repete é só este laço,
 * que confere antes; um `5xx`/`504` que veio DEPOIS de o Google gravar não vira linha duplicada, porque a conferência
 * acha a linha. Se a conferência falha (também), desiste em vez de anexar às cegas. A conferência que esbarrou na cota
 * (`429`) não é repetida por este laço: a leitura já a esperou em escada (`server.ts`).
 *
 * Nas planilhas com molde de fórmulas (as das marcas sem Cosmos, ADR-013), depois que a linha está lá — anexada agora
 * ou achada pela conferência — as fórmulas da operação são escritas nela (`escreverFormulas`).
 *
 * **Nunca lança**: qualquer erro vira `falhou` com o `motivo`.
 */
export async function gravarLinhaNaPlanilha(
    fluxo: FluxoPlanilha,
    marca: MarcaCxHub,
    linha: SheetCell[],
    caso: CasoDaLinha,
    prazo: number,
    deps: GravarDeps = PADRAO
): Promise<ResultadoDaPlanilha> {
    try {
        const destino = resolverPlanilha(fluxo, marca);
        const gravacao = await garantirLinha(fluxo, marca, destino, linha, caso, prazo, deps);
        if (gravacao.status === 'falhou') return { status: 'falhou', motivo: gravacao.motivo };
        return await escreverFormulas(fluxo, marca, destino, caso, gravacao.numeroDaLinha, prazo) ?? { status: gravacao.status };
    } catch (erro) {
        return { status: 'falhou', motivo: descrever(erro) };
    }
}

type Gravacao =
    /** A linha está lá; o número dela, quando se sabe (a conferência sempre sabe; o append, se o Google o devolveu). */
    | { status: 'gravado' | 'ja_existia'; numeroDaLinha: number | null }
    | { status: 'falhou'; motivo: string };

/** O laço que garante a linha sem duplicar — ver o doc do `gravarLinhaNaPlanilha`. */
async function garantirLinha(
    fluxo: FluxoPlanilha,
    marca: MarcaCxHub,
    destino: PlanilhaDestino,
    linha: SheetCell[],
    caso: CasoDaLinha,
    prazo: number,
    deps: GravarDeps,
): Promise<Gravacao> {
    for (let tentativa = 1; ; tentativa++) {
        let etapa: 'conferencia' | 'append' = 'conferencia';
        try {
            const achada = await acharLinhaDoCaso(fluxo, marca, caso, prazo);
            if (achada !== null) {
                // Na 1ª tentativa a linha já estava lá (alguém gravou antes); depois, é a nossa tentativa anterior que chegou.
                return { status: tentativa === 1 ? 'ja_existia' : 'gravado', numeroDaLinha: achada };
            }

            // Sem retentativa própria: a repetição é do laço, que confere antes (ver o doc acima).
            etapa = 'append';
            const numeroDaLinha = await anexarLinha(destino, linha, prazo, { retentar: 'nenhuma' });
            return { status: 'gravado', numeroDaLinha };
        } catch (erro) {
            const motivo = descrever(erro);
            const aguardar = esperaAntesDeRepetir(erro instanceof SheetsError ? erro : undefined, tentativa);
            console.warn(
                `${LOG} ${fluxo}/${marca} ${caso.idSolicitacao}: tentativa ${tentativa}/${MAX_TENTATIVAS} falhou `
                + `${etapa === 'append' ? 'no append' : 'na conferência'} — ${motivo}`,
            );
            if (tentativa >= MAX_TENTATIVAS || !retentavel(erro, etapa) || prazo - Date.now() <= aguardar + MIN_JANELA_RETENTATIVA_MS) {
                return { status: 'falhou', motivo };
            }
            await deps.esperar(aguardar);
        }
    }
}

/**
 * Escreve as fórmulas da operação na linha do caso (`formulas.ts`), num `values:batchUpdate` só, com `USER_ENTERED`
 * (é fórmula de verdade, não texto). Repetir é inofensivo: as mesmas fórmulas nas mesmas células. Sem o número da
 * linha (o append não o devolveu), ele é achado pela conferência.
 *
 * `null` quando a planilha não tem molde ou as fórmulas entraram; senão, `sem_formulas` com o motivo. **Nunca lança.**
 */
async function escreverFormulas(
    fluxo: FluxoPlanilha,
    marca: MarcaCxHub,
    destino: PlanilhaDestino,
    caso: CasoDaLinha,
    numeroConhecido: number | null,
    prazo: number,
): Promise<ResultadoDaPlanilha | null> {
    if (!FORMULAS_DA_LINHA[fluxo]?.[marca]) return null;

    let numero = numeroConhecido;
    try {
        numero ??= await acharLinhaDoCaso(fluxo, marca, caso, prazo);
        const formulas = numero === null ? [] : formulasDaLinha(fluxo, marca, numero);
        if (numero === null || formulas.length === 0) {
            return { status: 'sem_formulas', motivo: 'a linha entrou, mas não deu para saber o número dela para escrever as fórmulas' };
        }
        const linhaDasFormulas = numero;
        await atualizarCelulas(
            destino.spreadsheetId,
            formulas.map(({ coluna, formula }) => ({ intervalo: `${abaA1(destino.aba)}!${coluna}${linhaDasFormulas}`, valor: formula })),
            prazo,
            { entrada: 'USER_ENTERED' },
        );
        return null;
    } catch (erro) {
        const motivo = `a linha${numero === null ? '' : ` ${numero}`} entrou, mas as fórmulas da operação não: ${descrever(erro)}`;
        console.warn(`${LOG} ${fluxo}/${marca} ${caso.idSolicitacao}: ${motivo}`);
        return { status: 'sem_formulas', motivo };
    }
}

export interface LinhaDaSolicitacao extends CasoDaLinha {
    fluxo: FluxoPlanilha;
    marca: MarcaCxHub;
    linha: SheetCell[];
    /**
     * Colunas (0-based) que **não** vão ao log da linha que falhou, mesmo sendo o log o que permite repor à mão: a chave
     * Pix do reembolso das marcas sem Cosmos (LGPD, ADR-013). Quem repõe pede a chave de novo no atendimento.
     */
    colunasSensiveis?: number[];
}

/** A linha para o log: as colunas sensíveis viram `[omitido]`. */
function linhaParaOLog(item: LinhaDaSolicitacao): SheetCell[] {
    const sensiveis = new Set(item.colunasSensiveis ?? []);
    return item.linha.map((celula, i) => (sensiveis.has(i) && celula !== null && celula !== '' ? '[omitido]' : celula));
}

/** O que identifica a solicitação no aviso — sem dado pessoal (o `formatAlert` só lê estes campos). */
export interface ContextoDoRegistro {
    numeroPedido?: string;
    idAtendimento?: string;
    /**
     * O que a fila do Metabase respondeu antes da planilha (ADR-012). Muda o que o aviso afirma: com `enfileirado` a
     * solicitação "entrou na fila do Metabase"; com `incerto` não se sabe (a fila pode ter guardado ou não).
     */
    statusDaFila: 'enfileirado' | 'incerto';
}

/**
 * `linhasGravadas` — todas as falhas foram `sem_formulas`: as linhas **estão** na planilha, só sem as fórmulas da
 * operação. Quem responde à tela diz isso, em vez de "a planilha não foi atualizada". Ausente vale `false`.
 */
export type ResultadoDasPlanilhas = { ok: true } | { ok: false; motivo: string; linhasGravadas?: boolean };

/**
 * O que os `process*` chamam depois da fila do Metabase: grava cada linha (em paralelo, no mesmo prazo) e, se alguma
 * falhou, deixa cada linha que falhou completa no log (`console.error`, para repor à mão) e manda **UM aviso por chamada**,
 * listando todos os pares (fluxo, id) que falharam. Um aviso por linha não serve: as duas linhas do reembolso do
 * Bot são do mesmo pedido, têm a mesma chave de agrupamento, e o 2º card seria descartado. **Nunca lança** — o
 * `sendAlert` também não.
 *
 * ⚠️ A linha tem dado pessoal (nome, telefone, endereço): vai ao log da Vercel, como o caso vai quando a fila não o
 * guarda, mas **nunca** ao aviso do Chat.
 */
export async function gravarNasPlanilhas(
    linhas: LinhaDaSolicitacao[],
    contexto: ContextoDoRegistro,
    prazo: number = prazoDaPlanilha(),
    deps: GravarDeps = PADRAO
): Promise<ResultadoDasPlanilhas> {
    const resultados = await Promise.all(
        linhas.map((item) => gravarLinhaNaPlanilha(item.fluxo, item.marca, item.linha, item, prazo, deps))
    );

    const falhas = linhas
        .map((item, i) => ({
            item,
            semFormulas: resultados[i].status === 'sem_formulas',
            motivo: resultados[i].status === 'falhou' || resultados[i].status === 'sem_formulas'
                ? (resultados[i].motivo ?? 'motivo desconhecido')
                : null,
        }))
        .filter((falha): falha is { item: LinhaDaSolicitacao; semFormulas: boolean; motivo: string } => falha.motivo !== null);
    if (falhas.length === 0) return { ok: true };

    for (const { item, semFormulas, motivo } of falhas) {
        // A linha que entrou sem as fórmulas está na planilha: o log leva só o motivo (com o número dela), sem o dado pessoal.
        console.error(semFormulas
            ? `${LOG} linha sem as fórmulas da operação (${item.fluxo}/${item.marca}, id ${item.idSolicitacao}): ${motivo}`
            : `${LOG} linha não gravada (${item.fluxo}/${item.marca}, id ${item.idSolicitacao}): ${motivo} | linha ${JSON.stringify(linhaParaOLog(item))}`
        );
    }

    const linhasGravadas = falhas.every(({ semFormulas }) => semFormulas);
    const pares = falhas.map(({ item }) => `${item.fluxo} (${item.idSolicitacao})`).join(', ');
    const quais = linhasGravadas
        ? `${falhas.length === 1 ? 'a linha entrou' : 'as linhas entraram'} na planilha sem as fórmulas de prazo e SLA (complete à mão)`
        : `${falhas.length === 1 ? 'a linha não entrou' : 'as linhas não entraram'} na planilha`;
    await avisar({
        reason: 'SHEET_WRITE_FAILED',
        motivo: contexto.statusDaFila === 'enfileirado'
            ? `A solicitação entrou na fila do Metabase, mas ${quais}: ${pares}`
            : `Não deu para confirmar a entrada na fila do Metabase, e ${quais}: ${pares}`,
        requestId: falhas.map(({ item }) => item.idSolicitacao).join(', '),
        brand: falhas[0].item.marca,
        numeroPedido: contexto.numeroPedido,
        idAtendimento: contexto.idAtendimento,
        detalhe: falhas.map(({ item, motivo }) => `${item.fluxo}: ${motivo}`).join('; '),
    });

    const motivo = falhas.map((falha) => falha.motivo).join('; ');
    return linhasGravadas ? { ok: false, motivo, linhasGravadas } : { ok: false, motivo };
}
