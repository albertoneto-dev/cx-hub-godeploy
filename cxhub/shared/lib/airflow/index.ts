// Server-only: só rotas de API importam este barrel. Os builders dos módulos importam apenas o TIPO
// (`import type ... from '@shared/lib/airflow/types'`) para não arrastar credencial para o bundle do cliente.
//
// O nome ficou do tempo em que o CX Hub disparava a DAG: desde o ADR-012 quem dispara é a fila do app `cx-hub`
// (`@shared/lib/fila`), e aqui moram o contrato do `conf` da DAG e as leituras da raw e da gold pelo Metabase.
export { ID_DE_CASO, MAX_IDS_DO_REGISTRO, estadosNoRegistro, responderRegistro, sqlDosCasosNaRaw } from './registro';
export type { EstadosDeps, PedidoDeRegistro } from './registro';
export { problemaNoCaso, problemaNaAtualizacao } from './contrato';
export {
    TABELA_RAW,
    sqlDaSolicitacaoRecente,
    buscarSolicitacaoRecente,
    sqlDoReembolsoMaisRecente,
    buscarReembolsoMaisRecente,
    sqlDoCasoPorId,
    buscarCasoPorId,
} from './raw';
export type { SolicitacaoRecente, ReembolsoNaRaw, CasoNaRaw } from './raw';
export {
    agendarAtualizacaoNaGold,
    registrarAtualizacaoNaGold,
    buscarCasoNaGold,
    sqlDoCasoNaGold,
} from './atualizarCaso';
export type { AtualizarCasoDeps } from './atualizarCaso';
export {
    listarPaginaDaRaw,
    sqlDaListaDeSolicitacoes,
    inicioDaJanela,
    TAMANHO_DA_PAGINA,
} from './listarCasos';
export type { CasoDaFilaNaLista, LinhaDaPagina, OpcoesDaLista, PaginaDaLista } from './listarCasos';
export { TABELA_GOLD, SIGLA_DA_MARCA } from './gold';
export { ESPERAS_RETENTATIVA_MS, tentarComRetentativa } from './retentativa';
export type {
    AlteracaoGold,
    AtualizacaoCxhub,
    CasoCxhub,
    LocalizadorCasoGold,
    StatusExecucaoCxhub,
    TipoCasoCxhub,
} from './types';
