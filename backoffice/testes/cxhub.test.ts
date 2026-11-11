// As adaptações do backoffice ao app cx-hub (backoffice/ORIGEM.md), que os testes do app de origem não cobrem: as rotas
// em /api/backoffice, o autor pelo x-usuario-email de quem chama de servidor e os motivos por uma fonte de fora (a
// cache da rota dados do env.DB).

import { afterEach, describe, expect, it } from "vitest";
import { tratar } from "../servidor/app";
import { limparCacheDaRotaDados, motivosDaOrigem, RotaDadosErro, usarFonteDaRotaDados } from "../servidor/rotaDados";
import { EMAIL, URL_APP, criarAmbiente, linhaGold } from "./ambiente";

async function comUmReembolso() {
  const a = await criarAmbiente();
  const linha = linhaGold({ status_execucao: null, valor_nf_tratado: 59.9 });
  await a.datamart.inserir(linha);
  return { a, chave: String(linha.chave_unica) };
}

describe("rotas em /api/backoffice", () => {
  it("o caminho do app de origem, sem o prefixo, não é do backoffice: 404", async () => {
    const a = await criarAmbiente();
    const fora = await tratar(new Request(`${URL_APP}/api/eu`, { headers: { "x-godeploy-user-email": EMAIL } }), a.deps);
    expect(fora.status).toBe(404);
    const dentro = await tratar(new Request(`${URL_APP}/api/backoffice/eu`, { headers: { "x-godeploy-user-email": EMAIL } }), a.deps);
    expect(dentro.status).toBe(200);
    expect((await dentro.json()).email).toBe(EMAIL);
  });
});

describe("o autor pelo x-usuario-email", () => {
  it("de servidor, a pessoa que quem chama manda vale mais que o e-mail do gateway (o dono da chave), em minúsculas", async () => {
    const { a, chave } = await comUmReembolso();
    const r = await a.chamar("POST", `/api/solicitacoes/${encodeURIComponent(chave)}/edicoes`, {
      corpo: { campos: { cod_nfd: "NFD-9" } },
      semProtecao: true,
      cabecalhos: { "x-usuario-email": "Maria.Souza@gocase.com" },
    });
    expect(r.status).toBe(200);
    const [e] = await a.edicoes();
    expect(e.autor).toBe("maria.souza@gocase.com");
    const eu = await a.chamar("GET", "/api/eu", { cabecalhos: { "x-usuario-email": "maria.souza@gocase.com" } });
    expect(eu.json).toMatchObject({ email: "maria.souza@gocase.com", nome: "Maria Souza" });
  });

  it("sem o x-usuario-email, vale o e-mail do gateway; sem nenhum dos dois, 401", async () => {
    const a = await criarAmbiente();
    expect((await a.chamar("GET", "/api/eu")).json.email).toBe(EMAIL);
    expect((await a.chamar("GET", "/api/eu", { usuario: null })).status).toBe(401);
    expect((await a.chamar("GET", "/api/eu", { usuario: null, cabecalhos: { "x-usuario-email": "ana@gocase.com" } })).status).toBe(200);
  });

  it("x-usuario-email fora do formato de e-mail é recusado (400), em vez de cair no dono da chave", async () => {
    const a = await criarAmbiente();
    const r = await a.chamar("GET", "/api/eu", { cabecalhos: { "x-usuario-email": "maria" } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("INVALID_REQUEST");
  });
});

describe("os motivos por uma fonte de fora (a cache da rota dados)", () => {
  afterEach(() => {
    usarFonteDaRotaDados(null);
    limparCacheDaRotaDados();
  });
  const cfg = { url: "https://rota-dados.exemplo", token: "t", chave: null };
  const semRede = async () => {
    throw new Error("a fonte deveria ter sido usada");
  };

  it("com fonte, os motivos vêm dela, sem chamar a rota dados", async () => {
    usarFonteDaRotaDados(async origem => ({ status: 200, body: { marcas: ["lescent"], motivos: [` Extravio (${origem}) `] } }));
    expect(await motivosDaOrigem(cfg, semRede, "reenvio", 0)).toEqual(["Extravio (reenvio)"]);
  });

  it("a fonte com erro vira RotaDadosErro com o motivo dela; sem a lista de motivos, também", async () => {
    usarFonteDaRotaDados(async () => ({ status: 502, body: { error: "App de configuração do formulário inalcançável" } }));
    await expect(motivosDaOrigem(cfg, semRede, "reembolso", 0)).rejects.toThrow(new RotaDadosErro("App de configuração do formulário inalcançável (HTTP 502)"));
    usarFonteDaRotaDados(async () => ({ status: 200, body: { marcas: ["lescent"] } }));
    await expect(motivosDaOrigem(cfg, semRede, "reembolso", 0)).rejects.toThrow("sem a lista de motivos");
  });
});
