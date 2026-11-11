import type { SupportedBrand } from '../../../shared/lib/constants';
import type { SheetCell } from '../../../shared/lib/sheets/index';
import type { CasoNaPlanilha } from '../../../shared/lib/sheets/casoNaPlanilha';

/** O que cabe numa célula: texto, número (o valor do reembolso vai como número, não como `'59,90'`), booleano ou vazio. */
export type CelulaDaPlanilha = SheetCell;

/**
 * A planilha de reembolso de uma marca, vista pela gestão. A implementação real é a do Google Sheets
 * (`refundSheetPortGoogle.ts`); os testes usam uma em memória.
 *
 * Todo método recebe o `prazo`, o instante-limite (`Date.now()` + `JANELA_PLANILHA_MS`) da etapa da planilha que o
 * chamou: a gestão tem de caber no `maxDuration` da rota, e uma planilha lenta não pode empurrá-la para além dele.
 */
export interface PlanilhaDoReembolso {
    /**
     * O número da linha (1 = cabeçalho) do caso, ou `null`. Achada pelo pedido (só os dígitos) e pelo carimbo a até 2 min
     * do `criado_em` do caso (`acharLinhaDoCaso`); com mais de uma, vale a de carimbo mais próximo.
     */
    acharLinhaDoCaso(marca: SupportedBrand, caso: CasoNaPlanilha, prazo: number): Promise<number | null>;
    /** A linha 1. */
    lerCabecalho(marca: SupportedBrand, prazo: number): Promise<CelulaDaPlanilha[]>;
    /** Uma linha inteira, como aparece na tela (a data chega como `30/10/2026`, não como número serial). */
    lerLinha(marca: SupportedBrand, linha: number, prazo: number): Promise<CelulaDaPlanilha[]>;
    /** Reescreve células avulsas. `coluna` é o índice 0-based. Repetir é inofensivo. */
    atualizarCelulas(
        marca: SupportedBrand,
        alteracoes: { linha: number; coluna: number; valor: CelulaDaPlanilha }[],
        prazo: number,
    ): Promise<void>;
}
