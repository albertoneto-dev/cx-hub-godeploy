// Configuração lida dos segredos do app (setAppSecret no GoDeploy). Segredo inválido não derruba o app: vira um
// "problema" no log (sem o valor) e a parte afetada fica desligada. A lista completa, com o motivo de cada um, está no
// .env.example.

export type ConfigMetabase = { url: string; chave: string; banco: number };

// O app GoDeploy rota-dados-cxhub (o mesmo que o CX Hub usa para os dropdowns): x-form-data-token no app e a chave gdk_
// do gateway daquele app no Authorization (sem ela o gateway responde 302).
export type ConfigRotaDados = { url: string; token: string; chave: string | null };

export type ConfigAirflow = {
  baseUrl: string;
  usuario: string;
  senha: string;
  dagId: string;
  taskResultado: string;
  chaveResultado: string;
};

export type Config = {
  metabase: ConfigMetabase | null;
  rotaDados: ConfigRotaDados | null;
  airflow: ConfigAirflow | null;
  cronChave: string | null; // GODEPLOY_CRON_KEY, injetada pela plataforma
  loteMax: number;
  slackUrl: string | null;
  origemApp: string | null; // APP_ORIGIN: a origem pública, se a URL que o worker vê não for a do navegador
  problemas: string[];
};

export type Segredos = Partial<Record<
  | "METABASE_URL" | "METABASE_API_KEY" | "METABASE_DATABASE_ID"
  | "FORM_DATA_API_URL" | "FORM_DATA_API_TOKEN" | "FORM_DATA_GODEPLOY_KEY"
  | "AIRFLOW_BASE_URL" | "AIRFLOW_USER" | "AIRFLOW_PASSWORD" | "AIRFLOW_DAG_ID" | "AIRFLOW_RESULTADO_TASK_ID"
  | "AIRFLOW_RESULTADO_KEY" | "LOTE_MAX" | "SLACK_ALERT_WEBHOOK_URL" | "GODEPLOY_CRON_KEY" | "APP_ORIGIN", string>>;

export const DAG_PADRAO = "gobeaute_reenvio_reembolso_etl";
export const LOTE_MAX_PADRAO = 200;

const protocolo = (u: string) => {
  try {
    return new URL(u).protocol;
  } catch {
    return null;
  }
};

export function lerConfig(env: Segredos): Config {
  const problemas: string[] = [];

  let metabase: ConfigMetabase | null = null;
  const url = (env.METABASE_URL || "").trim().replace(/\/+$/, "");
  const chave = (env.METABASE_API_KEY || "").trim();
  const id = Number((env.METABASE_DATABASE_ID || "").trim());
  if (!url || !chave || !env.METABASE_DATABASE_ID?.trim()) problemas.push("METABASE_URL, METABASE_API_KEY ou METABASE_DATABASE_ID vazio: a lista responde 503");
  else if (protocolo(url) !== "https:" && protocolo(url) !== "http:") problemas.push("METABASE_URL não é uma URL http(s): a lista responde 503");
  else if (!Number.isInteger(id) || id <= 0) problemas.push("METABASE_DATABASE_ID não é um número: a lista responde 503");
  else metabase = { url, chave, banco: id };

  let rotaDados: ConfigRotaDados | null = null;
  const urlDados = (env.FORM_DATA_API_URL || "").trim().replace(/\/+$/, "");
  const tokenDados = (env.FORM_DATA_API_TOKEN || "").trim();
  if (!urlDados || !tokenDados) problemas.push("FORM_DATA_API_URL ou FORM_DATA_API_TOKEN vazio: sem a lista de motivos, o motivo não se edita");
  else if (protocolo(urlDados) !== "https:" && protocolo(urlDados) !== "http:") problemas.push("FORM_DATA_API_URL não é uma URL http(s): o motivo não se edita");
  else rotaDados = { url: urlDados, token: tokenDados, chave: (env.FORM_DATA_GODEPLOY_KEY || "").trim() || null };

  // O Airflow de produção só responde em http (decisão de 18/09/2026): http é aceito, como no app cx-hub.
  let airflow: ConfigAirflow | null = null;
  const base = (env.AIRFLOW_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) problemas.push("AIRFLOW_BASE_URL vazio: as edições ficam pendentes no env.DB (o lote não é disparado)");
  else if (protocolo(base) !== "http:" && protocolo(base) !== "https:") problemas.push("AIRFLOW_BASE_URL não é uma URL http(s): o lote não é disparado");
  else if (!env.AIRFLOW_USER || !env.AIRFLOW_PASSWORD) problemas.push("AIRFLOW_USER ou AIRFLOW_PASSWORD vazio: o lote não é disparado");
  else airflow = {
    baseUrl: base,
    usuario: env.AIRFLOW_USER,
    senha: env.AIRFLOW_PASSWORD,
    dagId: (env.AIRFLOW_DAG_ID || "").trim() || DAG_PADRAO,
    taskResultado: (env.AIRFLOW_RESULTADO_TASK_ID || "").trim() || "gravar",
    chaveResultado: (env.AIRFLOW_RESULTADO_KEY || "").trim() || "resultado",
  };

  let loteMax = LOTE_MAX_PADRAO;
  if (env.LOTE_MAX?.trim()) {
    const n = Number(env.LOTE_MAX);
    if (Number.isInteger(n) && n > 0) loteMax = n;
    else problemas.push(`LOTE_MAX inválido: vale o padrão ${LOTE_MAX_PADRAO}`);
  }

  let slackUrl: string | null = (env.SLACK_ALERT_WEBHOOK_URL || "").trim() || null;
  if (slackUrl && protocolo(slackUrl) !== "https:") {
    problemas.push("SLACK_ALERT_WEBHOOK_URL não é https: os avisos só vão para o log");
    slackUrl = null;
  }

  const origemApp = (env.APP_ORIGIN || "").trim().replace(/\/+$/, "") || null;

  return { metabase, rotaDados, airflow, cronChave: env.GODEPLOY_CRON_KEY?.trim() || null, loteMax, slackUrl, origemApp, problemas };
}
