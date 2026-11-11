// Copiado do app cx-hub. Quem pode chamar POST /api/interno/lote sem estar logado: o cron do GoDeploy, que assina a chamada com
// X-Godeploy-Cron ("t=<segundos>;sig=<64 hex>") e a GODEPLOY_CRON_KEY. A plataforma não documenta o esquema da
// assinatura, e nenhum candidato a reproduziu no api-procon-processos (de onde este arquivo veio, decisão 21 de lá).
// Por isso: primeiro a conferência pelos candidatos, com tempo dentro de ±300 s; se nenhum bater, o cabeçalho ainda
// passa por três travas: o formato exato, o t a menos de 5 min do relógio e no máximo uma rodada a cada 30 s. O log
// registra o caminho que valeu e o formato do cabeçalho, nunca o valor.

import { garantirEsquema, pegarVez } from "./banco";
import type { Contexto } from "./contexto";
import { base64ParaBytes, hmacSha256Hex, iguais, paraHex } from "./cripto";
import { lerBytes } from "./http";

const TOLERANCIA_MS = 300_000;
const CAMPOS_TEMPO = new Set(["t", "ts", "timestamp"]);
const CAMPOS_ASSINATURA = new Set(["v1", "s", "sig", "signature"]);

// Mensagens candidatas, na ordem em que são tentadas (t fica como veio no cabeçalho). "t." e "t.body" são o esquema
// do Stripe, HMAC de "<t>.<corpo>", que o campo v1= sugere (com corpo vazio, a mensagem é "<t>.").
const candidatas = (t: string, metodo: string, caminho: string, corpo: string): Array<[string, string]> => [
  ["t", t],
  ["t.", `${t}.`],
  ...(corpo ? [["t.body", `${t}.${corpo}`] as [string, string]] : []),
  ["t.path", `${t}.${caminho}`],
  ["t:path", `${t}:${caminho}`],
  ["t.METHOD.path", `${t}.${metodo}.${caminho}`],
  ["t.METHOD path", `${t}.${metodo} ${caminho}`],
  ["METHOD\\npath\\nt", `${metodo}\n${caminho}\n${t}`],
  ["path.t", `${caminho}.${t}`],
  ["path:t", `${caminho}:${t}`],
];

// Assinatura em 64 hex ou base64/base64url de 32 bytes → hex minúsculo; qualquer outra coisa → null.
function assinaturaHex(s: string): string | null {
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (!/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = base64ParaBytes(b64.padEnd(44, "="));
    return bytes.length === 32 ? paraHex(bytes) : null;
  } catch {
    return null;
  }
}

function lerCabecalho(cabecalho: string): { t: string; ms: number; assinaturas: string[] } | null {
  let t: string | null = null;
  const assinaturas: string[] = [];
  for (const parte of cabecalho.split(/[;,]/)) {
    const i = parte.indexOf("=");
    if (i <= 0) continue;
    const nome = parte.slice(0, i).trim().toLowerCase();
    const valor = parte.slice(i + 1).trim();
    if (CAMPOS_TEMPO.has(nome)) t ??= valor;
    else if (CAMPOS_ASSINATURA.has(nome)) {
      const hex = assinaturaHex(valor);
      if (hex) assinaturas.push(hex);
    }
  }
  if (t === null || !assinaturas.length) return null;
  if (/^\d{10}$/.test(t)) return { t, ms: Number(t) * 1000, assinaturas };
  if (/^\d{13}$/.test(t)) return { t, ms: Number(t), assinaturas };
  return null;
}

export type ConferenciaCron = { ok: boolean; esquema: string | null; motivo: string };

export async function conferirCron(
  cabecalho: string | null, chave: string | null, metodo: string, caminho: string, agora: number, corpo = "",
): Promise<ConferenciaCron> {
  if (!cabecalho?.trim()) return { ok: false, esquema: null, motivo: "sem cabeçalho" };
  if (!chave) return { ok: false, esquema: null, motivo: "sem a GODEPLOY_CRON_KEY" };
  if (cabecalho.length > 2048) return { ok: false, esquema: null, motivo: "cabeçalho grande demais" };
  const lido = lerCabecalho(cabecalho);
  if (!lido) return { ok: false, esquema: null, motivo: "formato desconhecido" };
  if (!(Math.abs(agora - lido.ms) <= TOLERANCIA_MS)) return { ok: false, esquema: null, motivo: "fora da janela de 5 min" };
  // Calcula todas as candidatas antes de comparar: o tempo de resposta não revela qual esquema chegou perto.
  const macs: Array<[string, string]> = [];
  for (const [esquema, mensagem] of candidatas(lido.t, metodo.toUpperCase(), caminho, corpo)) macs.push([esquema, await hmacSha256Hex(chave, mensagem)]);
  let achado: string | null = null;
  for (const [esquema, mac] of macs) for (const a of lido.assinaturas) if (iguais(mac, a) && !achado) achado = esquema;
  return achado ? { ok: true, esquema: achado, motivo: "ok" } : { ok: false, esquema: null, motivo: "nenhum esquema conferiu" };
}

// O formato do cabeçalho sem os valores (ex.: "t=<10 dígitos>;sig=<64 hex>"), para o log.
export function formatoCron(cabecalho: string): string {
  return cabecalho.slice(0, 300).split(/([;,])/).map(parte => {
    if (parte === ";" || parte === ",") return parte;
    const i = parte.indexOf("=");
    if (i <= 0) return "<?>";
    const v = parte.slice(i + 1).trim();
    const tipo = /^\d+$/.test(v) ? "dígitos" : /^[0-9a-f]+$/i.test(v) ? "hex" : "car.";
    return `${parte.slice(0, i).trim().slice(0, 20)}=<${v.length} ${tipo}>`;
  }).join("");
}

// O formato exato visto em produção (03/11/2026). A terceira trava, a de 30 s, precisa do banco: fica em autorizarCron.
const FORMATO_CRON = /^t=(\d{10});sig=[0-9a-fA-F]{64}$/;
const INTERVALO_SEM_ASSINATURA_MS = 30_000;

export function travasCron(cabecalho: string, agora: number): { ok: boolean; motivo: string } {
  const m = cabecalho.trim().match(FORMATO_CRON);
  if (!m) return { ok: false, motivo: "fora do formato t=<10 dígitos>;sig=<64 hex>" };
  if (!(Math.abs(agora - Number(m[1]) * 1000) <= TOLERANCIA_MS)) return { ok: false, motivo: "fora da janela de 5 min" };
  return { ok: true, motivo: "ok" };
}

// "cedo" é uma rodada sem assinatura a menos de 30 s da anterior. O corpo entra na conferência porque um dos
// candidatos (o do Stripe) assina o corpo.
export async function autorizarCron(c: Contexto): Promise<"ok" | "negado" | "cedo"> {
  const cabecalho = c.req.headers.get("x-godeploy-cron");
  if (!cabecalho) return "negado";
  const bytes = await lerBytes(c.req, 64 * 1024);
  const corpo = bytes ? new TextDecoder().decode(bytes) : "";
  const r = await conferirCron(cabecalho, c.cfg.cronChave, c.req.method, c.url.pathname, c.agora, corpo);
  let resultado: "ok" | "negado" | "cedo" = r.ok ? "ok" : "negado";
  let caminho = r.ok ? `esquema ${r.esquema}` : "";
  if (!r.ok) {
    const travas = travasCron(cabecalho, c.agora);
    if (!travas.ok) caminho = `recusado (${r.motivo}; travas: ${travas.motivo})`;
    else {
      await garantirEsquema(c.db);
      resultado = (await pegarVez(c.db, "cron_sem_assinatura", c.agora, INTERVALO_SEM_ASSINATURA_MS)) ? "ok" : "cedo";
      caminho = resultado === "ok" ? `aceito pelas travas (${r.motivo})` : "recusado (rodada sem assinatura há menos de 30 s)";
    }
  }
  console.log(`cron: cabeçalho ${formatoCron(cabecalho)} · corpo ${corpo.length} car. · ${caminho}`);
  return resultado;
}
