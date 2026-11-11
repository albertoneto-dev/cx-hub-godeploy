// Server-only: lê METABASE_API_KEY. Só código de rota importa este barrel.
export { consultarDataMart, literalSql, metabaseConfigurado, MetabaseError, METABASE_TIMEOUT_MS } from './client';
