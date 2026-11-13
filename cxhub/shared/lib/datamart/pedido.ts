import { repartirPeloMaiorResto } from '../centavos';
import { SUFIXO_DO_PEDIDO, type MarcaSemCosmosComPlanilha } from '../constants';
import type {
    BaseDoValorDaNf,
    ContextoDoPedido,
    ItemReenviado,
    KitDoPedido,
    LeiturasDoPedido,
    LinhaExplodida,
    NotaNoTiny,
    PedidoNoTiny,
    ValorDaNfDeReenvio,
} from './pedidoTipos';

/**
 * As regras do pedido das marcas sem Cosmos (ADR-018), puras: o que o servidor deriva das leituras do Data Mart (NF, CD,
 * status sugerido, avisos, kits e o valor da NF de reenvio). A leitura fica em `pedidoServer.ts` (server-only); este
 * arquivo não faz I/O e roda também no navegador.
 */

/** Arredonda em centavos (o `EPSILON` evita que 1,005 caia para 1,00). */
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * O pedido do Tiny que vale quando ele está nos dois CDs (acontece com pedido refeito): o de `data_pedido` mais recente,
 * e no empate o primeiro da lista (o ES vem antes do RJ). `null` sem pedido. O leitor usa esta mesma escolha para ler a
 * NF, então as duas pontas nunca divergem.
 */
export function pedidoEscolhidoNoTiny(pedidos: readonly PedidoNoTiny[]): PedidoNoTiny | null {
    let escolhido: PedidoNoTiny | null = null;
    for (const pedido of pedidos) {
        if (escolhido === null || (pedido.dataPedido ?? '') > (escolhido.dataPedido ?? '')) escolhido = pedido;
    }
    return escolhido;
}

/** Só os dígitos do número do pedido; `null` quando não sobram entre 3 e 9 (não é número de pedido da Shopify). */
export function digitosDoPedido(texto: string | null | undefined): string | null {
    const digitos = (texto ?? '').replace(/\D/g, '');
    return digitos.length >= 3 && digitos.length <= 9 ? digitos : null;
}

/** O número do pedido como a planilha o guarda: `1731559` na Ápice vira `SH1731559AP`. */
export function pedidoDaPlanilha(marca: MarcaSemCosmosComPlanilha, numero: string): string {
    return `SH${numero}${SUFIXO_DO_PEDIDO[marca]}`;
}

/** Os kits do pedido, na ordem em que aparecem: cada um com os componentes únicos e as unidades de cada um em UM kit. */
function kitsDasLinhas(linhas: readonly LinhaExplodida[]): KitDoPedido[] {
    const porKit = new Map<string, KitDoPedido>();
    for (const linha of linhas) {
        if (!linha.componenteDeKit) continue;
        let kit = porKit.get(linha.skuDaLinha);
        if (!kit) {
            kit = { sku: linha.skuDaLinha, componentes: [] };
            porKit.set(linha.skuDaLinha, kit);
        }
        if (kit.componentes.some((c) => c.sku === linha.sku)) continue;
        const quantidade = Number.isInteger(linha.qtdPorKit) && linha.qtdPorKit >= 1 ? linha.qtdPorKit : 1;
        kit.componentes.push({ sku: linha.sku, quantidade });
    }
    return [...porKit.values()];
}

function somarPorSku(itens: ReadonlyArray<{ sku: string; quantidade: number }>): Record<string, number> {
    const soma: Record<string, number> = {};
    for (const { sku, quantidade } of itens) soma[sku] = (soma[sku] ?? 0) + quantidade;
    return soma;
}

/** A base do valor na Ápice: a NF de venda (autorizada) do Tiny, com o preço unitário de cada SKU dela. */
function baseDaNota(nota: NotaNoTiny): BaseDoValorDaNf | null {
    if (nota.itens.length === 0 || !(nota.produtos > 0)) return null;
    const precos: Record<string, number> = {};
    for (const item of nota.itens) {
        if (!(item.sku in precos)) precos[item.sku] = item.precoUnitario;
    }
    return { total: nota.total, produtos: nota.produtos, desconto: nota.desconto, frete: nota.frete, precos };
}

/**
 * A base do valor na Yenzah e na Denavita, que não têm NF no Data Mart: o que a cliente pagou pelos produtos
 * (`total − frete`) repartido entre as linhas na proporção do valor cheio delas, em centavos (a soma fecha), sem desconto
 * à parte porque o preço pago já o leva.
 */
function baseDoPago(total: number, frete: number, linhas: readonly LinhaExplodida[]): BaseDoValorDaNf | null {
    const alvo = Math.round((total - frete) * 100);
    const pesos = linhas.map((l) => Math.max(0, Math.round(l.receita * 100)));
    if (!(alvo > 0) || pesos.reduce((s, p) => s + p, 0) <= 0) return null;
    const centavos = repartirPeloMaiorResto(alvo, pesos);
    const precos: Record<string, number> = {};
    linhas.forEach((linha, i) => {
        if (linha.sku in precos) return;
        precos[linha.sku] = r2(centavos[i] / 100 / Math.max(1, linha.unidades));
    });
    return { total, produtos: alvo / 100, desconto: 0, frete, precos };
}

/**
 * O que se deriva das leituras do pedido: NF, CD, status sugerido, avisos, kits e a base do valor da NF de reenvio.
 * Leitura que falhou nunca vira "ausente": a NF e o CD ficam `desconhecida` e `conferido: false`, para a tela e a
 * planilha dizerem "não conferido" em vez de afirmar que o pedido não tem NF ou CD.
 */
export function derivarContextoDoPedido(leituras: LeiturasDoPedido): ContextoDoPedido {
    const { marca, numero, intelipost: ip, shopify, explodidas } = leituras;
    const ehApice = marca === 'apice';
    const remessas = ip.ok ? ip.dados : [];
    const rem0 = remessas[0];
    const tiny = ehApice ? leituras.tiny : undefined;
    const tinyOk = tiny?.ok === true;
    const pedidosNoTiny = tiny?.ok ? tiny.dados : [];
    const escolhido = pedidoEscolhidoNoTiny(pedidosNoTiny);
    const nota = ehApice ? leituras.nota : undefined;
    const notaDados = nota?.ok ? nota.dados : null;
    const notaValida = notaDados && !/cancel/i.test(notaDados.situacao ?? '') ? notaDados : null;
    const pedidoNaShopify = shopify.ok ? shopify.dados : null;
    const linhas = explodidas.ok ? explodidas.dados : [];

    // NF: a da Intelipost vale primeiro; a Ápice tem o Tiny como reserva.
    let nf: ContextoDoPedido['nf'];
    if (rem0?.nf) {
        nf = { estado: 'achada', numero: rem0.nf };
    } else if (notaValida) {
        nf = { estado: 'achada', numero: notaValida.numero };
    } else {
        const respondeuTudo = ehApice ? ip.ok && tinyOk && nota?.ok === true : ip.ok;
        nf = { estado: respondeuTudo ? 'ausente' : 'desconhecida', numero: null };
    }

    // CD e os avisos que ele gera.
    const avisosDoCd: string[] = [];
    const uf = rem0?.ufOrigem ? `CD ${rem0.ufOrigem.trim().toUpperCase()}` : null;
    let cd: ContextoDoPedido['cd'];
    if (marca === 'denavita') {
        cd = { valor: 'CD MG', conferido: true };
    } else if (ehApice && escolhido) {
        cd = { valor: `CD ${escolhido.cd.toUpperCase()}`, conferido: true };
        if (pedidosNoTiny.length > 1) {
            const cds = pedidosNoTiny.map((p) => p.cd.toUpperCase()).join(', ');
            avisosDoCd.push(`Pedido encontrado em mais de um CD (${cds}); usando o CD ${escolhido.cd.toUpperCase()}.`);
        }
    } else if (uf) {
        cd = { valor: uf, conferido: true };
    } else if (ehApice ? tinyOk && ip.ok : ip.ok) {
        cd = { valor: null, conferido: true };
        avisosDoCd.push(ehApice ? 'Não encontrei o CD de origem no Tiny nem na Intelipost.' : 'Não encontrei o CD de origem na Intelipost.');
    } else {
        cd = { valor: null, conferido: false };
    }

    const kits = explodidas.ok ? kitsDasLinhas(explodidas.dados) : [];

    // Base do valor e as unidades do pedido (a régua do "pedido completo").
    let baseDoValor: BaseDoValorDaNf | null = null;
    let unidadesDoPedido: Record<string, number> = {};
    let baseConferida: boolean;
    if (ehApice) {
        if (notaValida) {
            baseDoValor = baseDaNota(notaValida);
            if (baseDoValor) unidadesDoPedido = somarPorSku(notaValida.itens);
        }
        baseConferida = nota?.ok === true && explodidas.ok;
    } else {
        if (explodidas.ok) unidadesDoPedido = somarPorSku(linhas.map((l) => ({ sku: l.sku, quantidade: l.unidades })));
        if (pedidoNaShopify && explodidas.ok && linhas.length > 0) {
            baseDoValor = baseDoPago(pedidoNaShopify.total, pedidoNaShopify.frete, linhas);
        }
        baseConferida = shopify.ok && explodidas.ok;
    }

    // Status sugerido: só com a Intelipost respondendo, porque "sem remessa" só vale se ela respondeu.
    let statusSugerido: string | null = null;
    if (ip.ok) {
        const temRastreio =
            rem0?.temRastreio === true ||
            (ehApice
                ? escolhido?.temRastreio === true || notaDados?.temRastreio === true
                : pedidoNaShopify?.temRastreio === true);
        if (rem0?.entregueEm) statusSugerido = 'Cliente ficou com o pedido';
        else if (rem0?.despachadaEm) statusSugerido = 'Pedido não entregue (em trânsito)';
        else if (!temRastreio) statusSugerido = 'Pedido não foi enviado';
    }

    const avisos: string[] = [];
    if (nf.estado === 'ausente') {
        avisos.push(
            ehApice
                ? 'O pedido ainda não tem NF de venda autorizada no Tiny nem na Intelipost.'
                : 'A Intelipost ainda não tem a NF deste pedido (pedido pode não ter sido faturado).',
        );
    }
    avisos.push(...avisosDoCd);
    if (ip.ok && remessas.length > 1) {
        avisos.push(`A Intelipost tem ${remessas.length} remessas para este pedido; pode já existir um reenvio. Confira antes de solicitar.`);
    }
    if (shopify.ok && shopify.dados?.cancelado) avisos.push('Este pedido está cancelado na Shopify.');
    if (shopify.ok && shopify.dados === null) avisos.push('Não encontrei este pedido na Shopify (Data Mart).');
    if (ehApice) {
        const semComposicao =
            tinyOk &&
            explodidas.ok &&
            escolhido?.itens.some(
                (item) =>
                    /^kit\b|mimos/i.test(item.descricao) &&
                    !linhas.some((l) => l.componenteDeKit && l.skuDaLinha === item.sku),
            );
        if (semComposicao) {
            avisos.push('Não encontrei a composição de algum kit; ajuste os itens nas observações se precisar reenviar só parte dele.');
        }
    } else if (pedidoNaShopify && explodidas.ok && linhas.length === 0) {
        avisos.push(
            'Não encontrei os itens deste pedido no Data Mart: a composição dos kits e o valor da NF de reenvio ficam de fora.',
        );
    }

    return {
        marca,
        numero,
        pedido: pedidoDaPlanilha(marca, numero),
        nf,
        cd,
        statusSugerido,
        avisos,
        kits,
        baseDoValor,
        baseConferida,
        unidadesDoPedido,
    };
}

/**
 * O valor da NF de reenvio sobre a base: o pedido completo vale o total da NF; o reenvio parcial vale os produtos
 * reenviados (preço unitário × quantidade) mais a fatia proporcional do frete, menos a do desconto. `null` quando um
 * SKU não tem preço na base ou a base não tem o valor dos produtos.
 */
export function valorNfReenvio(base: BaseDoValorDaNf, itens: ItemReenviado[], completo: boolean): number | null {
    if (completo) return r2(base.total);
    let soma = 0;
    for (const { sku, quantidade } of itens) {
        const preco = base.precos[sku];
        if (preco === undefined) return null;
        soma += preco * quantidade;
    }
    soma = r2(soma);
    if (base.produtos === 0) return null;
    const fatia = soma / base.produtos;
    return r2(soma - r2(base.desconto * fatia) + r2(base.frete * fatia));
}

/** O "Valor da NF de reenvio (R$)": calculado, em branco (com o motivo) ou não conferido (uma leitura falhou). */
export function valorDaNfDeReenvio(contexto: ContextoDoPedido, itens: ItemReenviado[] | null): ValorDaNfDeReenvio {
    if (!contexto.baseConferida) return { tipo: 'nao_conferido' };
    if (itens === null) {
        return {
            tipo: 'em_branco',
            motivo: 'não deu para separar os itens originais do reenvio (mimo ou troca sem a lista estruturada, ou "Produto a reenviar" fora do formato)',
        };
    }
    const reenviados = itens.filter((item) => item.quantidade > 0);
    if (reenviados.length === 0) return { tipo: 'em_branco', motivo: 'nenhum item do pedido no reenvio' };
    const base = contexto.baseDoValor;
    if (base === null) {
        return {
            tipo: 'em_branco',
            motivo: contexto.marca === 'apice' ? 'sem a NF original no Tiny' : 'sem os valores pagos do pedido',
        };
    }

    // O kit vira os componentes: é neles que a NF e o preço estão.
    const kitPorSku = new Map(contexto.kits.map((k) => [k.sku, k]));
    const expandidos = new Map<string, number>();
    const somar = (sku: string, quantidade: number) => expandidos.set(sku, (expandidos.get(sku) ?? 0) + quantidade);
    for (const item of reenviados) {
        const kit = kitPorSku.get(item.sku);
        if (kit) for (const c of kit.componentes) somar(c.sku, c.quantidade * item.quantidade);
        else somar(item.sku, item.quantidade);
    }
    const itensExpandidos = [...expandidos].map(([sku, quantidade]) => ({ sku, quantidade }));

    const unidades = Object.entries(contexto.unidadesDoPedido);
    const completo = unidades.length > 0 && unidades.length === expandidos.size && unidades.every(([sku, q]) => expandidos.get(sku) === q);

    const valor = valorNfReenvio(base, itensExpandidos, completo);
    if (valor === null) {
        const semPreco = itensExpandidos.find((item) => base.precos[item.sku] === undefined);
        return {
            tipo: 'em_branco',
            motivo: semPreco ? `o SKU ${semPreco.sku} não está na NF original` : 'a NF original não tem o valor dos produtos',
        };
    }
    return { tipo: 'calculado', valor };
}

/** Os itens do campo "Produto a reenviar" (`SKU - qtd;SKU - qtd`); `null` quando vazio ou fora do formato. */
export function itensDoProdutoReenviar(texto: string | null | undefined): ItemReenviado[] | null {
    if (!texto || !texto.trim()) return null;
    const itens: ItemReenviado[] = [];
    for (const parte of texto.split(';')) {
        const m = /^(.+?)\s+-\s+(\d+)$/.exec(parte.trim());
        if (!m) return null;
        itens.push({ sku: m[1].trim(), quantidade: Number(m[2]) });
    }
    return itens;
}

/** O comentário tem as notas que a tela grava ao incluir mimo ou trocar item sem estoque (ADR-016). */
export function temMimoOuTroca(comentarios: string | null | undefined): boolean {
    const texto = comentarios ?? '';
    return texto.includes('incluído como mimo') || texto.includes('sem estoque substituído pelo SKU');
}

/**
 * Os itens do pedido original que foram reenviados. Com a lista estruturada, vale ela; sem ela, o texto de "Produto a
 * reenviar" só serve quando não há mimo nem troca, porque nesses casos ele mistura itens que não são do pedido original.
 */
export function itensOriginaisDoReenvio(dados: {
    itensOriginaisReenviados?: ItemReenviado[] | null;
    produtoReenviar?: string | null;
    comentarios?: string | null;
}): ItemReenviado[] | null {
    if (Array.isArray(dados.itensOriginaisReenviados)) {
        // A lista vem do JSON de quem chama: item fora do formato (sem SKU em texto, quantidade que não é número) fica de
        // fora em vez de derrubar o registro.
        const itens: unknown[] = dados.itensOriginaisReenviados;
        return itens.flatMap((item) => {
            const { sku, quantidade } = (item ?? {}) as Partial<Record<keyof ItemReenviado, unknown>>;
            return typeof sku === 'string' && sku.trim() !== '' && typeof quantidade === 'number' && Number.isFinite(quantidade) && quantidade > 0
                ? [{ sku: sku.trim(), quantidade }]
                : [];
        });
    }
    if (temMimoOuTroca(dados.comentarios)) return null;
    return itensDoProdutoReenviar(dados.produtoReenviar);
}

const semZerosAEsquerda = (texto: string) => texto.replace(/\D/g, '').replace(/^0+/, '');

/** A NF digitada difere da derivada? Compara só os dígitos, sem zeros à esquerda; digitada vazia não diverge. */
export function nfDiverge(digitada: string | null | undefined, derivada: string): boolean {
    const digitos = semZerosAEsquerda(digitada ?? '');
    return digitos !== '' && digitos !== semZerosAEsquerda(derivada);
}

/** A nota que vai na célula quando o Data Mart não respondeu: `[CD/NF NÃO CONFERIDOS: DATA MART SEM RESPOSTA]`. */
export function notaDeNaoConferido(campos: ReadonlyArray<'cd' | 'nf' | 'valor'>): string {
    const rotulos = (['cd', 'nf', 'valor'] as const).filter((c) => campos.includes(c));
    if (rotulos.length === 0) return '';
    const nomes = { cd: 'CD', nf: 'NF', valor: 'VALOR' };
    const concordancia =
        rotulos.length > 1 ? 'NÃO CONFERIDOS' : rotulos[0] === 'nf' ? 'NÃO CONFERIDA' : 'NÃO CONFERIDO';
    return `[${rotulos.map((c) => nomes[c]).join('/')} ${concordancia}: DATA MART SEM RESPOSTA]`;
}
