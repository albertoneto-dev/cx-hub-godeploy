import type { SupportedBrand } from '../../../shared/lib/constants';
import { resolverPlanilha } from '../../../shared/lib/sheets/index';
import { abaA1, atualizarCelulas, lerAba } from '../../../shared/lib/sheets/server';
import { letraDaColuna } from '../../../shared/lib/sheets/a1';
import { acharLinhaDoCaso as acharLinhaDoCasoNaPlanilha, type CasoNaPlanilha } from '../../../shared/lib/sheets/casoNaPlanilha';
import type { CelulaDaPlanilha, PlanilhaDoReembolso } from './refundSheetPort';

/**
 * A `PlanilhaDoReembolso` de verdade: a planilha de reembolso da marca no Google Sheets (conta de serviço,
 * ADR-010), montada sobre o que `shared/lib/sheets/` já tem — a escolha da planilha por marca e `SHEETS_ENV`
 * (`resolverPlanilha`), a leitura e a escrita (`server.ts`) e a busca da linha do caso pelo pedido e pelo carimbo
 * (`casoNaPlanilha.ts`), as mesmas peças que gravam a linha na criação.
 *
 * - **Achar a linha:** pelo número do pedido e pelo carimbo a até 2 min do `criado_em` do caso, lendo só essas duas
 *   colunas (`acharLinhaDoCaso`). Cabeçalho da aba que não bate com o layout ⇒ erro: não se adivinha a coluna.
 * - **Ler:** o cabeçalho e a linha vêm **formatados** (`FORMATTED_VALUE`): a data de execução chega como
 *   `30/10/2026`, não como número serial.
 * - **Escrever:** data (`dd/mm/aaaa`) e número vão com `USER_ENTERED`, para virarem data e número de verdade na
 *   planilha; todo o resto (status, responsável, motivo) vai `RAW`, que é o padrão do `atualizarCelulas`: o texto que
 *   o agente digitou não vira fórmula nem data.
 *
 * Erros do Google sobem (`SheetsError`): quem chama (`refundGestaoComum.ts`) os trata como "a planilha falhou".
 *
 * ⚠️ Server-only — lê segredo e fala com o Google, fora do barrel de `modules/reembolsos/actions`.
 */

/** `dd/mm/aaaa`: o formato que a gestão escreve na data de execução. */
const DATA_BR = /^\d{2}\/\d{2}\/\d{4}$/;

/** Número e data são os que precisam ser interpretados; o resto é texto e vai como veio. */
const precisaSerInterpretada = (valor: CelulaDaPlanilha): boolean =>
    typeof valor === 'number' || (typeof valor === 'string' && DATA_BR.test(valor));

export function planilhaDoReembolsoGoogle(): PlanilhaDoReembolso {
    return {
        acharLinhaDoCaso(marca: SupportedBrand, caso: CasoNaPlanilha, prazo: number): Promise<number | null> {
            return acharLinhaDoCasoNaPlanilha('reembolso', marca, caso, prazo);
        },

        async lerCabecalho(marca: SupportedBrand, prazo: number): Promise<CelulaDaPlanilha[]> {
            const destino = resolverPlanilha('reembolso', marca);
            const [cabecalho = []] = await lerAba(destino.spreadsheetId, destino.aba, prazo, { intervalo: '1:1', formatado: true });
            return cabecalho;
        },

        async lerLinha(marca: SupportedBrand, linha: number, prazo: number): Promise<CelulaDaPlanilha[]> {
            const destino = resolverPlanilha('reembolso', marca);
            const [valores = []] = await lerAba(destino.spreadsheetId, destino.aba, prazo, {
                intervalo: `${linha}:${linha}`,
                formatado: true,
            });
            return valores;
        },

        async atualizarCelulas(
            marca: SupportedBrand,
            alteracoes: { linha: number; coluna: number; valor: CelulaDaPlanilha }[],
            prazo: number,
        ): Promise<void> {
            const destino = resolverPlanilha('reembolso', marca);
            const aba = abaA1(destino.aba);
            const celulas = alteracoes.map(({ linha, coluna, valor }) => ({
                intervalo: `${aba}!${letraDaColuna(coluna)}${linha}`,
                valor,
            }));

            // A opção de entrada vale para a chamada inteira, então texto e data/número vão em chamadas separadas.
            const texto = celulas.filter(({ valor }) => !precisaSerInterpretada(valor));
            const interpretadas = celulas.filter(({ valor }) => precisaSerInterpretada(valor));
            if (texto.length > 0) await atualizarCelulas(destino.spreadsheetId, texto, prazo);
            if (interpretadas.length > 0) {
                await atualizarCelulas(destino.spreadsheetId, interpretadas, prazo, { entrada: 'USER_ENTERED' });
            }
        },
    };
}
