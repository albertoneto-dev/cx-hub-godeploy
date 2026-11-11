import { describe, expect, it } from "vitest";
import {
  CAMPO_POR_NOME, camposDoTipo, lerValor, mesmoCliente, mesmoValor, nomeDoEmail, normalizarCampo, normalizarCliente,
} from "../shared/campos";

const def = (campo: string) => CAMPO_POR_NOME.get(campo)!;
const HOJE = "2026-11-10";

describe("campos editáveis por tipo", () => {
  it("reenvio: execução, motivo, os SKUs e a UF; reembolso: execução, motivo, escopo e valor", () => {
    expect(camposDoTipo("REENVIO").map(c => c.campo).sort()).toEqual(
      ["cod_nfd", "data_execucao", "motivo", "produtos_reenvio", "responsavel_execucao", "skus", "status_execucao", "uf"].sort());
    expect(camposDoTipo("REEMBOLSO").map(c => c.campo).sort()).toEqual(
      ["cod_nfd", "data_execucao", "escopo_reembolso", "motivo", "responsavel_execucao", "status_execucao", "valor"].sort());
  });

  it("só usa campos do contrato da DAG (CAMPOS_CASO e CAMPOS_EXECUCAO)", () => {
    const contrato = new Set([
      "nf", "chave_nf", "valor", "skus", "cliente", "cidade", "uf", "cep", "cd_origem", "status_pedido", "transportadora",
      "lote", "erp", "pedido_completo", "devolucao", "responsavel", "origem", "id_atendimento", "data_pedido", "motivo",
      "produtos_reenvio", "transportadora_reenvio", "tipo_solicitacao", "escopo_reembolso", "excecao_politica",
      "ticket_transportadora", "tratativa", "status_execucao", "data_execucao", "responsavel_execucao", "cod_nfd",
    ]);
    for (const c of CAMPO_POR_NOME.keys()) expect(contrato.has(c)).toBe(true);
  });
});

describe("lerValor", () => {
  it("lê o formato brasileiro e número", () => {
    expect(lerValor("1.234,56")).toBe(1234.56);
    expect(lerValor("59,9")).toBe(59.9);
    expect(lerValor("R$ 10")).toBe(10);
    expect(lerValor(59.9)).toBe(59.9);
  });

  it("recusa o ponto como decimal e o que não é valor", () => {
    expect(lerValor("59.90")).toBeNull();
    expect(lerValor("12,345")).toBeNull();
    expect(lerValor("abc")).toBeNull();
    expect(lerValor(Number.NaN)).toBeNull();
    expect(lerValor(null)).toBeNull();
  });
});

describe("normalizarCampo", () => {
  it("status: só Pendente, Realizado ou Cancelado, na grafia da DAG", () => {
    expect(normalizarCampo(def("status_execucao"), "realizado", HOJE)).toEqual({ ok: true, valor: "Realizado" });
    expect(normalizarCampo(def("status_execucao"), "", HOJE).ok).toBe(false);
    expect(normalizarCampo(def("status_execucao"), "No Prazo", HOJE).ok).toBe(false);
  });

  it("data: aaaa-mm-dd que existe, até hoje; vazia limpa", () => {
    expect(normalizarCampo(def("data_execucao"), "2026-11-10", HOJE)).toEqual({ ok: true, valor: "2026-11-10" });
    expect(normalizarCampo(def("data_execucao"), "", HOJE)).toEqual({ ok: true, valor: "" });
    expect(normalizarCampo(def("data_execucao"), "2026-11-11", HOJE)).toMatchObject({ ok: false, erro: expect.stringContaining("depois de hoje") });
    expect(normalizarCampo(def("data_execucao"), "2026-02-30", HOJE).ok).toBe(false);
    expect(normalizarCampo(def("data_execucao"), "10/11/2026", HOJE).ok).toBe(false);
  });

  it("valor: maior que zero, em número", () => {
    expect(normalizarCampo(def("valor"), "1.234,56", HOJE)).toEqual({ ok: true, valor: 1234.56 });
    expect(normalizarCampo(def("valor"), "0,00", HOJE).ok).toBe(false);
    expect(normalizarCampo(def("valor"), "59.90", HOJE).ok).toBe(false);
  });

  it("UF: uma das 27, em maiúscula; vazia limpa", () => {
    expect(normalizarCampo(def("uf"), "sp", HOJE)).toEqual({ ok: true, valor: "SP" });
    expect(normalizarCampo(def("uf"), "XX", HOJE).ok).toBe(false);
    expect(normalizarCampo(def("uf"), "", HOJE)).toEqual({ ok: true, valor: "" });
  });

  it("texto: aparado e com teto de tamanho", () => {
    expect(normalizarCampo(def("cod_nfd"), "  123  ", HOJE)).toEqual({ ok: true, valor: "123" });
    expect(normalizarCampo(def("cod_nfd"), "x".repeat(61), HOJE).ok).toBe(false);
    expect(normalizarCampo(def("motivo"), { a: 1 }, HOJE).ok).toBe(false);
  });
});

describe("mesmoValor", () => {
  it("valor compara em centavos; status sem diferenciar maiúscula; texto exato", () => {
    expect(mesmoValor(def("valor"), 59.9, 59.9)).toBe(true);
    expect(mesmoValor(def("valor"), 59.9, 59.91)).toBe(false);
    expect(mesmoValor(def("valor"), null, 10)).toBe(false);
    expect(mesmoValor(def("status_execucao"), "realizado", "Realizado")).toBe(true);
    expect(mesmoValor(def("cod_nfd"), null, "")).toBe(true);
    expect(mesmoValor(def("cod_nfd"), "1", "2")).toBe(false);
  });
});

describe("dados do cliente", () => {
  it("guarda o CEP como 00000-000 e confere os campos", () => {
    const r = normalizarCliente({ nome: " Maria ", cep: "01310 100", cidade: "São Paulo" });
    expect(r).toMatchObject({ ok: true, dados: { nome: "Maria", cep: "01310-100", cidade: "São Paulo", logradouro: "" } });
    expect(normalizarCliente({ cep: "123" }).ok).toBe(false);
    expect(normalizarCliente({ cpf: "1" })).toMatchObject({ ok: false, erro: expect.stringContaining("cpf") });
    expect(normalizarCliente({ nome: 1 }).ok).toBe(false);
    expect(normalizarCliente([]).ok).toBe(false);
  });

  it("mesmoCliente compara campo a campo, com o vazio igual a nada guardado", () => {
    const r = normalizarCliente({});
    if (!r.ok) throw new Error(r.erro);
    expect(mesmoCliente(null, r.dados)).toBe(true);
    expect(mesmoCliente(null, { ...r.dados, nome: "Maria" })).toBe(false);
  });
});

it("nomeDoEmail sugere o responsável a partir do e-mail", () => {
  expect(nomeDoEmail("ana.paula-silva@gocase.com")).toBe("Ana Paula Silva");
  expect(nomeDoEmail("BRUNO@gocase.com")).toBe("Bruno");
});
