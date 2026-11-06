// Tipos compartilhados pelas rotas: as dependências (reais no worker.ts, falsas nos testes) e o contexto da chamada.

import type { Banco } from "./banco";
import type { Config } from "./config";
import type { Relogio } from "./tempo";

export type Busca = (entrada: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type Dependencias = {
  db: Banco;
  cfg: Config;
  relogio: Relogio;
  fetch: Busca; // saídas: Airflow e Google Chat
};

export type Contexto = Dependencias & {
  req: Request;
  url: URL;
  agora: number; // hora da chamada, pelo relógio injetável
};
