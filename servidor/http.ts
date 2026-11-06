// Respostas JSON no formato do contrato (docs/fila-cxhub.md): erro sempre como { code, message }.

export const json = (dados: unknown, status = 200, cabecalhos: Record<string, string> = {}) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cabecalhos },
  });

export const erro = (status: number, code: string, message: string, cabecalhos: Record<string, string> = {}) =>
  json({ code, message }, status, cabecalhos);

// Corpo em bytes, sem passar do limite: com content-length, lê de uma vez; sem ele, para de ler ao passar do teto,
// para um corpo grande não encher a memória do Worker. null: passou do limite.
export async function lerBytes(req: Request, limite: number): Promise<Uint8Array | null> {
  const declarado = Number(req.headers.get("content-length") || 0);
  if (declarado > limite) return null;
  if (declarado) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    return bytes.byteLength > limite ? null : bytes;
  }
  if (!req.body) return new Uint8Array();
  const leitor = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    partes.push(value);
  }
  if (partes.length === 1) return partes[0];
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

// O corpo como objeto JSON, ou a resposta 400 pronta.
export async function lerObjeto(req: Request, limite: number): Promise<Record<string, unknown> | Response> {
  const bytes = await lerBytes(req, limite);
  if (!bytes) return erro(400, "INVALID_REQUEST", `Corpo maior que ${Math.round(limite / 1024)} KB.`);
  let corpo: unknown;
  try {
    corpo = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return erro(400, "INVALID_REQUEST", "JSON inválido. Confira a sintaxe do corpo.");
  }
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return erro(400, "INVALID_REQUEST", "O corpo precisa ser um objeto JSON.");
  return corpo as Record<string, unknown>;
}

// Trecho do caminho codificado na URL; com % malformado, fica como veio.
export function decodificar(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
