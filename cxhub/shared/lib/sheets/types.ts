/**
 * Valor de uma célula numa linha que vai (ou vem) do Google Sheets.
 *
 * `null` deixa a célula vazia — é o equivalente do "buraco" (`[a, , b]`) que os code nodes do n8n usavam
 * para pular coluna. Manter o `null` explícito é o que garante que cada valor caia na mesma coluna de antes.
 */
export type SheetCell = string | number | boolean | null;

/** Os três fluxos que gravam linha em planilha — um conjunto de planilhas (uma por marca) para cada. */
export type FluxoPlanilha = 'reenvio' | 'reembolso' | 'cancelamento';

/**
 * Qual conjunto de planilhas usar. Vem da env `SHEETS_ENV` e **não tem default** de propósito: um preview que
 * escrevesse na planilha de produção (ou uma produção escrevendo na de teste, sem ninguém notar) é pior do que
 * uma solicitação recusada com erro claro.
 */
export type AmbientePlanilha = 'prod' | 'staging';

/** Para onde vai uma linha: planilha, aba e como o append ancora a tabela. */
export interface PlanilhaDestino {
    spreadsheetId: string;
    aba: string;
    /**
     * Âncora do `values:append` — o mesmo intervalo que estava na URL do node do n8n. Ele não limita quantas
     * colunas a linha tem: só diz ao Sheets onde procurar a tabela.
     */
    intervalo: string;
    /**
     * `insertDataOption=INSERT_ROWS`. O n8n mandava em algumas planilhas e não em outras; está replicado
     * planilha a planilha para a linha cair do mesmo jeito (inserir linha nova × ocupar a próxima vazia).
     */
    inserirLinhas: boolean;
}
