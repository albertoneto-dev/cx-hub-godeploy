// GET (ou HEAD) /api/saude: a saúde de cada função do CX Hub, no contrato do Monitor da Black (17/11/2026).
//
// Por que existe: o Monitor da Black lê esta rota a cada 5 min para saber se cada função está de pé (registrar
// reenvio, reembolso e cancelamento, o bot, a busca de pedido, a fila que leva os casos à raw), e não só se o app
// responde. Componentes e regras: api/saude/regras.ts. Registro do desfecho de cada função: api/saude/registro.ts.
//
// Acesso: o app é "authenticated" no GoDeploy. O gateway barra quem não tem sessão nem a chave gdk_ deste app; o
// monitor chama com "Authorization: Bearer gdk_..." (decisão do usuário em 17/11/2026, sem ponte pública). O detalhe
// nunca leva dado de cliente nem segredo: só contagens, horários e códigos HTTP.
//
// Tempo: responde em até ~4 s. O banco tem 1,5 s; a leitura da fila e as sondas, 2,5 s, em paralelo. O que não
// responder no prazo fica de fora desta leitura, e a rota não espera.
//
// Sonda: só leitura (a DAG no Airflow, "select 1" no Data Mart), e só quando as chamadas reais não dizem nada (a
// dependência sem nenhuma chamada nos últimos 15 min). O Cosmos fica sem sonda: a única leitura barata exige login, e
// um login a cada 15 min não é só leitura. O resultado vira observação como qualquer chamada: dois leitores seguidos
// não dobram a sonda.

import type { ConfigMetabase } from "../../backoffice/servidor/config";
import { consultar } from "../../backoffice/servidor/metabase";
import { dagPausada } from "../../servidor/airflow";
import { type Banco, garantirEsquema } from "../../servidor/banco";
import type { ConfigAirflow } from "../../servidor/config";
import type { Busca } from "../../servidor/contexto";
import { erro } from "../../servidor/http";
import { DEPENDENCIAS, medirComo } from "./medidor";
import {
  aplicarResumo, CATALOGO, type ComponenteSaude, componenteDaAvaliacao, DESFECHOS_DE_FALHA, type EntradaAvaliacao,
  type EstadoGravado, estadoVazio, inicioDaUltimaHora, type LeituraDaFila, montarResposta, type Observacao, resumirObservacoes,
} from "./regras";
import { espiarPendentes, lerSaude, type LeituraSaude, podarSaude, precisaPodarSaude } from "./registro";

export const CAMINHO_DA_SAUDE = "/api/saude";

const PRAZO_BANCO_MS = 1500;
const PRAZO_EXTERNO_MS = 2500;
const SONDA_SEM_TRAFEGO_MS = 15 * 60_000;
const HORA_MS = 60 * 60_000;

export type DependenciasDaSaude = {
  /** null: o app está sem o env.DB. */
  db: Banco | null;
  agora: number;
  airflow: ConfigAirflow | null;
  metabase: ConfigMetabase | null;
  /** O fetch sem o medidor global: as sondas medem com medirComo. */
  busca: Busca;
  /** O que roda depois da resposta (a poda), no ctx.waitUntil. */
  depois(p: Promise<unknown>): void;
};

function comPrazo<T>(p: Promise<T>, ms: number, rotulo: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<T>((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(Object.assign(new Error(`${rotulo}: tempo esgotado`), { name: "TimeoutError" })), ms);
  });
  return Promise.race([p, prazo]).finally(() => clearTimeout(timer));
}

type Hora = { tentativas: number; erros: number; primeira: string | null; primeiroErro: string | null };
const horaVazia = (): Hora => ({ tentativas: 0, erros: 0, primeira: null, primeiroErro: null });

/** O estado gravado com as observações ainda não gravadas por cima (as sondas desta leitura, inclusive). */
function somarPendentes(leitura: LeituraSaude, obs: Observacao[], agora: number) {
  const estados = new Map<string, EstadoGravado>(leitura.estados);
  const hora = new Map<string, Hora>(leitura.hora);
  const porComponente = new Map<string, Observacao[]>();
  for (const o of obs) porComponente.set(o.componente, [...(porComponente.get(o.componente) ?? []), o]);
  const inicioDaHora = inicioDaUltimaHora(agora);
  for (const [componente, lista] of porComponente) {
    const r = resumirObservacoes(lista);
    estados.set(componente, aplicarResumo(estados.get(componente) ?? estadoVazio(), r));
    const h = { ...(hora.get(componente) ?? horaVazia()) };
    for (const [janela, v] of Object.entries(r.janelas)) {
      if (janela < inicioDaHora) continue;
      h.tentativas += v.tentativas;
      h.erros += v.erros;
      if (!h.primeira || janela < h.primeira) h.primeira = janela;
      if (v.erros > 0 && (!h.primeiroErro || janela < h.primeiroErro)) h.primeiroErro = janela;
    }
    hora.set(componente, h);
  }
  return { estados, hora };
}

const texto = (v: unknown) => (typeof v === "string" && v ? v : null);
const menor = (a: string | null, b: string | null) => (!a ? b : !b ? a : a <= b ? a : b);
const maior = (a: string | null, b: string | null) => (!a ? b : !b ? a : a >= b ? a : b);

/** A fila de agora, das tabelas dela: consultas pelos índices da situação, poucas linhas. */
async function lerFila(db: Banco, agora: number): Promise<LeituraDaFila> {
  await garantirEsquema(db);
  const [casos, atualizacoes, terminados, andando, rodada] = await Promise.all([
    db.um("SELECT COUNT(*) AS n, MIN(enfileirado_em) AS antigo FROM casos WHERE situacao IN ('pendente', 'enviado')"),
    db.um("SELECT COUNT(*) AS n, MIN(enfileirado_em) AS antigo FROM atualizacoes WHERE situacao IN ('pendente', 'enviado')"),
    db.query("SELECT desfecho, gravados, criado_em, terminado_em FROM lotes WHERE situacao = 'terminado' ORDER BY criado_em DESC LIMIT 20"),
    db.um("SELECT MAX(criado_em) AS em FROM lotes WHERE situacao IN ('montando', 'disparado')"),
    db.um("SELECT valor FROM controle WHERE chave = 'ultima_rodada'"),
  ]);
  const desdeUmaHora = new Date(agora - HORA_MS).toISOString();
  let ultimoGravado: string | null = null;
  let falhaRecente: LeituraDaFila["falha_recente"] = null;
  let falhasHora = 0;
  for (const l of terminados) {
    const fim = texto(l.terminado_em);
    if (fim && Number(l.gravados) > 0) ultimoGravado = maior(ultimoGravado, fim);
    if (fim && fim >= desdeUmaHora && DESFECHOS_DE_FALHA.includes(String(l.desfecho))) {
      falhasHora++;
      if (!falhaRecente || fim > falhaRecente.em) falhaRecente = { desfecho: String(l.desfecho), em: fim };
    }
  }
  let disparo: string | null = null;
  try {
    const r = JSON.parse(String(rodada?.valor ?? "null")) as { andamento?: { estado?: string }; disparo?: { estado?: string } | null; falhas?: unknown[] } | null;
    if (r?.falhas?.length) disparo = "erro";
    else if (r?.andamento?.estado === "sem_airflow") disparo = "sem_airflow";
    else disparo = texto(r?.disparo?.estado);
  } catch {
    disparo = null;
  }
  return {
    pendentes: (Number(casos?.n) || 0) + (Number(atualizacoes?.n) || 0),
    pendente_mais_antigo: menor(texto(casos?.antigo), texto(atualizacoes?.antigo)),
    ultimo_gravado: ultimoGravado,
    ultimo_lote: maior(texto(andando?.em), texto(terminados[0]?.criado_em)),
    falha_recente: falhaRecente,
    falhas_hora: falhasHora,
    disparo,
  };
}

/** As sondas que esta leitura precisa: só das dependências sem chamada real nos últimos 15 min. */
function sondas(d: DependenciasDaSaude, estados: Map<string, EstadoGravado>, achados: { pausada?: boolean }): Array<() => Promise<unknown>> {
  const semTrafego = (id: string) => {
    const t = estados.get(id)?.ultima_tentativa;
    return !t || d.agora - Date.parse(t) > SONDA_SEM_TRAFEGO_MS;
  };
  const lista: Array<() => Promise<unknown>> = [];
  const airflow = d.airflow;
  if (airflow && semTrafego(DEPENDENCIAS.airflow.componente)) {
    // A leitura da DAG que a rodada já faz: diz também se ela está pausada (a fila parada por isso).
    lista.push(async () => {
      achados.pausada = await dagPausada(airflow, medirComo(DEPENDENCIAS.airflow, d.busca), d.agora);
    });
  }
  const metabase = d.metabase;
  if (metabase && semTrafego(DEPENDENCIAS.datamart.componente)) {
    lista.push(() => consultar(metabase, medirComo(DEPENDENCIAS.datamart, d.busca), "select 1", PRAZO_EXTERNO_MS));
  }
  return lista;
}

export async function responderSaude(req: Request, d: DependenciasDaSaude): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return erro(405, "METHOD_NOT_ALLOWED", "Use GET, HEAD nesta rota.", { allow: "GET, HEAD" });
  const agora = d.agora;

  let leitura: LeituraSaude | null = null;
  let erroBanco: string | undefined;
  if (!d.db) erroBanco = "o app está sem o banco (env.DB)";
  else {
    try {
      leitura = await comPrazo(lerSaude(d.db, agora), PRAZO_BANCO_MS, "banco");
    } catch (err) {
      const tempo = (err as Error)?.name === "TimeoutError";
      erroBanco = tempo ? "o banco do app não respondeu em 1,5 s" : "o banco do app não respondeu";
      console.error(`[saude] ${erroBanco}: ${String((err as Error)?.message || err).slice(0, 160)}`);
    }
  }

  // A fila e as sondas, em paralelo e com prazo.
  const achados: { fila?: LeituraDaFila | null; pausada?: boolean } = {};
  if (leitura && d.db) {
    const db = d.db;
    const estadosAgora = somarPendentes(leitura, espiarPendentes(), agora).estados;
    const tarefas = [
      comPrazo(lerFila(db, agora), PRAZO_EXTERNO_MS, "fila").then(f => { achados.fila = f; }, () => { achados.fila = null; }),
      ...sondas(d, estadosAgora, achados).map(s => s().catch(() => undefined)),
    ];
    await comPrazo(Promise.allSettled(tarefas), PRAZO_EXTERNO_MS + 300, "sondas").catch(() => undefined);
  }
  if (achados.fila && achados.pausada) achados.fila.disparo = "dag_pausada";

  const somado = leitura ? somarPendentes(leitura, espiarPendentes(), agora) : null;
  const componentes: ComponenteSaude[] = CATALOGO.map(regra => {
    if (!somado && regra.id !== "app") {
      return {
        id: regra.id, nome: regra.nome, nivel: "alerta", ultimo_sucesso: null, ultima_tentativa: null, erros_ultima_hora: 0,
        pendentes: null, detalhe: "sem dados: o banco do app não respondeu", critico: regra.critico, tipo: regra.tipo,
      };
    }
    const e = somado?.estados.get(regra.id) ?? estadoVazio();
    const h = somado?.hora.get(regra.id) ?? horaVazia();
    const entrada: EntradaAvaliacao = {
      ...e, tentativas_hora: h.tentativas, erros_hora: h.erros, primeira_tentativa_hora: h.primeira, primeiro_erro_hora: h.primeiroErro,
      inicio_medicao: leitura?.inicio ?? null,
    };
    if (regra.id === "fila_entrega") entrada.fila = achados.fila ?? null;
    if (regra.id === "app") entrada.app = { bancoOk: Boolean(leitura), erroBanco };
    return componenteDaAvaliacao(regra, entrada, agora);
  });

  const { status, corpo } = montarResposta(componentes, agora);
  if (leitura && d.db && precisaPodarSaude(d.db, agora)) d.depois(podarSaude(d.db, agora));
  const cabecalhos = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (req.method === "HEAD") return new Response(null, { status, headers: cabecalhos });
  return new Response(JSON.stringify(corpo), { status, headers: cabecalhos });
}
