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
    /** `data_pedido` (`aaaa-mm-dd`): um dos desempates quando a busca acha mais de um pedido (`pedidoEscolhidoNoTiny`) */
    dataPedido: string | null;
    /**
     * `situacao` com "cancel" (`Cancelado`). Muito pedido cancelado é refeito, e então vale o refeito: 12.441 dos 30.654
     * cancelados no ES de 01/10 a 09/11/2026 foram refeitos no RJ. O CD e a NF nunca saem do pedido cancelado.
     */
    cancelado: boolean;
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
    /**
     * Só na Ápice: os pedidos achados no Tiny — 0, 1, ou mais quando o mesmo número aparece de novo (nos dois CDs,
     * cancelado e refeito, ou importado outra vez)
     */
    tiny?: Leitura<PedidoNoTiny[]>;
    /**
     * Só na Ápice: a NF de venda do pedido escolhido no Tiny. `null` quando não há NF a ler (o pedido não está no Tiny,
     * está cancelado, ou está sem o id da NF e a Intelipost não deu o número para a busca por faixa) ou quando a busca
     * não a achou (inclusive a NF que o Tiny já emitiu e ainda não chegou à tabela de NFs).
     */
    nota?: Leitura<NotaNoTiny | null>;
}

/**
 * `achada`: há NF de venda. `ausente`: o Data Mart prova que o pedido não foi faturado (o pedido ativo sem o id da NF, a
 * NF achada e cancelada, ou o pedido em lugar nenhum), e o servidor recusa a solicitação. `desconhecida`: não dá para
 * afirmar; o motivo vem junto (`MotivoDoNaoConferido`).
 */
export type EstadoDaNf = 'achada' | 'ausente' | 'desconhecida';

/**
 * Por que a NF ou o CD ficaram sem conferência no Data Mart. Vai na nota da planilha e no `nfMotivo` da order-context:
 * - `sem_resposta`: uma leitura falhou ou passou do prazo;
 * - `nf_fora_do_data_mart`: o pedido ativo no Tiny já tem o id da NF, e a NF ainda não chegou à tabela de NFs (ela
 *   chega em lotes, horas depois);
 * - `pedido_cancelado_no_tiny`: o Tiny só tem o pedido cancelado, que pode ter sido refeito fora do que a busca alcança.
 */
export type MotivoDoNaoConferido = 'sem_resposta' | 'nf_fora_do_data_mart' | 'pedido_cancelado_no_tiny';

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
    /** `numero` só com `estado: 'achada'`, e o `motivo` só com `desconhecida` */
    nf:
        | { estado: 'achada'; numero: string }
        | { estado: 'ausente'; numero: null }
        | { estado: 'desconhecida'; numero: null; motivo: MotivoDoNaoConferido };
    /**
     * `CD ES`, `CD RJ` ou `CD MG`; `null` quando não se sabe. Sem conferência (`conferido: false`), vem o motivo:
     * uma leitura falhou, ou o Tiny só tem o pedido cancelado e a Intelipost não deu a UF.
     */
    cd: { valor: string | null; conferido: true } | { valor: null; conferido: false; motivo: MotivoDoNaoConferido };
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

/** O que não pôde ser conferido no Data Mart: vai para a nota nas observações (`notaDeNaoConferido`), com o motivo. */
export type CampoConferido = 'cd' | 'nf' | 'valor';

/** O motivo de cada campo sem conferência; o campo que não está aqui ficou sem resposta do Data Mart. */
export type MotivoPorCampo = Partial<Record<CampoConferido, MotivoDoNaoConferido>>;

/** O "Valor da NF de reenvio (R$)" de uma solicitação. */
export type ValorDaNfDeReenvio =
    | { tipo: 'calculado'; valor: number }
    /** O Data Mart respondeu, mas o valor não sai (item fora da NF, base ausente): a célula fica em branco para o backoffice */
    | { tipo: 'em_branco'; motivo: string }
    /** Uma leitura de que o valor depende falhou: vale o que veio de quem chamou */
    | { tipo: 'nao_conferido' };
