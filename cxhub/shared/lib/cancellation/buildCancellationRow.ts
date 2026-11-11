import type { SupportedBrand } from '../constants';
import type { SheetCell } from '../sheets/index';
import type { CancellationPayload } from './types';

/**
 * Linha da planilha de cancelamento, coluna a coluna — transcrição dos code nodes `Create <Marca> Row` do
 * workflow `[PROD] [AUX] - Cancelamento CXHub`. `null` é coluna que o n8n pulava.
 *
 * Paridade deliberada com o n8n, inclusive no que parece errado (ADR-007, "migrar igual, corrigir depois"):
 * - `Status` e `Local da Tratativa` do payload **não chegam a nenhuma planilha**. Só a Lescent tem essas
 *   colunas, e com valores fixos (o espaço duplo em "Solicitar na  transportadora" é do n8n);
 * - o pedido vai como veio (com `#SHOPIFY`, se vier).
 *
 * O carimbo é o `criado_em` do caso (o mesmo instante que vai para a gold), formatado por quem monta a linha: é por ele e
 * pelo pedido que o CX Hub acha esta linha depois (`casoNaPlanilha.ts`, ADR-010).
 */
export interface CancellationRowSource {
    carimbo: string;
    responsavel: string;
    nomeCliente: string;
    numeroPedido: string;
    observacoes: string;
    numeroNF: string;
    cdOrigem: string;
    tratativa: string;
}

/**
 * Carimbo do servidor + a regra do Bot, que no n8n vivia no node "Edit Fields": quando quem abriu foi o Bot,
 * a tratativa é sempre "Reembolso" (o único caminho do Bot até aqui é o reembolso).
 */
export function prepararCancelamento(payload: CancellationPayload, carimbo: string): CancellationRowSource {
    const responsavel = payload['Responsável'];
    return {
        carimbo,
        responsavel,
        nomeCliente: payload['Nome do(a) cliente'],
        numeroPedido: payload['Número do pedido (Shopify)'],
        observacoes: payload['Observações'],
        numeroNF: payload['Número da NF'],
        cdOrigem: payload['CD de origem'],
        tratativa: responsavel === 'Bot' ? 'Reembolso' : payload['Tratativa'],
    };
}

const v = (valor: string | null | undefined): SheetCell => valor ?? null;

/** Layout comum de BySamia, Auá e Barbours. */
function linhaCurta(s: CancellationRowSource): SheetCell[] {
    return [v(s.carimbo), v(s.responsavel), v(s.nomeCliente), v(s.numeroPedido), v(s.observacoes), v(s.numeroNF), v(s.cdOrigem), v(s.tratativa)];
}

const BUILDERS: Record<SupportedBrand, (s: CancellationRowSource) => SheetCell[]> = {
    lescent: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.nomeCliente), v(s.numeroPedido), v(s.observacoes),
        v(s.numeroNF), v(s.cdOrigem), v(s.tratativa), 'Solicitar na  transportadora', 'Transportador',
    ],
    kokeshi: (s) => [
        v(s.carimbo), null, v(s.responsavel), v(s.nomeCliente), v(s.numeroPedido), v(s.observacoes),
        v(s.numeroNF), v(s.cdOrigem), v(s.tratativa),
    ],
    bysamia: linhaCurta,
    aua: linhaCurta,
    barbours: linhaCurta,
    rituaria: (s) => [
        v(s.carimbo), v(s.responsavel), null, null, v(s.nomeCliente), v(s.numeroPedido), null,
        v(s.observacoes), v(s.numeroNF), v(s.cdOrigem), v(s.tratativa),
    ],
};

export function buildCancellationRow(brand: SupportedBrand, source: CancellationRowSource): SheetCell[] {
    return BUILDERS[brand](source);
}
