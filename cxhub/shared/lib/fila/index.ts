// Server-only: só código de servidor importa este barrel (lê os segredos da fila). Os tipos podem ser importados com
// `import type ... from '@shared/lib/fila/types'`.
export {
    FilaError,
    FILA_TIMEOUT_MS,
    JANELA_FILA_MS,
    prazoDaFila,
    filaConfigurada,
    enfileirarCasos,
    enfileirarAtualizacao,
    casosDoPedidoNaFila,
    casoNaFila,
    casosAbertosNaFila,
    atualizacoesNaFila,
} from './client';
export {
    execucaoNaFila,
    solicitacaoRecenteNoRegistro,
    reembolsoMaisRecenteNoRegistro,
    casoNoRegistro,
    listarSolicitacoesNoRegistro,
} from './estado';
export type { EstadoDeps, ListaDeps } from './estado';
export {
    RESPONSAVEL_SEM_EXECUCAO,
    atualizacaoDoCaso,
    execucaoDoSemExecucao,
    notaDoSemExecucao,
    registrarFalhaDaTela,
    tentativaSemExecucao,
} from './semExecucao';
export type { DesfechoSemExecucao, SemExecucao, TentativaAnterior } from './semExecucao';
export type { AtualizacaoNaFila, CasoAbertoNaFila, CasoNaFila, ResultadoFila, SituacaoNaFila } from './types';
