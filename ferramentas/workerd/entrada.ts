// Entrada da conferência no workerd (ferramentas/workerd/conferir.mjs); não vai ao GoDeploy. É o worker.ts de verdade,
// com o env.DB do GoDeploy imitado por um service binding (BANCO) que o Node atende com SQLite, e GET /__conferencias,
// que devolve o que só o runtime decide: a assinatura RS256 pelo WebCrypto e os formatos de data do Intl.

import { atualizarAmbiente } from "../../api/ambiente";
import { formatarCarimboSP } from "../../cxhub/shared/lib/format";
import { __resetGoogleTokenCache, tokenDoGoogle } from "../../cxhub/shared/lib/sheets/googleAuth";
import worker from "../../worker";

type Servico = { fetch(url: string, init?: RequestInit): Promise<Response> };
type EnvDaConferencia = Record<string, unknown> & { BANCO: Servico };
type Ctx = { waitUntil(p: Promise<unknown>): void };

// A mesma interface do env.DB (query e exec), respondida pelo SQLite do Node.
function bancoPeloNode(banco: Servico) {
  const chamar = async (op: "query" | "exec", sql: string, params: unknown[] = []) => {
    const r = await banco.fetch(`http://banco/${op}`, { method: "POST", body: JSON.stringify({ sql, params }) });
    if (!r.ok) throw new Error(`banco: ${await r.text()}`);
    return r.json();
  };
  return {
    query: (sql: string, params?: unknown[]) => chamar("query", sql, params),
    exec: (sql: string, params?: unknown[]) => chamar("exec", sql, params),
  };
}

export default {
  async fetch(req: Request, env: EnvDaConferencia, ctx: Ctx): Promise<Response> {
    const comDb = { ...env, DB: bancoPeloNode(env.BANCO) };
    if (new URL(req.url).pathname !== "/__conferencias") return worker.fetch(req, comDb as never, ctx);

    atualizarAmbiente(comDb);
    __resetGoogleTokenCache();
    const instante = new Date(Date.UTC(2026, 10, 10, 15, 4, 5));
    const fuso = { timeZone: "America/Sao_Paulo" };
    const corpo = {
      processExiste: typeof process,
      bufferExiste: typeof (globalThis as Record<string, unknown>).Buffer,
      tokenDoGoogle: await tokenDoGoogle().catch((e: unknown) => `ERRO: ${e instanceof Error ? e.message : String(e)}`),
      carimboSP: formatarCarimboSP(instante),
      toLocaleString: instante.toLocaleString("pt-BR", fuso),
      toLocaleDateString: instante.toLocaleDateString("pt-BR", fuso),
    };
    return new Response(JSON.stringify(corpo), { headers: { "content-type": "application/json" } });
  },
};
