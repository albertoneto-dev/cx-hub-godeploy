// Os tipos que a API devolve e a tela lê. Uma linha da lista é uma linha da gold.fct_reenvio_reembolso_gobeaute (as
// colunas abaixo, com datas em texto) ou, quando a raw do CX Hub já a mudou e a gold ainda não, a mesma linha
// remontada da raw; por cima, as edições deste app que o Metabase ainda não mostra.

import type { DadosCliente } from "./campos";
import type { PedidoDoCaso, ProdutoDoCatalogo } from "./itens";

// As colunas que o app lê da gold, nesta ordem (a ordem do SELECT em servidor/gold.ts). Datas vêm como texto:
// data_solicitacao "2026-11-10T14:05:03.000000" (hora de São Paulo, sem fuso, como está na tabela), as datas
// "2026-11-10" e carregado_em em UTC ("...Z").
export const COLUNAS_GOLD = [
  "chave_unica", "sistema_origem", "tipo", "marca", "sigla", "data_solicitacao", "numero_pedido", "cod_nf_original",
  "chave_nf", "valor_nf_tratado", "sku_produto_problema", "produtos_reenvio", "escopo_reembolso", "motivo", "area",
  "uf_origem", "uf_destino", "status_ocorrencia", "transportadora", "transportadora_reenvio", "ticket_transportadora",
  "lote", "erp", "parcial_completo", "pedido_devolvido_operacao", "responsavel_atendimento", "origem_solicitacao",
  "id_atendimento", "tipo_solicitacao", "excecao_politica", "status_execucao", "data_execucao", "responsavel_execucao",
  "cod_nfd", "chave_nfd", "prazo_execucao", "data_pedido", "carregado_em",
] as const;

export type ColunaGold = (typeof COLUNAS_GOLD)[number];

export type ValorGold = string | number | boolean | null;

export type CasoGold = Record<ColunaGold, ValorGold> & {
  // O Cosmos já registrou o reenvio: o caso do CX Hub cuja criação na raw diz automacao = true (o CX Hub o criou no
  // Cosmos pela automação, e o Cosmos confirmou; a gold mostra o responsável "Automação"). Não é coluna da gold.
  reenvio_no_cosmos: boolean;
};

// pendente (no env.DB) → enviado (num lote disparado) → gravado (a DAG confirmou) → a linha sai do env.DB quando a raw
// que o Metabase lê tem o evento. recusado: a DAG recusou (fica 7 dias para quem editou ver o motivo).
export type SituacaoEdicao = "pendente" | "enviado" | "gravado" | "recusado";

export interface EdicaoVisivel {
  id: string;
  campos: Record<string, string | number>;
  autor: string;
  atualizadoEm: string;
  situacao: SituacaoEdicao;
  erro: string | null;
}

export interface Solicitacao extends CasoGold {
  editavel: boolean;
  // Por que a linha não se edita (null quando se edita).
  bloqueio: string | null;
  // As edições ainda não vistas no Metabase, já aplicadas nas colunas acima.
  aguardando: { situacao: Exclude<SituacaoEdicao, "recusado">; autor: string; atualizadoEm: string; campos: string[] } | null;
  // A última edição recusada pela DAG, quando não há outra mais nova por cima.
  recusada: { id: string; erro: string; autor: string; atualizadoEm: string } | null;
}

export interface Pagina {
  itens: Solicitacao[];
  // O cursor da página seguinte (opaco), ou null na última.
  proximo: string | null;
  // Quantas linhas o filtro tem: só vem quando pedido (contar=1, na primeira página).
  total: number | null;
}

export interface ClienteGuardado extends DadosCliente {
  atualizadoEm: string;
  autor: string;
}

export interface DetalheDoCaso {
  caso: Solicitacao;
  edicoes: EdicaoVisivel[];
  cliente: ClienteGuardado | null;
  // Os motivos da rota de dados para o tipo do caso (só no caso que se edita); null com o porquê em motivosErro.
  motivos: string[] | null;
  motivosErro: string | null;
  // O pedido da Shopify no Data Mart (só no caso que se edita): os itens que viram checkbox (escopo e valor do
  // reembolso; SKUs do reenvio), o frete e o total; null com o porquê em pedidoErro.
  pedido: PedidoDoCaso | null;
  pedidoErro: string | null;
  // O catálogo da marca para o mimo (só no reenvio que se edita); null com o porquê em catalogoErro.
  catalogo: ProdutoDoCatalogo[] | null;
  catalogoErro: string | null;
}

export interface Eu {
  email: string;
  nome: string;
  janelaDias: number;
  tamanhoPagina: number;
}

export const FILTROS_STATUS = ["sem_status", "Pendente", "Realizado", "Cancelado"] as const;
export type FiltroStatus = (typeof FILTROS_STATUS)[number];
