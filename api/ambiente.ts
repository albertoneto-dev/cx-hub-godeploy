// O process.env que o código portado do CX Hub lê (cxhub/), montado a partir dos segredos do app (o env do Worker).
// No Worker não há process; este módulo é o primeiro import do worker.ts, para o objeto existir antes de qualquer
// módulo do CX Hub ser avaliado, e o worker.ts o atualiza a cada requisição (um segredo trocado no GoDeploy vale sem
// novo deploy). Os valores vêm do env tal como estão; só três são completados aqui:
//   - CXHUB_FILA_URL e CXHUB_FILA_TOKEN: a fila mora neste Worker (api/filaNoWorker.ts). Sem eles cadastrados, a URL
//     é a origem interna dela e o token é o primeiro do CXHUB_FILA_TOKENS que a própria fila aceita;
//   - VERCEL_ENV=production: este app é a produção, e o COSMOS_RESEND_SIMULADO do CX Hub só vale fora dela.
// Sem imports de propósito: nada pode ser avaliado antes deste módulo.

/** A origem que o transporte da fila (api/filaNoWorker.ts) entrega ao roteador da fila, sem rede. Não resolve fora daqui. */
export const ORIGEM_DA_FILA_NO_WORKER = "http://fila.cx-hub.interno";

export type Ambiente = Record<string, string | undefined>;

type ComProcess = { process?: { env?: Ambiente } };

/** Garante process.env no global (no Node ele já existe) e o devolve. */
export function envDoProcesso(): Ambiente {
  const g = globalThis as unknown as ComProcess;
  if (!g.process) g.process = { env: {} };
  if (!g.process.env) g.process.env = {};
  return g.process.env;
}

envDoProcesso();

// As chaves que este módulo pôs no alvo, para tirar as que sumiram do env (segredo apagado no GoDeploy).
const postasPorAlvo = new WeakMap<Ambiente, Set<string>>();

/** O que vai ao process.env para este env: os segredos em texto e os três completados. */
export function ambienteDoApp(env: Record<string, unknown>): Ambiente {
  const saida: Ambiente = {};
  for (const [chave, valor] of Object.entries(env)) if (typeof valor === "string") saida[chave] = valor;
  if (!saida.CXHUB_FILA_URL?.trim()) saida.CXHUB_FILA_URL = ORIGEM_DA_FILA_NO_WORKER;
  if (!saida.CXHUB_FILA_TOKEN?.trim()) {
    const primeiro = (saida.CXHUB_FILA_TOKENS || "").split(",").map((t) => t.trim()).find(Boolean);
    if (primeiro) saida.CXHUB_FILA_TOKEN = primeiro;
  }
  saida.VERCEL_ENV = "production";
  return saida;
}

/** Copia para o alvo (o process.env, por padrão) o ambiente deste env, e tira o que esta função pôs antes e sumiu. */
export function atualizarAmbiente(env: Record<string, unknown>, alvo: Ambiente = envDoProcesso()): void {
  const novo = ambienteDoApp(env);
  const antes = postasPorAlvo.get(alvo) ?? new Set<string>();
  for (const chave of antes) if (!(chave in novo)) delete alvo[chave];
  for (const [chave, valor] of Object.entries(novo)) alvo[chave] = valor;
  postasPorAlvo.set(alvo, new Set(Object.keys(novo)));
}
