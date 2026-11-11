/**
 * Resolve o CD de origem para pedidos Shopify (sem dados de CD no ERP).
 *
 * Regras:
 * - Barbours / Rituária: SP→SP, RJ→RJ, demais→ES
 * - Lescent / Kokeshi / BySamia / AUA / Gobeaute (o site multimarca, ADR-014): SP→SP, demais→ES
 * - Denavita: sempre MG (sai do CD MG, fora da Unilog — ADR-013)
 * - Ápice / Yenzah: ES, o CD de quase todos os pedidos delas (91% na Ápice). O local de atendimento diria o CD de
 *   verdade, mas o integrations-gateway, por onde o pedido delas é lido, nega esse campo (ADR-013, a confirmar com a
 *   operação)
 * - Sem UF: '-'
 *
 * Retorna a sigla curta (ex: "SP") para uso interno (filtros, display).
 * Use formatCdOrigem para formatar antes de enviar ao webhook.
 */
export function resolveCdOrigem(uf: string, brand: string): string {
    if (brand === 'denavita') return 'MG';
    if (brand === 'apice' || brand === 'yenzah') return 'ES';

    if (!uf) return '-';

    const upperUf = uf.toUpperCase();

    if (brand === 'barbours' || brand === 'rituaria') {
        if (upperUf === 'SP') return 'SP';
        if (upperUf === 'RJ') return 'RJ';
        return 'ES';
    }

    // lescent, kokeshi, bysamia, aua, gobeaute
    if (upperUf === 'SP') return 'SP';
    return 'ES';
}

/**
 * Formata o cdOrigem para envio ao webhook.
 * "SP" → "CD SP", "-" ou "" → ""
 */
export function formatCdOrigem(cdOrigem: string): string {
    if (!cdOrigem || cdOrigem === '-') return '';
    return `CD ${cdOrigem}`;
}
