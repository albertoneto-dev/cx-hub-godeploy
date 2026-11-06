// Configuração lida dos segredos do app (setAppSecret no GoDeploy). Segredo inválido não derruba o app: vira um
// "problema" no log (sem o valor) e a parte afetada fica desligada.

export type ConfigAirflow = {
  baseUrl: string;
  usuario: string;
  senha: string;
  dagId: string;
  taskResultado: string;
  chaveResultado: string;
};

export type Config = {
  tokens: string[];          // os aceitos no x-cxhub-fila-token (mais de um durante a troca)
  cronChave: string | null;  // GODEPLOY_CRON_KEY, injetada pela plataforma
  airflow: ConfigAirflow | null;
  loteMax: number;
  slackUrl: string | null;   // SLACK_ALERT_WEBHOOK_URL, o Incoming Webhook do canal dos avisos
  problemas: string[];
};

export type Segredos = Partial<Record<
  | "CXHUB_FILA_TOKENS" | "GODEPLOY_CRON_KEY"
  | "AIRFLOW_BASE_URL" | "AIRFLOW_USER" | "AIRFLOW_PASSWORD" | "AIRFLOW_DAG_ID"
  | "AIRFLOW_RESULTADO_TASK_ID" | "AIRFLOW_RESULTADO_KEY" | "LOTE_MAX" | "SLACK_ALERT_WEBHOOK_URL", string>>;

export const DAG_PADRAO = "gobeaute_reenvio_reembolso_etl";
export const LOTE_MAX_PADRAO = 200;

const lista = (s?: string) => (s || "").split(",").map(x => x.trim()).filter(Boolean);

const protocolo = (u: string) => {
  try {
    return new URL(u).protocol;
  } catch {
    return null;
  }
};

export function lerConfig(env: Segredos): Config {
  const problemas: string[] = [];

  const tokens = lista(env.CXHUB_FILA_TOKENS);
  if (!tokens.length) problemas.push("CXHUB_FILA_TOKENS vazio: toda chamada recebe 401");

  // O Airflow de produção só responde em http (decisão de 18/09/2026): http é aceito, como no CX Hub.
  let airflow: ConfigAirflow | null = null;
  const base = (env.AIRFLOW_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) problemas.push("AIRFLOW_BASE_URL vazio: o lote não é disparado");
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
  if (!slackUrl) problemas.push("SLACK_ALERT_WEBHOOK_URL vazio: os avisos só vão para o log");
  else if (protocolo(slackUrl) !== "https:") {
    problemas.push("SLACK_ALERT_WEBHOOK_URL não é https: os avisos só vão para o log");
    slackUrl = null;
  }

  return { tokens, cronChave: env.GODEPLOY_CRON_KEY?.trim() || null, airflow, loteMax, slackUrl, problemas };
}
