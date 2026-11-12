// As rotas do CX Hub (docs/fila-cxhub.md, "Rotas para o CX Hub"): acesso, idempotência, validação e leituras.
import { describe, expect, it } from "vitest";
import { atualizacao, caso, criarAmbiente, falharUmaVez, INICIO, TOKEN_NOVO } from "./ambiente";

describe("acesso", () => {
  it("sem token ou com token errado: 401 UNAUTHORIZED, antes de ler o corpo", async () => {
    const a = await criarAmbiente();
    const sem = await a.chamar("POST", "/api/v1/casos", { corpo: { casos: [caso()] } });
    expect(sem.status).toBe(401);
    expect(sem.json.code).toBe("UNAUTHORIZED");
    const errado = await a.chamar("GET", "/api/v1/estado", { cabecalhos: { "x-cxhub-fila-token": "outro" } });
    expect(errado.status).toBe(401);
    expect((await a.fila("GET", "/api/v1/estado")).json.casos.pendente).toBe(0);
  });

  it("aceita qualquer um dos tokens de CXHUB_FILA_TOKENS (troca sem parar)", async () => {
    const a = await criarAmbiente();
    const r = await a.chamar("GET", "/api/v1/estado", { cabecalhos: { "x-cxhub-fila-token": TOKEN_NOVO } });
    expect(r.status).toBe(200);
  });

  it("CXHUB_FILA_TOKENS vazio: tudo 401", async () => {
    const a = await criarAmbiente({ segredos: { CXHUB_FILA_TOKENS: "" } });
    expect((await a.fila("GET", "/api/v1/estado")).status).toBe(401);
    expect((await a.chamar("GET", "/api/v1/estado", { cabecalhos: { "x-cxhub-fila-token": "" } })).status).toBe(401);
  });

  it("rota desconhecida: 404; método errado: 405 com allow", async () => {
    const a = await criarAmbiente();
    expect((await a.fila("GET", "/api/v1/outra")).json.code).toBe("NOT_FOUND");
    const r = await a.fila("DELETE", "/api/v1/casos");
    expect(r.status).toBe(405);
    expect(r.cabecalhos.get("allow")).toBe("GET, POST");
  });
});

describe("POST /api/v1/casos", () => {
  it("enfileira e devolve os ids; o caso fica pendente", async () => {
    const a = await criarAmbiente();
    const c1 = caso();
    const c2 = caso({ tipo: "CANCELAMENTO", tratativa: "Reembolso" });
    const r = await a.fila("POST", "/api/v1/casos", { casos: [c1, c2] });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ code: "ENFILEIRADO", ids: [c1.id_solicitacao, c2.id_solicitacao] });
    expect((await a.fila("GET", `/api/v1/casos/${c1.id_solicitacao}`)).json.caso).toEqual({
      id_solicitacao: c1.id_solicitacao, tipo: "REEMBOLSO", marca: "lescent", numero_pedido: "SH1001",
      criado_em: "2026-11-04T10:00:00-03:00", responsavel: "Ana", situacao: "pendente",
    });
  });

  it("é idempotente por id_solicitacao: repetir não duplica nem sobrescreve", async () => {
    const a = await criarAmbiente();
    const c1 = caso();
    await a.fila("POST", "/api/v1/casos", { casos: [c1] });
    const r = await a.fila("POST", "/api/v1/casos", { casos: [{ ...c1, numero_pedido: "SH9999", responsavel: "Bia" }] });
    expect(r.json).toEqual({ code: "ENFILEIRADO", ids: [c1.id_solicitacao] });
    const lido = (await a.fila("GET", `/api/v1/casos/${c1.id_solicitacao}`)).json.caso;
    expect(lido).toMatchObject({ numero_pedido: "SH1001", responsavel: "Ana" });
    expect((await a.fila("GET", "/api/v1/estado")).json.casos.pendente).toBe(1);
  });

  it("um caso inválido recusa a chamada inteira: 400 INVALID_REQUEST e nada guardado", async () => {
    const a = await criarAmbiente();
    const bom = caso();
    const r = await a.fila("POST", "/api/v1/casos", { casos: [bom, caso({ numero_pedido: "sem-digito" })] });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("INVALID_REQUEST");
    expect(r.json.message).toContain("casos[1].numero_pedido");
    expect((await a.fila("GET", `/api/v1/casos/${bom.id_solicitacao}`)).json.caso).toBeNull();
  });

  it.each([
    ["id_solicitacao", { id_solicitacao: "tem espaço" }],
    ["id_solicitacao", { id_solicitacao: "x".repeat(65) }],
    ["tipo", { tipo: "TROCA" }],
    ["marca", { marca: "gocase" }],
    ["criado_em", { criado_em: "04/11/2026" }],
    ["numero_pedido", { numero_pedido: undefined }],
  ])("confere a identidade: %s", async (campo, sobre) => {
    const a = await criarAmbiente();
    const r = await a.fila("POST", "/api/v1/casos", { casos: [caso(sobre)] });
    expect(r.status).toBe(400);
    expect(r.json.message).toContain(`casos[0].${campo}`);
  });

  it("de 1 a 10 casos; corpo que não é JSON é 400", async () => {
    const a = await criarAmbiente();
    expect((await a.fila("POST", "/api/v1/casos", { casos: [] })).status).toBe(400);
    expect((await a.fila("POST", "/api/v1/casos", { casos: Array.from({ length: 11 }, () => caso()) })).status).toBe(400);
    expect((await a.fila("POST", "/api/v1/casos", { casos: Array.from({ length: 10 }, () => caso()) })).status).toBe(200);
    expect((await a.fila("POST", "/api/v1/casos", "{nao e json")).status).toBe(400);
  });

  it("o caso vai ao conf como o CX Hub mandou (o resto do contrato não é conferido aqui)", async () => {
    const a = await criarAmbiente();
    const c1 = caso({ tipo: "reembolso", marca: "Lescent", campo_novo: { x: 1 } });
    await a.fila("POST", "/api/v1/casos", { casos: [c1] });
    await a.lote();
    expect(a.airflow.ultimo()[1].conf.casos).toEqual([c1]);
    expect((await a.fila("GET", `/api/v1/casos?tipo=REEMBOLSO&marca=lescent&pedido=1001`)).json.casos).toHaveLength(1);
  });

  it("falha do banco: 503 UNAVAILABLE, e repetir grava", async () => {
    const a = await criarAmbiente();
    await a.fila("GET", "/api/v1/estado"); // cria o esquema
    falharUmaVez(a, "INSERT INTO casos");
    const c1 = caso();
    const r = await a.fila("POST", "/api/v1/casos", { casos: [c1] });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("UNAVAILABLE");
    expect((await a.fila("POST", "/api/v1/casos", { casos: [c1] })).status).toBe(200);
    expect((await a.fila("GET", `/api/v1/casos/${c1.id_solicitacao}`)).json.caso.situacao).toBe("pendente");
  });
});

describe("POST /api/v1/atualizacoes", () => {
  it("enfileira; idempotente por id_atualizacao; o caso não precisa estar na fila", async () => {
    const a = await criarAmbiente();
    const u = atualizacao("caso-antigo-na-raw");
    const r = await a.fila("POST", "/api/v1/atualizacoes", { atualizacoes: [u] });
    expect(r.json).toEqual({ code: "ENFILEIRADO", ids: [u.id_atualizacao] });
    await a.fila("POST", "/api/v1/atualizacoes", { atualizacoes: [{ ...u, campos: { status_execucao: "Realizado" } }] });
    const lidas = (await a.fila("GET", "/api/v1/atualizacoes?ids=caso-antigo-na-raw")).json.atualizacoes;
    expect(lidas).toEqual([{
      id_atualizacao: u.id_atualizacao, id_solicitacao: "caso-antigo-na-raw", atualizado_em: u.atualizado_em,
      campos: { status_execucao: "Cancelado", responsavel_execucao: "Ana" }, situacao: "pendente",
    }]);
  });

  it.each([
    ["id_atualizacao", { id_atualizacao: "nao-e-uuid" }],
    ["id_solicitacao", { id_solicitacao: "" }],
    ["atualizado_em", { atualizado_em: "2026-11-04T13:05:00" }],
    ["campos", { campos: ["status_execucao"] }],
  ])("confere %s; um item inválido recusa a chamada inteira", async (campo, sobre) => {
    const a = await criarAmbiente();
    const bom = atualizacao("caso-1");
    const r = await a.fila("POST", "/api/v1/atualizacoes", { atualizacoes: [bom, atualizacao("caso-1", sobre)] });
    expect(r.status).toBe(400);
    expect(r.json.message).toContain(`atualizacoes[1].${campo}`);
    expect((await a.fila("GET", "/api/v1/atualizacoes?ids=caso-1")).json.atualizacoes).toEqual([]);
  });
});

describe("leituras", () => {
  it("GET /casos: por tipo, marca e os dígitos do pedido, o mais novo primeiro, no máximo 20", async () => {
    const a = await criarAmbiente();
    const velho = caso({ numero_pedido: "#1001", criado_em: "2026-11-03T10:00:00-03:00" });
    const novo = caso({ numero_pedido: "SH-1001", criado_em: "2026-11-04T09:00:00-03:00" });
    const outraMarca = caso({ marca: "kokeshi" });
    const outroTipo = caso({ tipo: "REENVIO" });
    await a.fila("POST", "/api/v1/casos", { casos: [velho, novo, outraMarca, outroTipo] });
    const r = await a.fila("GET", "/api/v1/casos?tipo=REEMBOLSO&marca=lescent&pedido=1001");
    expect(r.json.casos.map((x: { id_solicitacao: string }) => x.id_solicitacao)).toEqual([novo.id_solicitacao, velho.id_solicitacao]);

    for (let i = 0; i < 3; i++) await a.fila("POST", "/api/v1/casos", { casos: Array.from({ length: 10 }, () => caso()) });
    expect((await a.fila("GET", "/api/v1/casos?tipo=REEMBOLSO&marca=lescent&pedido=1001")).json.casos).toHaveLength(20);
  });

  it("GET /casos: tipo, marca e pedido conferidos", async () => {
    const a = await criarAmbiente();
    expect((await a.fila("GET", "/api/v1/casos?tipo=TROCA&marca=lescent&pedido=1")).status).toBe(400);
    expect((await a.fila("GET", "/api/v1/casos?tipo=REENVIO&marca=x&pedido=1")).status).toBe(400);
    expect((await a.fila("GET", "/api/v1/casos?tipo=REENVIO&marca=aua&pedido=SH1")).status).toBe(400);
  });

  it("GET /casos/{id}: { caso: null } quando a fila não tem o id", async () => {
    const a = await criarAmbiente();
    const r = await a.fila("GET", "/api/v1/casos/nao-existe");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ caso: null });
  });

  it("GET /atualizacoes: as dos casos pedidos, em ordem de atualizado_em; até 20 ids", async () => {
    const a = await criarAmbiente();
    const depois = atualizacao("caso-a", { atualizado_em: "2026-11-04T10:10:00-03:00" });
    const antes = atualizacao("caso-b", { atualizado_em: "2026-11-04T13:01:00.000Z" });
    const outro = atualizacao("caso-c");
    await a.fila("POST", "/api/v1/atualizacoes", { atualizacoes: [depois, antes, outro] });
    const r = await a.fila("GET", "/api/v1/atualizacoes?ids=caso-a,caso-b");
    expect(r.json.atualizacoes.map((x: { id_atualizacao: string }) => x.id_atualizacao)).toEqual([antes.id_atualizacao, depois.id_atualizacao]);
    const ids = Array.from({ length: 21 }, (_, i) => `caso-${i}`).join(",");
    expect((await a.fila("GET", `/api/v1/atualizacoes?ids=${ids}`)).status).toBe(400);
    expect((await a.fila("GET", "/api/v1/atualizacoes")).status).toBe(400);
  });

  it("GET /casos/abertos: pendente, enviado, recusado e o gravado há menos de 1 h, com valor e motivo, o mais novo primeiro", async () => {
    const a = await criarAmbiente();
    const em = (h: number) => `2026-11-04T0${h}:00:00-03:00`;
    const pendente = caso({ criado_em: em(5), valor: 59.9, motivo: "Produto avariado" });
    const enviado = caso({ criado_em: em(4), valor: "R$ 1.234,56", motivo: "Atraso" });
    const recusado = caso({ criado_em: em(3), valor: undefined, motivo: undefined });
    const gravadoAgora = caso({ criado_em: em(2), valor: { x: 1 }, motivo: 7 });
    const gravadoAntes = caso({ criado_em: em(1) });
    const reenvio = caso({ tipo: "REENVIO", criado_em: em(6) });
    await a.fila("POST", "/api/v1/casos", { casos: [pendente, enviado, recusado, gravadoAgora, gravadoAntes, reenvio] });
    const marcar = (id: string, situacao: string, minutosAtras?: number) =>
      a.deps.db.exec("UPDATE casos SET situacao = ?, terminado_em = ? WHERE id_solicitacao = ?",
        [situacao, minutosAtras === undefined ? null : new Date(INICIO - minutosAtras * 60_000).toISOString(), id]);
    await marcar(enviado.id_solicitacao, "enviado");
    await marcar(recusado.id_solicitacao, "recusado", 120);
    await marcar(gravadoAgora.id_solicitacao, "gravado", 59);
    await marcar(gravadoAntes.id_solicitacao, "gravado", 61);

    const r = await a.fila("GET", "/api/v1/casos/abertos?tipo=REEMBOLSO");
    expect(r.status).toBe(200);
    expect(r.json.casos.map((x: { id_solicitacao: string }) => x.id_solicitacao)).toEqual([
      pendente.id_solicitacao, enviado.id_solicitacao, recusado.id_solicitacao, gravadoAgora.id_solicitacao,
    ]);
    expect(r.json.casos[0]).toEqual({
      id_solicitacao: pendente.id_solicitacao, tipo: "REEMBOLSO", marca: "lescent", numero_pedido: "SH1001",
      criado_em: em(5), responsavel: "Ana", situacao: "pendente", valor: 59.9, motivo: "Produto avariado",
    });
    expect(r.json.casos[1]).toMatchObject({ situacao: "enviado", valor: "R$ 1.234,56", motivo: "Atraso" });
    expect(r.json.casos[2]).toMatchObject({ situacao: "recusado", valor: null, motivo: null });
    // valor e motivo fora da forma (objeto, número no motivo) viram null.
    expect(r.json.casos[3]).toMatchObject({ situacao: "gravado", valor: null, motivo: null });

    // Uma hora depois, o gravado também sai.
    a.relogio.avancar(2 * 60_000);
    const depois = await a.fila("GET", "/api/v1/casos/abertos?tipo=REEMBOLSO");
    expect(depois.json.casos.map((x: { situacao: string }) => x.situacao)).toEqual(["pendente", "enviado", "recusado"]);
    expect((await a.fila("GET", "/api/v1/casos/abertos?tipo=reenvio")).json.casos.map((x: { id_solicitacao: string }) => x.id_solicitacao))
      .toEqual([reenvio.id_solicitacao]);
  });

  it("GET /casos/abertos: marca e pedido são opcionais e, quando vêm, filtram", async () => {
    const a = await criarAmbiente();
    const lescent = caso({ numero_pedido: "SH-2002" });
    const kokeshi = caso({ marca: "kokeshi", numero_pedido: "#2002" });
    const outroPedido = caso({ numero_pedido: "3003" });
    await a.fila("POST", "/api/v1/casos", { casos: [lescent, kokeshi, outroPedido] });
    const ids = async (q: string) =>
      (await a.fila("GET", `/api/v1/casos/abertos?tipo=REEMBOLSO${q}`)).json.casos.map((x: { id_solicitacao: string }) => x.id_solicitacao).sort();
    expect(await ids("")).toEqual([lescent, kokeshi, outroPedido].map(x => x.id_solicitacao).sort());
    expect(await ids("&marca=lescent")).toEqual([lescent, outroPedido].map(x => x.id_solicitacao).sort());
    expect(await ids("&pedido=2002")).toEqual([lescent, kokeshi].map(x => x.id_solicitacao).sort());
    expect(await ids("&marca=Kokeshi&pedido=2002")).toEqual([kokeshi.id_solicitacao]);
  });

  it("GET /casos/abertos: no máximo 50", async () => {
    const a = await criarAmbiente();
    for (let i = 0; i < 6; i++) await a.fila("POST", "/api/v1/casos", { casos: Array.from({ length: 10 }, () => caso()) });
    expect((await a.fila("GET", "/api/v1/casos/abertos?tipo=REEMBOLSO")).json.casos).toHaveLength(50);
  });

  it("GET /casos/abertos: tipo obrigatório (REENVIO ou REEMBOLSO), marca e pedido conferidos, token exigido", async () => {
    const a = await criarAmbiente();
    expect((await a.fila("GET", "/api/v1/casos/abertos")).status).toBe(400);
    expect((await a.fila("GET", "/api/v1/casos/abertos?tipo=CANCELAMENTO")).status).toBe(400);
    expect((await a.fila("GET", "/api/v1/casos/abertos?tipo=REENVIO&marca=gocase")).status).toBe(400);
    expect((await a.fila("GET", "/api/v1/casos/abertos?tipo=REENVIO&pedido=SH1")).status).toBe(400);
    expect((await a.chamar("GET", "/api/v1/casos/abertos?tipo=REENVIO")).status).toBe(401);
    expect((await a.fila("POST", "/api/v1/casos/abertos", {})).status).toBe(405);
  });

  it("GET /estado: contagem por situação e a configuração, sem valor de segredo", async () => {
    const a = await criarAmbiente();
    await a.fila("POST", "/api/v1/casos", { casos: [caso(), caso()] });
    await a.fila("POST", "/api/v1/atualizacoes", { atualizacoes: [atualizacao("caso-x")] });
    const r = await a.fila("GET", "/api/v1/estado");
    expect(r.json.casos).toEqual({ pendente: 2, enviado: 0, gravado: 0, recusado: 0 });
    expect(r.json.atualizacoes.pendente).toBe(1);
    expect(r.json.lote_em_andamento).toBeNull();
    expect(r.json.config).toMatchObject({ airflow: { dag_id: "gobeaute_reenvio_reembolso_etl", task: "gravar", key: "resultado" }, lote_max: 200, tokens: 2 });
    expect(JSON.stringify(r.json)).not.toContain("senha-de-teste");
  });
});

// Ápice, Yenzah e Denavita registram pelo CX Hub sem Cosmos (ADR-013 do CX Hub): o pedido é SH{n}{sufixo da loja}.
describe("marcas sem Cosmos: apice, yenzah e denavita", () => {
  const SUFIXO_DO_PEDIDO = { apice: "AP", yenzah: "YE", denavita: "DN" };
  const ids = (r: { json: { casos: { id_solicitacao: string }[] } }) => r.json.casos.map(x => x.id_solicitacao);

  it.each(Object.entries(SUFIXO_DO_PEDIDO))("%s: POST /casos aceita, e GET /casos e /casos/abertos leem pela marca", async (marca, sufixo) => {
    const a = await criarAmbiente();
    const c1 = caso({ tipo: "REENVIO", marca, numero_pedido: `SH123${sufixo}` });
    const r = await a.fila("POST", "/api/v1/casos", { casos: [c1] });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ code: "ENFILEIRADO", ids: [c1.id_solicitacao] });

    const lidos = await a.fila("GET", `/api/v1/casos?tipo=REENVIO&marca=${marca}&pedido=123`);
    expect(lidos.status).toBe(200);
    expect(lidos.json.casos).toEqual([{
      id_solicitacao: c1.id_solicitacao, tipo: "REENVIO", marca, numero_pedido: `SH123${sufixo}`,
      criado_em: "2026-11-04T10:00:00-03:00", responsavel: "Ana", situacao: "pendente",
    }]);

    const abertos = await a.fila("GET", `/api/v1/casos/abertos?tipo=REENVIO&marca=${marca}&pedido=123`);
    expect(abertos.status).toBe(200);
    expect(ids(abertos)).toEqual([c1.id_solicitacao]);
  });

  it("as 3 numa chamada: cada leitura traz só a sua marca, e as 3 vão ao conf como vieram", async () => {
    const a = await criarAmbiente();
    const casos = Object.entries(SUFIXO_DO_PEDIDO).map(([marca, sufixo]) => caso({ tipo: "REENVIO", marca, numero_pedido: `SH123${sufixo}` }));
    expect((await a.fila("POST", "/api/v1/casos", { casos })).json.ids).toEqual(casos.map(x => x.id_solicitacao));

    for (const c of casos) {
      expect(ids(await a.fila("GET", `/api/v1/casos?tipo=REENVIO&marca=${c.marca}&pedido=123`))).toEqual([c.id_solicitacao]);
      expect(ids(await a.fila("GET", `/api/v1/casos/abertos?tipo=REENVIO&marca=${c.marca}`))).toEqual([c.id_solicitacao]);
    }

    await a.lote();
    expect(a.airflow.ultimo()[1].conf.casos).toEqual(casos);
  });
});

// Gobeaute é o site multimarca www.gobeaute.com.br, registrado como marca própria (ADR-014 do CX Hub): pedido SH{n}GB,
// só REENVIO e REEMBOLSO.
describe("gobeaute, o site multimarca", () => {
  const ids = (r: { json: { casos: { id_solicitacao: string }[] } }) => r.json.casos.map(x => x.id_solicitacao);

  it.each(["REENVIO", "REEMBOLSO"])("%s: POST /casos aceita, e GET /casos e /casos/abertos leem pela marca", async tipo => {
    const a = await criarAmbiente();
    const c1 = caso({ tipo, marca: "gobeaute", numero_pedido: "SH1041GB" });
    const r = await a.fila("POST", "/api/v1/casos", { casos: [c1] });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ code: "ENFILEIRADO", ids: [c1.id_solicitacao] });

    const lidos = await a.fila("GET", `/api/v1/casos?tipo=${tipo}&marca=gobeaute&pedido=1041`);
    expect(lidos.status).toBe(200);
    expect(lidos.json.casos).toEqual([{
      id_solicitacao: c1.id_solicitacao, tipo, marca: "gobeaute", numero_pedido: "SH1041GB",
      criado_em: "2026-11-04T10:00:00-03:00", responsavel: "Ana", situacao: "pendente",
    }]);

    const abertos = await a.fila("GET", `/api/v1/casos/abertos?tipo=${tipo}&marca=gobeaute&pedido=1041`);
    expect(abertos.status).toBe(200);
    expect(ids(abertos)).toEqual([c1.id_solicitacao]);
  });

  it("o mesmo número na Gobeaute e na loja da Ápice não se misturam, e o caso vai ao conf como veio", async () => {
    const a = await criarAmbiente();
    const site = caso({ tipo: "REENVIO", marca: "gobeaute", numero_pedido: "SH1041GB" });
    const loja = caso({ tipo: "REENVIO", marca: "apice", numero_pedido: "SH1041AP" });
    expect((await a.fila("POST", "/api/v1/casos", { casos: [site, loja] })).json.ids).toEqual([site.id_solicitacao, loja.id_solicitacao]);

    expect(ids(await a.fila("GET", "/api/v1/casos?tipo=REENVIO&marca=gobeaute&pedido=1041"))).toEqual([site.id_solicitacao]);
    expect(ids(await a.fila("GET", "/api/v1/casos?tipo=REENVIO&marca=apice&pedido=1041"))).toEqual([loja.id_solicitacao]);
    expect(ids(await a.fila("GET", "/api/v1/casos/abertos?tipo=REENVIO&marca=gobeaute"))).toEqual([site.id_solicitacao]);

    await a.lote();
    expect(a.airflow.ultimo()[1].conf.casos).toEqual([site, loja]);
  });
});

// A etapa extra da rodada é a parte do backoffice (fila única: backoffice/ORIGEM.md). Aqui, um falso no lugar dela; o
// ciclo inteiro com a de verdade está em backoffice/testes/lote.test.ts.
describe("a etapa extra da rodada (posRodada: no app, a do backoffice)", () => {
  it("roda depois das da fila, com o prazo da rodada; o resumo entra com o nome dela, e os avisos vão no mesmo Slack", async () => {
    const a = await criarAmbiente();
    const prazos: number[] = [];
    a.deps.posRodada = async (_c, prazo) => {
      prazos.push(prazo);
      return { nome: "extra", resumo: { feito: true }, avisos: ["aviso da etapa extra"] };
    };
    const r = await a.lote();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ code: "OK", disparo: { estado: "vazio" }, extra: { feito: true }, avisos: 1 });
    expect(prazos).toEqual([INICIO + 25_000]);
    expect(a.avisos().join("\n")).toContain("aviso da etapa extra");
  });

  it("a falha dela não derruba as outras: 500 com pos_rodada em falhas, e a vez da rodada é devolvida", async () => {
    const a = await criarAmbiente();
    a.deps.posRodada = async () => {
      throw new Error("falha simulada");
    };
    const r = await a.lote();
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ code: "INTERNAL_ERROR", disparo: { estado: "vazio" }, falhas: ["pos_rodada"] });
    a.deps.posRodada = undefined;
    expect((await a.lote()).json.code).toBe("OK");
  });
});
