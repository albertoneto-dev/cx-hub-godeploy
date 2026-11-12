// Tipos compartilhados pelas rotas: as dependências (reais no worker.ts, falsas nos testes) e o contexto da chamada.

import type { Banco } from "./banco";
import type { Config } from "./config";
import type { Relogio } from "./tempo";

export type Busca = (entrada: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Uma etapa extra da rodada do lote, depois das da fila e dentro da mesma vez: no app, a do backoffice (a conferência
 * das edições na raw). O resumo entra no da rodada com o `nome`, e os avisos vão no mesmo aviso do Slack. `prazo` é a
 * hora (ms) depois da qual a rodada não começa chamada de fora: a etapa respeita o mesmo corte das outras.
 */
export type PosRodada = (c: Contexto, prazo: number) => Promise<{ nome: string; resumo: unknown; avisos: string[] }>;

export type Dependencias = {
  db: Banco;
  cfg: Config;
  relogio: Relogio;
  fetch: Busca; // saídas: Airflow e Slack
  posRodada?: PosRodada;
};

export type Contexto = Dependencias & {
  req: Request;
  url: URL;
  agora: number; // hora da chamada, pelo relógio injetável
};
