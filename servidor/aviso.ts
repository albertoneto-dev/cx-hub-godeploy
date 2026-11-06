// Aviso no Slack (SLACK_ALERT_WEBHOOK_URL, um Incoming Webhook do canal), um por rodada do lote, juntando tudo o que a
// rodada achou: itens recusados (ids e motivo), lote que falhou, disparo recusado. Nunca lança: o aviso não muda o
// desfecho da rodada. Sem dado pessoal (a fila não tem nenhum). A URL do webhook é segredo (quem a tem posta no
// canal): não vai ao log.

import type { Contexto } from "./contexto";

const MAX_LINHAS = 25;
const MAX_CARACTERES = 3500;
const MAX_ERRO_DO_SLACK = 100;

// O Slack lê <...> como link ou menção (<!channel> chamaria o canal inteiro) e & como começo de entidade. O motivo
// da recusa vem da DAG e o erro vem do Airflow: o texto vai ao Slack com os três escapados.
const escapar = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function avisar(c: Contexto, linhas: string[]): Promise<void> {
  if (!linhas.length) return;
  const corpo = linhas.length > MAX_LINHAS ? [...linhas.slice(0, MAX_LINHAS), `… e mais ${linhas.length - MAX_LINHAS} linha(s): GET /api/v1/estado`] : linhas;
  let texto = `*Fila do CX Hub (app cx-hub)*\n${corpo.join("\n")}`;
  if (texto.length > MAX_CARACTERES) texto = `${texto.slice(0, MAX_CARACTERES)}…`;
  console.warn(`aviso: ${texto}`);
  if (!c.cfg.slackUrl) return;
  try {
    const r = await c.fetch(c.cfg.slackUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text: escapar(texto) }),
      signal: AbortSignal.timeout(5_000),
    });
    // 200 "ok" quando postou. No erro, o motivo vem no corpo, em texto curto: no_service (webhook revogado),
    // channel_is_archived, invalid_payload.
    if (!r.ok) {
      const motivo = (await r.text().catch(() => "")).trim().slice(0, MAX_ERRO_DO_SLACK);
      console.error(`aviso: o Slack respondeu HTTP ${r.status}${motivo ? ` (${motivo})` : ""}`);
    }
  } catch (err) {
    console.error(`aviso: o Slack não respondeu (${String((err as Error)?.name || err)})`);
  }
}
