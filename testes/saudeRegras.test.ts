// As regras puras da saúde (api/saude/regras.ts) e o medidor do fetch (api/saude/medidor.ts): o desfecho de cada
// função, as fronteiras de cada tipo de componente e o envoltório que mede as dependências sem mudar a chamada.

import { beforeEach, describe, expect, it } from "vitest";
import { dependenciaDaUrl, fetchSemMedidor, instalarMedidorDoFetch, medirFetch } from "../api/saude/medidor";
import {
  aplicarResumo, avaliarComponente, CATALOGO, componenteDaAvaliacao, desfechoDaBusca, desfechoDaCache, desfechoDaRodada,
  desfechoDoBackoffice, desfechoDoEnvio, type EntradaAvaliacao, estadoVazio, isoSemMs, janelaDe, type LeituraDaFila,
  montarResposta, quando, regraDe, resumirObservacoes,
} from "../api/saude/regras";
import { retirarPendentes } from "../api/saude/registro";

// 17/11/2026, 14:40 em Brasília.
const AGORA = Date.parse("2026-11-17T17:40:00Z");
const ha = (min: number) => new Date(AGORA - min * 60_000).toISOString();
const regra = (id: string) => regraDe(id)!;

function entrada(sobre: Partial<EntradaAvaliacao> = {}): EntradaAvaliacao {
  return {
    ...estadoVazio(), tentativas_hora: 0, erros_hora: 0, primeira_tentativa_hora: null, primeiro_erro_hora: null,
    inicio_medicao: ha(24 * 60), ...sobre,
  };
}

const avaliar = (id: string, sobre: Partial<EntradaAvaliacao> = {}) => avaliarComponente(entrada(sobre), regra(id), AGORA);

beforeEach(() => {
  retirarPendentes();
});

describe("catálogo", () => {
  it("16 componentes, ids únicos, e os críticos são as funções (as dependências só informam)", () => {
    expect(CATALOGO).toHaveLength(16);
    expect(new Set(CATALOGO.map(c => c.id)).size).toBe(16);
    expect(CATALOGO.filter(c => c.critico).map(c => c.id)).toEqual([
      "app", "fila_rodada", "fila_entrega", "reenvio", "reembolso", "cancelamento", "bot_reenvio", "consulta_pedido",
    ]);
    expect(CATALOGO.filter(c => c.tipo === "dependencia").every(c => !c.critico)).toBe(true);
  });
});

describe("desfecho dos envios (o code do corpo, como a tela e a Central leem)", () => {
  it("SUCCESS e SUCCESS_SHEETS_ONLY são registro", () => {
    expect(desfechoDoEnvio("refund/submit", 200, { code: "SUCCESS" })).toEqual({ resultado: "ok" });
    expect(desfechoDoEnvio("sheets/append", 200, { code: "SUCCESS_SHEETS_ONLY", sentToAPI: false })).toEqual({ resultado: "ok" });
  });

  it("o ensaio não conta", () => {
    expect(desfechoDoEnvio("sheets/append", 200, { code: "SUCCESS_TEST_MODE" })).toBeNull();
  });

  it("SHEETS_ERROR com a fila guardando é registro; sem nada guardado, é erro", () => {
    expect(desfechoDoEnvio("refund/submit", 200, { code: "SHEETS_ERROR", reason: "SHEET_WRITE_FAILED" })!.resultado).toBe("ok");
    expect(desfechoDoEnvio("cancellation/submit", 200, { code: "SHEETS_ERROR", reason: "ROW_UNCERTAIN", idSolicitacao: "c-1" })!.resultado).toBe("ok");
    expect(desfechoDoEnvio("sheets/append", 200, { code: "SHEETS_ERROR", sentToAPI: true })!.resultado).toBe("ok");
    expect(desfechoDoEnvio("refund/submit", 200, { code: "SHEETS_ERROR", reason: "ROW_UNCERTAIN" })).toEqual({
      resultado: "erro", erro: "não gravou na planilha nem na fila",
    });
  });

  it("API_TIMEOUT com o caso é registro fora do reenvio; no reenvio, é erro", () => {
    expect(desfechoDoEnvio("refund/submit", 200, { code: "API_TIMEOUT", idSolicitacao: "c-1" })!.resultado).toBe("ok");
    expect(desfechoDoEnvio("sheets/append", 200, { code: "API_TIMEOUT", idSolicitacao: "c-1" })!.resultado).toBe("erro");
    expect(desfechoDoEnvio("refund/submit", 200, { code: "API_TIMEOUT" })!.resultado).toBe("erro");
  });

  it("o que é dado de quem chama é neutro: duplicado, estoque, itens, 400, 409 e 422", () => {
    for (const code of ["DUPLICATE_REFUND", "DUPLICATE_RESEND", "OUT_OF_STOCK", "INVALID_ITEMS"]) {
      expect(desfechoDoEnvio("sheets/append", 200, { code }), code).toEqual({ resultado: "neutro" });
    }
    for (const status of [400, 401, 409, 422]) expect(desfechoDoEnvio("refund/submit", status, { code: "UNKNOWN_ERROR" }), String(status)).toEqual({ resultado: "neutro" });
  });

  it("5xx, API_ERROR, code desconhecido e corpo sem code são erro, com frase curta", () => {
    expect(desfechoDoEnvio("refund/submit", 500, { code: "UNKNOWN_ERROR" })).toEqual({ resultado: "erro", erro: "HTTP 500 (UNKNOWN_ERROR)" });
    expect(desfechoDoEnvio("sheets/append", 200, { code: "API_ERROR" })!.erro).toBe("o Cosmos não executou o reenvio");
    expect(desfechoDoEnvio("refund/submit", 200, { code: "UNKNOWN_ERROR" })!.erro).toBe("respondeu UNKNOWN_ERROR");
    expect(desfechoDoEnvio("refund/submit", 200, null)!.erro).toBe("respondeu sem desfecho");
  });

  it("no bot, o 401 e o 503 são erro: o Typebot sem o segredo certo não registra nada", () => {
    expect(desfechoDoEnvio("reenvio/bot", 401, { code: "UNKNOWN_ERROR" })!.erro).toBe("o bot chegou sem o x-bot-secret certo");
    expect(desfechoDoEnvio("reenvio/bot", 503, { code: "UNKNOWN_ERROR" })!.erro).toBe("falta o secret BOT_RESEND_SECRET");
    expect(desfechoDoEnvio("reenvio/bot", 400, { code: "UNKNOWN_ERROR", reason: "INVALID_PAYLOAD" })!.resultado).toBe("neutro");
  });

  it("o bot que registrou sem a automação porque o Cosmos ou a Shopify caiu leva a degradação, com a hora", () => {
    const em = ha(5);
    expect(desfechoDoEnvio("reenvio/bot", 200, { code: "SUCCESS_SHEETS_ONLY", reason: "COSMOS_UNAVAILABLE" }, em)).toEqual({
      resultado: "ok", extra: { degradado_por: "Cosmos fora", degradado_em: em },
    });
    // Desligado de propósito (BOT_RESEND_EXECUTE=off) não é degradação.
    expect(desfechoDoEnvio("reenvio/bot", 200, { code: "SUCCESS_SHEETS_ONLY", reason: "AUTOMATION_OFF" })).toEqual({ resultado: "ok" });
  });
});

describe("desfecho da busca, da rodada, da cache e do backoffice", () => {
  it("busca: achou é ok; lista vazia, 404 e 401 são neutros; 5xx é erro", () => {
    expect(desfechoDaBusca("cosmos/orders", 200, [{ id: 1 }]).resultado).toBe("ok");
    expect(desfechoDaBusca("cosmos/orders", 200, []).resultado).toBe("neutro");
    expect(desfechoDaBusca("shopify/orders", 200, { orders: [{ id: 1 }] }).resultado).toBe("ok");
    expect(desfechoDaBusca("shopify/orders", 200, { orders: [] }).resultado).toBe("neutro");
    expect(desfechoDaBusca("cosmos/orders/123", 200, { id: 123 }).resultado).toBe("ok");
    expect(desfechoDaBusca("datamart/order-context", 200, { nf: "1" }).resultado).toBe("ok");
    expect(desfechoDaBusca("cosmos/orders/123", 404, {}).resultado).toBe("neutro");
    expect(desfechoDaBusca("datamart/order-context", 401, {}).resultado).toBe("neutro");
    expect(desfechoDaBusca("datamart/order-context", 502, {})).toEqual({ resultado: "erro", erro: "busca respondeu HTTP 502" });
  });

  it("rodada: OK é sucesso; as etapas que falharam vão no erro; a que não rodou não conta", () => {
    expect(desfechoDaRodada(200, { code: "OK" })).toEqual({ resultado: "ok" });
    expect(desfechoDaRodada(500, { code: "INTERNAL_ERROR", falhas: ["disparo", "limpeza"] })).toEqual({
      resultado: "erro", erro: "a rodada falhou em: disparo, limpeza",
    });
    expect(desfechoDaRodada(200, { code: "OUTRA_RODADA" })).toBeNull();
    expect(desfechoDaRodada(401, { code: "UNAUTHORIZED" })).toBeNull();
    expect(desfechoDaRodada(429, { code: "TOO_MANY_REQUESTS" })).toBeNull();
    expect(desfechoDaRodada(503, {})!.resultado).toBe("erro");
  });

  it("cache: OK é sucesso; FALHOU e o banco fora são erro; o cron recusado não conta", () => {
    expect(desfechoDaCache(200, { code: "OK" })).toEqual({ resultado: "ok" });
    expect(desfechoDaCache(502, { code: "FALHOU" })!.resultado).toBe("erro");
    expect(desfechoDaCache(503, { code: "UNAVAILABLE" })!.resultado).toBe("erro");
    expect(desfechoDaCache(401, { code: "UNAUTHORIZED" })).toBeNull();
  });

  it("backoffice: a regra de edição (4xx) é neutra; 5xx é erro", () => {
    expect(desfechoDoBackoffice(200).resultado).toBe("ok");
    expect(desfechoDoBackoffice(422).resultado).toBe("neutro");
    expect(desfechoDoBackoffice(500)).toEqual({ resultado: "erro", erro: "HTTP 500" });
  });
});

describe("cron (fila_rodada: alerta em 15 min, erro em 30)", () => {
  it("nas fronteiras", () => {
    expect(avaliar("fila_rodada", { ultimo_sucesso: ha(14) })).toEqual({ nivel: "ok", detalhe: "última execução às 14:26" });
    expect(avaliar("fila_rodada", { ultimo_sucesso: ha(16) })).toEqual({ nivel: "alerta", detalhe: "última execução com sucesso às 14:24" });
    expect(avaliar("fila_rodada", { ultimo_sucesso: ha(31) })).toEqual({ nivel: "erro", detalhe: "sem sucesso desde 14:09" });
  });

  it("um erro depois do último sucesso é alerta; parado, o erro vai junto da frase", () => {
    expect(avaliar("fila_rodada", { ultimo_sucesso: ha(12), ultimo_erro: "a rodada falhou em: disparo", ultimo_erro_em: ha(2) })).toEqual({
      nivel: "alerta", detalhe: "a rodada falhou em: disparo às 14:38",
    });
    expect(avaliar("fila_rodada", { ultimo_sucesso: ha(40), ultimo_erro: "a rodada falhou em: disparo", ultimo_erro_em: ha(2) }).detalhe)
      .toBe("sem sucesso desde 14:00; último erro: a rodada falhou em: disparo");
  });

  it("nunca rodou: compara com o início da medição, em vez de ficar ok para sempre", () => {
    expect(avaliar("fila_rodada", { inicio_medicao: ha(5) })).toEqual({ nivel: "ok", detalhe: "aguardando a primeira execução" });
    expect(avaliar("fila_rodada", { inicio_medicao: ha(45) })).toEqual({ nivel: "erro", detalhe: "nenhuma execução com sucesso desde 13:55" });
    expect(avaliar("fila_rodada", { inicio_medicao: null })).toEqual({ nivel: "alerta", detalhe: "nenhuma execução registrada ainda" });
  });

  it("o sucesso de outro dia sai com a data", () => {
    expect(quando("2026-11-16T13:05:00Z", AGORA)).toBe("em 16/11 às 10:05");
  });
});

describe("demanda", () => {
  it("envio: 3 falhas na hora sem nenhum sucesso é erro; com sucesso depois da primeira, alerta", () => {
    const tres = { erros_hora: 3, tentativas_hora: 3, primeiro_erro_hora: janelaDe(AGORA - 40 * 60_000), ultimo_erro: "HTTP 500", ultimo_erro_em: ha(1) };
    expect(avaliar("reembolso", { ...tres, ultimo_sucesso: ha(120) })).toEqual({
      nivel: "erro", detalhe: "3 falhas na última hora, sem nenhum sucesso; último erro: HTTP 500",
    });
    expect(avaliar("reembolso", { ...tres, ultimo_sucesso: ha(10) }).nivel).toBe("alerta");
    expect(avaliar("reembolso", { ...tres, erros_hora: 2 }).nivel).toBe("alerta");
  });

  it("envio: neutros não pesam (5 recusas do 422 sem nenhum sucesso continuam ok)", () => {
    expect(avaliar("reenvio", { tentativas_hora: 5, primeira_tentativa_hora: janelaDe(AGORA - 30 * 60_000), ultima_tentativa: ha(1) })).toEqual({
      nivel: "ok", detalhe: "sem sucesso na última hora, abaixo do limite de erro",
    });
  });

  it("busca: 5 tentativas sem achar nenhum pedido é erro; 4, não", () => {
    const sem = { primeira_tentativa_hora: janelaDe(AGORA - 30 * 60_000), ultimo_sucesso: ha(90) };
    expect(avaliar("consulta_pedido", { ...sem, tentativas_hora: 5 })).toEqual({ nivel: "erro", detalhe: "5 buscas sem achar pedido na última hora, sem nenhum sucesso" });
    expect(avaliar("consulta_pedido", { ...sem, tentativas_hora: 4 }).nivel).toBe("ok");
  });

  it("sem chamadas na hora é ok, com a última chamada", () => {
    expect(avaliar("cancelamento", { ultima_tentativa: ha(150), ultimo_sucesso: ha(150) })).toEqual({ nivel: "ok", detalhe: "sem chamadas desde 12:10" });
  });

  it("o bot degradado na última hora é alerta; mais velho, volta a ok", () => {
    const extra = { degradado_por: "Cosmos fora", degradado_em: ha(20) };
    expect(avaliar("bot_reenvio", { extra, ultimo_sucesso: ha(20), tentativas_hora: 1, ultima_tentativa: ha(20) })).toEqual({
      nivel: "alerta", detalhe: "registrou sem a automação (Cosmos fora) às 14:20",
    });
    expect(avaliar("bot_reenvio", { extra: { ...extra, degradado_em: ha(61) }, ultimo_sucesso: ha(61), ultima_tentativa: ha(61) }).nivel).toBe("ok");
  });
});

describe("dependência", () => {
  it("2 falhas seguidas é erro; 1, alerta; lenta, alerta; sem uso, ok", () => {
    const falha = { ultimo_erro: "Cosmos respondeu HTTP 503", ultimo_erro_em: ha(1), ultima_tentativa: ha(1) };
    expect(avaliar("dep_cosmos", { ...falha, falhas_seguidas: 2 })).toEqual({ nivel: "erro", detalhe: "Cosmos respondeu HTTP 503 às 14:39 (2 falhas seguidas)" });
    expect(avaliar("dep_cosmos", { ...falha, falhas_seguidas: 1 })).toEqual({ nivel: "alerta", detalhe: "Cosmos respondeu HTTP 503 às 14:39" });
    expect(avaliar("dep_cosmos", { ultimo_sucesso: ha(2), ultima_tentativa: ha(2), ultima_duracao_ms: 5200 })).toEqual({ nivel: "alerta", detalhe: "respondeu em 5,2 s às 14:38" });
    expect(avaliar("dep_cosmos", { ultimo_sucesso: ha(2), ultima_tentativa: ha(2), ultima_duracao_ms: 900 })).toEqual({ nivel: "ok", detalhe: "respondeu às 14:38" });
    expect(avaliar("dep_cosmos", {})).toEqual({ nivel: "ok", detalhe: "sem uso registrado ainda" });
  });
});

describe("fila_entrega (o que está na fila agora)", () => {
  const fila = (sobre: Partial<LeituraDaFila> = {}): LeituraDaFila => ({
    pendentes: 0, pendente_mais_antigo: null, ultimo_gravado: ha(5), ultimo_lote: ha(5), falha_recente: null, falhas_hora: 0, disparo: "vazio", ...sobre,
  });

  it("item há mais de 60 min é erro (com o motivo da rodada); há mais de 30, alerta", () => {
    expect(avaliar("fila_entrega", { fila: fila({ pendentes: 12, pendente_mais_antigo: ha(61), disparo: "dag_pausada" }) })).toMatchObject({
      nivel: "erro", detalhe: "12 item(ns) na fila, o mais antigo desde 13:39; a DAG está pausada", pendentes: 12,
    });
    expect(avaliar("fila_entrega", { fila: fila({ pendentes: 2, pendente_mais_antigo: ha(31) }) }).nivel).toBe("alerta");
    expect(avaliar("fila_entrega", { fila: fila({ pendentes: 2, pendente_mais_antigo: ha(20) }) })).toMatchObject({
      nivel: "ok", detalhe: "2 item(ns) na fila; último lote gravado às 14:35",
    });
  });

  it("um lote sem resultado na última hora é alerta; a fila que não pôde ser lida, também", () => {
    expect(avaliar("fila_entrega", { fila: fila({ falha_recente: { desfecho: "sem_resultado", em: ha(12) }, falhas_hora: 1 }) })).toMatchObject({
      nivel: "alerta", detalhe: "um lote terminou sem resultado às 14:28", erros_ultima_hora: 1,
    });
    expect(avaliar("fila_entrega", { fila: null })).toEqual({ nivel: "alerta", detalhe: "a fila não pôde ser lida agora", pendentes: null });
  });

  it("os campos da resposta vêm da fila, e não da saude_estado", () => {
    const c = componenteDaAvaliacao(regra("fila_entrega"), entrada({ fila: fila({ pendentes: 3, ultimo_gravado: "2026-11-17T17:35:00.123Z" }) }), AGORA);
    expect(c).toMatchObject({ pendentes: 3, ultimo_sucesso: "2026-11-17T17:35:00Z", tipo: "demanda", critico: true });
  });
});

describe("resumo das observações e resposta", () => {
  it("resumir na ordem; sucesso zera as falhas; o estado só anda para a frente", () => {
    const r = resumirObservacoes([
      { componente: "dep_cosmos", resultado: "erro", em: ha(3), erro: "Cosmos respondeu HTTP 503" },
      { componente: "dep_cosmos", resultado: "ok", em: ha(2), duracaoMs: 300 },
      { componente: "dep_cosmos", resultado: "erro", em: ha(1), erro: "Cosmos: falha de rede" },
    ]);
    expect(r).toMatchObject({ zerarFalhas: true, falhas: 1, ultimo_sucesso: ha(2), ultima_tentativa: ha(1), ultimo_erro: "Cosmos: falha de rede", ultima_duracao_ms: 300 });
    expect(aplicarResumo({ ...estadoVazio(), falhas_seguidas: 4, ultimo_sucesso: ha(1) }, r)).toMatchObject({ falhas_seguidas: 1, ultimo_sucesso: ha(1) });
    const soFalha = resumirObservacoes([{ componente: "dep_cosmos", resultado: "erro", em: ha(0), erro: "x" }]);
    expect(aplicarResumo({ ...estadoVazio(), falhas_seguidas: 1 }, soFalha).falhas_seguidas).toBe(2);
  });

  it("503 só com crítico em erro; alerta crítico e erro não crítico ficam em 200", () => {
    const comp = (id: string, nivel: "ok" | "alerta" | "erro") => ({ ...componenteDaAvaliacao(regra(id), entrada(), AGORA), nivel });
    expect(montarResposta([comp("app", "ok"), comp("dep_cosmos", "erro"), comp("reenvio", "alerta")], AGORA).status).toBe(200);
    const r = montarResposta([comp("app", "ok"), comp("reenvio", "erro")], AGORA);
    expect(r).toMatchObject({ status: 503, corpo: { ok: false, gerado_em: "2026-11-17T17:40:00Z" } });
  });

  it("ISO sem milissegundos e janelas de 5 min", () => {
    expect(isoSemMs("2026-11-17T17:40:05.987Z")).toBe("2026-11-17T17:40:05Z");
    expect(isoSemMs("lixo")).toBeNull();
    expect(janelaDe(Date.parse("2026-11-17T17:44:59Z"))).toBe("2026-11-17T17:40:00.000Z");
  });
});

describe("medidor do fetch", () => {
  const env = {
    AIRFLOW_BASE_URL: "http://airflow.exemplo:8080/", COSMOS_API_URL: "https://api.cosmos.exemplo", METABASE_URL: "https://metabase.exemplo",
    FORM_DATA_API_URL: "https://rota-dados.exemplo",
  };

  it("cada host cadastrado vira a dependência dele; o gateway sem cadastro é o de produção; o resto não é medido", () => {
    expect(dependenciaDaUrl("http://airflow.exemplo:8080/api/v2/dags/x", env)?.componente).toBe("dep_airflow");
    expect(dependenciaDaUrl("https://api.cosmos.exemplo/organizations/1/orders", env)?.componente).toBe("dep_cosmos");
    expect(dependenciaDaUrl("https://sheets.googleapis.com/v4/spreadsheets/x", env)?.componente).toBe("dep_sheets");
    expect(dependenciaDaUrl("https://oauth2.googleapis.com/token", env)?.componente).toBe("dep_sheets");
    expect(dependenciaDaUrl("https://metabase.exemplo/api/dataset", env)?.componente).toBe("dep_datamart");
    expect(dependenciaDaUrl("https://integrations-gateway-prod.rpa-ia.workers.dev/shopify/apice/graphql", env)?.componente).toBe("dep_gateway");
    // A Intelipost ao vivo (a NF fora do Data Mart, 19/11/2026) passa pelo mesmo host.
    expect(dependenciaDaUrl("https://integrations-gateway-prod.rpa-ia.workers.dev/intelipost/apice/shipment_order/sales_order_number/SH1AP", env)?.componente).toBe("dep_gateway");
    expect(dependenciaDaUrl("https://rota-dados.exemplo/api/v1/form-data", env)?.componente).toBe("dep_rota_dados");
    expect(dependenciaDaUrl("https://hooks.slack.exemplo/services/x", env)).toBeNull();
    expect(dependenciaDaUrl("http://fila.cx-hub.interno/api/v1/casos", env)).toBeNull();
  });

  it("a chamada segue igual (a mesma resposta, a mesma exceção) e o desfecho é anotado", async () => {
    const resposta = new Response("{}", { status: 503 });
    const falha = new TypeError("fetch failed");
    const base = async (entrada: string | URL | Request) => {
      const url = String(entrada);
      if (url.includes("/rede")) throw falha;
      if (url.includes("/abort")) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (url.includes("/login")) return Object.defineProperties(new Response("<html>"), { redirected: { value: true }, url: { value: "https://cx-hub.devgogroup.com/login?x" } });
      if (url.includes("/401")) return new Response("{}", { status: 401 });
      if (url.startsWith("https://api.cosmos.exemplo/503")) return resposta;
      return new Response("{}", { status: 200 });
    };
    const f = medirFetch(base, () => env);

    expect(await f("https://api.cosmos.exemplo/503")).toBe(resposta);
    await expect(f("https://metabase.exemplo/rede")).rejects.toBe(falha);
    await expect(f("https://metabase.exemplo/abort")).rejects.toThrow("aborted");
    await f("https://rota-dados.exemplo/login");
    await f("https://api.cosmos.exemplo/401");
    await f("https://metabase.exemplo/401");
    await f("https://hooks.slack.exemplo/x");

    expect(retirarPendentes().map(o => [o.componente, o.resultado, o.erro])).toEqual([
      ["dep_cosmos", "erro", "Cosmos respondeu HTTP 503"],
      ["dep_datamart", "erro", "Data Mart: falha de rede"],
      ["dep_datamart", "erro", "Data Mart sem resposta (tempo esgotado)"],
      ["dep_rota_dados", "erro", "Rota dados: o gateway do GoDeploy pediu login (chave recusada)"],
      // O 401 do Cosmos é o token de quem chama: o serviço está de pé. O do Metabase é a chave do app.
      ["dep_cosmos", "ok", undefined],
      ["dep_datamart", "erro", "Data Mart respondeu HTTP 401"],
    ]);
  });

  it("instalado uma vez só: a segunda instalação não mede de novo, e o fetch sem medidor é o de baixo", async () => {
    const chamadas: string[] = [];
    const alvo = { fetch: (async (e: string | URL | Request) => { chamadas.push(String(e)); return new Response("{}"); }) as typeof fetch };
    const original = alvo.fetch;
    instalarMedidorDoFetch(alvo);
    const medido = alvo.fetch;
    instalarMedidorDoFetch(alvo);
    expect(alvo.fetch).toBe(medido);
    expect(medido).not.toBe(original);
    await fetchSemMedidor(alvo)("https://api.cosmos.exemplo/x");
    expect(chamadas).toEqual(["https://api.cosmos.exemplo/x"]);
    expect(retirarPendentes()).toEqual([]);
  });
});
