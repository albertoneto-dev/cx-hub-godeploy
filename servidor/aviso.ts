// Aviso no Google Chat (GCHAT_ALERT_WEBHOOK_URL), um por rodada do lote, juntando tudo o que a rodada achou: itens
// recusados (ids e motivo), lote que falhou, disparo recusado. Nunca lança: o aviso não muda o desfecho da rodada.
// Sem dado pessoal (a fila não tem nenhum). A URL do webhook é segredo (leva key e token do espaço): não vai ao log.

import type { Contexto } from "./contexto";

const MAX_LINHAS = 25;
const MAX_CARACTERES = 3500;

export async function avisar(c: Contexto, linhas: string[]): Promise<void> {
  if (!linhas.length) return;
  const corpo = linhas.length > MAX_LINHAS ? [...linhas.slice(0, MAX_LINHAS), `… e mais ${linhas.length - MAX_LINHAS} linha(s): GET /api/v1/estado`] : linhas;
  let texto = `*Fila do CX Hub (app cx-hub)*\n${corpo.join("\n")}`;
  if (texto.length > MAX_CARACTERES) texto = `${texto.slice(0, MAX_CARACTERES)}…`;
  console.warn(`aviso: ${texto}`);
  if (!c.cfg.chatUrl) return;
  try {
    const r = await c.fetch(c.cfg.chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text: texto }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) console.error(`aviso: o Google Chat respondeu HTTP ${r.status}`);
  } catch (err) {
    console.error(`aviso: o Google Chat não respondeu (${String((err as Error)?.name || err)})`);
  }
}
