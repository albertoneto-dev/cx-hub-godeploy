// O aviso da rodada vai ao Slack (docs/fila-cxhub.md, "O lote", passo 5): um POST JSON { text } por rodada no Incoming
// Webhook do segredo SLACK_ALERT_WEBHOOK_URL. O aviso nunca muda o desfecho da rodada.
import { afterEach, describe, expect, it, vi } from "vitest";
import { lerConfig } from "../servidor/config";
import { caso, criarAmbiente, HOST_SLACK, MINUTOS_20, resultadoDaDag, URL_SLACK, type Ambiente } from "./ambiente";

afterEach(() => {
  vi.restoreAllMocks();
});

// Uma rodada dispara um caso; a seguinte lê o resultado da DAG, com o caso recusado.
async function rodadaComRecusa(a: Ambiente, erro: string) {
  const c1 = caso();
  await a.fila("POST", "/api/v1/casos", { casos: [c1] });
  await a.lote();
  const [id, run] = a.airflow.ultimo();
  a.airflow.terminar(id, "success", resultadoDaDag(run.conf, { casosRecusados: { 0: erro } }));
  a.relogio.avancar(MINUTOS_20);
  return { id, c1, r: await a.lote() };
}

const escrito = (espiao: { mock: { calls: unknown[][] } }) => espiao.mock.calls.flat().map(String).join("\n");

describe("aviso no Slack", () => {
  it("a rodada com recusa posta um aviso: POST JSON { text } na URL do segredo", async () => {
    const a = await criarAmbiente();
    const { id, c1, r } = await rodadaComRecusa(a, "marca fora da lista");
    expect(r.json.code).toBe("OK");
    expect(await a.situacao("casos", c1.id_solicitacao)).toMatchObject({ situacao: "recusado" });

    const posts = a.rede.para(HOST_SLACK);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(URL_SLACK);
    expect(posts[0].metodo).toBe("POST");
    expect(posts[0].cabecalhos.get("content-type")).toContain("application/json");
    expect(JSON.parse(posts[0].corpo)).toEqual({
      text: `*Fila do CX Hub (app cx-hub)*\nLote ${id}: 1 item(ns) recusado(s):\n• caso ${c1.id_solicitacao}: marca fora da lista`,
    });

    const estado = (await a.fila("GET", "/api/v1/estado")).json;
    expect(estado.config.slack).toBe(true);
    expect(JSON.stringify(estado)).not.toContain("segredo-de-teste");
  });

  it("rodada sem nada a avisar não posta", async () => {
    const a = await criarAmbiente();
    await a.fila("POST", "/api/v1/casos", { casos: [caso()] });
    expect((await a.lote()).json.disparo.estado).toBe("disparado");
    expect(a.rede.para(HOST_SLACK)).toHaveLength(0);
  });

  it("o motivo vem da DAG: &, < e > vão escapados (nada vira link nem chama o canal)", async () => {
    const a = await criarAmbiente();
    await rodadaComRecusa(a, "<!channel> valor <0 & sem NF");
    const [texto] = a.avisos();
    expect(texto).toContain("&lt;!channel&gt; valor &lt;0 &amp; sem NF");
    expect(texto).not.toMatch(/[<>]/);
  });

  it("o log guarda o texto como veio, e nunca a URL do webhook", async () => {
    const espioes = (["log", "warn", "error"] as const).map(n => vi.spyOn(console, n).mockImplementation(() => {}));
    const a = await criarAmbiente();
    await rodadaComRecusa(a, "valor <0 & sem NF");
    const log = espioes.map(escrito).join("\n");
    expect(log).toContain("aviso: *Fila do CX Hub (app cx-hub)*");
    expect(log).toContain("valor <0 & sem NF");
    expect(log).not.toContain("segredo-de-teste");
  });

  const falhas: [string, () => Response, string][] = [
    ["404 no_service: webhook revogado", () => new Response("no_service", { status: 404 }), "o Slack respondeu HTTP 404 (no_service)"],
    ["410 channel_is_archived", () => new Response("channel_is_archived", { status: 410 }), "o Slack respondeu HTTP 410 (channel_is_archived)"],
    ["500 sem corpo", () => new Response(null, { status: 500 }), "o Slack respondeu HTTP 500"],
    ["fora do ar", () => { throw new TypeError("fetch failed"); }, "o Slack não respondeu (TypeError)"],
  ];

  it.each(falhas)("Slack com erro (%s): a rodada segue, e o motivo vai ao log", async (_nome, resposta, noLog) => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await criarAmbiente();
    a.rede.responder(HOST_SLACK, resposta);
    const { c1, r } = await rodadaComRecusa(a, "marca fora da lista");
    expect(r.status).toBe(200);
    expect(r.json.code).toBe("OK");
    expect(await a.situacao("casos", c1.id_solicitacao)).toMatchObject({ situacao: "recusado" });
    expect(escrito(erro)).toContain(noLog);
    expect(escrito(erro)).not.toContain("segredo-de-teste");
  });

  it("sem SLACK_ALERT_WEBHOOK_URL: o aviso só vai ao log, e /estado mostra o problema", async () => {
    const a = await criarAmbiente({ semSlack: true });
    const { r } = await rodadaComRecusa(a, "marca fora da lista");
    expect(r.json.code).toBe("OK");
    expect(a.rede.para(HOST_SLACK)).toHaveLength(0);
    const config = (await a.fila("GET", "/api/v1/estado")).json.config;
    expect(config.slack).toBe(false);
    expect(config.problemas).toContain("SLACK_ALERT_WEBHOOK_URL vazio: os avisos só vão para o log");
  });

  it.each(["http://hooks.slack.com/services/T000/B000/x", "nao-e-url"])("URL que não é https (%s): o aviso fica desligado", url => {
    const cfg = lerConfig({ SLACK_ALERT_WEBHOOK_URL: url });
    expect(cfg.slackUrl).toBeNull();
    expect(cfg.problemas).toContain("SLACK_ALERT_WEBHOOK_URL não é https: os avisos só vão para o log");
  });
});
