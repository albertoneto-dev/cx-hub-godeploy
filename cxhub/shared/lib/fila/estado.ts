import {
    buscarCasoPorId,
    buscarReembolsoMaisRecente,
    buscarSolicitacaoRecente,
    type CasoNaRaw,
    type ReembolsoNaRaw,
    type SolicitacaoRecente,
} from '../airflow/raw';
import { TAMANHO_DA_PAGINA, listarPaginaDaRaw } from '../airflow/listarCasos';
import { SIGLA_DA_MARCA } from '../airflow/gold';
import type { MarcaCxHub } from '../constants';
import type { TipoCasoCxhub } from '../airflow/types';
import type { FiltroSolicitacoes, PaginaDeSolicitacoes, SolicitacaoListada } from '../solicitacoes/types';
import { atualizacoesNaFila, casoNaFila, casosAbertosNaFila, casosDoPedidoNaFila } from './client';
import type { AtualizacaoNaFila, CasoAbertoNaFila } from './types';

const LOG = '[Fila]';

/**
 * O estado de uma solicitação com a gravação em lote (ADR-012): **raw + fila**. A raw só recebe um caso ou uma
 * alteração quando o lote roda (até 20 min, mais o atraso da réplica), e até lá eles estão na fila do app `cx-hub`.
 * O dedup e a gestão do reembolso olham os dois:
 * - um caso existe se está na raw **ou** na fila (menos o que a DAG recusou);
 * - o status de execução é o da atualização mais recente **da fila**, quando há alguma: toda alteração passa pela
 *   fila, e ela as guarda por 7 dias depois de gravadas, então o que só a raw tem é mais antigo. Sem atualização na
 *   fila, vale o status da raw.
 *
 * As três funções têm a forma das de `raw.ts`, que elas substituem nos chamadores. Erro da raw ou da fila sobe: o
 * dedup recusa a solicitação, e a gestão responde que não deu para ler.
 *
 * ⚠️ Server-only.
 */

const JANELA_DEDUP_MS = 24 * 3600_000;
/** O limite de ids de `GET /api/v1/atualizacoes` (`docs/fila-cxhub.md`). */
const MAX_IDS = 20;

export interface EstadoDeps {
    solicitacaoRecenteNaRaw: typeof buscarSolicitacaoRecente;
    reembolsoMaisRecenteNaRaw: typeof buscarReembolsoMaisRecente;
    casoPorIdNaRaw: typeof buscarCasoPorId;
    casosDoPedidoNaFila: typeof casosDoPedidoNaFila;
    casoNaFila: typeof casoNaFila;
    atualizacoesNaFila: typeof atualizacoesNaFila;
    agora: () => number;
}

const PADRAO: EstadoDeps = {
    solicitacaoRecenteNaRaw: buscarSolicitacaoRecente,
    reembolsoMaisRecenteNaRaw: buscarReembolsoMaisRecente,
    casoPorIdNaRaw: buscarCasoPorId,
    casosDoPedidoNaFila,
    casoNaFila,
    atualizacoesNaFila,
    agora: () => Date.now(),
};

interface ExecucaoNaFila {
    /** Em minúsculas, como a raw: `realizado`, `cancelado`, `pendente` */
    status: string;
    dataExecucao: string | null;
    responsavelExecucao: string | null;
}

const textoOuNulo = (valor: unknown): string | null => {
    const limpo = valor === null || valor === undefined ? '' : String(valor).trim();
    return limpo || null;
};

/** O status que a atualização mais recente da fila deu ao caso (a que a DAG recusou não conta), ou `null`. */
export function execucaoNaFila(atualizacoes: AtualizacaoNaFila[], idSolicitacao: string): ExecucaoNaFila | null {
    const ultima = atualizacoes
        .filter((a) => a.idSolicitacao === idSolicitacao && a.situacao !== 'recusado' && textoOuNulo(a.campos.status_execucao))
        .sort((a, b) => Date.parse(b.atualizadoEm) - Date.parse(a.atualizadoEm))[0];
    if (!ultima) return null;
    return {
        status: String(ultima.campos.status_execucao).trim().toLowerCase(),
        dataExecucao: textoOuNulo(ultima.campos.data_execucao),
        responsavelExecucao: textoOuNulo(ultima.campos.responsavel_execucao),
    };
}

/**
 * O dedup de 24 h: a solicitação do mesmo tipo, marca e pedido aberta nas últimas 24 h e não cancelada, na fila ou
 * na raw. Um cancelamento ainda na fila já libera o pedido.
 */
export async function solicitacaoRecenteNoRegistro(
    tipo: TipoCasoCxhub,
    marca: MarcaCxHub,
    pedido: string,
    deps: EstadoDeps = PADRAO,
): Promise<SolicitacaoRecente | null> {
    const [naFila, naRaw] = await Promise.all([
        deps.casosDoPedidoNaFila(tipo, marca, pedido),
        deps.solicitacaoRecenteNaRaw(tipo, marca, pedido),
    ]);
    const limite = deps.agora() - JANELA_DEDUP_MS;
    const candidatos = naFila.filter((c) => c.situacao !== 'recusado' && Date.parse(c.criadoEm) >= limite);
    const ids = [...new Set([...candidatos.map((c) => c.idSolicitacao), ...(naRaw ? [naRaw.idSolicitacao] : [])])];
    const atualizacoes = ids.length > 0 ? await deps.atualizacoesNaFila(ids.slice(0, MAX_IDS)) : [];
    const cancelado = (id: string) => execucaoNaFila(atualizacoes, id)?.status === 'cancelado';

    const daFila = candidatos.find((c) => !cancelado(c.idSolicitacao));
    if (daFila) {
        return {
            idSolicitacao: daFila.idSolicitacao,
            pedido: daFila.numeroPedido,
            responsavel: daFila.responsavel ?? '',
            solicitadoEm: daFila.criadoEm,
        };
    }
    return naRaw && !cancelado(naRaw.idSolicitacao) ? naRaw : null;
}

/** O reembolso mais recente do pedido (pela criação), na fila ou na raw, com o status de execução atual. */
export async function reembolsoMaisRecenteNoRegistro(
    marca: MarcaCxHub,
    pedido: string,
    deps: EstadoDeps = PADRAO,
): Promise<ReembolsoNaRaw | null> {
    const [naFila, naRaw] = await Promise.all([
        deps.casosDoPedidoNaFila('REEMBOLSO', marca, pedido),
        deps.reembolsoMaisRecenteNaRaw(marca, pedido),
    ]);
    const daFila = naFila.find((c) => c.situacao !== 'recusado');

    let alvo: ReembolsoNaRaw | null = naRaw;
    if (daFila && (!naRaw || !(naRaw.criadoEm.getTime() > Date.parse(daFila.criadoEm)))) {
        alvo = {
            idSolicitacao: daFila.idSolicitacao,
            numeroPedido: daFila.numeroPedido,
            // O mesmo caso já na raw traz o status dela; um caso só da fila ainda não tem nenhum.
            status: naRaw?.idSolicitacao === daFila.idSolicitacao ? naRaw.status : 'aberto',
            criadoEm: new Date(daFila.criadoEm),
        };
    }
    if (!alvo) return null;

    const execucao = execucaoNaFila(await deps.atualizacoesNaFila([alvo.idSolicitacao]), alvo.idSolicitacao);
    return execucao ? { ...alvo, status: execucao.status } : alvo;
}

/** Um caso pelo id, na raw ou na fila, com o status, a data e o responsável da execução atual. */
export async function casoNoRegistro(idSolicitacao: string, deps: EstadoDeps = PADRAO): Promise<CasoNaRaw | null> {
    const [naRaw, naFila, atualizacoes] = await Promise.all([
        deps.casoPorIdNaRaw(idSolicitacao),
        deps.casoNaFila(idSolicitacao),
        deps.atualizacoesNaFila([idSolicitacao]),
    ]);
    const base: CasoNaRaw | null = naRaw ?? (naFila && naFila.situacao !== 'recusado'
        ? {
            idSolicitacao: naFila.idSolicitacao,
            tipo: naFila.tipo,
            marca: naFila.marca,
            numeroPedido: naFila.numeroPedido,
            criadoEm: new Date(naFila.criadoEm),
            status: 'aberto',
            dataExecucao: null,
            responsavelExecucao: null,
        }
        : null);
    if (!base) return null;

    const execucao = execucaoNaFila(atualizacoes, idSolicitacao);
    return execucao ? { ...base, ...execucao } : base;
}

// ─── A lista: raw + fila, paginada ───────────────────────────────────

export interface ListaDeps {
    listarPaginaDaRaw: typeof listarPaginaDaRaw;
    casosAbertosNaFila: typeof casosAbertosNaFila;
    atualizacoesNaFila: typeof atualizacoesNaFila;
    agora: () => number;
}

const PADRAO_DA_LISTA: ListaDeps = { listarPaginaDaRaw, casosAbertosNaFila, atualizacoesNaFila, agora: () => Date.now() };

/** A linha da fila, com o que só ela sabe (valor, motivo, responsável e onde está no caminho até a raw). */
function linhaDaFila(linha: SolicitacaoListada, caso: CasoAbertoNaFila): SolicitacaoListada {
    return {
        ...linha,
        valor: caso.valor,
        motivo: caso.motivo,
        responsavel: caso.responsavel,
        criadoEm: caso.criadoEm,
        // Gravado mas ainda fora da raw (a réplica atrasa): para a tag, já está no Metabase.
        situacaoNaFila: caso.situacao === 'gravado' ? null : caso.situacao,
    };
}

const STATUS_LEGIVEL: Record<string, string> = { realizado: 'Realizado', cancelado: 'Cancelado', pendente: 'Pendente' };

/**
 * Uma página da lista de solicitações (`GET /api/solicitacoes`): os últimos 30 dias (ou todo o histórico do pedido
 * buscado) da raw **e** da fila do Metabase (ADR-012), para um caso aparecer para todas as agentes logo depois do envio,
 * e não só depois do lote e da réplica. A junção, a contagem, a ordem e o "mais recente do pedido" são do SQL
 * (`listarPaginaDaRaw`), para valerem na lista inteira e não só na página; o caso que está nas duas vale o da raw.
 * O status de execução de cada linha da página leva por cima a atualização mais recente da fila (cancelar ou concluir
 * aparece antes do lote).
 *
 * A fila é melhoria, não requisito: fora do ar, a lista sai só com a raw (e o log diz). Erro da raw sobe.
 */
export async function listarSolicitacoesNoRegistro(
    filtro: FiltroSolicitacoes,
    pagina = 1,
    deps: ListaDeps = PADRAO_DA_LISTA,
): Promise<PaginaDeSolicitacoes> {
    // Primeiro a fila: os casos dela vão para dentro do SQL da raw. Marca desconhecida nem entra.
    const daFila = (await deps.casosAbertosNaFila({ tipo: filtro.tipo, marca: filtro.marca, pedido: filtro.pedido }).catch((erro) => {
        console.warn(`${LOG} lista sem a fila: ${erro instanceof Error ? erro.message : String(erro)}`);
        return [] as CasoAbertoNaFila[];
    })).filter((caso) => Object.hasOwn(SIGLA_DA_MARCA, caso.marca));
    const casoDaFila = new Map(daFila.map((caso) => [caso.idSolicitacao, caso]));

    const { total, linhas } = await deps.listarPaginaDaRaw(filtro, { pagina, daFila, agora: deps.agora() });
    const naPagina = linhas.map(({ solicitacao, daFila: veioDaFila }) => {
        const caso = veioDaFila ? casoDaFila.get(solicitacao.idSolicitacao) : undefined;
        return caso ? linhaDaFila(solicitacao, caso) : solicitacao;
    });

    // As atualizações ainda na fila, por cima do status da raw: até 20 ids por pergunta (uma, com a página de 20).
    const atualizacoes: AtualizacaoNaFila[] = [];
    const ids = naPagina.map((item) => item.idSolicitacao);
    try {
        for (let i = 0; i < ids.length; i += MAX_IDS) {
            atualizacoes.push(...(await deps.atualizacoesNaFila(ids.slice(i, i + MAX_IDS))));
        }
    } catch (erro) {
        console.warn(`${LOG} lista sem as atualizações da fila: ${erro instanceof Error ? erro.message : String(erro)}`);
    }

    return {
        solicitacoes: naPagina.map((item) => {
            const execucao = execucaoNaFila(atualizacoes, item.idSolicitacao);
            return execucao ? { ...item, statusExecucao: STATUS_LEGIVEL[execucao.status] ?? execucao.status } : item;
        }),
        paginacao: {
            pagina,
            porPagina: TAMANHO_DA_PAGINA,
            total,
            totalPaginas: Math.max(1, Math.ceil(total / TAMANHO_DA_PAGINA)),
        },
    };
}
