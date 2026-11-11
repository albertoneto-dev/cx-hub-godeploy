import type {
    FiltroSolicitacoes,
    PaginacaoDaLista,
    SolicitacaoListada,
    TipoSolicitacaoListada,
} from '../solicitacoes/types';
import { consultarRegistro } from './client';
import type { EstadoDoEnvio, EstadoDoRegistro, SolicitacaoEnviada } from './types';

/**
 * As solicitações que este navegador enviou, guardadas no `localStorage` até a raw trazê-las (o lote da fila do
 * Metabase roda a cada 20 min, ADR-012). É delas que a lista mostra a tag de status logo depois do envio.
 *
 * O `localStorage` pode faltar (aba anônima, dado do site apagado ou bloqueado): toda leitura e escrita tolera isso,
 * e a lista segue só com a gold.
 */

const CHAVE = 'cxhub_solicitacoes_enviadas';

/** Quanto a enviada fica no navegador: a janela do dedup. Até lá a raw já a tem, se gravou. */
export const VALIDADE_DA_ENVIADA_MS = 24 * 60 * 60 * 1000;

function armazenamento(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

function lerTudo(): SolicitacaoEnviada[] {
    try {
        const texto = armazenamento()?.getItem(CHAVE);
        const lista: unknown = texto ? JSON.parse(texto) : [];
        return Array.isArray(lista) ? (lista as SolicitacaoEnviada[]) : [];
    } catch {
        return [];
    }
}

function gravarTudo(lista: SolicitacaoEnviada[]): void {
    try {
        armazenamento()?.setItem(CHAVE, JSON.stringify(lista));
    } catch {
        // Sem espaço ou bloqueado: a tag some, a solicitação não (ela está na fila do Metabase).
    }
}

function dentroDaValidade(enviada: SolicitacaoEnviada, agora: number): boolean {
    const enviadaEm = Date.parse(enviada.enviadaEm);
    return Number.isFinite(enviadaEm) && agora - enviadaEm < VALIDADE_DA_ENVIADA_MS;
}

/** As enviadas do tipo, mais recentes primeiro. As vencidas são apagadas na leitura. */
export function lerSolicitacoesEnviadas(tipo: TipoSolicitacaoListada, agora: number = Date.now()): SolicitacaoEnviada[] {
    const todas = lerTudo();
    const validas = todas.filter((enviada) => dentroDaValidade(enviada, agora));
    if (validas.length !== todas.length) gravarTudo(validas);
    return validas
        .filter((enviada) => enviada.tipo === tipo)
        .sort((a, b) => Date.parse(b.enviadaEm) - Date.parse(a.enviadaEm));
}

/** Guarda a enviada (a mesma `idSolicitacao` é substituída). */
export function guardarSolicitacaoEnviada(enviada: SolicitacaoEnviada): void {
    gravarTudo([enviada, ...lerTudo().filter((outra) => outra.idSolicitacao !== enviada.idSolicitacao)]);
}

/** Troca, no armazenamento, as enviadas que mudaram de estado. As outras ficam como estavam. */
export function atualizarSolicitacoesEnviadas(atualizadas: SolicitacaoEnviada[]): void {
    const porId = new Map(atualizadas.map((enviada) => [enviada.idSolicitacao, enviada]));
    gravarTudo(lerTudo().map((enviada) => porId.get(enviada.idSolicitacao) ?? enviada));
}

/** Apaga as enviadas que a lista não precisa mais mostrar (a raw já as trouxe). */
export function esquecerSolicitacoesEnviadas(ids: string[]): void {
    if (ids.length === 0) return;
    const apagar = new Set(ids);
    gravarTudo(lerTudo().filter((enviada) => !apagar.has(enviada.idSolicitacao)));
}

const digitos = (pedido: string) => pedido.replace(/\D/g, '');

/**
 * As enviadas que a lista mostra: as do filtro da busca (marca e pedido, pelos dígitos, como a lista) que a raw
 * ainda não trouxe.
 */
export function enviadasDaLista(
    enviadas: SolicitacaoEnviada[],
    filtro: FiltroSolicitacoes,
    idsNaLista: ReadonlySet<string>,
): SolicitacaoEnviada[] {
    const pedido = filtro.pedido ? digitos(filtro.pedido) : '';
    return enviadas.filter((enviada) =>
        enviada.tipo === filtro.tipo
        && !idsNaLista.has(enviada.idSolicitacao)
        && (!filtro.marca || enviada.marca === filtro.marca)
        && (!pedido || digitos(enviada.numeroPedido) === pedido));
}

/** Onde está a página que a tela mostra: as enviadas só entram na primeira. */
export interface PaginaNaTela {
    /** A partir de 1 */
    numero: number;
    /** É a última página da lista? */
    ultima: boolean;
}

/** A lista sem paginação (as enviadas sozinhas, com a gestão desligada ou a busca que falhou). */
export const PAGINA_UNICA: PaginaNaTela = { numero: 1, ultima: true };

/** A página da tela a partir da paginação que a lista devolveu. */
export function paginaNaTela(paginacao: PaginacaoDaLista): PaginaNaTela {
    return { numero: paginacao.pagina, ultima: paginacao.pagina >= paginacao.totalPaginas };
}

/**
 * As enviadas que a página mostra no topo: as do filtro que a página não traz (`enviadasDaLista`), só na primeira
 * página e, quando a lista tem mais páginas, só as mais novas que a última linha dela. A lista já traz o que está na
 * raw e na fila; a enviada que a primeira página não traz e é mais antiga que ela, se o registro a tem, está numa página
 * seguinte, e no topo apareceria duas vezes. As outras páginas nunca as acrescentam.
 */
export function enviadasDaPagina(
    enviadas: SolicitacaoEnviada[],
    filtro: FiltroSolicitacoes,
    daPagina: SolicitacaoListada[],
    pagina: PaginaNaTela,
): SolicitacaoEnviada[] {
    if (pagina.numero !== 1) return [];
    const novas = enviadasDaLista(enviadas, filtro, new Set(daPagina.map((item) => item.idSolicitacao)));
    const maisAntiga = daPagina.at(-1);
    if (pagina.ultima || !maisAntiga) return novas;
    return novas.filter((enviada) => comoSolicitacaoListada(enviada).dataSolicitacao >= maisAntiga.dataSolicitacao);
}

/** São Paulo não tem horário de verão desde 2019: UTC−3 o ano todo. */
const SAO_PAULO_MS = -3 * 60 * 60 * 1000;

/** A enviada no formato da linha da lista, para a mesma lista mostrar as duas. */
export function comoSolicitacaoListada(enviada: SolicitacaoEnviada): SolicitacaoListada {
    // A lista traz a data em hora de São Paulo, sem fuso, e a formata pelo texto: a enviada vai igual.
    const dataSolicitacao = new Date(Date.parse(enviada.enviadaEm) + SAO_PAULO_MS).toISOString().slice(0, 19);
    return {
        idSolicitacao: enviada.idSolicitacao,
        tipo: enviada.tipo,
        marca: enviada.marca,
        numeroPedido: enviada.numeroPedido,
        dataSolicitacao,
        valor: enviada.valor,
        motivo: enviada.motivo,
        statusExecucao: null,
        responsavel: enviada.responsavel,
        maisRecenteDoPedido: false,
        criadoEm: null,
        // A enviada sabe pelo envio: só a planilha que falhou (`SHEET_WRITE_FAILED`) fica sem a linha.
        naPlanilha: !enviada.semPlanilha,
        situacaoNaFila: null,
    };
}

/** A tag do envio (a linha na planilha) a partir do `naPlanilha` da linha; sem saber (`null`), nenhuma. */
export function estadoDoEnvioNaPlanilha(naPlanilha: boolean | null): EstadoDoEnvio | null {
    if (naPlanilha === null) return null;
    return naPlanilha ? 'sucesso' : 'falhou';
}

/**
 * A tag do Metabase de uma linha da lista: a da raw (e o caso gravado que a réplica ainda não trouxe) já está no
 * Metabase; a que veio da fila está esperando o lote, ou foi recusada pela DAG.
 */
export function estadoNoMetabaseDaLinha(situacaoNaFila: SolicitacaoListada['situacaoNaFila']): EstadoDoEnvio {
    if (situacaoNaFila === null) return 'sucesso';
    return situacaoNaFila === 'recusado' ? 'falhou' : 'em_andamento';
}

/** O estado do caso como a tag o mostra. */
export function estadoDoEnvio(estado: EstadoDoRegistro): EstadoDoEnvio {
    if (estado === 'gravado') return 'sucesso';
    if (estado === 'recusado') return 'falhou';
    return 'em_andamento';
}

/** Os casos ainda aguardando o Metabase que dá para acompanhar: o da solicitação e o do cancelamento pedido junto. */
function idsAguardando(enviada: SolicitacaoEnviada, ignorar: ReadonlySet<string>): string[] {
    const ids: string[] = [];
    if (enviada.estado === 'em_andamento' && !ignorar.has(enviada.idSolicitacao)) ids.push(enviada.idSolicitacao);
    const cancelamento = enviada.cancelamento;
    if (cancelamento?.idSolicitacao && cancelamento.estado === 'em_andamento' && !ignorar.has(cancelamento.idSolicitacao)) {
        ids.push(cancelamento.idSolicitacao);
    }
    return ids;
}

/** Ainda há caso para perguntar? */
export function haRegistroEmAndamento(enviadas: SolicitacaoEnviada[], ignorar: ReadonlySet<string>): boolean {
    return enviadas.some((enviada) => idsAguardando(enviada, ignorar).length > 0);
}

/** Quantos ids `GET /api/registro` aceita numa pergunta. */
export const MAX_IDS_POR_CONSULTA = 20;

export interface RodadaDoAcompanhamento {
    /** As enviadas com os estados novos. A mesma referência quando nada mudou. */
    enviadas: SolicitacaoEnviada[];
    /** Ids que não dá para acompanhar nesta sessão (pedido inválido ou sem acesso): param de ser perguntados. */
    semAcompanhamento: string[];
}

/** Pedido inválido ou sem acesso não melhoram repetindo. */
function semVolta(status: number): boolean {
    return status === 400 || status === 401 || status === 403;
}

/**
 * Uma rodada do acompanhamento: pergunta, de uma vez (até `MAX_IDS_POR_CONSULTA`), onde estão os casos aguardando.
 * Pergunta que falha (rede, 5xx) deixa o estado como estava, e a próxima rodada tenta de novo. Nunca lança.
 */
export async function acompanharEnviadas(
    enviadas: SolicitacaoEnviada[],
    token: string,
    ignorar: ReadonlySet<string>,
    consultar: typeof consultarRegistro = consultarRegistro,
): Promise<RodadaDoAcompanhamento> {
    const ids = [...new Set(enviadas.flatMap((enviada) => idsAguardando(enviada, ignorar)))].slice(0, MAX_IDS_POR_CONSULTA);
    if (ids.length === 0) return { enviadas, semAcompanhamento: [] };

    const { status, body } = await consultar(ids, token);
    if (semVolta(status)) return { enviadas, semAcompanhamento: ids };
    if (body.code !== 'SUCCESS' || !body.estados) return { enviadas, semAcompanhamento: [] };

    const estados = body.estados;
    const novo = (id: string | undefined, atual: EstadoDoEnvio): EstadoDoEnvio => {
        const estado = id ? estados[id] : undefined;
        return estado ? estadoDoEnvio(estado) : atual;
    };

    let mudou = false;
    const atualizadas = enviadas.map((enviada) => {
        let atualizada = enviada;
        const estado = novo(enviada.idSolicitacao, enviada.estado);
        if (estado !== enviada.estado) atualizada = { ...atualizada, estado };
        const cancelamento = enviada.cancelamento;
        if (cancelamento?.idSolicitacao) {
            const doCancelamento = novo(cancelamento.idSolicitacao, cancelamento.estado);
            if (doCancelamento !== cancelamento.estado) {
                atualizada = { ...atualizada, cancelamento: { ...cancelamento, estado: doCancelamento } };
            }
        }
        if (atualizada !== enviada) mudou = true;
        return atualizada;
    });

    return { enviadas: mudou ? atualizadas : enviadas, semAcompanhamento: [] };
}
