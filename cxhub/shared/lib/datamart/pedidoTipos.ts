import type { MarcaSemCosmosComPlanilha } from '../constants';

/**
 * Os tipos da conferência do pedido das marcas sem Cosmos no Data Mart (ADR-018): o que cada consulta traz
 * (`pedidoServer.ts`, server-only) e o que as regras derivam disso (`pedido.ts`, puro). Só valem para Ápice, Yenzah e
 * Denavita (`MarcaSemCosmosComPlanilha`): a Gobeaute não tem planilha nem estas regras.
 */

/** O resultado de uma consulta: os dados, ou o motivo de não tê-los (erro do Metabase, prazo estourado). */
export type Leitura<T> = { ok: true; dados: T } | { ok: false; motivo: string };

/** Uma remessa da Intelipost (`gold.fct_intelipost_orders`), na ordem de criação: a primeira é a do pedido original. */
export interface RemessaIntelipost {
    /** `invoice_number`: o número da NF de venda */
    nf: string | null;
    /** `origin_state_code`: a UF do CD que despachou (`ES`, `RJ`, `MG`) */
    ufOrigem: string | null;
    /** `external_erp_id`: o `id_pedido` do Tiny (só a Ápice usa) */
    idPedidoTiny: string | null;
    /** `dispatched_at` */
    despachadaEm: string | null;
    /** `delivered_date` */
    entregueEm: string | null;
    /** `track_code` não vazio. O código em si não é lido. */
    temRastreio: boolean;
}

/** O pedido em `gold.fct_shopify_orders`, achado pela marca e pelo número. */
export interface PedidoNaShopify {
    orderId: string;
    /** `created_at` (ISO): a base da busca por data no Tiny da Ápice */
    criadoEm: string | null;
    /** `value_total`: o que a cliente pagou */
    total: number;
    /** `value_shipment`: o frete pago */
    frete: number;
    /** `cancelled_at` preenchido */
    cancelado: boolean;
    /** `track_code` não vazio */
    temRastreio: boolean;
}

/** Uma linha de `gold.vw_shopify_order_items_exploded_priced_enriched`: o componente de um kit, ou o item avulso. */
export interface LinhaExplodida {
    /** `source_sku`: o SKU da linha do pedido (o kit, ou o próprio item avulso) */
    skuDaLinha: string;
    /** `effective_sku`: o SKU que sai do CD (o componente, ou o próprio item) */
    sku: string;
    /** `is_kit_component` */
    componenteDeKit: boolean;
    /** `qty_per_kit`: unidades do componente em UM kit */
    qtdPorKit: number;
    /** `component_units`: unidades do componente na linha inteira (`qtdPorKit` × kits comprados) */
    unidades: number;
    /** `allocated_revenue`: o valor cheio da linha (preço de tabela), o peso do rateio do que foi pago */
    receita: number;
}

/** O pedido no Tiny da Ápice (`api.tiny_pedidos_ap_cosmetics_{es,rj}` e `_itens`). */
export interface PedidoNoTiny {
    /** A tabela em que o pedido está: é o CD de origem (ES = Estoca, Serra/ES; RJ = Unilog, AP COSMETICS FILIAL 2) */
    cd: 'es' | 'rj';
    idPedido: string;
    /** `id_nota_fiscal`; `'0'` e vazio viram `null` */
    idNotaFiscal: string | null;
    /** `data_pedido` (`aaaa-mm-dd`): desempata o pedido achado nos dois CDs (vale o mais recente) */
    dataPedido: string | null;
    /** `codigo_rastreamento` não vazio */
    temRastreio: boolean;
    /** Os itens como o Tiny os tem: o kit é uma linha só, com o SKU do kit */
    itens: Array<{ sku: string; descricao: string; quantidade: number }>;
}

/** A NF de venda no Tiny da Ápice (`api.tiny_nfe_ap_cosmetics_{cd}` e `_itens`): os itens já vêm por componente. */
export interface NotaNoTiny {
    /** `numero_nota` */
    numero: string;
    /** `descricao_situacao` (`Autorizada`, `Cancelada`…) */
    situacao: string | null;
    /** `valor_nota` */
    total: number;
    /** `valor_produtos` */
    produtos: number;
    /** `valor_desconto` */
    desconto: number;
    /** `valor_frete` */
    frete: number;
    /** `codigo_rastreamento` da NF não vazio */
    temRastreio: boolean;
    /** `codigo_produto`, `quantidade_produto`, `valor_unitario_produto` */
    itens: Array<{ sku: string; quantidade: number; precoUnitario: number }>;
}

/**
 * Tudo o que foi lido do pedido, consulta por consulta. `tiny` e `nota` só existem na Ápice (as outras não têm Tiny).
 * Uma leitura que não pôde nem começar (a anterior falhou, o prazo acabou) vem `{ ok: false }` com o motivo.
 */
export interface LeiturasDoPedido {
    marca: MarcaSemCosmosComPlanilha;
    /** Só os dígitos do número do pedido (`SH1731559AP` → `1731559`) */
    numero: string;
    intelipost: Leitura<RemessaIntelipost[]>;
    /** `null`: o pedido não está na `fct_shopify_orders` */
    shopify: Leitura<PedidoNaShopify | null>;
    explodidas: Leitura<LinhaExplodida[]>;
    /** Só na Ápice: os pedidos achados no Tiny — 0, 1, ou 2 quando o mesmo pedido está no ES e no RJ */
    tiny?: Leitura<PedidoNoTiny[]>;
    /**
     * Só na Ápice: a NF de venda do pedido escolhido no Tiny. `null` quando não há NF a ler (o pedido não está no Tiny,
     * ou está sem o id da NF e a Intelipost não deu o número para a busca por faixa) ou quando a busca não a achou.
     */
    nota?: Leitura<NotaNoTiny | null>;
}

/** `achada`: há NF de venda; `ausente`: o Data Mart respondeu e não há; `desconhecida`: uma leitura falhou. */
export type EstadoDaNf = 'achada' | 'ausente' | 'desconhecida';

/** Um kit do pedido e a composição dele: os componentes e as unidades de cada um em UM kit. */
export interface KitDoPedido {
    sku: string;
    componentes: Array<{ sku: string; quantidade: number }>;
}

/** A base do "Valor da NF de reenvio (R$)": a NF original (Ápice) ou o que foi pago (Yenzah e Denavita). */
export interface BaseDoValorDaNf {
    total: number;
    produtos: number;
    desconto: number;
    frete: number;
    /** Preço unitário por SKU de componente (ou de item avulso) */
    precos: Record<string, number>;
}

/** O que o servidor deriva do pedido: para gravar a solicitação e para a tela mostrar (`/api/datamart/order-context`). */
export interface ContextoDoPedido {
    marca: MarcaSemCosmosComPlanilha;
    /** Só os dígitos */
    numero: string;
    /** O número como a planilha o guarda: `SH1731559AP` */
    pedido: string;
    /** `numero` só com `estado: 'achada'` */
    nf: { estado: EstadoDaNf; numero: string | null };
    /** `CD ES`, `CD RJ` ou `CD MG`; `null` quando não se sabe. `conferido: false` quando foi porque uma leitura falhou. */
    cd: { valor: string | null; conferido: boolean };
    /** Um dos `STATUS_OPTIONS`, ou `null` */
    statusSugerido: string | null;
    avisos: string[];
    kits: KitDoPedido[];
    /** `null` quando o valor não tem base (sem NF original na Ápice, sem os valores pagos nas outras) */
    baseDoValor: BaseDoValorDaNf | null;
    /** `false` quando uma leitura de que a base depende falhou: o valor fica "não conferido", e não "em branco" */
    baseConferida: boolean;
    /** As unidades do pedido por SKU de componente (ou de item avulso): a régua do "pedido completo" */
    unidadesDoPedido: Record<string, number>;
}

/** Um item do pedido que vai no reenvio, como foi marcado: o kit inteiro (o SKU do kit) ou o componente, e a quantidade. */
export interface ItemReenviado {
    sku: string;
    quantidade: number;
}

/** O que a conferência no Data Mart deu para uma solicitação (`conferirPedidoNoDataMart`). */
export type Conferencia =
    /** A marca não tem a conferência: só Ápice, Yenzah e Denavita têm */
    | { tipo: 'nao_se_aplica' }
    /** Nada pôde ser conferido (o número do pedido fora do formato, uma falha inesperada): vale o que veio de quem chamou */
    | { tipo: 'nao_conferido'; motivo: string }
    | { tipo: 'lido'; contexto: ContextoDoPedido };

/** O que não pôde ser conferido no Data Mart: vai para a nota nas observações (`notaDeNaoConferido`). */
export type CampoConferido = 'cd' | 'nf' | 'valor';

/** O "Valor da NF de reenvio (R$)" de uma solicitação. */
export type ValorDaNfDeReenvio =
    | { tipo: 'calculado'; valor: number }
    /** O Data Mart respondeu, mas o valor não sai (item fora da NF, base ausente): a célula fica em branco para o backoffice */
    | { tipo: 'em_branco'; motivo: string }
    /** Uma leitura de que o valor depende falhou: vale o que veio de quem chamou */
    | { tipo: 'nao_conferido' };
