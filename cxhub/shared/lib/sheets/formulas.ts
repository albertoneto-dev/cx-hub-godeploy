import type { MarcaCxHub } from '../constants';
import type { FluxoPlanilha } from './types';

/**
 * As fórmulas que cada linha nova leva nas colunas da operação (prazo, competência, semana, mês, ano, SLA), nas
 * planilhas das marcas sem Cosmos (ADR-013). Não são `ARRAYFORMULA`: cada linha tem as suas, escritas com o número da
 * própria linha (`{r}`), e a linha que chega sem elas fica sem prazo e sem SLA — e a base consolidada perde o
 * `prazo_execucao`.
 *
 * Copiadas da última linha de cada planilha em 2026-11-05, **como estão**, inclusive as referências quebradas
 * herdadas de outra ordem de colunas (o SLA e a "Semana - Execução" do reenvio da Yenzah e da Denavita leem o "Status
 * do Reenvio" como se fosse a data de execução; o SLA do reembolso da Denavita compara com "Pedido será devolvido…").
 * **Não corrija aqui**: o sync e os relatórios podem depender delas, e quem decide é quem cuida das planilhas.
 *
 * Só as colunas de fórmula. As de valor (a "Data solicitação" do reenvio da Ápice, o "Prazo para o reembolso") vão
 * na própria linha, pelo `build*Row`, e as da operação que a equipe preenche (status, execução, responsável, executor,
 * COD NFD, custo, comentários) **nunca** são escritas.
 */
export const FORMULAS_DA_LINHA: Partial<Record<FluxoPlanilha, Partial<Record<MarcaCxHub, Readonly<Record<string, string>>>>>> = {
    reenvio: {
        apice: {
            AA: '=WORKDAY(Z{r}; 3)',
            AH: '=IF(AE{r}="";"Pendente";WEEKNUM(AE{r};15)-1)',
            AI: '=WEEKNUM(A{r};15)-1',
            AJ: '=MONTH(A{r})',
            AK: '=YEAR(A{r})',
            AN: '=IF(AE{r}="";"";NETWORKDAYS(Z{r};AE{r})-1)',
        },
        yenzah: {
            Y: '=DATE(YEAR(A{r});MONTH(A{r});(DAY(A{r})))',
            Z: '=WORKDAY(Y{r}; 3)',
            AA: '=CONCATENATE(MONTH(Y{r});"/";YEAR(Y{r}))',
            AJ: '=IF(AI{r}="";"Pendente";WEEKNUM(AD{r};15)-1)',
            AM: '=WEEKNUM(A{r};15)-1',
            AN: '=MONTH(A{r})',
            AO: '=YEAR(A{r})',
            AP: '=TODAY()',
            AQ: '=IF(AI{r}=""; ""; NETWORKDAYS(Z{r}; AI{r}) - 1)',
        },
        denavita: {
            Z: '=DATE(YEAR(A{r});MONTH(A{r});(DAY(A{r})))',
            AA: '=WORKDAY(Z{r}; 3)',
            AB: '=CONCATENATE(MONTH(Z{r});"/";YEAR(Z{r}))',
            AK: '=IF(AJ{r}="";"Pendente";WEEKNUM(AJ{r};15)-1)',
            AN: '=WEEKNUM(A{r};15)-1',
            AO: '=MONTH(A{r})',
            AP: '=YEAR(A{r})',
            AQ: '=TODAY()',
            AR: '=IF(AJ{r}=""; ""; NETWORKDAYS(AA{r}; AJ{r}) - 1)',
        },
    },
    reembolso: {
        apice: {
            AC: '=WEEKNUM(A{r};15)-1',
            AD: '=MONTH(A{r})',
            AE: '=YEAR(A{r})',
            AH: '=DATE(YEAR(A{r});MONTH(A{r});DAY(A{r}))',
            AI: '=IF(Y{r}<=P{r};1;0)',
        },
        yenzah: {
            AE: '=WORKDAY(A{r};3)',
            AF: '=WEEKNUM(A{r};15)-1',
            AG: '=MONTH(A{r})',
            AH: '=YEAR(A{r})',
            AI: '=CONCATENATE(MONTH(A{r});"/";YEAR(A{r}))',
            AJ: '=IF(X{r}<=P{r};1;0)',
        },
        denavita: {
            AE: '=WORKDAY(A{r};3)',
            AF: '=WEEKNUM(A{r};15)-1',
            AG: '=MONTH(A{r})',
            AH: '=YEAR(A{r})',
            AI: '=CONCATENATE(MONTH(A{r});"/";YEAR(A{r}))',
            AJ: '=IF(X{r}<=P{r};1;0)',
        },
    },
};

/**
 * As fórmulas da linha `linha` (1 = cabeçalho) do fluxo e marca, prontas para o `values:batchUpdate`: a coluna e a
 * fórmula com o `{r}` trocado pelo número da linha. Lista vazia quando a planilha não tem molde (as 6 marcas do
 * Cosmos, cujas planilhas o n8n nunca preencheu assim).
 */
export function formulasDaLinha(fluxo: FluxoPlanilha, marca: MarcaCxHub, linha: number): Array<{ coluna: string; formula: string }> {
    const molde = FORMULAS_DA_LINHA[fluxo]?.[marca];
    if (!molde || !Number.isInteger(linha) || linha < 2) return [];
    return Object.entries(molde).map(([coluna, formula]) => ({ coluna, formula: formula.replaceAll('{r}', String(linha)) }));
}
