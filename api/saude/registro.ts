// O registro do desfecho de cada função, para o GET /api/saude (17/11/2026). As regras estão em api/saude/regras.ts.
//
// Como funciona:
//   1. Onde a função termina, anotarSaude(...) só empurra a observação para uma lista em memória: não toca no banco,
//      não espera e nunca lança. O registro não pode derrubar nem atrasar a função medida.
//   2. No fim de cada requisição, e de cada tarefa que o after() deixou rodando, o worker.ts chama
//      gravarObservacoes(db, retirarPendentes()) dentro do ctx.waitUntil: agrupa por componente e grava com dois
//      UPSERTs por componente (saude_estado e saude_janela).
//   3. O GET /api/saude lê as duas tabelas (consultas pequenas e indexadas) e poda as janelas com mais de 48 h, no
//      máximo uma vez por hora.
//
// Custo no env.DB: a rodada do lote (144 por dia) e a da cache (288 por dia) gravam sempre. A dependência com sucesso
// seguido grava no máximo uma vez por minuto por isolate; a falha grava sempre.

import type { Banco } from "../../servidor/banco";
import { type EstadoGravado, inicioDaUltimaHora, janelaDe, type Observacao, regraDe, type Resultado, resumirObservacoes } from "./regras";

const LIMITE_PENDENTES = 500;
const pendentes: Observacao[] = [];

/** Guarda uma observação para gravar no fim da requisição. Nunca lança. */
export function anotarSaude(
  componente: string,
  resultado: Resultado,
  opcoes: { erro?: string; duracaoMs?: number; extra?: Record<string, string>; em?: string } = {},
): Observacao | null {
  try {
    const o: Observacao = { componente, resultado, em: opcoes.em || new Date().toISOString() };
    if (opcoes.erro) o.erro = String(opcoes.erro).slice(0, 160);
    if (typeof opcoes.duracaoMs === "number") o.duracaoMs = Math.max(0, Math.round(opcoes.duracaoMs));
    if (opcoes.extra) o.extra = opcoes.extra;
    pendentes.push(o);
    // Se a gravação falhar de vez, a lista não cresce sem fim: fica com as mais novas.
    if (pendentes.length > LIMITE_PENDENTES) pendentes.splice(0, pendentes.length - LIMITE_PENDENTES);
    return o;
  } catch {
    return null;
  }
}

/** Esvazia a lista e devolve o que estava nela. */
export function retirarPendentes(): Observacao[] {
  return pendentes.splice(0);
}

/** Uma cópia da lista, sem esvaziá-la: a leitura da saúde soma o que ainda não foi gravado (as sondas dela, inclusive). */
export function espiarPendentes(): Observacao[] {
  return [...pendentes];
}

// Por banco (WeakSet/WeakMap no env.DB bruto): o banco() da fila é um objeto novo a cada requisição, e nos testes cada
// ambiente tem o seu env.DB, então estado de módulo vazaria de um teste para o outro.
const tabelasProntas = new WeakSet<object>();
const ultimoOkDaDependencia = new WeakMap<object, Map<string, number>>();
const ultimaPoda = new WeakMap<object, number>();

export async function garantirTabelasSaude(db: Banco): Promise<void> {
  if (tabelasProntas.has(db.bruto)) return;
  await db.exec(`CREATE TABLE IF NOT EXISTS saude_estado (
    componente TEXT PRIMARY KEY, ultimo_sucesso TEXT, ultima_tentativa TEXT, ultimo_erro TEXT, ultimo_erro_em TEXT,
    falhas_seguidas INTEGER NOT NULL DEFAULT 0, ultima_duracao_ms INTEGER, extra TEXT)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS saude_janela (
    componente TEXT NOT NULL, janela TEXT NOT NULL, tentativas INTEGER NOT NULL DEFAULT 0, erros INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (componente, janela))`);
  await db.exec("CREATE INDEX IF NOT EXISTS ix_saude_janela ON saude_janela(janela)");
  // inicio: quando o app começou a medir. O cron que nunca rodou desde então é comparado com ele, em vez de ficar "ok"
  // para sempre ou de inventar uma data de sucesso.
  await db.exec("CREATE TABLE IF NOT EXISTS saude_meta (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)");
  await db.exec("INSERT OR IGNORE INTO saude_meta (chave, valor) VALUES ('inicio', ?)", [new Date().toISOString()]);
  tabelasProntas.add(db.bruto);
}

// Cada campo só anda para a frente: duas requisições que gravam fora de ordem não apagam o sucesso mais novo.
const SQL_ESTADO = `INSERT INTO saude_estado
    (componente, ultimo_sucesso, ultima_tentativa, ultimo_erro, ultimo_erro_em, falhas_seguidas, ultima_duracao_ms, extra)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(componente) DO UPDATE SET
    ultimo_sucesso = CASE WHEN excluded.ultimo_sucesso IS NOT NULL
        AND (saude_estado.ultimo_sucesso IS NULL OR excluded.ultimo_sucesso > saude_estado.ultimo_sucesso)
      THEN excluded.ultimo_sucesso ELSE saude_estado.ultimo_sucesso END,
    ultima_tentativa = CASE WHEN excluded.ultima_tentativa IS NOT NULL
        AND (saude_estado.ultima_tentativa IS NULL OR excluded.ultima_tentativa > saude_estado.ultima_tentativa)
      THEN excluded.ultima_tentativa ELSE saude_estado.ultima_tentativa END,
    ultimo_erro = CASE WHEN excluded.ultimo_erro_em IS NOT NULL
        AND (saude_estado.ultimo_erro_em IS NULL OR excluded.ultimo_erro_em >= saude_estado.ultimo_erro_em)
      THEN excluded.ultimo_erro ELSE saude_estado.ultimo_erro END,
    ultimo_erro_em = CASE WHEN excluded.ultimo_erro_em IS NOT NULL
        AND (saude_estado.ultimo_erro_em IS NULL OR excluded.ultimo_erro_em >= saude_estado.ultimo_erro_em)
      THEN excluded.ultimo_erro_em ELSE saude_estado.ultimo_erro_em END,
    falhas_seguidas = CASE WHEN ? = 1 THEN excluded.falhas_seguidas
      ELSE saude_estado.falhas_seguidas + excluded.falhas_seguidas END,
    ultima_duracao_ms = COALESCE(excluded.ultima_duracao_ms, saude_estado.ultima_duracao_ms),
    extra = CASE WHEN excluded.extra IS NULL THEN saude_estado.extra
      ELSE json_patch(COALESCE(saude_estado.extra, '{}'), excluded.extra) END`;

const SQL_JANELA = `INSERT INTO saude_janela (componente, janela, tentativas, erros) VALUES (?, ?, ?, ?)
  ON CONFLICT(componente, janela) DO UPDATE SET
    tentativas = saude_janela.tentativas + excluded.tentativas, erros = saude_janela.erros + excluded.erros`;

/** Grava as observações. Nunca lança: o erro vai só para o log. */
export async function gravarObservacoes(db: Banco | null | undefined, obs: Observacao[], agoraMs: number = Date.now()): Promise<void> {
  if (!db || !obs.length) return;
  try {
    await garantirTabelasSaude(db);
    const porComponente = new Map<string, Observacao[]>();
    for (const o of obs) {
      if (!regraDe(o.componente)) continue;
      const lista = porComponente.get(o.componente) ?? [];
      lista.push(o);
      porComponente.set(o.componente, lista);
    }
    let okRecentes = ultimoOkDaDependencia.get(db.bruto);
    if (!okRecentes) ultimoOkDaDependencia.set(db.bruto, (okRecentes = new Map()));
    for (const [componente, lista] of porComponente) {
      if (regraDe(componente)!.tipo === "dependencia") {
        if (lista.every(o => o.resultado === "ok")) {
          const ultimo = okRecentes.get(componente);
          if (ultimo !== undefined && agoraMs - ultimo < 60_000) continue;
          okRecentes.set(componente, agoraMs);
        } else {
          okRecentes.delete(componente);
        }
      }
      const r = resumirObservacoes(lista);
      await db.exec(SQL_ESTADO, [
        componente, r.ultimo_sucesso, r.ultima_tentativa, r.ultimo_erro, r.ultimo_erro_em, r.falhas, r.ultima_duracao_ms,
        r.extra ? JSON.stringify(r.extra) : null, r.zerarFalhas ? 1 : 0,
      ]);
      for (const [janela, v] of Object.entries(r.janelas)) await db.exec(SQL_JANELA, [componente, janela, v.tentativas, v.erros]);
    }
  } catch (err) {
    console.error(`[saude] registro não gravado: ${String((err as Error)?.message || err).slice(0, 160)}`);
  }
}

export interface LeituraSaude {
  estados: Map<string, EstadoGravado>;
  /** A soma da última hora por componente, e o início da janela mais antiga com tentativa e com erro. */
  hora: Map<string, { tentativas: number; erros: number; primeira: string | null; primeiroErro: string | null }>;
  inicio: string | null;
}

function lerExtra(v: unknown): Record<string, string> | null {
  if (typeof v !== "string" || !v) return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : null;
  } catch {
    return null;
  }
}

const textoOuNull = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Lê o estado, a última hora e o início da medição. Lança se o banco falhar: quem chama trata como o app em erro. */
export async function lerSaude(db: Banco, agoraMs: number): Promise<LeituraSaude> {
  await garantirTabelasSaude(db);
  const [e, j, m] = await Promise.all([
    db.query("SELECT componente, ultimo_sucesso, ultima_tentativa, ultimo_erro, ultimo_erro_em, falhas_seguidas, ultima_duracao_ms, extra FROM saude_estado"),
    db.query("SELECT componente, janela, tentativas, erros FROM saude_janela WHERE janela >= ?", [inicioDaUltimaHora(agoraMs)]),
    db.um("SELECT valor FROM saude_meta WHERE chave = 'inicio'"),
  ]);
  const estados = new Map<string, EstadoGravado>();
  for (const r of e) {
    estados.set(String(r.componente), {
      ultimo_sucesso: textoOuNull(r.ultimo_sucesso),
      ultima_tentativa: textoOuNull(r.ultima_tentativa),
      ultimo_erro: textoOuNull(r.ultimo_erro),
      ultimo_erro_em: textoOuNull(r.ultimo_erro_em),
      falhas_seguidas: Number(r.falhas_seguidas) || 0,
      ultima_duracao_ms: r.ultima_duracao_ms === null || r.ultima_duracao_ms === undefined ? null : Number(r.ultima_duracao_ms),
      extra: lerExtra(r.extra),
    });
  }
  const hora: LeituraSaude["hora"] = new Map();
  for (const r of j) {
    const c = String(r.componente);
    const h = hora.get(c) ?? { tentativas: 0, erros: 0, primeira: null, primeiroErro: null };
    const tentativas = Number(r.tentativas) || 0;
    const erros = Number(r.erros) || 0;
    const janela = String(r.janela);
    h.tentativas += tentativas;
    h.erros += erros;
    if (tentativas > 0 && (!h.primeira || janela < h.primeira)) h.primeira = janela;
    if (erros > 0 && (!h.primeiroErro || janela < h.primeiroErro)) h.primeiroErro = janela;
    hora.set(c, h);
  }
  return { estados, hora, inicio: textoOuNull(m?.valor) };
}

/** A poda roda no máximo uma vez por hora por isolate. */
export function precisaPodarSaude(db: Banco, agoraMs: number): boolean {
  const u = ultimaPoda.get(db.bruto);
  return u === undefined || agoraMs - u > 60 * 60_000;
}

/** Apaga as janelas com mais de 48 h. Nunca lança. */
export async function podarSaude(db: Banco, agoraMs: number): Promise<void> {
  ultimaPoda.set(db.bruto, agoraMs);
  try {
    await db.exec("DELETE FROM saude_janela WHERE janela < ?", [janelaDe(agoraMs - 48 * 60 * 60_000)]);
  } catch (err) {
    console.error(`[saude] poda falhou: ${String((err as Error)?.message || err).slice(0, 120)}`);
  }
}
