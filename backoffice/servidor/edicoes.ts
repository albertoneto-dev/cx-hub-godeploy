// As edições do drawer. Salvar NÃO escreve no Metabase: a edição entra na tabela `edicoes` do env.DB (pendente), e o
// cron a leva à DAG no próximo lote (servidor/lote.ts). Até a raw que o Metabase lê mostrá-la, a lista e o drawer
// aplicam a edição por cima da linha (gold + raw, servidor/gold.ts), com a tag "Aguardando Metabase". Os dados do
// cliente vão para a tabela `clientes` e ficam lá: o Metabase não guarda dado pessoal.
//
// Só se edita caso do CX Hub (chave cxhub|<id_solicitacao>) com a solicitação feita há até 30 dias. A linha do
// histórico (planilhas e Supabase) não tem evento de criação na raw, e a DAG recusaria a atualização ("caso
// inexistente").

import {
  CAMPOS_CLIENTE, CAMPO_POR_NOME, JANELA_EDICAO_DIAS, TIPOS, camposDoTipo, mesmoCliente, mesmoValor,
  normalizarCampo, normalizarCliente, type DadosCliente, type Tipo,
} from "../shared/campos";
import {
  calcularReembolso, chaveDaSelecao, selecaoDoTexto, temQuantidade, textoDaSelecao,
  type CampoDeItens, type Mimo, type ProdutoDoCatalogo, type SelecaoDeItens,
} from "../shared/itens";
import type { CasoGold, ClienteGuardado, DetalheDoCaso, EdicaoVisivel, SituacaoEdicao, Solicitacao } from "../shared/tipos";
import { problemaNaEscrita } from "./acesso";
import type { Banco, Linha } from "./banco";
import type { ConfigMetabase } from "./config";
import type { Contexto } from "./contexto";
import { catalogoDaMarca, CatalogoErro } from "./catalogo";
import { casoDaLinha, sqlDoCaso } from "./gold";
import { erro, json, lerObjeto } from "./http";
import { comoMetabaseErro, consultar } from "./metabase";
import { pedidoDoCaso, type PedidoNoDataMart } from "./pedido";
import { motivosDaOrigem, RotaDadosErro, type Origem } from "./rotaDados";
import { DIA, diaSP, horaSP, isoUtc } from "./tempo";

export const PREFIXO_CXHUB = "cxhub|";
const LIMITE_DO_CORPO = 16 * 1024;

export type EdicaoGuardada = {
  id: string;
  chave: string;
  campos: Record<string, string | number>;
  autor: string;
  atualizadoEm: string;
  situacao: SituacaoEdicao;
  erro: string | null;
};

function daLinha(l: Linha): EdicaoGuardada {
  let campos: Record<string, string | number> = {};
  try {
    campos = JSON.parse(String(l.campos)) as Record<string, string | number>;
  } catch {
    // campos ilegíveis não deveriam existir (o app grava JSON.stringify); a edição fica sem efeito na tela
  }
  return {
    id: String(l.id_atualizacao),
    chave: String(l.chave_unica),
    campos,
    autor: String(l.autor),
    atualizadoEm: String(l.atualizado_em),
    situacao: String(l.situacao) as SituacaoEdicao,
    erro: l.erro === null || l.erro === undefined ? null : String(l.erro),
  };
}

// As edições ainda guardadas para estas linhas, na ordem em que foram feitas.
export async function edicoesDasChaves(db: Banco, chaves: string[]): Promise<Map<string, EdicaoGuardada[]>> {
  const mapa = new Map<string, EdicaoGuardada[]>();
  if (!chaves.length) return mapa;
  const linhas = await db.query(
    `SELECT id_atualizacao, chave_unica, campos, autor, atualizado_em, situacao, erro FROM bo_edicoes
     WHERE chave_unica IN (SELECT value FROM json_each(?)) ORDER BY atualizado_em, criado_em, id_atualizacao`,
    [JSON.stringify(chaves)],
  );
  for (const l of linhas) {
    const e = daLinha(l);
    mapa.set(e.chave, [...(mapa.get(e.chave) ?? []), e]);
  }
  return mapa;
}

export function editabilidade(caso: CasoGold, agora: number): { editavel: boolean; bloqueio: string | null } {
  const chave = typeof caso.chave_unica === "string" ? caso.chave_unica : "";
  if (caso.sistema_origem !== "CX Hub" || !chave.startsWith(PREFIXO_CXHUB))
    return { editavel: false, bloqueio: "Linha do histórico (planilhas e Supabase, até 29/10/2026): a DAG só atualiza casos criados pelo CX Hub." };
  if (!TIPOS.includes(caso.tipo as Tipo)) return { editavel: false, bloqueio: "Só reenvio e reembolso se editam aqui." };
  // A data_solicitacao é hora de São Paulo sem fuso: compara como texto com o limite no mesmo formato.
  const limite = horaSP(agora - JANELA_EDICAO_DIAS * DIA);
  if (typeof caso.data_solicitacao !== "string" || caso.data_solicitacao < limite)
    return { editavel: false, bloqueio: `Solicitação com mais de ${JANELA_EDICAO_DIAS} dias: só leitura.` };
  // Decisões de 11/11/2026: o caso cancelado, o reembolso já efetuado e o reenvio que o Cosmos já registrou não se editam.
  const status = String(caso.status_execucao ?? "").trim().toLowerCase();
  if (status === "cancelado") return { editavel: false, bloqueio: "Solicitação cancelada (status Cancelado): não se edita mais." };
  if (caso.tipo === "REEMBOLSO" && status === "realizado")
    return { editavel: false, bloqueio: "Reembolso já efetuado (status Realizado): não se edita mais." };
  if (caso.tipo === "REENVIO" && caso.reenvio_no_cosmos === true)
    return { editavel: false, bloqueio: "O Cosmos já registrou este reenvio (o CX Hub o criou pela automação): não se edita mais." };
  return { editavel: true, bloqueio: null };
}

const ETAPA: Record<Exclude<SituacaoEdicao, "recusado">, number> = { pendente: 0, enviado: 1, gravado: 2 };

// A linha do Metabase com as edições que ele ainda não mostra aplicadas por cima, na ordem em que foram feitas (a mais
// nova vence, como na DAG). A recusada não se aplica: só aparece como aviso. Se a linha se edita é decidido sobre esse
// estado: o caso marcado aqui mesmo como Cancelado (ou, no reembolso, Realizado) já trava (a edição pendente ainda se
// desfaz).
export function comEdicoes(caso: CasoGold, edicoes: EdicaoGuardada[], agora: number): Solicitacao {
  const efetivo: CasoGold = { ...caso };
  const validas = edicoes.filter(e => e.situacao !== "recusado");
  for (const e of validas)
    for (const [campo, valor] of Object.entries(e.campos)) {
      const def = CAMPO_POR_NOME.get(campo);
      if (def) efetivo[def.coluna] = valor === "" ? null : valor;
    }
  // Cancelado não tem data de execução: a gold a deixa vazia.
  if (validas.some(e => "status_execucao" in e.campos) && efetivo.status_execucao === "Cancelado") efetivo.data_execucao = null;
  const ultima = validas[validas.length - 1];
  const recusada = edicoes.filter(e => e.situacao === "recusado").pop();
  let etapa: Exclude<SituacaoEdicao, "recusado"> = "gravado";
  for (const e of validas) if (e.situacao !== "recusado" && ETAPA[e.situacao] < ETAPA[etapa]) etapa = e.situacao;
  return {
    ...efetivo,
    ...editabilidade(efetivo, agora),
    aguardando: ultima
      ? { situacao: etapa, autor: ultima.autor, atualizadoEm: ultima.atualizadoEm, campos: [...new Set(validas.flatMap(e => Object.keys(e.campos)))] }
      : null,
    recusada: recusada && (!ultima || recusada.atualizadoEm >= ultima.atualizadoEm)
      ? { id: recusada.id, erro: recusada.erro || "recusada pela DAG, sem motivo", autor: recusada.autor, atualizadoEm: recusada.atualizadoEm }
      : null,
  };
}

const visivel = (e: EdicaoGuardada): EdicaoVisivel => ({
  id: e.id, campos: e.campos, autor: e.autor, atualizadoEm: e.atualizadoEm, situacao: e.situacao, erro: e.erro,
});

export async function lerCliente(db: Banco, chave: string): Promise<ClienteGuardado | null> {
  const l = await db.um(`SELECT ${CAMPOS_CLIENTE.map(c => c.campo).join(", ")}, atualizado_em, autor FROM bo_clientes WHERE chave_unica = ?`, [chave]);
  if (!l) return null;
  const dados = Object.fromEntries(CAMPOS_CLIENTE.map(c => [c.campo, String(l[c.campo] ?? "")])) as DadosCliente;
  return { ...dados, atualizadoEm: String(l.atualizado_em), autor: String(l.autor) };
}

async function salvarCliente(db: Banco, chave: string, dados: DadosCliente, agora: number, autor: string) {
  const nomes = CAMPOS_CLIENTE.map(c => c.campo);
  await db.exec(
    `INSERT INTO bo_clientes (chave_unica, ${nomes.join(", ")}, atualizado_em, autor) VALUES (?, ${nomes.map(() => "?").join(", ")}, ?, ?)
     ON CONFLICT(chave_unica) DO UPDATE SET ${nomes.map(n => `${n} = excluded.${n}`).join(", ")}, atualizado_em = excluded.atualizado_em, autor = excluded.autor`,
    [chave, ...nomes.map(n => dados[n]), isoUtc(agora), autor],
  );
}

// O caso como o Metabase o mostra agora: a gold, ou a raw quando ela já tem evento que a gold ainda não mostra.
export async function casoNoMetabase(c: Contexto, m: ConfigMetabase, chave: string): Promise<CasoGold | null> {
  const linhas = await consultar(m, c.fetch, sqlDoCaso(chave));
  return linhas.length ? casoDaLinha(linhas[0]) : null;
}

type MotivosLidos = { motivos: string[] | null; erro: string | null };

const ORIGEM: Record<Tipo, Origem> = { REENVIO: "reenvio", REEMBOLSO: "reembolso" };

// A lista de motivos do tipo, ou o porquê de não ter vindo (nunca lança: o drawer abre sem ela).
async function motivosDoTipo(c: Contexto, tipo: Tipo): Promise<MotivosLidos> {
  if (!c.cfg.rotaDados) return { motivos: null, erro: "O app está sem a configuração da rota de dados (FORM_DATA_API_URL e FORM_DATA_API_TOKEN)." };
  try {
    return { motivos: await motivosDaOrigem(c.cfg.rotaDados, c.fetch, ORIGEM[tipo], c.agora), erro: null };
  } catch (err) {
    const msg = err instanceof RotaDadosErro ? err.message : String((err as Error)?.message || err);
    console.error(`rota de dados: ${msg}`);
    return { motivos: null, erro: `Lista de motivos indisponível (${msg}).` };
  }
}

// O pedido no Data Mart, ou o porquê de não ter vindo (nunca lança: o drawer abre sem ele).
async function pedidoNoDataMart(c: Contexto, m: ConfigMetabase, caso: CasoGold): Promise<PedidoNoDataMart> {
  try {
    return await pedidoDoCaso(m, c.fetch, caso);
  } catch (err) {
    const e = comoMetabaseErro(err);
    console.error(`pedido no Data Mart: ${e.message}`);
    return { pedido: null, erro: `Não deu para ler o pedido no Data Mart agora (${e.message}): os itens do pedido não se marcam.` };
  }
}

type CatalogoLido = { catalogo: ProdutoDoCatalogo[] | null; erro: string | null };

// O catálogo da marca para o mimo, ou o porquê de não ter vindo (nunca lança: o drawer abre sem ele).
async function catalogoDoCaso(c: Contexto, m: ConfigMetabase, caso: CasoGold): Promise<CatalogoLido> {
  try {
    return { catalogo: await catalogoDaMarca(m, c.fetch, String(caso.sigla ?? ""), c.agora), erro: null };
  } catch (err) {
    const msg = err instanceof CatalogoErro ? err.message : comoMetabaseErro(err).message;
    console.error(`catálogo do mimo: ${msg}`);
    return { catalogo: null, erro: `Catálogo do mimo indisponível (${msg}).` };
  }
}

// O detalhe do drawer. A lista de motivos e o pedido (de onde saem os checkboxes) só vêm para o caso que se edita, e o
// catálogo do mimo, só para o reenvio que se edita; o que já foi lido no salvar é reaproveitado.
export async function detalheDoCaso(
  c: Contexto, m: ConfigMetabase, caso: CasoGold,
  lidos: { motivos?: MotivosLidos | null; pedido?: PedidoNoDataMart | null; catalogo?: CatalogoLido | null } = {},
): Promise<DetalheDoCaso> {
  const chave = String(caso.chave_unica);
  const tipo = caso.tipo as Tipo;
  const edicoes = (await edicoesDasChaves(c.db, [chave])).get(chave) ?? [];
  const atual = comEdicoes(caso, edicoes, c.agora);
  const editavel = atual.editavel;
  const [cliente, motivos, pedido, catalogo] = await Promise.all([
    tipo === "REENVIO" ? lerCliente(c.db, chave) : Promise.resolve(null),
    editavel ? (lidos.motivos ? Promise.resolve(lidos.motivos) : motivosDoTipo(c, tipo)) : Promise.resolve({ motivos: null, erro: null }),
    editavel ? (lidos.pedido ? Promise.resolve(lidos.pedido) : pedidoNoDataMart(c, m, caso)) : Promise.resolve({ pedido: null, erro: null }),
    editavel && tipo === "REENVIO"
      ? (lidos.catalogo ? Promise.resolve(lidos.catalogo) : catalogoDoCaso(c, m, caso))
      : Promise.resolve({ catalogo: null, erro: null }),
  ]);
  return {
    caso: atual, edicoes: edicoes.map(visivel), cliente,
    motivos: motivos.motivos, motivosErro: motivos.erro, pedido: pedido.pedido, pedidoErro: pedido.erro,
    catalogo: catalogo.catalogo, catalogoErro: catalogo.erro,
  };
}

const ehObjeto = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const CAMPOS_DE_ITENS: ReadonlySet<string> = new Set<CampoDeItens>(["escopo_reembolso", "produtos_reenvio", "skus"]);

// O corpo "itens": { <campo>: { itens: [{ id, quantidade }], frete, mimos: [{ sku, quantidade }] } } — os itens do
// pedido marcados no drawer, por campo. A quantidade só conta onde o campo a tem (no SKU com problema, não); o frete só
// vale no escopo do reembolso, e o mimo, no SKU do reenvio (quem confere é o textoDaSelecao).
function lerSelecoes(v: unknown): Map<CampoDeItens, SelecaoDeItens> | string {
  if (!ehObjeto(v)) return '"itens" precisa ser um objeto.';
  const selecoes = new Map<CampoDeItens, SelecaoDeItens>();
  for (const [nome, s] of Object.entries(v)) {
    if (!CAMPOS_DE_ITENS.has(nome)) return `Campo que não sai dos itens do pedido: ${nome}.`;
    const campo = nome as CampoDeItens;
    if (!ehObjeto(s) || !Array.isArray(s.itens) || s.itens.length > 200) return `"itens.${campo}" precisa de uma lista de itens.`;
    const itens: SelecaoDeItens["itens"] = [];
    for (const i of s.itens) {
      if (!ehObjeto(i) || typeof i.id !== "string" || (temQuantidade(campo) && typeof i.quantidade !== "number"))
        return `Cada item de "itens.${campo}" precisa de id${temQuantidade(campo) ? " e quantidade" : ""}.`;
      itens.push({ id: i.id, quantidade: temQuantidade(campo) ? Number(i.quantidade) : 1 });
    }
    if (s.frete !== undefined && typeof s.frete !== "boolean") return `"itens.${campo}.frete" precisa ser verdadeiro ou falso.`;
    const mimos: Mimo[] = [];
    if (s.mimos !== undefined) {
      if (!Array.isArray(s.mimos) || s.mimos.length > 50) return `"itens.${campo}.mimos" precisa ser uma lista.`;
      for (const x of s.mimos) {
        if (!ehObjeto(x) || typeof x.sku !== "string" || typeof x.quantidade !== "number") return `Cada mimo de "itens.${campo}" precisa de sku e quantidade.`;
        mimos.push({ sku: x.sku.trim(), quantidade: x.quantidade });
      }
    }
    selecoes.set(campo, { itens, frete: s.frete === true, mimos });
  }
  return selecoes;
}

const reais = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`;

// POST /api/solicitacoes/:chave/edicoes
//   { campos?: { <campo da DAG>: valor }, cliente?: { nome, telefone, ... }, itens?: { <campo>: { itens: [{ id, quantidade }], frete } } }
// Só o que mudou em relação ao que a linha mostra (Metabase + edições guardadas) vira edição. Regras que a tela também
// segue, mas que só valem conferidas aqui:
//   - motivo: um da lista da rota de dados para o tipo do caso;
//   - escopo do reembolso e os SKUs do reenvio: nunca digitados; saem dos itens do pedido marcados ("itens"), sempre
//     o item do kit, nunca o SKU do kit; o mimo do reenvio, do catálogo da marca (o que já estava registrado fica);
//   - valor do reembolso: sai dos mesmos itens marcados do escopo; só se digita com exceção à política (e aí os itens
//     mudam só o escopo), e nunca acima do total do pedido.
export async function registrarEdicao(c: Contexto, m: ConfigMetabase, chave: string): Promise<Response> {
  const problema = problemaNaEscrita(c);
  if (problema) return erro(403, "FORBIDDEN", problema);
  const corpo = await lerObjeto(c.req, LIMITE_DO_CORPO);
  if (corpo instanceof Response) return corpo;
  const brutos = corpo.campos ?? {};
  if (!ehObjeto(brutos)) return erro(400, "INVALID_REQUEST", '"campos" precisa ser um objeto.');
  const selecoes = corpo.itens !== undefined && corpo.itens !== null ? lerSelecoes(corpo.itens) : new Map<CampoDeItens, SelecaoDeItens>();
  if (typeof selecoes === "string") return erro(400, "INVALID_REQUEST", selecoes);

  const caso = await casoNoMetabase(c, m, chave);
  if (!caso) return erro(404, "NOT_FOUND", "Solicitação não encontrada no Metabase.");
  // Como a tela mostra: com as edições guardadas por cima (o caso marcado aqui como Cancelado ou Realizado já trava).
  const guardadas = (await edicoesDasChaves(c.db, [chave])).get(chave) ?? [];
  const atual = comEdicoes(caso, guardadas, c.agora);
  if (!atual.editavel) return erro(422, "NOT_EDITABLE", atual.bloqueio || "Esta solicitação não se edita.");
  const tipo = caso.tipo as Tipo;

  const defs = new Map(camposDoTipo(tipo).map(d => [d.campo, d]));
  const desconhecidos = Object.keys(brutos).filter(k => !defs.has(k));
  if (desconhecidos.length) return erro(400, "INVALID_REQUEST", `Campo que não se edita em ${tipo.toLowerCase()}: ${desconhecidos.join(", ")}.`);
  const foraDoTipo = [...selecoes.keys()].filter(k => !defs.has(k));
  if (foraDoTipo.length) return erro(400, "INVALID_REQUEST", `Campo que não se edita em ${tipo.toLowerCase()}: ${foraDoTipo.join(", ")}.`);
  const excecao = caso.excecao_politica === true;
  if ("valor" in brutos && !excecao)
    return erro(400, "INVALID_REQUEST", "O valor do reembolso sai dos itens marcados; só se digita com exceção à política.");

  // O que precisa de fora, lido uma vez e reaproveitado no detalhe da resposta.
  const [motivos, pedido] = await Promise.all([
    "motivo" in brutos ? motivosDoTipo(c, tipo) : Promise.resolve(null),
    selecoes.size || "valor" in brutos ? pedidoNoDataMart(c, m, caso) : Promise.resolve(null),
  ]);

  const hoje = diaSP(c.agora);
  const campos: Record<string, string | number> = {};
  for (const [nome, bruto] of Object.entries(brutos)) {
    const def = defs.get(nome)!;
    const n = normalizarCampo(def, bruto, hoje);
    if (!n.ok) return erro(400, "INVALID_REQUEST", n.erro);
    if (def.formato === "opcao") {
      if (!motivos?.motivos) return erro(503, "UNAVAILABLE", `Não deu para conferir o motivo. ${motivos?.erro ?? ""}`.trim());
      if (!motivos.motivos.includes(String(n.valor))) return erro(400, "INVALID_REQUEST", "Motivo fora da lista da rota de dados.");
    }
    if (def.formato === "valor") {
      if (!pedido?.pedido) return erro(422, "NOT_EDITABLE", pedido?.erro ?? "Sem o pedido no Data Mart, o valor não se edita.");
      if (Number(n.valor) > pedido.pedido.total)
        return erro(400, "INVALID_REQUEST", `O valor passa do total do pedido (${reais(pedido.pedido.total)}).`);
    }
    if (!mesmoValor(def, atual[def.coluna], n.valor)) campos[nome] = n.valor;
  }

  // Os itens marcados: o texto de cada campo e, no escopo do reembolso fora da exceção à política, o valor (o servidor
  // recalcula; a tela só mostra). A seleção que o texto registrado já representa não muda nada: o valor registrado fica
  // (o do CX Hub saiu dos preços do Cosmos), e o que não é item do pedido também. O mimo novo tem de estar no catálogo
  // da marca; o que já estava registrado (o item adicional que o CX Hub gravou) pode ficar.
  let catalogo: CatalogoLido | null = null;
  for (const [campo, selecao] of selecoes) {
    if (!pedido?.pedido) return erro(422, "NOT_EDITABLE", pedido?.erro ?? "Sem o pedido no Data Mart, os itens do pedido não se marcam.");
    const def = defs.get(campo)!;
    const r = campo === "escopo_reembolso" ? calcularReembolso(pedido.pedido, selecao) : textoDaSelecao(campo, pedido.pedido, selecao);
    if (!r.ok) return erro(400, "INVALID_REQUEST", `${def.rotulo}: ${r.erro}`);
    const registrada = selecaoDoTexto(campo, pedido.pedido, atual[def.coluna]).selecao;
    if (chaveDaSelecao(selecao) === chaveDaSelecao(registrada)) continue;
    const jaRegistrados = new Set((registrada.mimos ?? []).map(x => x.sku.toUpperCase()));
    const novos = (selecao.mimos ?? []).filter(x => !jaRegistrados.has(x.sku.toUpperCase()));
    if (novos.length) {
      catalogo ??= await catalogoDoCaso(c, m, caso);
      if (!catalogo.catalogo) return erro(503, "UNAVAILABLE", `Não deu para conferir o mimo. ${catalogo.erro ?? ""}`.trim());
      const doCatalogo = new Set(catalogo.catalogo.map(p => p.sku.toUpperCase()));
      const fora = novos.filter(x => !doCatalogo.has(x.sku.toUpperCase()));
      if (fora.length) return erro(400, "INVALID_REQUEST", `Mimo fora do catálogo da marca: ${fora.map(x => x.sku).join(", ")}.`);
    }
    const novo = "escopo" in r ? r.escopo : r.texto;
    if (!mesmoValor(def, atual[def.coluna], novo)) campos[campo] = novo;
    if ("valor" in r && !excecao && !mesmoValor(CAMPO_POR_NOME.get("valor")!, atual.valor_nf_tratado, r.valor)) campos.valor = r.valor;
  }

  let cliente: DadosCliente | null = null;
  if (corpo.cliente !== undefined && corpo.cliente !== null) {
    if (tipo !== "REENVIO") return erro(400, "INVALID_REQUEST", "Dados do cliente só se guardam no reenvio.");
    const nc = normalizarCliente(corpo.cliente);
    if (!nc.ok) return erro(400, "INVALID_REQUEST", nc.erro);
    if (!mesmoCliente(await lerCliente(c.db, chave), nc.dados)) cliente = nc.dados;
  }

  const autor = c.usuario!;
  const mudouCampos = Object.keys(campos).length > 0;
  const lidos = { motivos, pedido, catalogo };
  if (!mudouCampos && !cliente) return json({ code: "SEM_MUDANCA", message: "Nada mudou.", ...(await detalheDoCaso(c, m, caso, lidos)) });

  if (mudouCampos) {
    const agoraIso = isoUtc(c.agora);
    await c.db.exec(
      `INSERT INTO bo_edicoes (id_atualizacao, id_solicitacao, chave_unica, tipo, sigla, campos, atualizado_em, autor, situacao, criado_em, mudou_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`,
      [(c.novoId ?? (() => crypto.randomUUID()))(), chave.slice(PREFIXO_CXHUB.length), chave, tipo, caso.sigla, JSON.stringify(campos),
        agoraIso, autor, agoraIso, agoraIso],
    );
  }
  if (cliente) await salvarCliente(c.db, chave, cliente, c.agora, autor);

  const partes = [
    mudouCampos ? "a edição chega ao Metabase no próximo lote, em até 10 min" : "",
    cliente ? "os dados do cliente foram guardados no app" : "",
  ].filter(Boolean);
  return json({ code: "OK", message: `Salvo: ${partes.join("; ")}.`, ...(await detalheDoCaso(c, m, caso, lidos)) });
}

// DELETE /api/edicoes/:id — desfaz uma edição que ainda não foi ao lote (pendente) ou dispensa uma recusada. Enviada
// ou gravada não volta: já está a caminho do Metabase (para mudar, faça outra edição por cima).
export async function descartarEdicao(c: Contexto, id: string): Promise<Response> {
  const problema = problemaNaEscrita(c);
  if (problema) return erro(403, "FORBIDDEN", problema);
  const apagou = await c.db.exec("DELETE FROM bo_edicoes WHERE id_atualizacao = ? AND situacao IN ('pendente', 'recusado')", [id]);
  if (apagou > 0) return json({ code: "OK", message: "Edição descartada." });
  const existe = await c.db.um("SELECT situacao FROM bo_edicoes WHERE id_atualizacao = ?", [id]);
  if (!existe) return erro(404, "NOT_FOUND", "Edição não encontrada (talvez já tenha chegado ao Metabase).");
  return erro(409, "CONFLICT", "A edição já foi enviada ao Metabase e não pode ser desfeita. Faça outra edição por cima.");
}
