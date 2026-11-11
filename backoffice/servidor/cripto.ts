// HMAC, comparação em tempo constante e base64, só com as APIs da web (o Worker não tem Buffer).

const texto = new TextEncoder();

export const paraHex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");

export async function hmacSha256Hex(chave: string, mensagem: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", texto.encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return paraHex(await crypto.subtle.sign("HMAC", k, texto.encode(mensagem)));
}

// Compara sem sair no primeiro caractere diferente: o tempo da resposta não revela quanto do token bateu.
export function iguais(a: string, b: string): boolean {
  let dif = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) dif |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return dif === 0;
}

export function base64ParaBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
