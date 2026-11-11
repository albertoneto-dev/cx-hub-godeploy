// O SQL de servidor/gold.ts rodando num Postgres de verdade (PGlite): a paginação por cursor, os filtros, a busca, a
// contagem e a conferência das edições na gold.

import { beforeEach, describe, expect, it } from "vitest";
import type { ConfigMetabase } from "../servidor/config";
import {
  casoDaLinha, codificarCursor, cursorDoCaso, lerCursor, sqlDaConferencia, sqlDaContagem, sqlDaPagina, type Cursor, type Filtro,
} from "../servidor/gold";
import { consultar } from "../servidor/metabase";
import { CHAVE_METABASE, DataMartFalso, HOST_METABASE, RedeFalsa, linhaGold, type LinhaGold } from "./ambiente";

const CFG: ConfigMetabase = { url: `https://${HOST_METABASE}`, chave: CHAVE_METABASE, banco: 43 };
let datamart: DataMartFalso;
let rede: RedeFalsa;
const sql = (texto: string) => consultar(CFG, rede.fetch, texto);

beforeEach(async () => {
  datamart = await DataMartFalso.criar();
  rede = new RedeFalsa();
  rede.responder(HOST_METABASE, datamart.manipular);
});

const filtro = (sobre: Partial<Filtro> = {}): Filtro => ({ tipo: "REEMBOLSO", sigla: null, status: null, busca: null, ...sobre });

// Percorre todas as páginas do filtro, como a tela faz, e devolve as chaves na ordem em que apareceram.
async function percorrer(f: Filtro, tamanho: number): Promise<string[]> {
  const vistas: string[] = [];
  let cursor: Cursor | null = null;
  for (let i = 0; i < 100; i++) {
    const casos = (await sql(sqlDaPagina(f, cursor, tamanho))).map(casoDaLinha);
    const pagina = casos.slice(0, tamanho);
    vistas.push(...pagina.map(c => String(c.chave_unica)));
    if (casos.length <= tamanho) return vistas;
    // Como a rota: o cursor passa pela tela codificado e volta.
    cursor = lerCursor(codificarCursor(cursorDoCaso(pagina[pagina.length - 1])!));
  }
  throw new Error("paginação não terminou");
}

describe("paginação por cursor", () => {
  it("percorre todas as linhas do filtro, na ordem (data desc, chave desc), sem pular nem repetir", async () => {
    const linhas: LinhaGold[] = [];
    for (let i = 0; i < 47; i++) {
      // Grupos de 3 linhas com a mesma data: o desempate é a chave.
      const grupo = Math.floor(i / 3);
      linhas.push(linhaGold({
        chave_unica: `cxhub|k${String(i).padStart(3, "0")}`,
        data_solicitacao: `2026-11-0${(grupo % 5) + 1} 10:${String(grupo).padStart(2, "0")}:00`,
      }));
    }
    linhas.push(linhaGold({ tipo: "REENVIO", chave_unica: "cxhub|reenvio-fora-do-filtro" }));
    await datamart.inserir(...linhas);

    const esperado = linhas
      .filter(l => l.tipo === "REEMBOLSO")
      .sort((a, b) => (a.data_solicitacao === b.data_solicitacao
        ? (String(a.chave_unica) < String(b.chave_unica) ? 1 : -1)
        : (String(a.data_solicitacao) < String(b.data_solicitacao) ? 1 : -1)))
      .map(l => String(l.chave_unica));

    for (const tamanho of [1, 3, 10, 46, 47, 50]) expect(await percorrer(filtro(), tamanho)).toEqual(esperado);
    expect((await sql(sqlDaContagem(filtro())))[0][0]).toBe(47);
  });

  it("guarda a data exata, com os microssegundos, no texto que vai para o cursor", async () => {
    await datamart.inserir(linhaGold({ chave_unica: "cxhub|a", data_solicitacao: "2026-11-10 10:00:00.123456" }));
    const [caso] = (await sql(sqlDaPagina(filtro(), null, 10))).map(casoDaLinha);
    expect(caso.data_solicitacao).toBe("2026-11-10T10:00:00.123456");
    expect(caso.carregado_em).toBe("2026-11-10T12:20:00Z");
  });

  it("uma linha nova no topo não muda as páginas seguintes", async () => {
    await datamart.inserir(...[1, 2, 3, 4].map(i => linhaGold({ chave_unica: `cxhub|${i}`, data_solicitacao: `2026-11-0${i} 10:00:00` })));
    const primeira = (await sql(sqlDaPagina(filtro(), null, 2))).map(casoDaLinha);
    await datamart.inserir(linhaGold({ chave_unica: "cxhub|9", data_solicitacao: "2026-11-09 10:00:00" }));
    const seguinte = (await sql(sqlDaPagina(filtro(), cursorDoCaso(primeira[1]), 2))).map(casoDaLinha);
    expect(seguinte.map(c => c.chave_unica)).toEqual(["cxhub|2", "cxhub|1"]);
  });
});

describe("filtros e busca", () => {
  beforeEach(async () => {
    await datamart.inserir(
      linhaGold({ chave_unica: "cxhub|le", sigla: "LE", status_execucao: null, numero_pedido: "SH5001LE" }),
      linhaGold({ chave_unica: "cxhub|bb", sigla: "BB", marca: "Barbour's", status_execucao: "Realizado", motivo: "Cliente pediu o 100% do valor" }),
      linhaGold({ chave_unica: "cxhub|ko", sigla: "KO", status_execucao: "", cod_nfd: "NFD-77" }),
      linhaGold({ chave_unica: "cxhub|rt", sigla: "RT", status_execucao: "Pendente", responsavel_execucao: "Joana D'Arc" }),
    );
  });

  const chaves = async (f: Filtro) => (await sql(sqlDaPagina(f, null, 50))).map(r => casoDaLinha(r).chave_unica).sort();

  it("por marca (sigla) e por status, com 'sem status' pegando nulo e vazio", async () => {
    expect(await chaves(filtro({ sigla: "BB" }))).toEqual(["cxhub|bb"]);
    expect(await chaves(filtro({ status: "sem_status" }))).toEqual(["cxhub|ko", "cxhub|le"]);
    expect(await chaves(filtro({ status: "Realizado" }))).toEqual(["cxhub|bb"]);
    expect((await sql(sqlDaContagem(filtro({ status: "sem_status" }))))[0][0]).toBe(2);
  });

  it("busca sem diferenciar maiúsculas, em várias colunas, com apóstrofo e % como texto", async () => {
    expect(await chaves(filtro({ busca: "sh5001" }))).toEqual(["cxhub|le"]);
    expect(await chaves(filtro({ busca: "nfd-77" }))).toEqual(["cxhub|ko"]);
    expect(await chaves(filtro({ busca: "D'Arc" }))).toEqual(["cxhub|rt"]);
    expect(await chaves(filtro({ busca: "100%" }))).toEqual(["cxhub|bb"]);
    expect(await chaves(filtro({ busca: "1_0" }))).toEqual([]);
  });
});

describe("cursor", () => {
  it("vai e volta, inclusive com acento na chave", () => {
    const c = { d: "2026-11-10T10:00:00.000000", c: "fonte_auá_reembolso|ção" };
    expect(lerCursor(codificarCursor(c))).toEqual(c);
  });

  it("recusa o que não é cursor", () => {
    expect(lerCursor("lixo")).toBeNull();
    expect(lerCursor(codificarCursor({ d: "10/11/2026", c: "x" }))).toBeNull();
    expect(lerCursor(codificarCursor({ d: "2026-11-10T10:00:00", c: "" }))).toBeNull();
  });
});

describe("conferência das edições", () => {
  it("acha na raw o evento de cada edição gravada, pelo id_atualizacao", async () => {
    await datamart.evento({ id: "caso-1", tipo: "atualizacao", payload: { id_atualizacao: "a1", status_execucao: "Realizado" }, carregadoEm: "2026-11-10T13:10:00Z" });
    await datamart.evento({ id: "caso-2", tipo: "atualizacao", payload: { id_atualizacao: "a2", cod_nfd: "1" }, carregadoEm: "2026-11-10T13:30:00Z" });
    const linhas = await sql(sqlDaConferencia([
      { idAtualizacao: "a1", idSolicitacao: "caso-1" },
      { idAtualizacao: "a2", idSolicitacao: "caso-2" },
      { idAtualizacao: "a3", idSolicitacao: "caso-2" }, // ainda não chegou à réplica
      { idAtualizacao: "a1", idSolicitacao: "outro-caso" }, // o id do caso também confere
    ]));
    expect(new Map(linhas.map(l => [l[0], l[1]]))).toEqual(new Map([["a1", "2026-11-10T13:10:00Z"], ["a2", "2026-11-10T13:30:00Z"]]));
  });
});
