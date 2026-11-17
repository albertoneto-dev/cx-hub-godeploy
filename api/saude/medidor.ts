// A saúde de cada serviço externo, medida nas chamadas reais do app (17/11/2026, ver api/saude/regras.ts).
//
// Por que no fetch global: as chamadas saem de uns 15 lugares da cópia do CX Hub (cxhub/), do Airflow da fila
// (servidor/) e do Metabase do backoffice. Medir em cada um seria editar o código portado, e cada edição ali vira uma
// adaptação no cxhub/ORIGEM.md. O envoltório fica na frente do fetch do Worker, olha só o host da URL e anota o
// desfecho; a chamada segue igual: mesmo argumento, mesma resposta, mesma exceção. Ele nunca lê o corpo.
//
// O host é comparado com o que o app tem cadastrado (AIRFLOW_BASE_URL, COSMOS_API_URL, METABASE_URL,
// INTEGRATIONS_GATEWAY_URL, FORM_DATA_API_URL), lido do process.env na hora da chamada, como o código do CX Hub lê.

import type { Busca } from "../../servidor/contexto";
import { type Ambiente, envDoProcesso } from "../ambiente";
import { falhaHttp, type Observacao } from "./regras";
import { anotarSaude } from "./registro";

export interface Dependencia {
  componente: string;
  nome: string;
  /** O status que conta como falha do serviço. */
  falha(status: number): boolean;
}

// O Cosmos responde 401/403 ao token de quem chama (o login do agente, o token vencido que a Central renova e repete):
// é o serviço de pé, recusando a credencial. Só a falha dele mesmo conta.
const falhaDoCosmos = (status: number) => status >= 500 || status === 429;

export const DEPENDENCIAS = {
  airflow: { componente: "dep_airflow", nome: "Airflow", falha: falhaHttp },
  cosmos: { componente: "dep_cosmos", nome: "Cosmos", falha: falhaDoCosmos },
  sheets: { componente: "dep_sheets", nome: "Google Planilhas", falha: falhaHttp },
  datamart: { componente: "dep_datamart", nome: "Data Mart", falha: falhaHttp },
  gateway: { componente: "dep_gateway", nome: "integrations-gateway", falha: falhaHttp },
  rotaDados: { componente: "dep_rota_dados", nome: "Rota dados", falha: falhaHttp },
} satisfies Record<string, Dependencia>;

const MEDIDO = Symbol.for("cx-hub.saude.fetch-medido");
const BASE = Symbol.for("cx-hub.saude.fetch-base");

// Os padrões do código do CX Hub quando a variável não está cadastrada (cxhub/shared/lib/shopify/gateway.ts e o
// .env.example).
const GATEWAY_PADRAO = "integrations-gateway-prod.rpa-ia.workers.dev";
const ROTA_DADOS_PADRAO = "rota-dados-cxhub.devgogroup.com";
const HOSTS_DO_GOOGLE = new Set(["sheets.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"]);

function hostDe(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return null;
  }
}

/** A dependência da URL, ou null para o que não é medido (o Slack, as fontes, a fila dentro do Worker). */
export function dependenciaDaUrl(url: string, env: Ambiente = envDoProcesso()): Dependencia | null {
  const h = hostDe(url);
  if (!h) return null;
  if (h === hostDe(env.AIRFLOW_BASE_URL)) return DEPENDENCIAS.airflow;
  if (h === hostDe(env.COSMOS_API_URL)) return DEPENDENCIAS.cosmos;
  if (HOSTS_DO_GOOGLE.has(h)) return DEPENDENCIAS.sheets;
  if (h === hostDe(env.METABASE_URL)) return DEPENDENCIAS.datamart;
  if (h === (hostDe(env.INTEGRATIONS_GATEWAY_URL) ?? GATEWAY_PADRAO)) return DEPENDENCIAS.gateway;
  if (h === (hostDe(env.FORM_DATA_API_URL) ?? ROTA_DADOS_PADRAO)) return DEPENDENCIAS.rotaDados;
  return null;
}

/**
 * Anota o desfecho de uma chamada. status null: não houve resposta. `login`: a resposta veio da página de login do
 * gateway do GoDeploy (a chave do app foi recusada e o fetch seguiu o 302). Nunca lança.
 */
export function observarChamada(dep: Dependencia, status: number | null, duracaoMs: number, erro?: unknown, login = false): Observacao | null {
  try {
    if (status !== null && !login && !dep.falha(status)) return anotarSaude(dep.componente, "ok", { duracaoMs });
    const nomeDoErro = (erro as Error | undefined)?.name;
    const texto = login
      ? `${dep.nome}: o gateway do GoDeploy pediu login (chave recusada)`
      : status !== null
        ? `${dep.nome} respondeu HTTP ${status}`
        : nomeDoErro === "AbortError" || nomeDoErro === "TimeoutError"
          ? `${dep.nome} sem resposta (tempo esgotado)`
          : `${dep.nome}: falha de rede`;
    return anotarSaude(dep.componente, "erro", { erro: texto, duracaoMs });
  } catch {
    return null;
  }
}

function urlDe(entrada: string | URL | Request): string {
  return typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
}

/** A chamada medida: a dependência vem de `qual`; sem dependência, a chamada passa direto. */
function medir(base: Busca, qual: (url: string) => Dependencia | null): Busca {
  return async (entrada, init) => {
    let dep: Dependencia | null = null;
    try {
      dep = qual(urlDe(entrada));
    } catch {
      dep = null;
    }
    if (!dep) return base(entrada, init);
    const inicio = Date.now();
    let resposta: Response;
    try {
      resposta = await base(entrada, init);
    } catch (erro) {
      observarChamada(dep, null, Date.now() - inicio, erro);
      throw erro;
    }
    const login = resposta.redirected && /\/login/i.test(resposta.url || "");
    observarChamada(dep, resposta.status, Date.now() - inicio, undefined, login);
    return resposta;
  };
}

/** O fetch que mede pela URL. `env`: de onde vêm as URLs cadastradas (o process.env, no Worker). */
export function medirFetch(base: Busca, env: () => Ambiente = envDoProcesso): Busca {
  const medido = medir(base, url => dependenciaDaUrl(url, env()));
  Object.defineProperty(medido, MEDIDO, { value: true });
  Object.defineProperty(medido, BASE, { value: base });
  return medido;
}

/** O fetch que mede toda chamada como da dependência dada: o das sondas, que sabem o que estão chamando. */
export const medirComo = (dep: Dependencia, base: Busca): Busca => medir(base, () => dep);

type ComFetch = { fetch: typeof fetch };
const ehMedido = (f: unknown) => typeof f === "function" && (f as unknown as Record<symbol, unknown>)[MEDIDO] === true;

/**
 * Põe o medidor na frente do fetch global, uma vez só: se o fetch global já é o medido, não faz nada. Chamado a cada
 * requisição porque quem troca o fetch global (os testes, com vi.spyOn) recebe o medidor de novo na próxima.
 */
export function instalarMedidorDoFetch(alvo: ComFetch = globalThis): void {
  try {
    const atual = alvo.fetch;
    if (typeof atual !== "function" || ehMedido(atual)) return;
    // bind: no Workers, o fetch chamado como método de outro objeto dá "Illegal invocation".
    alvo.fetch = medirFetch(atual.bind(alvo) as Busca) as typeof fetch;
  } catch {
    // Sem o medidor, as dependências só ficam sem medida: o app segue igual.
  }
}

/** O fetch global sem o medidor: as sondas da rota medem por conta própria (medirComo). */
export function fetchSemMedidor(alvo: ComFetch = globalThis): Busca {
  const atual = alvo.fetch;
  if (ehMedido(atual)) return (atual as unknown as Record<symbol, Busca>)[BASE];
  return (entrada, init) => alvo.fetch(entrada, init);
}
