import type { MarcaSemCosmosComPlanilha } from '../constants';
import { consultarDataMart, literalSql, METABASE_TIMEOUT_MS } from '../metabase/index';
import { pedidoEscolhidoNoTiny } from './pedido';
import type {
    Leitura,
    LeiturasDoPedido,
    LinhaExplodida,
    NotaNoTiny,
    PedidoNaShopify,
    PedidoNoTiny,
    RemessaIntelipost,
} from './pedidoTipos';

/**
 * A leitura do pedido das marcas sem Cosmos no Data Mart, pelo Metabase (ADR-018): a Intelipost, a Shopify, os itens
 * explodidos e, só na Ápice, o pedido e a NF no Tiny. Devolve o que foi lido, consulta por consulta; as regras que
 * derivam disso (CD, status, valor da NF) são de `pedido.ts`, puro.
 *
 * ⚠️ **Server-only** (lê `METABASE_API_KEY` pelo cliente do Metabase): fora do barrel de propósito. Importe por
 * `@shared/lib/datamart/pedidoServer`.
 *
 * **Nunca lança**: cada consulta vira uma `Leitura`, `ok` ou com o motivo (curto, sem dado pessoal). Nome, endereço e
 * telefone da cliente nem são lidos.
 *
 * Os SQLs **têm de continuar por índice**: a visão explodida só tem índice em `order_id`, e filtrá-la por `order_name`,
 * `order_number` ou `brand`, ou juntá-la com uma subconsulta no `FROM`, varre a visão inteira (45 s). Por isso a
 * subconsulta fica no `WHERE`.
 */

const LOG = '[Pedido no Data Mart]';

/** Abaixo disto a consulta nem sai: o Metabase não responde a tempo, e o timeout só gastaria o prazo que sobra. */
const MIN_PRAZO_DA_CONSULTA_MS = 500;

/** Quanto o Tiny deixa entre a criação do pedido na Shopify e a do pedido dele: de 1 dia antes a 12 depois. */
const DIAS_ANTES_NO_TINY = 1;
const DIAS_DEPOIS_NO_TINY = 12;

/**
 * As larguras da busca da NF por faixa de `id_nota`, da menor para a maior: o id da NF nasce depois do id do pedido, na
 * mesma sequência do Tiny, a até ~1,5 milhão de ids dele (6 milhões nos casos mais lentos).
 */
const LARGURAS_DA_FAIXA = [1_500_000, 6_000_000];

type Cd = 'es' | 'rj';

export interface OpcoesDaConsulta {
    timeoutMs?: number;
}

export interface DepsDaLeitura {
    consultar?: (sql: string, opcoes?: OpcoesDaConsulta) => Promise<unknown[][]>;
    agora?: () => number;
}

// ── O SQL ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** As remessas do pedido, na ordem de criação (a primeira é a original). Medida: 0,03 s. */
export function sqlDaIntelipost(marca: MarcaSemCosmosComPlanilha, numero: string): string {
    return `select invoice_number, origin_state_code, external_erp_id, dispatched_at, delivered_date, coalesce(track_code, '') <> '' as tem_rastreio
from gold.fct_intelipost_orders
where shopify_order_number = ${literalSql(numero)} and brand_code = ${literalSql(marca)}
order by created_iso`;
}

/** O pedido na Shopify; o `order_number` é numérico, então vai sem aspas (`numero` já vem só com dígitos). */
export function sqlDaShopify(marca: MarcaSemCosmosComPlanilha, numero: string): string {
    return `select order_id::text, created_at, value_total, value_shipment, cancelled_at is not null as cancelado, coalesce(track_code, '') <> '' as tem_rastreio
from gold.fct_shopify_orders
where brand = ${literalSql(marca)} and order_number = ${numero}
order by order_id desc limit 1`;
}

/** Os itens explodidos do mesmo pedido. A subconsulta fica no WHERE, nunca no FROM (ver o doc do arquivo). Medida: 0,33 s. */
export function sqlDasExplodidas(marca: MarcaSemCosmosComPlanilha, numero: string): string {
    return `select e.source_sku, e.effective_sku, e.is_kit_component, e.qty_per_kit, e.component_units, e.allocated_revenue
from gold.vw_shopify_order_items_exploded_priced_enriched e
where e.order_id = (select order_id from gold.fct_shopify_orders where brand = ${literalSql(marca)} and order_number = ${numero} order by order_id desc limit 1)
order by e.line_item_id, e.effective_sku`;
}

/**
 * O pedido e os itens no Tiny de UM CD (o `_sp` não tem pedido desde jul/2026 e não é lido). O `filtro` é o `where`
 * sobre `p`, já com os literais.
 */
function sqlDoTinyDoCd(cd: Cd, filtro: string): string {
    return `select '${cd}' as cd, p.id_pedido, p.id_nota_fiscal, p.data_pedido, coalesce(p.codigo_rastreamento, '') <> '' as tem_rastreio, i.codigo_produto, i.descricao_produto, i.quantidade_produto
from api.tiny_pedidos_ap_cosmetics_${cd} p left join api.tiny_pedidos_ap_cosmetics_${cd}_itens i on i.id_pedido = p.id_pedido
where ${filtro}`;
}

/** O pedido do Tiny pelo `id_pedido` (o `external_erp_id` da Intelipost): ES e RJ numa consulta só. Medida: 0,6 s. */
export function sqlDoTinyPorId(idPedido: string): string {
    const filtro = `p.id_pedido = ${literalSql(idPedido)}`;
    return `${sqlDoTinyDoCd('es', filtro)}
union all
${sqlDoTinyDoCd('rj', filtro)}`;
}

/**
 * O pedido do Tiny de um CD pela data e pelo `numero_ecommerce`. A data é obrigatória: só pelo `numero_ecommerce` a
 * consulta varre a tabela inteira. Uma consulta por CD: o `union all` dos dois levou 15,3 s, e cada um sozinho, menos.
 */
export function sqlDoTinyPorData(cd: Cd, de: string, ate: string, numero: string): string {
    return sqlDoTinyDoCd(cd, `p.data_pedido >= ${literalSql(de)} and p.data_pedido <= ${literalSql(ate)} and p.numero_ecommerce = ${literalSql(numero)}`);
}

/** A NF com os itens, na tabela do CD; o `filtro` é o `where` sobre `n`. */
function sqlDaNota(cd: Cd, filtro: string): string {
    return `select n.id_nota, n.numero_nota, n.descricao_situacao, n.valor_nota, n.valor_produtos, n.valor_desconto, n.valor_frete, coalesce(n.codigo_rastreamento, '') <> '' as tem_rastreio, i.codigo_produto, i.quantidade_produto, i.valor_unitario_produto
from api.tiny_nfe_ap_cosmetics_${cd} n left join api.tiny_nfe_ap_cosmetics_${cd}_itens i on i.id_nota = n.id_nota
where ${filtro}`;
}

/** A NF pelo `id_nota_fiscal` do pedido do Tiny. */
export function sqlDaNotaPorId(cd: Cd, idNota: string): string {
    return sqlDaNota(cd, `n.id_nota = ${literalSql(idNota)}`);
}

/** A NF por uma faixa de `id_nota` a partir do id do pedido, pelo número da NF que a Intelipost deu. */
export function sqlDaNotaPorFaixa(cd: Cd, de: string, ate: string, numeroDaNf: string): string {
    return sqlDaNota(cd, `n.id_nota >= ${literalSql(de)} and n.id_nota <= ${literalSql(ate)} and n.numero_nota = ${literalSql(numeroDaNf)}`);
}

// ── A conversão das linhas (as colunas vêm por posição, na ordem do SELECT) ─────────────────────────────────────────

/** Os números do Tiny vêm como texto (`'305.70'`, `'1.0'`); o que não é número vira 0. */
function numero(valor: unknown): number {
    const convertido = Number(valor);
    return Number.isFinite(convertido) ? convertido : 0;
}

/** Texto aparado; vazio ou ausente vira `null`. */
function texto(valor: unknown): string | null {
    if (valor === null || valor === undefined) return null;
    const aparado = String(valor).trim();
    return aparado === '' ? null : aparado;
}

/** Id que entra em SQL: só dígitos. Qualquer outra coisa conta como ausente. */
function idNumerico(valor: unknown): string | null {
    const id = texto(valor);
    return id !== null && /^\d+$/.test(id) ? id : null;
}

function remessas(linhas: unknown[][]): RemessaIntelipost[] {
    return linhas.map(([nf, uf, erp, despachada, entregue, rastreio]) => ({
        nf: texto(nf),
        ufOrigem: texto(uf),
        idPedidoTiny: idNumerico(erp),
        despachadaEm: texto(despachada),
        entregueEm: texto(entregue),
        temRastreio: rastreio === true,
    }));
}

function pedidoNaShopify(linhas: unknown[][]): PedidoNaShopify | null {
    const linha = linhas[0];
    if (!linha) return null;
    const [orderId, criadoEm, total, frete, cancelado, rastreio] = linha;
    return {
        orderId: String(orderId),
        criadoEm: texto(criadoEm),
        total: numero(total),
        frete: numero(frete),
        cancelado: cancelado === true,
        temRastreio: rastreio === true,
    };
}

function explodidas(linhas: unknown[][]): LinhaExplodida[] {
    return linhas.map(([skuDaLinha, sku, componente, qtdPorKit, unidades, receita]) => ({
        skuDaLinha: texto(skuDaLinha) ?? '',
        sku: texto(sku) ?? '',
        componenteDeKit: componente === true,
        qtdPorKit: numero(qtdPorKit),
        unidades: numero(unidades),
        receita: numero(receita),
    }));
}

/** O `id_nota_fiscal` do Tiny: `0` e vazio querem dizer "sem NF". */
function idDaNotaNoPedido(valor: unknown): string | null {
    const id = texto(valor);
    return id === null || id === '0' ? null : id;
}

/**
 * Os pedidos do Tiny: uma linha por item, agrupadas por (CD, `id_pedido`), o ES antes do RJ. O pedido sem itens (o
 * `left join` devolve uma linha com `codigo_produto` nulo) entra com a lista vazia; o item nulo, não.
 */
function pedidosNoTiny(linhas: unknown[][]): PedidoNoTiny[] {
    const pedidos = new Map<string, PedidoNoTiny>();
    for (const [cd, idPedido, idNota, data, rastreio, codigo, descricao, quantidade] of linhas) {
        if (cd !== 'es' && cd !== 'rj') continue;
        const id = String(idPedido).trim();
        const chave = `${cd}|${id}`;
        let pedido = pedidos.get(chave);
        if (!pedido) {
            pedido = {
                cd,
                idPedido: id,
                idNotaFiscal: idDaNotaNoPedido(idNota),
                dataPedido: texto(data)?.slice(0, 10) ?? null,
                temRastreio: rastreio === true,
                itens: [],
            };
            pedidos.set(chave, pedido);
        }
        const sku = texto(codigo);
        if (sku !== null) pedido.itens.push({ sku, descricao: texto(descricao) ?? '', quantidade: numero(quantidade) });
    }
    // O `union all` não promete ordem: o ES vem antes do RJ (a ordem é estável dentro de cada CD).
    return [...pedidos.values()].sort((a, b) => Number(b.cd === 'es') - Number(a.cd === 'es'));
}

/** As NFs da consulta (uma linha por item), na ordem em que apareceram. */
function notasNoTiny(linhas: unknown[][]): NotaNoTiny[] {
    const notas = new Map<string, NotaNoTiny>();
    for (const [idNota, numeroDaNota, situacao, total, produtos, desconto, frete, rastreio, codigo, quantidade, preco] of linhas) {
        const chave = String(idNota);
        let nota = notas.get(chave);
        if (!nota) {
            nota = {
                numero: texto(numeroDaNota) ?? '',
                situacao: texto(situacao),
                total: numero(total),
                produtos: numero(produtos),
                desconto: numero(desconto),
                frete: numero(frete),
                temRastreio: rastreio === true,
                itens: [],
            };
            notas.set(chave, nota);
        }
        const sku = texto(codigo);
        if (sku !== null) nota.itens.push({ sku, quantidade: numero(quantidade), precoUnitario: numero(preco) });
    }
    return [...notas.values()];
}

/** Achou mais de uma NF com o mesmo número: vale a que não está cancelada. */
function notaEscolhida(notas: NotaNoTiny[]): NotaNoTiny | null {
    return notas.find((nota) => !/cancel/i.test(nota.situacao ?? '')) ?? notas[0] ?? null;
}

/** `aaaa-mm-dd` mais ou menos `dias`, em UTC ao meio-dia (a virada de horário de verão não desloca o dia). `null` se a data não existe. */
function somarDias(data: string, dias: number): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return null;
    const instante = new Date(`${data}T12:00:00Z`);
    if (Number.isNaN(instante.getTime())) return null;
    instante.setUTCDate(instante.getUTCDate() + dias);
    return instante.toISOString().slice(0, 10);
}

// ── A leitura ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Contexto {
    consultar: (sql: string, opcoes?: OpcoesDaConsulta) => Promise<unknown[][]>;
    agora: () => number;
    prazo: number;
    /** O nome e o motivo de cada consulta que não deu certo, para o log. */
    falhas: string[];
}

/**
 * Uma consulta com o que sobra do prazo: o teto é o de 5 s do cliente ou o que resta, o que for menor. As lentas (o Tiny
 * por data e a NF por faixa, medidas em 15,3 s e 7,9 s) pedem `semTeto` e levam tudo o que resta. Sobrando menos de 500 ms, não sai.
 */
async function ler<T>(
    ctx: Contexto,
    nome: string,
    sql: string,
    converter: (linhas: unknown[][]) => T,
    opcoes: { semTeto?: boolean } = {},
): Promise<Leitura<T>> {
    const restante = ctx.prazo - ctx.agora();
    if (restante < MIN_PRAZO_DA_CONSULTA_MS) return falhou(ctx, nome, 'prazo esgotado antes da consulta');
    const timeoutMs = opcoes.semTeto ? restante : Math.min(METABASE_TIMEOUT_MS, restante);
    try {
        return { ok: true, dados: converter(await ctx.consultar(sql, { timeoutMs })) };
    } catch (erro) {
        return falhou(ctx, nome, (erro instanceof Error ? erro.message : String(erro)).slice(0, 200));
    }
}

function falhou<T>(ctx: Contexto, nome: string, motivo: string): Leitura<T> {
    ctx.falhas.push(`${nome} (${motivo})`);
    return { ok: false, motivo };
}

/** O pedido no Tiny: pelo id da Intelipost; sem ele, pela data da Shopify e pelo número; sem nenhum dos dois, não se sabe. */
async function lerPedidoNoTiny(
    ctx: Contexto,
    numeroDoPedido: string,
    rem0: RemessaIntelipost | undefined,
    shopify: Leitura<PedidoNaShopify | null>,
): Promise<Leitura<PedidoNoTiny[]>> {
    if (rem0?.idPedidoTiny) return ler(ctx, 'tiny', sqlDoTinyPorId(rem0.idPedidoTiny), pedidosNoTiny);
    if (shopify.ok) {
        // O pedido não está na Shopify do Data Mart: então não há o que procurar no Tiny.
        if (shopify.dados === null) return { ok: true, dados: [] };
        const criado = shopify.dados.criadoEm?.slice(0, 10) ?? '';
        const de = somarDias(criado, -DIAS_ANTES_NO_TINY);
        const ate = somarDias(criado, DIAS_DEPOIS_NO_TINY);
        if (de !== null && ate !== null) {
            // Sem o teto de 5 s, só o prazo: medidos pelo Metabase, o ES e o RJ juntos levaram 15,3 s; um por vez, em
            // paralelo, cabem no prazo da rota. Só é `ok` se os dois CDs responderem: um que falta pode ser o do pedido.
            const [es, rj] = await Promise.all((['es', 'rj'] as const).map(
                (cd) => ler(ctx, `tiny ${cd}`, sqlDoTinyPorData(cd, de, ate, numeroDoPedido), pedidosNoTiny, { semTeto: true }),
            ));
            if (!es.ok) return es;
            if (!rj.ok) return rj;
            return { ok: true, dados: [...es.dados, ...rj.dados] };
        }
    }
    return falhou(ctx, 'tiny', 'sem o id do Tiny nem a data da Shopify');
}

/** A NF de venda do pedido escolhido no Tiny: pelo id da NF, ou por faixa com o número da NF da Intelipost. */
async function lerNota(
    ctx: Contexto,
    rem0: RemessaIntelipost | undefined,
    tiny: Leitura<PedidoNoTiny[]>,
): Promise<Leitura<NotaNoTiny | null>> {
    if (!tiny.ok) return falhou(ctx, 'nota', 'o pedido do Tiny não foi lido');
    const escolhido = pedidoEscolhidoNoTiny(tiny.dados);
    if (!escolhido) return { ok: true, dados: null };

    const idDaNota = idNumerico(escolhido.idNotaFiscal);
    if (idDaNota) {
        return ler(ctx, 'nota', sqlDaNotaPorId(escolhido.cd, idDaNota), (linhas) => notaEscolhida(notasNoTiny(linhas)));
    }
    if (!rem0?.nf) return { ok: true, dados: null };

    const idDoPedido = idNumerico(escolhido.idPedido);
    for (const largura of LARGURAS_DA_FAIXA) {
        if (idDoPedido === null) break;
        const limite = String(Number(idDoPedido) + largura);
        // O `id_nota` é texto no Data Mart, e texto compara caractere a caractere: a faixa só vale quando os dois
        // limites têm o mesmo tamanho. Se somar a largura muda o número de dígitos (999.999.999 + 1,5 milhão), a faixa
        // é inválida e conta como "não achou", em vez de comparar '1000000000' com '999999999' e errar em silêncio.
        if (limite.length !== idDoPedido.length) continue;
        // Sem o teto de 5 s: a faixa de 1,5 milhão levou 7,9 s no Metabase, e a de 6 milhões, mais.
        const achada = await ler(ctx, 'nota', sqlDaNotaPorFaixa(escolhido.cd, idDoPedido, limite, rem0.nf), (linhas) => notaEscolhida(notasNoTiny(linhas)), { semTeto: true });
        if (!achada.ok || achada.dados !== null) return achada;
    }
    return { ok: true, dados: null };
}

/**
 * Lê o pedido no Data Mart. `numero` é só os dígitos (quem chama já extraiu de `SH1731559AP`); `prazo` é o instante-limite
 * (`Date.now()` + o que a rota pode gastar). Etapa 1, em paralelo: Intelipost, Shopify e explodidas. Só na Ápice, depois:
 * o pedido no Tiny (etapa 2) e a NF dele (etapa 3), que dependem das anteriores.
 */
export async function lerPedidoNoDataMart(
    marca: MarcaSemCosmosComPlanilha,
    numeroDoPedido: string,
    prazo: number,
    deps: DepsDaLeitura = {},
): Promise<LeiturasDoPedido> {
    const agora = deps.agora ?? Date.now;
    const comTiny = marca === 'apice';

    if (!/^\d{1,12}$/.test(numeroDoPedido)) {
        const invalida = { ok: false, motivo: 'número do pedido inválido' } as const;
        return {
            marca,
            numero: numeroDoPedido,
            intelipost: invalida,
            shopify: invalida,
            explodidas: invalida,
            ...(comTiny ? { tiny: invalida, nota: invalida } : {}),
        };
    }

    const inicio = agora();
    const ctx: Contexto = { consultar: deps.consultar ?? consultarDataMart, agora, prazo, falhas: [] };

    const [intelipost, shopify, explodidasLidas] = await Promise.all([
        ler(ctx, 'intelipost', sqlDaIntelipost(marca, numeroDoPedido), remessas),
        ler(ctx, 'shopify', sqlDaShopify(marca, numeroDoPedido), pedidoNaShopify),
        ler(ctx, 'explodidas', sqlDasExplodidas(marca, numeroDoPedido), explodidas),
    ]);
    const leituras: LeiturasDoPedido = { marca, numero: numeroDoPedido, intelipost, shopify, explodidas: explodidasLidas };

    if (comTiny) {
        const rem0 = intelipost.ok ? intelipost.dados[0] : undefined;
        leituras.tiny = await lerPedidoNoTiny(ctx, numeroDoPedido, rem0, shopify);
        leituras.nota = await lerNota(ctx, rem0, leituras.tiny);
    }

    console.log(`${LOG} ${marca} ${numeroDoPedido}: ${agora() - inicio} ms${ctx.falhas.length > 0 ? `; falharam: ${ctx.falhas.join(', ')}` : ''}`);
    return leituras;
}
