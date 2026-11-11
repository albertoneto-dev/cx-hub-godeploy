// Seguro para o navegador: os tipos, o cliente HTTP e o que o navegador guarda. Quem fala com a raw e a fila é a rota
// (`@shared/lib/airflow/registro`).
export { consultarRegistro } from './client';
export type { RespostaDoRegistro } from './client';
export {
    VALIDADE_DA_ENVIADA_MS,
    acompanharEnviadas,
    atualizarSolicitacoesEnviadas,
    comoSolicitacaoListada,
    enviadasDaLista,
    enviadasDaPagina,
    esquecerSolicitacoesEnviadas,
    estadoDoEnvio,
    estadoDoEnvioNaPlanilha,
    estadoNoMetabaseDaLinha,
    guardarSolicitacaoEnviada,
    haRegistroEmAndamento,
    lerSolicitacoesEnviadas,
    MAX_IDS_POR_CONSULTA,
    PAGINA_UNICA,
    paginaNaTela,
} from './enviadas';
export type { PaginaNaTela, RodadaDoAcompanhamento } from './enviadas';
export type { EstadoDoEnvio, EstadoDoRegistro, RegistroCode, RegistroResponse, SolicitacaoEnviada } from './types';
