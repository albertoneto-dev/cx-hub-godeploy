import { registraNaPlanilha, type MarcaCxHub } from '../constants';
import type { SolicitacaoListada } from '../solicitacoes/types';
import {
    casoComparavel,
    lerColunasDosCasos,
    linhasDosCasos,
    type CasoNaPlanilha,
    type ColunasLidas,
} from './casoNaPlanilha';
import { planilhasConfiguradas } from './googleAuth';
import { resolverPlanilha } from './targets';
import type { FluxoPlanilha } from './types';

/**
 * Se a linha de cada solicitação da lista está na planilha da marca: é o que a tag "Sucesso"/"Falhou" das linhas que
 * vêm da raw mostra (a enviada deste navegador já sabe pelo envio). Acha a linha como a gravação (pedido + carimbo a
 * até 2 min do `criado_em`), com **uma leitura das duas colunas por marca** (uma requisição, `lerColunasDosCasos`),
 * nunca uma por linha.
 *
 * - **Cache curto:** as colunas lidas ficam guardadas por `TTL_DA_PRESENCA_MS` (60 s), por fluxo, marca, planilha e aba:
 *   paginar e filtrar a lista não relê a planilha. A chave leva a planilha e a aba (que mudam com o `SHEETS_ENV`), então
 *   o cache nunca responde por outra planilha. Quem pede a mesma chave enquanto a leitura corre espera a mesma leitura.
 * - **Caso mais novo que a leitura guardada:** a linha dele pode ter entrado depois dela. Se a leitura guardada não o
 *   acha, a planilha é lida de novo — senão a tag diria "Falhou" para uma linha que acabou de entrar.
 * - **A lista não espera a cota:** a leitura vai com `retentarCota: false`. Com a cota estourada a marca fica sem tag
 *   na hora, e a cota que resta fica para quem grava (a gravação espera a cota em escada, `server.ts`).
 *
 * Nunca lança: a marca cuja planilha não responde (ou cujo cabeçalho não confere) fica `null` — sem tag —, e as outras
 * seguem; o que falhou não fica guardado. Sem a configuração do Google, tudo fica `null`. A marca sem planilha (a
 * Gobeaute, ADR-014) também fica `null`, sem leitura nenhuma.
 *
 * ⚠️ Server-only (fala com o Google): fora do barrel de `shared/lib/sheets`.
 */

const LOG = '[Planilha]';

/**
 * Quanto a lista espera a planilha (as marcas da página em paralelo), contado de agora: 15 s, como antes. Não é a
 * `JANELA_PLANILHA_MS` da gravação (25 s): a rota da lista tem 60 s, e a conferência do token no Cosmos e a leitura da
 * fila e da raw vêm antes.
 */
export const JANELA_PRESENCA_MS = 15_000;

/** Instante-limite da leitura da planilha pela lista, contado de agora. */
export function prazoDaPresenca(): number {
    return Date.now() + JANELA_PRESENCA_MS;
}

/** Por quanto tempo as colunas lidas servem a outra carga da lista (outra página, outro filtro). */
export const TTL_DA_PRESENCA_MS = 60_000;

/**
 * Até quanto depois do `criado_em` a linha de um caso ainda pode estar a caminho da planilha: o maior `maxDuration` das
 * rotas que gravam (o bot, 150 s). Para um caso criado menos que isso antes da leitura guardada, o "não está" dela não
 * vale: a linha pode ter entrado depois.
 */
const ATRASO_MAXIMO_DA_LINHA_MS = 150_000;

const FLUXO_DO_TIPO: Record<SolicitacaoListada['tipo'], FluxoPlanilha> = {
    REENVIO: 'reenvio',
    REEMBOLSO: 'reembolso',
};

interface LeituraGuardada {
    colunas: Promise<ColunasLidas>;
    /** Quando a leitura começou: a linha gravada antes disso está nela. */
    lidaEm: number;
    ate: number;
}

const guardadas = new Map<string, LeituraGuardada>();

/** Só para teste — o cache é estado de módulo e vazaria entre casos. */
export function __resetPresencaNaPlanilha(): void {
    guardadas.clear();
}

export interface PresencaDeps {
    lerColunasDosCasos: typeof lerColunasDosCasos;
    planilhasConfiguradas: typeof planilhasConfiguradas;
}

const PADRAO: PresencaDeps = { lerColunasDosCasos, planilhasConfiguradas };

/** Lê as colunas e guarda a leitura; a que falha sai do cache, para a próxima carga tentar de novo. */
function lerEGuardar(chave: string, fluxo: FluxoPlanilha, marca: MarcaCxHub, prazo: number, deps: PresencaDeps): LeituraGuardada {
    const lidaEm = Date.now();
    const leitura: LeituraGuardada = {
        colunas: deps.lerColunasDosCasos(fluxo, marca, prazo, { retentarCota: false }),
        lidaEm,
        ate: lidaEm + TTL_DA_PRESENCA_MS,
    };
    guardadas.set(chave, leitura);
    leitura.colunas.catch(() => {
        if (guardadas.get(chave) === leitura) guardadas.delete(chave);
    });
    return leitura;
}

/** O número da linha de cada caso (ou `null`), da leitura guardada quando ela serve. Erro da leitura sobe. */
async function linhasNaPlanilha(
    fluxo: FluxoPlanilha,
    marca: MarcaCxHub,
    casos: CasoNaPlanilha[],
    prazo: number,
    deps: PresencaDeps,
): Promise<(number | null)[]> {
    if (!casos.some(casoComparavel)) return casos.map(() => null);

    const { spreadsheetId, aba } = resolverPlanilha(fluxo, marca);
    const chave = `${fluxo}/${marca}/${spreadsheetId}/${aba}`;
    const guardada = guardadas.get(chave);
    if (guardada && guardada.ate > Date.now()) {
        const linhas = linhasDosCasos(await guardada.colunas, casos);
        const serve = casos.every((caso, i) =>
            linhas[i] !== null || !casoComparavel(caso) || caso.criadoEm.getTime() + ATRASO_MAXIMO_DA_LINHA_MS <= guardada.lidaEm);
        if (serve) return linhas;
    }
    return linhasDosCasos(await lerEGuardar(chave, fluxo, marca, prazo, deps).colunas, casos);
}

/** As solicitações com o `naPlanilha` de cada uma: `true`, `false` ou `null` (não deu para saber). */
export async function comPresencaNaPlanilha(
    solicitacoes: SolicitacaoListada[],
    prazo: number,
    deps: PresencaDeps = PADRAO,
): Promise<SolicitacaoListada[]> {
    if (solicitacoes.length === 0) return solicitacoes;
    if (!deps.planilhasConfiguradas()) return solicitacoes.map((item) => ({ ...item, naPlanilha: null }));

    // O que venceu sai: são poucas chaves (fluxo × marca), mas cada uma guarda duas colunas inteiras.
    const agora = Date.now();
    for (const [chave, guardada] of guardadas) if (guardada.ate <= agora) guardadas.delete(chave);

    const presenca = new Map<string, boolean | null>();
    const porGrupo = new Map<string, SolicitacaoListada[]>();
    for (const item of solicitacoes) {
        const chave = `${item.tipo}/${item.marca}`;
        porGrupo.set(chave, [...(porGrupo.get(chave) ?? []), item]);
    }

    await Promise.all([...porGrupo.values()].map(async (itens) => {
        const { tipo, marca } = itens[0];
        // Sem planilha (ADR-014) não há o que ler: sem tag do envio, e sem um aviso no log a cada carga da lista.
        if (!registraNaPlanilha(marca)) {
            itens.forEach((item) => presenca.set(item.idSolicitacao, null));
            return;
        }
        const casos = itens.map((item) => ({ pedido: item.numeroPedido, criadoEm: new Date(item.criadoEm ?? '') }));
        try {
            const linhas = await linhasNaPlanilha(FLUXO_DO_TIPO[tipo], marca, casos, prazo, deps);
            itens.forEach((item, i) => {
                // Sem `criado_em` não há como achar a linha: não dá para dizer que ela falta.
                presenca.set(item.idSolicitacao, Number.isNaN(casos[i].criadoEm.getTime()) ? null : linhas[i] !== null);
            });
        } catch (erro) {
            console.warn(`${LOG} lista: não deu para ler a planilha de ${tipo}/${marca} (${erro instanceof Error ? erro.message : String(erro)})`);
            itens.forEach((item) => presenca.set(item.idSolicitacao, null));
        }
    }));

    return solicitacoes.map((item) => ({ ...item, naPlanilha: presenca.get(item.idSolicitacao) ?? null }));
}
