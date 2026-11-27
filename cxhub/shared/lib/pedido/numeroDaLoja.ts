import type { MarcaCxHub } from '../constants';

/**
 * O número do pedido na loja, lido do que chega (a tela, a Central de Tickets, o bot, o extravios), decisão deste app
 * em 2026-11-27 (pedidos da Gocreators).
 *
 * Até a v24 o CX Hub reduzia o pedido aos dígitos em toda parte (busca, dedup, NF), porque no `SH{n}{sigla}` e no
 * `#n` os dígitos do nome são o `order_number` da loja. Os pedidos da Gocreators quebram isso: o nome é
 * `GC{n}{sigla}` (`GC104306BB`, `GC109828LC`), o `order_number` deles é outro (o interno da Shopify: 2901055, 741050),
 * e os dígitos do GC colidem com pedidos antigos da mesma loja (o `#109828` da Lescent é de 10/2025; o `GC109828LC`,
 * de 17/11/2026). Em 26/11 a v24 devolvia o `#104306` de 2024 para o `GC104306BB`.
 *
 * A regra:
 * - **GC** é o texto que tem `GC` seguido de dígito. Só vale no formato `GC{n}` com ou sem a sigla (`GC104306BB`,
 *   `gc104306`, `#GC104306BB`); qualquer outra coisa com `GC{dígito}` (`GC107465BB-R-1`, que é um reenvio) não é um
 *   pedido, e volta `null` em vez de cair nos dígitos, que achariam o `#n` de mesmo número.
 * - **SH** é todo o resto com dígito: `SH1954655BB`, `#1475900`, `1475900`, `#SHOPIFY1475900`. Só os dígitos continuam
 *   significando o SH/`#n`, como até a v24.
 * - O GC é sempre comparado pelo número inteiro (`GC` + dígitos); o SH, pelos dígitos, mas nunca com um GC.
 */
export interface NumeroDaLoja {
    prefixo: 'SH' | 'GC';
    digitos: string;
    /** A sigla da marca no fim do nome (`BB`, `LC`): a que veio, ou a da marca; vazia quando nenhuma das duas existe */
    sufixo: string;
}

/**
 * A sigla de cada marca no nome do pedido da loja (`SH{n}{sigla}` e `GC{n}{sigla}`): a do `SUFIXO_DO_PEDIDO` nas sem
 * Cosmos e a da Central de Tickets nas do Cosmos. Os GC conferidos no Data Mart em 26/11 usam as mesmas: AU, BB, KS, LC,
 * RT e YE.
 */
export const SIGLA_DO_PEDIDO_NA_LOJA: Record<MarcaCxHub, string> = {
    lescent: 'LC',
    kokeshi: 'KS',
    bysamia: 'BS',
    aua: 'AU',
    barbours: 'BB',
    rituaria: 'RT',
    apice: 'AP',
    yenzah: 'YE',
    denavita: 'DN',
    gobeaute: 'GB',
};

/**
 * Desde quando há pedido GC na Shopify: o primeiro é de 13/10/2026 (Lescent; conferido no Data Mart em 27/11). Corta a
 * busca pelo `order_name`, que não tem índice, nas leituras do Data Mart.
 */
export const INICIO_DOS_PEDIDOS_GC = '2026-09-01';

/** A sigla da marca no nome do pedido, ou vazio para marca desconhecida. */
export function siglaDaMarcaNoPedido(marca: string | null | undefined): string {
    const m = String(marca ?? '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SIGLA_DO_PEDIDO_NA_LOJA, m) ? SIGLA_DO_PEDIDO_NA_LOJA[m as MarcaCxHub] : '';
}

const TEM_GC = /GC\d/i;

/** O texto é de um pedido GC (tem `GC` seguido de dígito)? Vale para o que vem de fora e para o que está gravado. */
export function pareceGc(texto: string | null | undefined): boolean {
    return TEM_GC.test(String(texto ?? ''));
}

/**
 * O número do pedido, ou `null` quando não há o que procurar (sem dígito, ou um GC fora do formato). A `marca` só
 * completa a sigla que não veio.
 */
export function lerNumeroDaLoja(texto: string | null | undefined, marca?: string | null): NumeroDaLoja | null {
    const limpo = String(texto ?? '').toUpperCase().replace(/[\s#]/g, '');
    if (TEM_GC.test(limpo)) {
        const gc = /^GC(\d+)([A-Z]{2})?$/.exec(limpo);
        return gc ? { prefixo: 'GC', digitos: gc[1], sufixo: gc[2] ?? siglaDaMarcaNoPedido(marca) } : null;
    }
    const digitos = limpo.replace(/\D/g, '');
    if (!digitos) return null;
    const sh = /^SH\d+([A-Z]{2})/.exec(limpo);
    return { prefixo: 'SH', digitos, sufixo: sh?.[1] ?? siglaDaMarcaNoPedido(marca) };
}

export function ehGc(numero: NumeroDaLoja | null | undefined): boolean {
    return numero?.prefixo === 'GC';
}

/** O nome do GC na loja e no Cosmos (`GC104306BB`); sem a sigla, só `GC104306`. */
export function nomeDoGc(numero: NumeroDaLoja): string {
    return `GC${numero.digitos}${numero.sufixo}`;
}

/**
 * O pedido como ele é dito para fora (a resposta do `/api/reenvio/existente`, os logs): os dígitos no SH, como até a
 * v24, e o GC inteiro.
 */
export function textoDoPedido(numero: NumeroDaLoja): string {
    return numero.prefixo === 'GC' ? nomeDoGc(numero) : numero.digitos;
}

/**
 * O texto gravado (ou devolvido por uma fonte) é este pedido? Os mesmos dígitos e o mesmo lado (GC ou não), a mesma
 * regra do `sqlDoMesmoPedido`. A sigla não entra: as buscas já são de uma marca só.
 */
export function mesmoPedido(texto: string | null | undefined, numero: NumeroDaLoja | null | undefined): boolean {
    if (!numero) return false;
    const t = String(texto ?? '');
    return t.replace(/\D/g, '') === numero.digitos && pareceGc(t) === (numero.prefixo === 'GC');
}

/**
 * O mesmo que o `mesmoPedido`, em SQL do Postgres (o Data Mart e a raw pelo Metabase), para uma coluna de texto. Os
 * dígitos entram no SQL só depois de conferidos (`^\d+$`); sem pedido, a condição é falsa.
 */
export function sqlDoMesmoPedido(coluna: string, numero: NumeroDaLoja | null | undefined): string {
    if (!numero || !/^\d+$/.test(numero.digitos)) return 'false';
    const valor = `coalesce(${coluna}, '')`;
    const gc = `${valor} ~* 'GC[0-9]'`;
    return `(regexp_replace(${valor}, '[^0-9]', '', 'g') = '${numero.digitos}' and ${numero.prefixo === 'GC' ? gc : `not (${gc})`})`;
}

/**
 * A chave do pedido em SQL, para agrupar (`partition by`): os dígitos e o lado (GC ou não), a mesma régua do
 * `sqlDoMesmoPedido`. Duas expressões separadas por vírgula.
 */
export function sqlDaChaveDoPedido(coluna: string): string {
    const valor = `coalesce(${coluna}, '')`;
    return `regexp_replace(${valor}, '[^0-9]', '', 'g'), (${valor} ~* 'GC[0-9]')`;
}

/**
 * O que vai no `external_id=` da listagem do Cosmos, que busca por "contém" (ILIKE): os dígitos no SH (como até a v24)
 * e o GC inteiro, que no Cosmos é o `external_id` do pedido (`GC104306BB`, origem `gocreators`). Quem casa o pedido
 * certo na lista é o `ehOPedidoNoCosmos`.
 */
export function buscaNoCosmos(numero: NumeroDaLoja): string {
    return numero.prefixo === 'GC' ? nomeDoGc(numero) : numero.digitos;
}

/** O nome do original no Cosmos, em regex: `SH{n}{sigla}{n?}` ou `#SHOPIFY{n}` no SH; `GC{n}{sigla}` no GC. */
function originalNoCosmos(numero: NumeroDaLoja): string {
    if (numero.prefixo === 'GC') return `GC${numero.digitos}${numero.sufixo || '[A-Z]{2}'}`;
    return `(?:SH${numero.digitos}[A-Z]{2}\\d*|#SHOPIFY${numero.digitos})`;
}

/**
 * O pedido da lista do Cosmos é o original procurado? O SH segue a regra de sempre (a do n8n): `SH{n}{sigla}{n?}` ou
 * `#SHOPIFY{n}`. O GC casa o nome inteiro. Uma regra nunca casa o pedido da outra.
 */
export function ehOPedidoNoCosmos(externalId: string | null | undefined, numero: NumeroDaLoja): boolean {
    return new RegExp(`^${originalNoCosmos(numero)}$`, 'i').test(String(externalId ?? '').trim());
}

/** O pedido da lista do Cosmos é um reenvio do original procurado (`{original}-R-{k}`)? */
export function ehReenvioDoPedidoNoCosmos(externalId: string | null | undefined, numero: NumeroDaLoja): boolean {
    return new RegExp(`^${originalNoCosmos(numero)}-R-\\d+$`, 'i').test(String(externalId ?? '').trim());
}
