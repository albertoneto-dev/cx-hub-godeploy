// Configuração lida dos segredos do app (setAppSecret no GoDeploy). Segredo inválido não derruba o app: vira um
// "problema" no log (sem o valor) e a parte afetada fica desligada. A lista completa, com o motivo de cada um, está no
// .env.example.
//
// Adaptação do app cx-hub (fila única, backoffice/ORIGEM.md): o Airflow, o Slack, o LOTE_MAX e a chave do cron são os
// da fila do app (servidor/config.ts da raiz), que leva as edições à DAG. O backoffice só lê o Metabase e a rota dados.

export type ConfigMetabase = { url: string; chave: string; banco: number };

// O app GoDeploy rota-dados-cxhub (o mesmo que o CX Hub usa para os dropdowns): x-form-data-token no app e a chave gdk_
// do gateway daquele app no Authorization (sem ela o gateway responde 302).
export type ConfigRotaDados = { url: string; token: string; chave: string | null };

export type Config = {
  metabase: ConfigMetabase | null;
  rotaDados: ConfigRotaDados | null;
  origemApp: string | null; // APP_ORIGIN: a origem pública, se a URL que o worker vê não for a do navegador
  problemas: string[];
};

export type Segredos = Partial<Record<
  | "METABASE_URL" | "METABASE_API_KEY" | "METABASE_DATABASE_ID"
  | "FORM_DATA_API_URL" | "FORM_DATA_API_TOKEN" | "FORM_DATA_GODEPLOY_KEY" | "APP_ORIGIN", string>>;

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

  const origemApp = (env.APP_ORIGIN || "").trim().replace(/\/+$/, "") || null;

  return { metabase, rotaDados, origemApp, problemas };
}
