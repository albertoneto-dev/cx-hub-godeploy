import { repartirPeloMaiorResto } from '../centavos';
import { SUFIXO_DO_PEDIDO, type MarcaSemCosmosComPlanilha } from '../constants';
import { temNfNaShopify, type OrigemDaNf } from '../nfDaVenda';
import type {
    BaseDoValorDaNf,
    CampoConferido,
    ContextoDoPedido,
    ItemReenviado,
    KitDoPedido,
    LeiturasDaNfForaDoDataMart,
    LeiturasDoPedido,
    LinhaExplodida,
    MotivoDaNota,
    MotivoPorCampo,
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
 * O pedido do Tiny que vale quando a busca acha mais de um com o mesmo número (o cancelado e o refeito, nos dois CDs ou
 * no mesmo, ou a cópia importada de novo): o ativo antes do cancelado; entre eles, o que tem o id da NF (a cópia "Em
 * aberto" importada dias depois não tem, e não pode derrubar o pedido faturado); depois o de `data_pedido` mais recente;
 * e no empate, o do ES. `null` sem pedido. O escolhido só sai cancelado quando todos estão. O leitor usa esta mesma
 * escolha para ler a NF, então as duas pontas nunca divergem.
 */
export function pedidoEscolhidoNoTiny(pedidos: readonly PedidoNoTiny[]): PedidoNoTiny | null {
    let escolhido: PedidoNoTiny | null = null;
    for (const pedido of pedidos) {
        if (escolhido === null || valeMaisQue(pedido, escolhido)) escolhido = pedido;
    }
    return escolhido;
}

/** `a` vale mais que `b` (`pedidoEscolhidoNoTiny`)? No empate em tudo, fica `b`, que veio antes. */
function valeMaisQue(a: PedidoNoTiny, b: PedidoNoTiny): boolean {
    if (a.cancelado !== b.cancelado) return !a.cancelado;
    const aTemNf = a.idNotaFiscal !== null;
    if (aTemNf !== (b.idNotaFiscal !== null)) return aTemNf;
    const dataA = a.dataPedido ?? '';
    const dataB = b.dataPedido ?? '';
    if (dataA !== dataB) return dataA > dataB;
    return a.cd === 'es' && b.cd !== 'es';
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
 * A NF de venda da Ápice no Tiny, quando vale: a do pedido ativo (`pedidoEscolhidoNoTiny`), não cancelada. A NF de
 * pedido cancelado não vale, nem como NF nem como base do valor (o leitor nem a lê): o cancelado com NF autorizada quase
 * sempre foi refeito com outra NF (os 20 do RJ de 03 a 07/11/2026; 42 dos 56 do ES de 05 e 06/11). `null` nas outras marcas.
 */
function notaValidaNoTiny(leituras: LeiturasDoPedido): NotaNoTiny | null {
    if (leituras.marca !== 'apice') return null;
    const escolhido = pedidoEscolhidoNoTiny(leituras.tiny?.ok ? leituras.tiny.dados : []);
    const notaDados = leituras.nota?.ok ? leituras.nota.dados : null;
    return escolhido && !escolhido.cancelado && notaDados && !/cancel/i.test(notaDados.situacao ?? '') ? notaDados : null;
}

/**
 * O Data Mart deu a NF de venda (a da primeira remessa da Intelipost ou, na Ápice, a do Tiny)? Sem ela, a conferência
 * procura fora do Data Mart antes de concluir qualquer coisa (`LeiturasDaNfForaDoDataMart`). É a mesma régua dos dois
 * primeiros passos da NF em `derivarContextoDoPedido`.
 */
export function dataMartDeuANf(leituras: LeiturasDoPedido): boolean {
    const rem0 = leituras.intelipost.ok ? leituras.intelipost.dados[0] : undefined;
    return Boolean(rem0?.nf) || notaValidaNoTiny(leituras) !== null;
}

/** A NF achada fora do Data Mart, e onde: o metacampo da Shopify vale antes da Intelipost ao vivo. */
export function nfAchadaForaDoDataMart(fora: LeiturasDaNfForaDoDataMart | undefined): { nf: string; origem: OrigemDaNf } | null {
    if (fora?.shopify?.ok && fora.shopify.dados) return { nf: fora.shopify.dados, origem: 'shopify' };
    if (fora?.intelipost?.ok && fora.intelipost.dados) return { nf: fora.intelipost.dados, origem: 'intelipost' };
    return null;
}

/**
 * As fontes de fora do Data Mart responderam todas (sem NF)? O metacampo só conta nas marcas que o preenchem
 * (`temNfNaShopify`). Sem as leituras, não: quem não leu não pode afirmar que não há NF.
 */
function foraDoDataMartRespondeu(marca: MarcaSemCosmosComPlanilha, fora: LeiturasDaNfForaDoDataMart | undefined): boolean {
    if (!fora) return false;
    if (temNfNaShopify(marca) && fora.shopify?.ok !== true) return false;
    return fora.intelipost?.ok === true;
}

/**
 * O que se deriva das leituras do pedido: NF, CD, status sugerido, avisos, kits e a base do valor da NF de reenvio.
 *
 * A NF vale do Data Mart (a Intelipost do gold e, na Ápice, o Tiny); sem ela, do metacampo da Shopify ou da Intelipost
 * ao vivo (`foraDoDataMart`, 2026-11-19), com a `origem` de onde foi achada.
 *
 * A NF só fica `ausente`, e o servidor recusa a solicitação, com prova de que o pedido não foi faturado: o Data Mart a
 * dá (o pedido ativo sem o id da NF, a NF achada e cancelada, ou o pedido em lugar nenhum), e as fontes de fora
 * responderam sem NF. Na dúvida, fica `desconhecida` com o motivo: a tela pede a NF, e o servidor grava a que veio com
 * a nota do motivo. Leitura que falhou nunca vira "ausente": a NF e o CD ficam sem conferência, para a tela e a
 * planilha dizerem "não conferido" em vez de afirmar que não há NF ou CD.
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
    // O escolhido só sai cancelado quando todos estão: o pedido pode ter sido refeito fora do que a busca alcança.
    const soCancelados = escolhido?.cancelado === true;
    const ativo = soCancelados ? null : escolhido;
    const nota = ehApice ? leituras.nota : undefined;
    const notaDados = nota?.ok ? nota.dados : null;
    const notaValida = notaValidaNoTiny(leituras);
    const pedidoNaShopify = shopify.ok ? shopify.dados : null;
    const linhas = explodidas.ok ? explodidas.dados : [];
    const achadaFora = nfAchadaForaDoDataMart(leituras.foraDoDataMart);

    // NF: a da Intelipost vale primeiro; a Ápice tem o Tiny como reserva; fora do Data Mart, o metacampo da Shopify e a
    // Intelipost ao vivo.
    let nf: ContextoDoPedido['nf'];
    let avisoDaNf: string | null = null;
    const respondeuTudo = ehApice ? ip.ok && tinyOk && nota?.ok === true : ip.ok;
    if (rem0?.nf) {
        nf = { estado: 'achada', numero: rem0.nf, origem: 'datamart' };
    } else if (notaValida) {
        nf = { estado: 'achada', numero: notaValida.numero, origem: 'datamart' };
    } else if (achadaFora) {
        nf = { estado: 'achada', numero: achadaFora.nf, origem: achadaFora.origem };
    } else if (!respondeuTudo) {
        nf = { estado: 'desconhecida', numero: null, motivo: 'sem_resposta' };
    } else if (ativo?.idNotaFiscal && notaDados === null) {
        // O Tiny já deu o id da NF ao pedido; a tabela de NFs, que chega em lotes horas depois, ainda não a tem.
        nf = { estado: 'desconhecida', numero: null, motivo: 'nf_fora_do_data_mart' };
        avisoDaNf = `A NF deste pedido já foi emitida no Tiny do CD ${ativo.cd.toUpperCase()}, mas ainda não chegou ao Data Mart. `
            + 'Confira o número na Intelipost.';
    } else if (soCancelados) {
        nf = { estado: 'desconhecida', numero: null, motivo: 'pedido_cancelado_no_tiny' };
    } else if (!foraDoDataMartRespondeu(marca, leituras.foraDoDataMart)) {
        // O Data Mart prova que não há NF, mas ele chega atrasado (~1 h depois da Intelipost): sem a resposta das fontes
        // de fora, não dá para afirmar.
        nf = { estado: 'desconhecida', numero: null, motivo: 'sem_resposta', foraDoDataMart: true };
        avisoDaNf = 'O Data Mart ainda não tem a NF deste pedido, e '
            + `${temNfNaShopify(marca) ? 'a Shopify e a Intelipost não responderam' : 'a Intelipost não respondeu'} a tempo para confirmar. `
            + 'Confira o número na Intelipost; ao gravar, o servidor confere de novo.';
    } else {
        nf = { estado: 'ausente', numero: null };
        avisoDaNf = ehApice
            ? 'O pedido ainda não tem NF de venda autorizada no Tiny nem na Intelipost.'
            : temNfNaShopify(marca)
                ? 'A Intelipost e a Shopify ainda não têm a NF deste pedido (pedido pode não ter sido faturado).'
                : 'A Intelipost ainda não tem a NF deste pedido (pedido pode não ter sido faturado).';
    }

    // CD e os avisos que ele gera. O CD nunca sai de pedido cancelado: o refeito pode estar no outro CD.
    const avisosDoCd: string[] = [];
    const uf = rem0?.ufOrigem ? `CD ${rem0.ufOrigem.trim().toUpperCase()}` : null;
    let cd: ContextoDoPedido['cd'];
    if (marca === 'denavita') {
        cd = { valor: 'CD MG', conferido: true };
    } else if (ehApice && ativo) {
        const cdDoAtivo = ativo.cd.toUpperCase();
        cd = { valor: `CD ${cdDoAtivo}`, conferido: true };
        if (pedidosNoTiny.length > 1) {
            const achados = pedidosNoTiny.map((p) => `${p.cd.toUpperCase()}${p.cancelado ? ' cancelado' : ''}`).join(', ');
            avisosDoCd.push(new Set(pedidosNoTiny.map((p) => p.cd)).size > 1
                ? `Pedido encontrado em mais de um CD (${achados}); usando o CD ${cdDoAtivo}.`
                : `Pedido encontrado mais de uma vez no Tiny (${achados}); usando o CD ${cdDoAtivo}.`);
        }
    } else if (uf) {
        cd = { valor: uf, conferido: true };
    } else if (soCancelados && ip.ok) {
        cd = { valor: null, conferido: false, motivo: 'pedido_cancelado_no_tiny' };
    } else if (ehApice ? tinyOk && ip.ok : ip.ok) {
        cd = { valor: null, conferido: true };
        avisosDoCd.push(ehApice ? 'Não encontrei o CD de origem no Tiny nem na Intelipost.' : 'Não encontrei o CD de origem na Intelipost.');
    } else {
        cd = { valor: null, conferido: false, motivo: 'sem_resposta' };
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
    if (avisoDaNf) avisos.push(avisoDaNf);
    if (soCancelados) {
        const cds = [...new Set(pedidosNoTiny.map((p) => p.cd.toUpperCase()))];
        const onde = cds.length > 1 ? `dos CDs ${cds.join(' e ')}` : `do CD ${cds[0]} e pode ter sido refeito em outro CD`;
        // Sem a NF, a tela a pede: a do refeito está na Intelipost assim que ele sai.
        avisos.push(`O pedido está cancelado no Tiny ${onde}.${nf.estado === 'desconhecida' ? ' Confira a NF na Intelipost.' : ''}`);
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

const NOME_DO_CAMPO: Record<CampoConferido, string> = { cd: 'CD', nf: 'NF', valor: 'VALOR' };

/** O que a nota diz depois dos campos: por que eles não foram conferidos. */
const TEXTO_DO_MOTIVO: Record<MotivoDaNota, string> = {
    sem_resposta: 'DATA MART SEM RESPOSTA',
    nf_fora_do_data_mart: 'AINDA FORA DO DATA MART',
    pedido_cancelado_no_tiny: 'PEDIDO CANCELADO NO TINY',
    consulta_ao_vivo_sem_resposta: 'CONSULTA AO VIVO SEM RESPOSTA',
};

/**
 * A nota que vai na célula com o que não foi conferido e o porquê: `[CD/NF NÃO CONFERIDOS: DATA MART SEM RESPOSTA]`.
 * Os campos vão na ordem CD, NF, valor, sem repetir; o campo sem motivo em `motivos` ficou sem resposta. Motivos
 * diferentes viram uma nota cada: `[NF NÃO CONFERIDA: AINDA FORA DO DATA MART] [VALOR NÃO CONFERIDO: DATA MART SEM RESPOSTA]`.
 */
export function notaDeNaoConferido(campos: ReadonlyArray<CampoConferido>, motivos: MotivoPorCampo = {}): string {
    const porMotivo = new Map<MotivoDaNota, CampoConferido[]>();
    for (const campo of (['cd', 'nf', 'valor'] as const).filter((c) => campos.includes(c))) {
        const motivo = motivos[campo] ?? 'sem_resposta';
        porMotivo.set(motivo, [...(porMotivo.get(motivo) ?? []), campo]);
    }
    return [...porMotivo]
        .map(([motivo, grupo]) => {
            const concordancia = grupo.length > 1 ? 'NÃO CONFERIDOS' : grupo[0] === 'nf' ? 'NÃO CONFERIDA' : 'NÃO CONFERIDO';
            return `[${grupo.map((c) => NOME_DO_CAMPO[c]).join('/')} ${concordancia}: ${TEXTO_DO_MOTIVO[motivo]}]`;
        })
        .join(' ');
}

/**
 * O motivo da NF `desconhecida` e o do CD sem conferência: para a nota da planilha e para a order-context. A NF que só
 * as fontes de fora do Data Mart deixaram sem resposta ganha a nota delas, e não "DATA MART SEM RESPOSTA".
 */
export function motivosDoNaoConferido(contexto: ContextoDoPedido): MotivoPorCampo {
    const motivos: MotivoPorCampo = {};
    if (contexto.nf.estado === 'desconhecida') {
        motivos.nf = contexto.nf.foraDoDataMart ? 'consulta_ao_vivo_sem_resposta' : contexto.nf.motivo;
    }
    if (!contexto.cd.conferido) motivos.cd = contexto.cd.motivo;
    return motivos;
}
