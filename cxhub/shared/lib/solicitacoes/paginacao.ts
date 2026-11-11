import type { FiltroSolicitacoes, PaginacaoDaLista } from './types';

/** A lista mostra os últimos 30 dias. */
export const JANELA_DA_LISTA_DIAS = 30;

/**
 * Quantos dias a lista cobre com esse filtro: a janela, ou `null` na busca por pedido, que traz o histórico inteiro do
 * pedido (é como se acha uma solicitação mais antiga). O servidor corta por ela; a tela a descreve.
 */
export function janelaDaLista(filtro: Pick<FiltroSolicitacoes, 'pedido'>): number | null {
    return (filtro.pedido ?? '').replace(/\D/g, '') ? null : JANELA_DA_LISTA_DIAS;
}

/** O que a lista cobre, para a descrição dela na tela. */
export function descricaoDaLista(filtro: Pick<FiltroSolicitacoes, 'pedido'>): string {
    const dias = janelaDaLista(filtro);
    return dias === null
        ? 'Todas as solicitações do pedido, mais recentes primeiro.'
        : `Últimos ${dias} dias, mais recentes primeiro. Para achar uma mais antiga, busque pelo número do pedido.`;
}

/** A paginação de uma lista que veio inteira, numa página só (a resposta sem `paginacao`). */
export function paginaUnica(total: number): PaginacaoDaLista {
    return { pagina: 1, porPagina: Math.max(total, 1), total, totalPaginas: 1 };
}

/** "21–40 de 381": as posições da página na lista inteira. Vazia, "0 de 0" (ou "0 de 381", além da última). */
export function descreverPaginacao(paginacao: PaginacaoDaLista, naPagina: number): string {
    if (naPagina === 0) return `0 de ${paginacao.total}`;
    const primeira = (paginacao.pagina - 1) * paginacao.porPagina + 1;
    return `${primeira}–${primeira + naPagina - 1} de ${paginacao.total}`;
}
