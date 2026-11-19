// As regras puras da saúde do CX Hub (GET /api/saude), sem fetch, env nem banco: ficam fora da rota para o teste
// unitário (testes/saudeRegras.test.ts).
//
// Por que existe (17/11/2026): o Monitor da Black lê cada app a cada 5 min e precisa saber se cada função está de pé,
// e não só se o app responde. O campo que importa é o ultimo_sucesso: por ele se vê que o CX Hub "parou de registrar"
// com o app no ar. O contrato (os campos de cada componente, o 503 só com crítico em erro) é o mesmo da Central de
// Tickets (src/saude/regras.ts de lá), para o monitor ler os dois apps do mesmo jeito.
//
// O desfecho de cada função é anotado onde ela termina de verdade (api/saude/registro.ts): o `code` do corpo dos envios
// (como a tela e a Central leem), a rodada do lote pelo resumo dela, cada serviço externo na chamada real. Aqui ficam
// o catálogo e a regra que transforma o que foi gravado em ok, alerta ou erro.

export type TipoComponente = "cron" | "demanda" | "dependencia" | "app";
export type Nivel = "ok" | "alerta" | "erro";
/** neutro: houve tentativa, mas sem sucesso nem falha do sistema (pedido que não existe, dado recusado pela regra). */
export type Resultado = "ok" | "erro" | "neutro";

export interface RegraComponente {
  id: string;
  nome: string;
  tipo: TipoComponente;
  /** Crítico em erro faz a rota responder 503. */
  critico: boolean;
  /** cron: sem sucesso há mais destes minutos vira erro. */
  erroMin?: number;
  /** cron: sem sucesso há mais destes minutos vira alerta. */
  alertaMin?: number;
  /**
   * demanda: o que conta para o erro. "erros" (padrão): só as falhas do sistema; um 422 da conferência ou um pedido
   * duplicado não pesam. "tentativas": toda tentativa sem sucesso, inclusive a neutra (a busca que não achou).
   */
  contar?: "erros" | "tentativas";
  /** demanda: quantas, na última hora e sem nenhum sucesso desde a primeira, viram erro (padrão 3). */
  limite?: number;
  /** demanda: como a frase do erro chama o que contou (padrão "falhas"). */
  nomeDoLimite?: string;
  /** dependência: resposta acima destes ms vira alerta. Sem o campo, o tempo não conta. */
  lentaMs?: number;
}

/**
 * Os componentes da resposta, na ordem dela. O `id` é estável: o monitor guarda o histórico por ele. Lista fechada
 * com o usuário em 17/11/2026.
 */
export const CATALOGO: RegraComponente[] = [
  { id: "app", nome: "Worker e banco do CX Hub", tipo: "app", critico: true },
  // O cron chama a rodada a cada 10 min: erro em 3 rodadas perdidas, alerta em 1,5.
  { id: "fila_rodada", nome: "Rodada do lote da fila (cron a cada 10 min)", tipo: "cron", critico: true, erroMin: 30, alertaMin: 15 },
  // Avaliada pelo que está na fila (ver avaliarEntrega): um caso leva até ~20 min para chegar à raw (medido nos logs
  // de 17/11/2026: cada lote termina antes da rodada seguinte).
  { id: "fila_entrega", nome: "Entrega dos casos ao Airflow (raw)", tipo: "demanda", critico: true },
  { id: "reenvio", nome: "Registro de reenvio (POST /api/sheets/append)", tipo: "demanda", critico: true },
  { id: "reembolso", nome: "Registro de reembolso (POST /api/refund/submit)", tipo: "demanda", critico: true },
  { id: "cancelamento", nome: "Registro de cancelamento (POST /api/cancellation/submit)", tipo: "demanda", critico: true },
  { id: "bot_reenvio", nome: "Reenvio pelo bot do Typebot (POST /api/reenvio/bot)", tipo: "demanda", critico: true },
  // Busca que não acha é normal (número digitado errado); cinco na hora, nenhuma achando, é a busca quebrada.
  {
    id: "consulta_pedido", nome: "Busca de pedido (Cosmos, Shopify e Data Mart)", tipo: "demanda", critico: true,
    contar: "tentativas", limite: 5, nomeDoLimite: "buscas sem achar pedido",
  },
  // Com a rota dados fora, quem lê usa a última resposta boa por até 24 h: a cache parada não para o app.
  { id: "cache_rota_dados", nome: "Cache da rota dados (cron a cada 5 min)", tipo: "cron", critico: false, erroMin: 30, alertaMin: 15 },
  { id: "backoffice", nome: "Edições do backoffice (salvar e desfazer)", tipo: "demanda", critico: false },
  { id: "dep_airflow", nome: "Airflow", tipo: "dependencia", critico: false, lentaMs: 5000 },
  { id: "dep_cosmos", nome: "Cosmos", tipo: "dependencia", critico: false, lentaMs: 3000 },
  { id: "dep_sheets", nome: "Google Planilhas", tipo: "dependencia", critico: false, lentaMs: 4000 },
  // O Metabase roda SQL: demora mais que uma API comum.
  { id: "dep_datamart", nome: "Data Mart (Metabase Gobeaute)", tipo: "dependencia", critico: false, lentaMs: 8000 },
  // O mesmo host atende a Shopify e, desde 19/11/2026, a Intelipost ao vivo (a NF fora do Data Mart).
  { id: "dep_gateway", nome: "integrations-gateway (Shopify e Intelipost)", tipo: "dependencia", critico: false, lentaMs: 3000 },
  { id: "dep_rota_dados", nome: "Rota dados (rota-dados-cxhub)", tipo: "dependencia", critico: false, lentaMs: 3000 },
];

export function regraDe(id: string): RegraComponente | null {
  return CATALOGO.find(r => r.id === id) ?? null;
}

// ─── Datas ───────────────────────────────────────────────────────────────────

const MINUTO_MS = 60_000;
const BRT_MS = 3 * 60 * MINUTO_MS;
const BLOCO_MS = 5 * MINUTO_MS;

/** Início do bloco de 5 min (UTC) que contém o instante: a chave da saude_janela. */
export function janelaDe(ms: number): string {
  return new Date(Math.floor(ms / BLOCO_MS) * BLOCO_MS).toISOString();
}

/** As 12 janelas da última hora começam aqui (o bloco atual e os 11 anteriores). */
export function inicioDaUltimaHora(agoraMs: number): string {
  return janelaDe(agoraMs - 11 * BLOCO_MS);
}

/** ISO 8601 UTC sem milissegundos, como o contrato pede ("2026-11-17T14:01:10Z"). */
export function isoSemMs(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** "14:03" no horário de Brasília (UTC-3; o Brasil não tem horário de verão desde 2019). */
function horaBrasilia(ms: number): string {
  return new Date(ms - BRT_MS).toISOString().slice(11, 16);
}

/** "às 14:03" se for hoje em Brasília; senão "em 16/11 às 14:03". */
export function quando(iso: string, agoraMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const dia = new Date(t - BRT_MS).toISOString().slice(0, 10);
  const hoje = new Date(agoraMs - BRT_MS).toISOString().slice(0, 10);
  if (dia === hoje) return `às ${horaBrasilia(t)}`;
  return `em ${dia.slice(8, 10)}/${dia.slice(5, 7)} às ${horaBrasilia(t)}`;
}

/** O `quando` sem o "às" do começo, para depois de "desde". */
const desde = (iso: string, agoraMs: number) => quando(iso, agoraMs).replace(/^às /, "");

// ─── Desfechos ───────────────────────────────────────────────────────────────

export type Desfecho = { resultado: Resultado; erro?: string; extra?: Record<string, string> };

/** As rotas de envio e o componente de cada uma. */
export const COMPONENTE_DO_ENVIO: Readonly<Record<string, string>> = {
  "sheets/append": "reenvio",
  "refund/submit": "reembolso",
  "cancellation/submit": "cancelamento",
  "reenvio/bot": "bot_reenvio",
};

// O bot registrou, mas sem a automação, porque um serviço não respondeu: o caso está salvo e o sistema degradou.
const DEGRADACAO_DO_BOT: Readonly<Record<string, string>> = {
  COSMOS_UNAVAILABLE: "Cosmos fora",
  SHOPIFY_UNAVAILABLE: "Shopify fora",
};

type Corpo = Record<string, unknown>;
const comoObjeto = (v: unknown): Corpo => (v && typeof v === "object" && !Array.isArray(v) ? (v as Corpo) : {});

/**
 * O desfecho de um envio (reenvio, reembolso, cancelamento e o bot) pelo corpo da resposta. O CX Hub devolve 200 para
 * desfechos diferentes, e o `code` é o que vale ("200 com code de erro quer dizer registrado, não repita"). A régua é a
 * do desfechoEnvioCxHub da Central de Tickets, para os dois lados contarem igual, com três diferenças deliberadas: o
 * que é dado de quem chama (400, 409, 422, DUPLICATE_*, OUT_OF_STOCK) é neutro aqui, e não erro, porque o CX Hub fez
 * a parte dele; e no bot, 401 e 503 são erro: o Typebot sem o segredo certo não registra nada.
 * null: não conta (o modo de teste não grava, e o ensaio não prova a gravação). `em`: a hora da degradação do bot.
 */
export function desfechoDoEnvio(rota: string, status: number, corpo: unknown, em = new Date().toISOString()): Desfecho | null {
  const bot = rota === "reenvio/bot";
  const b = comoObjeto(corpo);
  const code = typeof b.code === "string" ? b.code : "";
  if (code === "SUCCESS_TEST_MODE") return null;
  if (bot && status === 401) return { resultado: "erro", erro: "o bot chegou sem o x-bot-secret certo" };
  if (bot && status === 503) return { resultado: "erro", erro: "falta o secret BOT_RESEND_SECRET" };
  if (status >= 500) return { resultado: "erro", erro: `HTTP ${status}${code ? ` (${code.slice(0, 40)})` : ""}` };
  if (status < 200 || status >= 300) return { resultado: "neutro" };

  const comCaso = typeof b.idSolicitacao === "string" && b.idSolicitacao !== "";
  const doReenvio = rota === "sheets/append" || bot;
  let d: Desfecho;
  if (code === "SUCCESS" || code === "SUCCESS_SHEETS_ONLY") d = { resultado: "ok" };
  else if (code === "DUPLICATE_REFUND" || code === "DUPLICATE_RESEND" || code === "OUT_OF_STOCK" || code === "INVALID_ITEMS") {
    d = { resultado: "neutro" };
  } else if (code === "SHEETS_ERROR") {
    // SHEET_WRITE_FAILED: a fila guardou e só a planilha falhou; ROW_UNCERTAIN com o caso: a fila também guardou.
    if (b.reason === "SHEET_WRITE_FAILED" || (b.reason === "ROW_UNCERTAIN" && comCaso) || (doReenvio && b.sentToAPI === true)) d = { resultado: "ok" };
    else d = { resultado: "erro", erro: "não gravou na planilha nem na fila" };
  } else if (code === "API_TIMEOUT") {
    // A fila incerta com a linha já na planilha (ADR-012): registrado, não repita.
    d = comCaso && !doReenvio ? { resultado: "ok" } : { resultado: "erro", erro: "sem confirmação do registro (tempo esgotado)" };
  } else if (code === "API_ERROR") {
    d = { resultado: "erro", erro: "o Cosmos não executou o reenvio" };
  } else {
    d = { resultado: "erro", erro: code ? `respondeu ${code.slice(0, 40)}` : "respondeu sem desfecho" };
  }
  const reason = typeof b.reason === "string" ? b.reason : "";
  if (bot && d.resultado === "ok" && DEGRADACAO_DO_BOT[reason]) d.extra = { degradado_por: DEGRADACAO_DO_BOT[reason], degradado_em: em };
  return d;
}

/** As rotas de busca de pedido, com o método. */
export const ROTAS_DE_BUSCA: ReadonlyArray<RegExp> = [
  /^cosmos\/orders$/, /^cosmos\/orders\/[^/]+$/, /^shopify\/orders$/, /^datamart\/order-context$/,
];

/**
 * O desfecho de uma busca de pedido: achou (ok), não achou ou o pedido de quem chama estava errado (neutro), o sistema
 * não respondeu (erro). O 401/403 é o token de quem chama, não o sistema.
 */
export function desfechoDaBusca(rota: string, status: number, corpo: unknown): Desfecho {
  if (status >= 500) return { resultado: "erro", erro: `busca respondeu HTTP ${status}` };
  if (status < 200 || status >= 300) return { resultado: "neutro" };
  // cosmos/orders devolve a lista do Cosmos; shopify/orders, { orders: [...] }; os outros, o pedido.
  if (rota === "cosmos/orders") return { resultado: Array.isArray(corpo) && corpo.length > 0 ? "ok" : "neutro" };
  if (rota === "shopify/orders") {
    const pedidos = comoObjeto(corpo).orders;
    return { resultado: Array.isArray(pedidos) && pedidos.length > 0 ? "ok" : "neutro" };
  }
  return { resultado: "ok" };
}

/**
 * O desfecho da rodada do lote pelo resumo que ela devolve (servidor/lote.ts). null: a rodada não rodou (outra estava
 * em andamento, ou o cron foi recusado) e não diz nada da fila.
 */
export function desfechoDaRodada(status: number, corpo: unknown): Desfecho | null {
  const b = comoObjeto(corpo);
  if (b.code === "OK") return { resultado: "ok" };
  if (b.code === "INTERNAL_ERROR") {
    const falhas = Array.isArray(b.falhas) ? b.falhas.map(String).join(", ") : "";
    return { resultado: "erro", erro: falhas ? `a rodada falhou em: ${falhas}` : "a rodada falhou" };
  }
  if (status >= 500) return { resultado: "erro", erro: `a rodada respondeu HTTP ${status}` };
  return null;
}

/** O desfecho da rodada que renova a cache da rota dados (api/cacheDaRotaDados.ts). */
export function desfechoDaCache(status: number, corpo: unknown): Desfecho | null {
  const b = comoObjeto(corpo);
  if (b.code === "OK") return { resultado: "ok" };
  if (b.code === "FALHOU") return { resultado: "erro", erro: "a rota dados não respondeu para nenhuma lista" };
  if (status >= 500) return { resultado: "erro", erro: `a renovação respondeu HTTP ${status}` };
  return null;
}

/** Salvar ou desfazer uma edição no backoffice: o 4xx é a regra de edição (422 NOT_EDITABLE, 403), não o sistema. */
export function desfechoDoBackoffice(status: number): Desfecho {
  if (status >= 500) return { resultado: "erro", erro: `HTTP ${status}` };
  if (status >= 200 && status < 300) return { resultado: "ok" };
  return { resultado: "neutro" };
}

/** Resposta de serviço externo que conta como falha da dependência (o resto é o serviço de pé). */
export function falhaHttp(status: number): boolean {
  return status >= 500 || status === 401 || status === 403 || status === 407 || status === 429 || (status >= 300 && status < 400);
}

// ─── Estado ──────────────────────────────────────────────────────────────────

/** Uma execução, chamada ou tentativa observada. */
export interface Observacao {
  componente: string;
  resultado: Resultado;
  /** ISO UTC. */
  em: string;
  /** Frase curta, já sem dado de cliente. */
  erro?: string;
  duracaoMs?: number;
  /** Campos pequenos que a regra usa (ex.: a degradação do bot). */
  extra?: Record<string, string>;
}

/** O que a saude_estado guarda por componente. */
export interface EstadoGravado {
  ultimo_sucesso: string | null;
  ultima_tentativa: string | null;
  ultimo_erro: string | null;
  ultimo_erro_em: string | null;
  falhas_seguidas: number;
  ultima_duracao_ms: number | null;
  extra: Record<string, string> | null;
}

export function estadoVazio(): EstadoGravado {
  return { ultimo_sucesso: null, ultima_tentativa: null, ultimo_erro: null, ultimo_erro_em: null, falhas_seguidas: 0, ultima_duracao_ms: null, extra: null };
}

const maior = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a >= b ? a : b);

/**
 * As observações de UM componente num resumo, para gravar de uma vez: o mesmo que aplicá-las uma a uma, em ordem.
 * `zerarFalhas`: houve sucesso no meio (as falhas seguidas recomeçam de `falhas`); sem sucesso, `falhas` soma ao que
 * já estava gravado.
 */
export interface ResumoObservacoes {
  ultimo_sucesso: string | null;
  ultima_tentativa: string | null;
  ultimo_erro: string | null;
  ultimo_erro_em: string | null;
  zerarFalhas: boolean;
  falhas: number;
  ultima_duracao_ms: number | null;
  extra: Record<string, string> | null;
  /** Tentativas e erros por janela de 5 min. */
  janelas: Record<string, { tentativas: number; erros: number }>;
}

export function resumirObservacoes(obs: Observacao[]): ResumoObservacoes {
  const r: ResumoObservacoes = {
    ultimo_sucesso: null, ultima_tentativa: null, ultimo_erro: null, ultimo_erro_em: null,
    zerarFalhas: false, falhas: 0, ultima_duracao_ms: null, extra: null, janelas: {},
  };
  const ordenadas = [...obs].sort((a, b) => (a.em < b.em ? -1 : a.em > b.em ? 1 : 0));
  for (const o of ordenadas) {
    r.ultima_tentativa = maior(r.ultima_tentativa, o.em);
    const j = janelaDe(Date.parse(o.em));
    const jan = r.janelas[j] ?? (r.janelas[j] = { tentativas: 0, erros: 0 });
    jan.tentativas++;
    if (o.resultado === "ok") {
      r.ultimo_sucesso = maior(r.ultimo_sucesso, o.em);
      r.zerarFalhas = true;
      r.falhas = 0;
      if (typeof o.duracaoMs === "number") r.ultima_duracao_ms = o.duracaoMs;
    } else if (o.resultado === "erro") {
      jan.erros++;
      r.falhas++;
      r.ultimo_erro = o.erro || "falha sem detalhe";
      r.ultimo_erro_em = o.em;
    }
    if (o.extra) r.extra = { ...(r.extra ?? {}), ...o.extra };
  }
  return r;
}

/** Aplica o resumo sobre o estado gravado, como o UPSERT da saude_estado faz no banco. */
export function aplicarResumo(estado: EstadoGravado, r: ResumoObservacoes): EstadoGravado {
  const erroMaisNovo = Boolean(r.ultimo_erro_em) && (!estado.ultimo_erro_em || r.ultimo_erro_em! >= estado.ultimo_erro_em);
  return {
    ultimo_sucesso: maior(estado.ultimo_sucesso, r.ultimo_sucesso),
    ultima_tentativa: maior(estado.ultima_tentativa, r.ultima_tentativa),
    ultimo_erro: erroMaisNovo ? r.ultimo_erro : estado.ultimo_erro,
    ultimo_erro_em: erroMaisNovo ? r.ultimo_erro_em : estado.ultimo_erro_em,
    falhas_seguidas: r.zerarFalhas ? r.falhas : estado.falhas_seguidas + r.falhas,
    ultima_duracao_ms: r.ultima_duracao_ms ?? estado.ultima_duracao_ms,
    extra: r.extra ? { ...(estado.extra ?? {}), ...r.extra } : estado.extra,
  };
}

// ─── Avaliação ───────────────────────────────────────────────────────────────

/** A fila de agora, lida das tabelas dela (casos, atualizacoes, lotes): a fila_entrega não grava nada próprio. */
export interface LeituraDaFila {
  /** Casos e atualizações pendentes ou num lote em andamento. */
  pendentes: number;
  pendente_mais_antigo: string | null;
  /** O fim do último lote que gravou algo na raw. */
  ultimo_gravado: string | null;
  /** O início do último lote. */
  ultimo_lote: string | null;
  /** O último lote que terminou sem resultado ou com o disparo recusado, se terminou na última hora. */
  falha_recente: { desfecho: string; em: string } | null;
  /** Lotes que terminaram com falha na última hora. */
  falhas_hora: number;
  /** O que a última rodada fez no disparo (controle.ultima_rodada), para explicar a fila parada. */
  disparo: string | null;
}

export interface EntradaAvaliacao extends EstadoGravado {
  /** Soma das 12 janelas da última hora. */
  tentativas_hora: number;
  erros_hora: number;
  /** Início da janela mais antiga da última hora com tentativa, e com erro. */
  primeira_tentativa_hora: string | null;
  primeiro_erro_hora: string | null;
  /** Quando o app começou a medir: a referência de quem nunca rodou. */
  inicio_medicao: string | null;
  /** Só na fila_entrega. null = a leitura da fila falhou. */
  fila?: LeituraDaFila | null;
  /** Só no app. */
  app?: { bancoOk: boolean; erroBanco?: string };
}

export interface Avaliacao {
  nivel: Nivel;
  detalhe: string;
  pendentes?: number | null;
  /** Para a fila_entrega, que não usa a saude_estado. */
  ultimo_sucesso?: string | null;
  ultima_tentativa?: string | null;
  erros_ultima_hora?: number;
}

const limitar = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

function avaliarCron(e: EntradaAvaliacao, regra: RegraComponente, agoraMs: number): Avaliacao {
  const ref = e.ultimo_sucesso || e.inicio_medicao;
  if (!ref) return { nivel: "alerta", detalhe: "nenhuma execução registrada ainda" };
  const idadeMin = (agoraMs - Date.parse(ref)) / MINUTO_MS;
  const erroDepois = Boolean(e.ultimo_erro_em) && (!e.ultimo_sucesso || e.ultimo_erro_em! > e.ultimo_sucesso);
  if (regra.erroMin !== undefined && idadeMin > regra.erroMin) {
    const base = e.ultimo_sucesso ? `sem sucesso desde ${desde(e.ultimo_sucesso, agoraMs)}` : `nenhuma execução com sucesso desde ${desde(ref, agoraMs)}`;
    return { nivel: "erro", detalhe: limitar(erroDepois && e.ultimo_erro ? `${base}; último erro: ${e.ultimo_erro}` : base) };
  }
  let nivel: Nivel = "ok";
  const partes: string[] = [];
  if (erroDepois && e.ultimo_erro && e.ultimo_erro_em) {
    nivel = "alerta";
    partes.push(`${e.ultimo_erro} ${quando(e.ultimo_erro_em, agoraMs)}`);
  }
  if (regra.alertaMin !== undefined && idadeMin > regra.alertaMin) {
    nivel = "alerta";
    if (!erroDepois) {
      partes.push(e.ultimo_sucesso ? `última execução com sucesso ${quando(e.ultimo_sucesso, agoraMs)}` : `nenhuma execução desde ${desde(ref, agoraMs)}`);
    }
  } else if (!partes.length) {
    partes.push(e.ultimo_sucesso ? `última execução ${quando(e.ultimo_sucesso, agoraMs)}` : "aguardando a primeira execução");
  }
  return { nivel, detalhe: limitar(partes.join("; ")) };
}

function avaliarDemanda(e: EntradaAvaliacao, regra: RegraComponente, agoraMs: number): Avaliacao {
  const contarTentativas = regra.contar === "tentativas";
  const contadas = contarTentativas ? e.tentativas_hora : e.erros_hora;
  const primeira = contarTentativas ? e.primeira_tentativa_hora : e.primeiro_erro_hora;
  const semSucessoDesdeAPrimeira = !e.ultimo_sucesso || (Boolean(primeira) && e.ultimo_sucesso < primeira!);
  if (contadas >= (regra.limite ?? 3) && semSucessoDesdeAPrimeira) {
    const base = `${contadas} ${regra.nomeDoLimite || "falhas"} na última hora, sem nenhum sucesso`;
    const erroRecente = e.ultimo_erro && e.ultimo_erro_em && primeira && e.ultimo_erro_em >= primeira;
    return { nivel: "erro", detalhe: limitar(erroRecente ? `${base}; último erro: ${e.ultimo_erro}` : base) };
  }
  if (e.erros_hora > 0 && e.ultimo_erro && e.ultimo_erro_em) {
    const depois = e.ultimo_sucesso && e.ultimo_sucesso > e.ultimo_erro_em ? `; sucesso depois, ${quando(e.ultimo_sucesso, agoraMs)}` : "";
    return { nivel: "alerta", detalhe: limitar(`${e.erros_hora} erro(s) na última hora; último: ${e.ultimo_erro} ${quando(e.ultimo_erro_em, agoraMs)}${depois}`) };
  }
  // O bot que registrou sem a automação porque um serviço caiu (o caso está salvo; o sistema, degradado).
  const degradado = e.extra?.degradado_em;
  if (degradado && agoraMs - Date.parse(degradado) < 60 * MINUTO_MS) {
    return { nivel: "alerta", detalhe: limitar(`registrou sem a automação (${e.extra?.degradado_por || "serviço fora"}) ${quando(degradado, agoraMs)}`) };
  }
  if (e.tentativas_hora === 0) {
    const ref = e.ultima_tentativa || e.inicio_medicao;
    return { nivel: "ok", detalhe: ref ? `sem chamadas desde ${desde(ref, agoraMs)}` : "sem chamadas registradas" };
  }
  return { nivel: "ok", detalhe: e.ultimo_sucesso ? `último sucesso ${quando(e.ultimo_sucesso, agoraMs)}` : "sem sucesso na última hora, abaixo do limite de erro" };
}

function avaliarDependencia(e: EstadoGravado, regra: RegraComponente, agoraMs: number): Avaliacao {
  if (e.falhas_seguidas >= 2 && e.ultimo_erro && e.ultimo_erro_em) {
    return { nivel: "erro", detalhe: limitar(`${e.ultimo_erro} ${quando(e.ultimo_erro_em, agoraMs)} (${e.falhas_seguidas} falhas seguidas)`) };
  }
  if (e.falhas_seguidas === 1 && e.ultimo_erro && e.ultimo_erro_em) {
    return { nivel: "alerta", detalhe: limitar(`${e.ultimo_erro} ${quando(e.ultimo_erro_em, agoraMs)}`) };
  }
  if (regra.lentaMs !== undefined && e.ultima_duracao_ms !== null && e.ultima_duracao_ms > regra.lentaMs && e.ultimo_sucesso) {
    const s = String(Math.round(e.ultima_duracao_ms / 100) / 10).replace(".", ",");
    return { nivel: "alerta", detalhe: `respondeu em ${s} s ${quando(e.ultimo_sucesso, agoraMs)}` };
  }
  if (!e.ultima_tentativa) return { nivel: "ok", detalhe: "sem uso registrado ainda" };
  if (e.ultimo_sucesso) return { nivel: "ok", detalhe: `respondeu ${quando(e.ultimo_sucesso, agoraMs)}` };
  return { nivel: "ok", detalhe: `sem uso desde ${desde(e.ultima_tentativa, agoraMs)}` };
}

const ENTREGA_ERRO_MIN = 60;
const ENTREGA_ALERTA_MIN = 30;

// O disparo da última rodada que explica a fila parada (servidor/lote.ts, montar): o resto é o caminho normal.
const DISPARO_PARADO: Readonly<Record<string, string>> = {
  dag_pausada: "a DAG está pausada",
  sem_airflow: "o app está sem a configuração do Airflow",
  falha_no_disparo: "o Airflow não aceitou o disparo",
  disparo_recusado: "o Airflow recusou o disparo",
  erro: "a última rodada falhou",
};

const DESFECHO_DO_LOTE: Readonly<Record<string, string>> = {
  sem_resultado: "terminou sem resultado",
  concluido_sem_resultado: "terminou sem resultado",
  falha_no_disparo: "não foi disparado",
  disparo_recusado: "teve o disparo recusado",
};

/** Os desfechos de lote que contam como falha (servidor/lote.ts). */
export const DESFECHOS_DE_FALHA = Object.keys(DESFECHO_DO_LOTE);

/**
 * A fila_entrega pelo que está na fila agora: o item mais antigo esperando é o sinal que pega qualquer causa (o
 * Airflow fora, a DAG pausada, o run preso, o cron parado), inclusive a rodada que "dá certo" sem entregar nada.
 */
function avaliarEntrega(f: LeituraDaFila | null | undefined, agoraMs: number): Avaliacao {
  if (!f) return { nivel: "alerta", detalhe: "a fila não pôde ser lida agora", pendentes: null };
  const base = { pendentes: f.pendentes, ultimo_sucesso: f.ultimo_gravado, ultima_tentativa: f.ultimo_lote, erros_ultima_hora: f.falhas_hora };
  const motivo = f.disparo && DISPARO_PARADO[f.disparo] ? `; ${DISPARO_PARADO[f.disparo]}` : "";
  if (f.pendentes > 0 && f.pendente_mais_antigo) {
    const idadeMin = (agoraMs - Date.parse(f.pendente_mais_antigo)) / MINUTO_MS;
    const frase = `${f.pendentes} item(ns) na fila, o mais antigo desde ${desde(f.pendente_mais_antigo, agoraMs)}${motivo}`;
    if (idadeMin > ENTREGA_ERRO_MIN) return { ...base, nivel: "erro", detalhe: limitar(frase) };
    if (idadeMin > ENTREGA_ALERTA_MIN) return { ...base, nivel: "alerta", detalhe: limitar(frase) };
  }
  if (f.falha_recente) {
    const o = DESFECHO_DO_LOTE[f.falha_recente.desfecho] || "terminou com falha";
    return { ...base, nivel: "alerta", detalhe: limitar(`um lote ${o} ${quando(f.falha_recente.em, agoraMs)}`) };
  }
  const fila = f.pendentes > 0 ? `${f.pendentes} item(ns) na fila` : "fila vazia";
  return { ...base, nivel: "ok", detalhe: limitar(f.ultimo_gravado ? `${fila}; último lote gravado ${quando(f.ultimo_gravado, agoraMs)}` : fila) };
}

function avaliarApp(e: EntradaAvaliacao): Avaliacao {
  if (!e.app?.bancoOk) return { nivel: "erro", detalhe: limitar(e.app?.erroBanco || "o banco do app não respondeu") };
  return { nivel: "ok", detalhe: "Worker e banco respondendo" };
}

export function avaliarComponente(e: EntradaAvaliacao, regra: RegraComponente, agoraMs: number): Avaliacao {
  if (regra.id === "fila_entrega") return avaliarEntrega(e.fila, agoraMs);
  switch (regra.tipo) {
    case "cron": return avaliarCron(e, regra, agoraMs);
    case "demanda": return avaliarDemanda(e, regra, agoraMs);
    case "dependencia": return avaliarDependencia(e, regra, agoraMs);
    case "app": return avaliarApp(e);
  }
}

// ─── Resposta ────────────────────────────────────────────────────────────────

export interface ComponenteSaude {
  id: string;
  nome: string;
  nivel: Nivel;
  ultimo_sucesso: string | null;
  ultima_tentativa: string | null;
  erros_ultima_hora: number;
  pendentes: number | null;
  detalhe: string;
  critico: boolean;
  tipo: TipoComponente;
}

export interface RespostaSaude {
  ok: boolean;
  gerado_em: string;
  componentes: ComponenteSaude[];
}

export function componenteDaAvaliacao(regra: RegraComponente, e: EntradaAvaliacao, agoraMs: number): ComponenteSaude {
  const a = avaliarComponente(e, regra, agoraMs);
  return {
    id: regra.id,
    nome: regra.nome,
    nivel: a.nivel,
    ultimo_sucesso: isoSemMs(a.ultimo_sucesso !== undefined ? a.ultimo_sucesso : e.ultimo_sucesso),
    ultima_tentativa: isoSemMs(a.ultima_tentativa !== undefined ? a.ultima_tentativa : e.ultima_tentativa),
    erros_ultima_hora: a.erros_ultima_hora ?? e.erros_hora,
    pendentes: a.pendentes !== undefined ? a.pendentes : 0,
    detalhe: a.detalhe,
    critico: regra.critico,
    tipo: regra.tipo,
  };
}

/** 200 quando nenhum crítico está em erro; 503 quando algum está. Alerta nunca gera 503. */
export function montarResposta(componentes: ComponenteSaude[], agoraMs: number): { status: number; corpo: RespostaSaude } {
  const ok = !componentes.some(c => c.critico && c.nivel === "erro");
  return { status: ok ? 200 : 503, corpo: { ok, gerado_em: isoSemMs(new Date(agoraMs).toISOString())!, componentes } };
}
