// O que o drawer edita e como cada valor é conferido. A tela confere para avisar na hora; o servidor confere de novo
// antes de guardar (a tela não é a guarda).
//
// Os campos editáveis são os que a DAG gobeaute_reenvio_reembolso_etl aceita numa atualização (CAMPOS_CASO e
// CAMPOS_EXECUCAO em config/constants.py do repo do Airflow): nome no contrato da DAG (`campo`) e a coluna da gold que
// ele muda (`coluna`). Campo fora do contrato faz a DAG recusar a atualização, então a lista é fechada.
//
// Os dados do cliente (nome, endereço, telefone) NÃO vão à DAG: a raw descarta cliente, cidade e CEP, e a gold não tem
// endereço. Ficam só no env.DB deste app (decisão de 10/11/2026). A UF de destino é a exceção: a gold a guarda.

import type { ColunaGold } from "./tipos";

export type Tipo = "REENVIO" | "REEMBOLSO";
export const TIPOS: readonly Tipo[] = ["REENVIO", "REEMBOLSO"];

export const STATUS_EXECUCAO = ["Pendente", "Realizado", "Cancelado"] as const;

export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

// Só se edita caso do CX Hub com a solicitação feita há até 30 dias (decisão de 10/11/2026).
export const JANELA_EDICAO_DIAS = 30;
export const TAMANHO_PAGINA = 50;

// opcao: um dos valores de uma lista que o servidor confere (o motivo, da rota de dados). itens: não se digita, sai dos
// itens do pedido marcados (shared/itens.ts): o escopo do reembolso e os dois SKUs do reenvio. valor: no reembolso, sai
// dos mesmos itens marcados do escopo; só se digita com exceção à política, e nunca acima do total do pedido.
export type Formato = "texto" | "status" | "data" | "valor" | "uf" | "opcao" | "itens";
export type Grupo = "execucao" | "solicitacao" | "cliente";

export interface CampoEditavel {
  campo: string;
  coluna: ColunaGold;
  rotulo: string;
  formato: Formato;
  max: number;
  tipos: readonly Tipo[];
  grupo: Grupo;
}

const OS_DOIS: readonly Tipo[] = ["REENVIO", "REEMBOLSO"];

export const CAMPOS_EDITAVEIS: readonly CampoEditavel[] = [
  { campo: "status_execucao", coluna: "status_execucao", rotulo: "Status da execução", formato: "status", max: 20, tipos: OS_DOIS, grupo: "execucao" },
  { campo: "data_execucao", coluna: "data_execucao", rotulo: "Data de execução", formato: "data", max: 10, tipos: OS_DOIS, grupo: "execucao" },
  { campo: "responsavel_execucao", coluna: "responsavel_execucao", rotulo: "Responsável pela execução", formato: "texto", max: 120, tipos: OS_DOIS, grupo: "execucao" },
  { campo: "cod_nfd", coluna: "cod_nfd", rotulo: "COD NFD", formato: "texto", max: 60, tipos: OS_DOIS, grupo: "execucao" },
  { campo: "motivo", coluna: "motivo", rotulo: "Motivo", formato: "opcao", max: 300, tipos: OS_DOIS, grupo: "solicitacao" },
  { campo: "skus", coluna: "sku_produto_problema", rotulo: "SKU com problema", formato: "itens", max: 500, tipos: ["REENVIO"], grupo: "solicitacao" },
  { campo: "produtos_reenvio", coluna: "produtos_reenvio", rotulo: "SKU do reenvio", formato: "itens", max: 500, tipos: ["REENVIO"], grupo: "solicitacao" },
  { campo: "escopo_reembolso", coluna: "escopo_reembolso", rotulo: "Escopo do reembolso", formato: "itens", max: 500, tipos: ["REEMBOLSO"], grupo: "solicitacao" },
  { campo: "valor", coluna: "valor_nf_tratado", rotulo: "Valor do reembolso", formato: "valor", max: 20, tipos: ["REEMBOLSO"], grupo: "solicitacao" },
  { campo: "uf", coluna: "uf_destino", rotulo: "UF de destino", formato: "uf", max: 2, tipos: ["REENVIO"], grupo: "cliente" },
];

export const CAMPO_POR_NOME: ReadonlyMap<string, CampoEditavel> = new Map(CAMPOS_EDITAVEIS.map(c => [c.campo, c]));

export const camposDoTipo = (tipo: Tipo) => CAMPOS_EDITAVEIS.filter(c => c.tipos.includes(tipo));

// Os campos do tipo que saem dos itens do pedido marcados (o escopo no reembolso; os dois SKUs no reenvio).
export const camposDeItens = (tipo: Tipo) => camposDoTipo(tipo).filter(c => c.formato === "itens");

export type Normalizado = { ok: true; valor: string | number } | { ok: false; erro: string };

// Data aaaa-mm-dd que existe no calendário.
export function dataValida(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// Valor em reais: número, ou texto em formato brasileiro ("1.234,56", "59,9", "R$ 10"). "59.90" é recusado: no
// formato brasileiro o ponto separa milhar, e adivinhar seria errar valor de reembolso.
export function lerValor(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/R\$/i, "").replace(/\s/g, "");
  if (!/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s) && !/^\d+(,\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s.replace(/\./g, "").replace(",", ".")) * 100) / 100;
}

const VALOR_MAXIMO = 1_000_000;

// O valor que vai à DAG, ou o erro para a pessoa. `hoje` é o dia em São Paulo (aaaa-mm-dd): data de execução não
// pode ser depois dele.
export function normalizarCampo(def: CampoEditavel, bruto: unknown, hoje: string): Normalizado {
  const v = bruto === null || bruto === undefined ? "" : bruto;
  if (typeof v !== "string" && typeof v !== "number") return { ok: false, erro: `${def.rotulo}: valor inválido.` };
  const texto = String(v).trim();
  switch (def.formato) {
    case "status": {
      const status = STATUS_EXECUCAO.find(s => s.toLowerCase() === texto.toLowerCase());
      return status ? { ok: true, valor: status } : { ok: false, erro: `${def.rotulo}: escolha Pendente, Realizado ou Cancelado.` };
    }
    case "data":
      if (!texto) return { ok: true, valor: "" };
      if (!dataValida(texto)) return { ok: false, erro: `${def.rotulo}: data inválida.` };
      if (texto > hoje) return { ok: false, erro: `${def.rotulo}: não pode ser depois de hoje.` };
      return { ok: true, valor: texto };
    case "valor": {
      const n = lerValor(v);
      if (n === null) return { ok: false, erro: `${def.rotulo}: use o formato 1.234,56.` };
      if (n <= 0) return { ok: false, erro: `${def.rotulo}: precisa ser maior que zero.` };
      if (n > VALOR_MAXIMO) return { ok: false, erro: `${def.rotulo}: acima de R$ 1.000.000,00.` };
      return { ok: true, valor: n };
    }
    case "uf": {
      if (!texto) return { ok: true, valor: "" };
      const uf = texto.toUpperCase();
      return (UFS as readonly string[]).includes(uf) ? { ok: true, valor: uf } : { ok: false, erro: `${def.rotulo}: UF inválida.` };
    }
    case "itens":
      return { ok: false, erro: `${def.rotulo}: não se digita, marque os itens do pedido.` };
    case "opcao":
      // Se está na lista, quem confere é o servidor (a lista vem da rota de dados).
      if (!texto) return { ok: false, erro: `${def.rotulo}: escolha um da lista.` };
      if (texto.length > def.max) return { ok: false, erro: `${def.rotulo}: até ${def.max} caracteres.` };
      return { ok: true, valor: texto };
    default:
      if (texto.length > def.max) return { ok: false, erro: `${def.rotulo}: até ${def.max} caracteres.` };
      return { ok: true, valor: texto };
  }
}

// O valor novo é o mesmo que a linha já mostra? (o que não mudou não vai à DAG)
export function mesmoValor(def: CampoEditavel, atual: unknown, novo: string | number): boolean {
  if (def.formato === "valor") {
    const a = lerValor(typeof atual === "string" ? atual.replace(".", ",") : atual);
    return a !== null && Math.abs(a - Number(novo)) < 0.005;
  }
  const a = atual === null || atual === undefined ? "" : String(atual).trim();
  return def.formato === "status" ? a.toLowerCase() === String(novo).toLowerCase() : a === String(novo);
}

// ─── Dados do cliente (só no env.DB) ─────────────────────────────────────────

export const CAMPOS_CLIENTE = [
  { campo: "nome", rotulo: "Nome", max: 150 },
  { campo: "telefone", rotulo: "Telefone", max: 30 },
  { campo: "cep", rotulo: "CEP", max: 9 },
  { campo: "logradouro", rotulo: "Logradouro", max: 200 },
  { campo: "numero", rotulo: "Número", max: 20 },
  { campo: "complemento", rotulo: "Complemento", max: 100 },
  { campo: "bairro", rotulo: "Bairro", max: 100 },
  { campo: "cidade", rotulo: "Cidade", max: 100 },
] as const;

export type CampoCliente = (typeof CAMPOS_CLIENTE)[number]["campo"];
export type DadosCliente = Record<CampoCliente, string>;

export const clienteVazio = (): DadosCliente =>
  Object.fromEntries(CAMPOS_CLIENTE.map(c => [c.campo, ""])) as DadosCliente;

// CEP com 8 dígitos, guardado como 00000-000 (hífen e espaço são irrelevantes, como na régua do CX Hub).
export function normalizarCliente(bruto: unknown): { ok: true; dados: DadosCliente } | { ok: false; erro: string } {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return { ok: false, erro: "Dados do cliente: precisa ser um objeto." };
  const entrada = bruto as Record<string, unknown>;
  const conhecidos = new Set<string>(CAMPOS_CLIENTE.map(c => c.campo));
  const desconhecidos = Object.keys(entrada).filter(k => !conhecidos.has(k));
  if (desconhecidos.length) return { ok: false, erro: `Dados do cliente: campo desconhecido (${desconhecidos.join(", ")}).` };
  const dados = clienteVazio();
  for (const def of CAMPOS_CLIENTE) {
    const v = entrada[def.campo];
    if (v !== undefined && v !== null && typeof v !== "string") return { ok: false, erro: `${def.rotulo}: precisa ser texto.` };
    const texto = (v ?? "").trim();
    if (def.campo === "cep") {
      const digitos = texto.replace(/[\s.-]/g, "");
      if (digitos && !/^\d{8}$/.test(digitos)) return { ok: false, erro: "CEP: precisa ter 8 dígitos." };
      dados.cep = digitos ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : "";
      continue;
    }
    if (texto.length > def.max) return { ok: false, erro: `${def.rotulo}: até ${def.max} caracteres.` };
    dados[def.campo] = texto;
  }
  return { ok: true, dados };
}

export const mesmoCliente = (a: DadosCliente | null, b: DadosCliente) =>
  CAMPOS_CLIENTE.every(c => (a?.[c.campo] ?? "") === b[c.campo]);

// "ana.paula-silva@gocase.com" → "Ana Paula Silva": o responsável sugerido para quem está logado.
export function nomeDoEmail(email: string): string {
  const local = email.split("@")[0] || "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}
