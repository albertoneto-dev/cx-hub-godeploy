// O que o app confere nos corpos do CX Hub (docs/fila-cxhub.md): só a identidade de cada item. O resto do contrato
// é o contrato.ts do CX Hub, conferido antes de enfileirar, e a DAG confere de novo no lote.

export const TIPOS = ["REENVIO", "REEMBOLSO", "CANCELAMENTO"];
export const MARCAS = ["lescent", "kokeshi", "bysamia", "aua", "barbours", "rituaria"];
export const MAX_POR_CHAMADA = 10;

export const ID_SOLICITACAO = /^[A-Za-z0-9-]{1,64}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const COM_FUSO = /(Z|[+-]\d{2}:?\d{2})$/i;

export type CasoNovo = {
  id: string;
  tipo: string;
  marca: string;
  numeroPedido: string;
  pedidoDigitos: string;
  criadoEm: string;
  criadoEmUtc: string;
  responsavel: string | null;
  dados: string; // o caso inteiro, como veio: é o que vai ao conf
};

export type AtualizacaoNova = {
  id: string;
  idSolicitacao: string;
  atualizadoEm: string;
  atualizadoEmUtc: string;
  campos: string;
};

type Validado<T> = { ok: true; itens: T[] } | { ok: false; message: string };

const texto = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const ehObjeto = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function dataIso(v: unknown, exigeFuso: boolean): string | null {
  const s = texto(v);
  if (!ISO.test(s) || (exigeFuso && !COM_FUSO.test(s))) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function lista(corpo: Record<string, unknown>, campo: string): unknown[] | string {
  const v = corpo[campo];
  if (!Array.isArray(v)) return `"${campo}" precisa ser uma lista.`;
  if (v.length < 1 || v.length > MAX_POR_CHAMADA) return `"${campo}" precisa ter de 1 a ${MAX_POR_CHAMADA} itens.`;
  return v;
}

// Um item inválido recusa a chamada inteira: nada é guardado.
export function validarCasos(corpo: Record<string, unknown>): Validado<CasoNovo> {
  const itens = lista(corpo, "casos");
  if (typeof itens === "string") return { ok: false, message: itens };
  const casos: CasoNovo[] = [];
  for (const [i, bruto] of itens.entries()) {
    const onde = `casos[${i}]`;
    if (!ehObjeto(bruto)) return { ok: false, message: `${onde} precisa ser um objeto.` };
    const id = texto(bruto.id_solicitacao);
    if (!ID_SOLICITACAO.test(id)) return { ok: false, message: `${onde}.id_solicitacao precisa casar com ^[A-Za-z0-9-]{1,64}$.` };
    const tipo = texto(bruto.tipo).toUpperCase();
    if (!TIPOS.includes(tipo)) return { ok: false, message: `${onde}.tipo precisa ser ${TIPOS.join(", ")}.` };
    const marca = texto(bruto.marca).toLowerCase();
    if (!MARCAS.includes(marca)) return { ok: false, message: `${onde}.marca precisa ser ${MARCAS.join(", ")}.` };
    const criadoEmUtc = dataIso(bruto.criado_em, false);
    if (!criadoEmUtc) return { ok: false, message: `${onde}.criado_em precisa ser data e hora ISO 8601.` };
    const numeroPedido = texto(bruto.numero_pedido);
    const pedidoDigitos = numeroPedido.replace(/\D/g, "");
    if (!pedidoDigitos) return { ok: false, message: `${onde}.numero_pedido precisa ter ao menos um dígito.` };
    casos.push({
      id, tipo, marca, numeroPedido, pedidoDigitos, criadoEm: texto(bruto.criado_em), criadoEmUtc,
      responsavel: texto(bruto.responsavel) || null,
      dados: JSON.stringify(bruto),
    });
  }
  return { ok: true, itens: casos };
}

export function validarAtualizacoes(corpo: Record<string, unknown>): Validado<AtualizacaoNova> {
  const itens = lista(corpo, "atualizacoes");
  if (typeof itens === "string") return { ok: false, message: itens };
  const atualizacoes: AtualizacaoNova[] = [];
  for (const [i, bruto] of itens.entries()) {
    const onde = `atualizacoes[${i}]`;
    if (!ehObjeto(bruto)) return { ok: false, message: `${onde} precisa ser um objeto.` };
    const id = texto(bruto.id_atualizacao);
    if (!UUID.test(id)) return { ok: false, message: `${onde}.id_atualizacao precisa ser um UUID.` };
    const idSolicitacao = texto(bruto.id_solicitacao);
    if (!ID_SOLICITACAO.test(idSolicitacao)) return { ok: false, message: `${onde}.id_solicitacao precisa casar com ^[A-Za-z0-9-]{1,64}$.` };
    const atualizadoEmUtc = dataIso(bruto.atualizado_em, true);
    if (!atualizadoEmUtc) return { ok: false, message: `${onde}.atualizado_em precisa ser data e hora ISO 8601 com fuso.` };
    if (!ehObjeto(bruto.campos)) return { ok: false, message: `${onde}.campos precisa ser um objeto.` };
    atualizacoes.push({ id, idSolicitacao, atualizadoEm: texto(bruto.atualizado_em), atualizadoEmUtc, campos: JSON.stringify(bruto.campos) });
  }
  return { ok: true, itens: atualizacoes };
}
