import type { MarcaCxHub, SupportedBrand } from '../constants';

export type TipoCasoCxhub = 'REENVIO' | 'REEMBOLSO' | 'CANCELAMENTO';

/**
 * Um caso do `conf.casos` da DAG `gobeaute_reenvio_reembolso_etl`, que grava a
 * `gold.fct_reenvio_reembolso_gobeaute` (a base que o Metabase lê).
 *
 * O contrato é o do guia da DAG no repo do Airflow (`docs/cx/GUIA_DAG_GOBEAUTE_REENVIO_REEMBOLSO.md`,
 * seção 1) e os nomes são os de `registro_do_cxhub`: mudar um nome aqui é mudar o contrato dos dois lados.
 * Campo ausente vira coluna vazia; quem limpa e normaliza o valor é a DAG.
 */
export interface CasoCxhub {
    /** Vira `chave_unica = cxhub|<id>` e o `dag_run_id = cxhub__<id>`. Único por solicitação. */
    id_solicitacao: string;
    tipo: TipoCasoCxhub;
    marca: MarcaCxHub;
    /** ISO 8601 com offset. */
    criado_em: string;
    numero_pedido: string;
    /** Data da compra do pedido original, dd/mm/aaaa. Sem ela, a DAG de acompanhamento busca na Shopify. */
    data_pedido?: string;
    nf?: string;
    chave_nf?: string;
    /** Número, ou texto em formato BR ("R$ 112,84") — a DAG aceita os dois. */
    valor?: number | string;
    motivo?: string;
    /** Só reenvio: "SKU1;SKU2". */
    skus?: string;
    // Nome, cidade e CEP do cliente NÃO vão: a raw os descarta, mas o `conf` fica no metadado do Airflow e
    // aparece na tela dele. Quem precisa do endereço busca o pedido no Cosmos ou na Shopify (ADR-008).
    uf?: string;
    cd_origem?: string;
    status_pedido?: string;
    transportadora?: string;
    lote?: string;
    erp?: string;
    pedido_completo?: boolean;
    devolucao?: boolean;
    responsavel?: string;
    origem?: string;
    id_atendimento?: string;
    /** Só reenvio: `true` quando a solicitação foi ao Cosmos pela automação. */
    automacao?: boolean;
    // ─── O que a planilha guardava e a gold não (ADR-008). Dependem da mudança na DAG: até ela aceitar, a
    // criação os descarta em silêncio. Ver `contrato.ts`.
    // As observações do agente NÃO vão: texto livre traz nome, telefone e endereço, e a gold é lida pela API do
    // data mart — a DAG já não lê essa coluna nem nas planilhas de cancelamento.
    /** Só reenvio: o que vai na caixa ("SKU - qtd;…"), a escolha do agente. */
    produtos_reenvio?: string;
    /** Só reenvio: a transportadora escolhida para o reenvio (a `transportadora` é a do pedido original). */
    transportadora_reenvio?: string;
    /** Só reenvio: `Reenvio` ou `Cashback` — o cashback sai do mesmo formulário e conta como REENVIO no `tipo`. */
    tipo_solicitacao?: string;
    /** Só reembolso: itens e frete reembolsados ("SKU01 - 1;Frete"). */
    escopo_reembolso?: string;
    /** Só reembolso: feito fora da política. O Bot nunca reembolsa como exceção. */
    excecao_politica?: boolean;
    /** Reenvio e reembolso: o ticket aberto com a transportadora. */
    ticket_transportadora?: string;
    /** Só cancelamento: a tratativa que o acompanha (`Reenvio` ou `Reembolso`). */
    tratativa?: string;
}

export type StatusExecucaoCxhub = 'Realizado' | 'Cancelado' | 'Pendente';

/**
 * Uma atualização do `conf.atualizacoes` (cancelar, editar, marcar a execução), sem o `id_solicitacao`. Só
 * mudam as colunas que vierem; campo fora do contrato faz a DAG falhar o run sem retry. Tipo, marca, data e
 * pedido não entram: mudar qualquer um deles é abrir outro caso (guia da DAG, seção 1).
 */
export type AtualizacaoCxhub = Partial<Omit<CasoCxhub, 'id_solicitacao' | 'tipo' | 'marca' | 'criado_em' | 'numero_pedido' | 'automacao'>> & {
    status_execucao?: StatusExecucaoCxhub;
    /** dd/mm/aaaa ou aaaa-mm-dd. Com `Cancelado`, a DAG deixa vazia. */
    data_execucao?: string;
    /** Quem executou ou cancelou. */
    responsavel_execucao?: string;
    cod_nfd?: string;
};

/**
 * Como achar na gold o caso de uma alteração. O CX Hub não guarda o `id_solicitacao` da criação, então ele é
 * lido de volta da tabela, pelo Metabase, com a mesma régua que cada lado já usa para casar o caso.
 */
export type LocalizadorCasoGold =
    /** O pedido `-R-n` do Cosmos e quando ele foi criado: a janela do acompanhamento, vista do outro lado. */
    | { tipo: 'REENVIO'; marca: SupportedBrand; pedidoReenvio: string; reenvioCriadoEm: string }
    /** O pedido da solicitação: vale a mais recente, como o n8n faz para achar a linha na planilha. */
    | { tipo: 'REEMBOLSO'; marca: SupportedBrand; numeroPedido: string };

/** Uma alteração feita no CX Hub, pronta para virar atualização na gold. */
export interface AlteracaoGold {
    localizador: LocalizadorCasoGold;
    /** Vai no `dag_run_id` (`cxhub__<id>__<evento>__<instante>`), um run por evento. */
    evento: 'cancelado' | 'editado' | 'realizado';
    atualizacao: AtualizacaoCxhub;
}
