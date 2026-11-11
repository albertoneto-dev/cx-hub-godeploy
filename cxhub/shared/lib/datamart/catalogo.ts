/**
 * O catálogo de produtos avulsos das marcas sem Cosmos (ADR-016), lido do Data Mart: é dele que saem o mimo e o
 * produto substituto do reenvio da Ápice, da Yenzah e da Denavita, que não têm o catálogo do Cosmos.
 *
 * Aqui fica só o que é puro: o formato, as regras (portadas do app "Reenvio e Reembolso" que essas marcas usavam) e o
 * id. A leitura do Data Mart e o cache são do `catalogoServer.ts` (server-only, fora do barrel).
 */

/** Um produto do catálogo, no mesmo formato dos produtos do Cosmos (para a tela reaproveitar a busca). */
export interface CatalogoItem {
    id: number;
    sku: string;
    name: string;
    /** `preco_loja_ref` com 2 casas (`'59.90'`); `'0.00'` quando o Data Mart não tem preço. */
    price: string;
    is_kit: false;
    ativo: boolean;
}

/**
 * O nome que cita outra marca descarta a linha (o Data Mart atribui à marca produtos de outras, pelo SKU repetido).
 * São também as marcas que têm catálogo: a Gobeaute (o site multimarca, ADR-014) não tem produto próprio no Data Mart.
 */
const CITA_OUTRA_MARCA = {
    apice: /kokeshi|lescent|barbour|ritu[aá]ria|by ?samia|yenzah|denavita/i,
    yenzah: /kokeshi|lescent|barbour|ritu[aá]ria|by ?samia|[aá]pice|denavita/i,
    denavita: /kokeshi|lescent|barbour|ritu[aá]ria|by ?samia|[aá]pice|yenzah/i,
} as const;

export type MarcaDoCatalogo = keyof typeof CITA_OUTRA_MARCA;

export function ehMarcaDoCatalogo(marca: string): marca is MarcaDoCatalogo {
    return Object.prototype.hasOwnProperty.call(CITA_OUTRA_MARCA, marca);
}

/** O EAN que alguns nomes trazem na frente (`7898… - Shampoo`). */
const EAN_NA_FRENTE = /^\d{8,14}\s*-\s*/;
const SO_DIGITOS = /^\d+$/;

/** Uma linha de `gold.dim_produto_gobeauty` (só os avulsos da marca). */
export interface LinhaDoDataMart {
    sku: string;
    nome: string;
    ativo: boolean;
    codigoShopify: string | null;
    /** `preco_loja_ref` como o Metabase devolve (número, texto ou nulo). */
    preco: number | string | null;
}

/** Um código do Tiny da Ápice (`api.vw_tiny_cadastro_produtos`, empresas `AP COSMETICS…`), já agrupado. */
export interface LinhaDoTiny {
    codigo: string;
    /** O nome da linha que vale para o código (a ativa mais recente). */
    nome: string;
    /** Alguma linha do código com situação diferente de `'I'`. Falso ⇒ inativo em todas as empresas. */
    ativo: boolean;
}

/** O nome sem espaços nas pontas e sem o EAN da frente. */
export function limparNome(nome: string): string {
    return nome.trim().replace(EAN_NA_FRENTE, '').trim();
}

/** O preço com 2 casas, em texto; sem preço (ou ilegível) ⇒ `'0.00'`. */
export function precoDoCatalogo(preco: number | string | null | undefined): string {
    if (preco === null || preco === undefined || preco === '') return '0.00';
    const valor = Number(preco);
    return Number.isFinite(valor) ? valor.toFixed(2) : '0.00';
}

/** FNV-1a de 32 bits sobre os bytes UTF-8 do texto, sem sinal (0 a 2³²−1). */
export function fnv1a32(texto: string): number {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(texto)) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * O id de cada SKU: `fnv1a32(sku)`, estável entre leituras. Colisão (ou id 0) se resolve de forma determinística: os SKUs
 * são percorridos em ordem crescente (comparação simples de texto), e o que chega a um id já usado passa a
 * `fnv1a32(sku + '#1')`, `'#2'`… até achar um livre.
 */
export function idsDosSkus(skus: Iterable<string>): Map<string, number> {
    const ids = new Map<string, number>();
    const usados = new Set<number>();
    for (const sku of [...new Set(skus)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        let id = fnv1a32(sku);
        for (let n = 1; id === 0 || usados.has(id); n++) id = fnv1a32(`${sku}#${n}`);
        usados.add(id);
        ids.set(sku, id);
    }
    return ids;
}

type ItemSemId = Omit<CatalogoItem, 'id'>;

/**
 * Só Ápice: o Tiny por cima do Data Mart. Para o mesmo SKU vale o nome do Tiny; o SKU numérico que só existe no Tiny
 * entra (ativo, sem preço), menos o de nome começando com "kit"; e o SKU que aparece no Tiny inativo em todas as
 * empresas sai.
 */
function comOTiny(itens: ItemSemId[], tiny: LinhaDoTiny[]): ItemSemId[] {
    const doTiny = new Map<string, LinhaDoTiny>();
    for (const linha of tiny) {
        const codigo = linha.codigo.trim();
        if (SO_DIGITOS.test(codigo) && !doTiny.has(codigo)) doTiny.set(codigo, linha);
    }

    const resultado = itens.map((item) => {
        const nomeNoTiny = doTiny.has(item.sku) ? limparNome(doTiny.get(item.sku)!.nome) : '';
        return nomeNoTiny ? { ...item, name: nomeNoTiny } : item;
    });
    const noDataMart = new Set(itens.map((item) => item.sku));
    for (const [codigo, linha] of doTiny) {
        const nome = limparNome(linha.nome);
        if (noDataMart.has(codigo) || /^kit/i.test(nome)) continue;
        resultado.push({ sku: codigo, name: nome, price: '0.00', is_kit: false, ativo: true });
    }
    return resultado.filter((item) => doTiny.get(item.sku)?.ativo !== false);
}

/**
 * O catálogo da marca a partir das linhas do Data Mart (e, na Ápice, do Tiny), com as regras do app antigo, nesta
 * ordem:
 * 1. descarta a linha cujo nome cita outra marca (`CITA_OUTRA_MARCA`) e tira o EAN da frente do nome;
 * 2. só Ápice: o SKU precisa ser numérico — senão vale o `codigo_shopify` numérico, e sem ele a linha sai;
 * 3. só Ápice: o Tiny por cima (`comOTiny`);
 * 4. um item por SKU, preferindo o ativo (empate: o primeiro na ordem das linhas, que a consulta ordena pelo SKU);
 * 5. ativos primeiro, depois pelo nome (`localeCompare` pt-BR) e, no empate, pelo SKU;
 * 6. o id de cada SKU (`idsDosSkus`).
 */
export function montarCatalogo(marca: MarcaDoCatalogo, linhas: LinhaDoDataMart[], tiny: LinhaDoTiny[] = []): CatalogoItem[] {
    const itens: ItemSemId[] = [];
    for (const linha of linhas) {
        if (CITA_OUTRA_MARCA[marca].test(linha.nome)) continue;
        let sku = linha.sku.trim();
        if (marca === 'apice' && !SO_DIGITOS.test(sku)) {
            sku = (linha.codigoShopify ?? '').trim();
            if (!SO_DIGITOS.test(sku)) continue;
        }
        if (!sku) continue;
        itens.push({ sku, name: limparNome(linha.nome), price: precoDoCatalogo(linha.preco), is_kit: false, ativo: linha.ativo });
    }

    const porSku = new Map<string, ItemSemId>();
    for (const item of marca === 'apice' ? comOTiny(itens, tiny) : itens) {
        const anterior = porSku.get(item.sku);
        if (!anterior || (!anterior.ativo && item.ativo)) porSku.set(item.sku, item);
    }

    const ids = idsDosSkus(porSku.keys());
    return [...porSku.values()]
        .sort((a, b) =>
            Number(b.ativo) - Number(a.ativo)
            || a.name.localeCompare(b.name, 'pt-BR')
            || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
        .map((item) => ({ id: ids.get(item.sku)!, ...item }));
}
