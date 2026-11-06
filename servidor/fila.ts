// As rotas do CX Hub (docs/fila-cxhub.md): entregar casos e atualizações à fila e ler o que ela guarda. As duas
// escritas são idempotentes (INSERT ... ON CONFLICT DO NOTHING, uma instrução para a chamada inteira): repetir o
// mesmo id não duplica nem sobrescreve, e a falha do banco no meio não deixa metade gravada.

import type { Linha } from "./banco";
import type { Contexto } from "./contexto";
import { erro, json, lerObjeto } from "./http";
import { isoUtc } from "./tempo";
import { ID_SOLICITACAO, MARCAS, TIPOS, validarAtualizacoes, validarCasos } from "./validacao";

const LIMITE_CORPO = 256 * 1024;
const MAX_CASOS_NA_LISTA = 20;
const MAX_IDS = 20;
const SITUACOES = ["pendente", "enviado", "gravado", "recusado"];

export async function postCasos(c: Contexto): Promise<Response> {
  const corpo = await lerObjeto(c.req, LIMITE_CORPO);
  if (corpo instanceof Response) return corpo;
  const v = validarCasos(corpo);
  if (!v.ok) return erro(400, "INVALID_REQUEST", v.message);
  const agora = isoUtc(c.agora);
  const linhas = v.itens.map(x => ({
    id: x.id, tipo: x.tipo, marca: x.marca, numero_pedido: x.numeroPedido, pedido_digitos: x.pedidoDigitos,
    criado_em: x.criadoEm, criado_em_utc: x.criadoEmUtc, responsavel: x.responsavel, dados: x.dados,
  }));
  // "WHERE true": sem ele, o SQLite lê o ON de ON CONFLICT como o de um JOIN.
  await c.db.exec(
    `INSERT INTO casos (id_solicitacao, tipo, marca, numero_pedido, pedido_digitos, criado_em, criado_em_utc, responsavel,
       dados, situacao, enfileirado_em, mudou_em)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.tipo'), json_extract(value, '$.marca'),
       json_extract(value, '$.numero_pedido'), json_extract(value, '$.pedido_digitos'), json_extract(value, '$.criado_em'),
       json_extract(value, '$.criado_em_utc'), json_extract(value, '$.responsavel'), json_extract(value, '$.dados'),
       'pendente', ?, ?
     FROM json_each(?) WHERE true
     ON CONFLICT(id_solicitacao) DO NOTHING`,
    [agora, agora, JSON.stringify(linhas)],
  );
  return json({ code: "ENFILEIRADO", ids: [...new Set(v.itens.map(x => x.id))] });
}

export async function postAtualizacoes(c: Contexto): Promise<Response> {
  const corpo = await lerObjeto(c.req, LIMITE_CORPO);
  if (corpo instanceof Response) return corpo;
  const v = validarAtualizacoes(corpo);
  if (!v.ok) return erro(400, "INVALID_REQUEST", v.message);
  const agora = isoUtc(c.agora);
  const linhas = v.itens.map(x => ({
    id: x.id, id_solicitacao: x.idSolicitacao, atualizado_em: x.atualizadoEm, atualizado_em_utc: x.atualizadoEmUtc, campos: x.campos,
  }));
  await c.db.exec(
    `INSERT INTO atualizacoes (id_atualizacao, id_solicitacao, atualizado_em, atualizado_em_utc, campos, situacao,
       enfileirado_em, mudou_em)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.id_solicitacao'), json_extract(value, '$.atualizado_em'),
       json_extract(value, '$.atualizado_em_utc'), json_extract(value, '$.campos'), 'pendente', ?, ?
     FROM json_each(?) WHERE true
     ON CONFLICT(id_atualizacao) DO NOTHING`,
    [agora, agora, JSON.stringify(linhas)],
  );
  return json({ code: "ENFILEIRADO", ids: [...new Set(v.itens.map(x => x.id))] });
}

const casoDaLinha = (l: Linha) => ({
  id_solicitacao: String(l.id_solicitacao),
  tipo: String(l.tipo),
  marca: String(l.marca),
  numero_pedido: String(l.numero_pedido),
  criado_em: String(l.criado_em),
  responsavel: l.responsavel === null || l.responsavel === undefined ? null : String(l.responsavel),
  situacao: String(l.situacao),
});

const COLUNAS_DO_CASO = "id_solicitacao, tipo, marca, numero_pedido, criado_em, responsavel, situacao";

// GET /api/v1/casos?tipo=&marca=&pedido=: o pedido é comparado só pelos dígitos (o CX Hub manda só eles).
export async function listarCasos(c: Contexto): Promise<Response> {
  const q = c.url.searchParams;
  const tipo = (q.get("tipo") || "").trim().toUpperCase();
  const marca = (q.get("marca") || "").trim().toLowerCase();
  const pedido = (q.get("pedido") || "").trim();
  if (!TIPOS.includes(tipo)) return erro(400, "INVALID_REQUEST", `"tipo" precisa ser ${TIPOS.join(", ")}.`);
  if (!MARCAS.includes(marca)) return erro(400, "INVALID_REQUEST", `"marca" precisa ser ${MARCAS.join(", ")}.`);
  if (!/^\d{1,40}$/.test(pedido)) return erro(400, "INVALID_REQUEST", '"pedido" precisa ter só dígitos.');
  const linhas = await c.db.query(
    `SELECT ${COLUNAS_DO_CASO} FROM casos WHERE tipo = ? AND marca = ? AND pedido_digitos = ?
     ORDER BY criado_em_utc DESC, enfileirado_em DESC LIMIT ?`,
    [tipo, marca, pedido, MAX_CASOS_NA_LISTA],
  );
  return json({ casos: linhas.map(casoDaLinha) });
}

export async function verCaso(c: Contexto, id: string): Promise<Response> {
  if (!ID_SOLICITACAO.test(id)) return erro(400, "INVALID_REQUEST", "O id precisa casar com ^[A-Za-z0-9-]{1,64}$.");
  const l = await c.db.um(`SELECT ${COLUNAS_DO_CASO} FROM casos WHERE id_solicitacao = ?`, [id]);
  return json({ caso: l ? casoDaLinha(l) : null });
}

const TIPOS_ABERTOS = ["REENVIO", "REEMBOLSO"];
const MAX_ABERTOS = 50;
// O gravado continua na lista por 1 h depois do lote: a réplica do Data Mart atrasa minutos para mostrá-lo na raw.
const JANELA_GRAVADO_MS = 60 * 60_000;

// valor e motivo como vieram no caso: valor é número ou texto ("R$ 1.234,56"); o resto vira null.
function valorEMotivo(dados: unknown) {
  let caso: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(String(dados));
    if (v && typeof v === "object" && !Array.isArray(v)) caso = v as Record<string, unknown>;
  } catch {
    // caso ilegível: valor e motivo ficam null
  }
  const valor = typeof caso.valor === "number" || typeof caso.valor === "string" ? caso.valor : null;
  const motivo = typeof caso.motivo === "string" ? caso.motivo : null;
  return { valor, motivo };
}

// GET /api/v1/casos/abertos?tipo=&marca=&pedido=: o que a raw talvez ainda não mostre, para a lista de solicitações
// do CX Hub (raw + fila): pendente, enviado, recusado, e gravado há menos de 1 h. marca e pedido são opcionais.
export async function listarAbertos(c: Contexto): Promise<Response> {
  const q = c.url.searchParams;
  const tipo = (q.get("tipo") || "").trim().toUpperCase();
  const marca = (q.get("marca") || "").trim().toLowerCase();
  const pedido = (q.get("pedido") || "").trim();
  if (!TIPOS_ABERTOS.includes(tipo)) return erro(400, "INVALID_REQUEST", `"tipo" precisa ser ${TIPOS_ABERTOS.join(" ou ")}.`);
  if (marca && !MARCAS.includes(marca)) return erro(400, "INVALID_REQUEST", `"marca" precisa ser ${MARCAS.join(", ")}.`);
  if (pedido && !/^\d{1,40}$/.test(pedido)) return erro(400, "INVALID_REQUEST", '"pedido" precisa ter só dígitos.');
  const filtros = ["tipo = ?"];
  const params: unknown[] = [tipo];
  if (marca) {
    filtros.push("marca = ?");
    params.push(marca);
  }
  if (pedido) {
    filtros.push("pedido_digitos = ?");
    params.push(pedido);
  }
  const linhas = await c.db.query(
    `SELECT ${COLUNAS_DO_CASO}, dados FROM casos
     WHERE ${filtros.join(" AND ")}
       AND (situacao IN ('pendente', 'enviado', 'recusado') OR (situacao = 'gravado' AND terminado_em >= ?))
     ORDER BY criado_em_utc DESC, enfileirado_em DESC LIMIT ?`,
    [...params, isoUtc(c.agora - JANELA_GRAVADO_MS), MAX_ABERTOS],
  );
  return json({ casos: linhas.map(l => ({ ...casoDaLinha(l), ...valorEMotivo(l.dados) })) });
}

// GET /api/v1/atualizacoes?ids=a,b,c: as de até 20 casos, em ordem de atualizado_em.
export async function listarAtualizacoes(c: Contexto): Promise<Response> {
  const ids = [...new Set((c.url.searchParams.get("ids") || "").split(",").map(x => x.trim()).filter(Boolean))];
  if (!ids.length) return erro(400, "INVALID_REQUEST", '"ids" precisa ter ao menos um id de caso.');
  if (ids.length > MAX_IDS) return erro(400, "INVALID_REQUEST", `"ids" aceita até ${MAX_IDS} ids.`);
  if (!ids.every(id => ID_SOLICITACAO.test(id))) return erro(400, "INVALID_REQUEST", "Cada id precisa casar com ^[A-Za-z0-9-]{1,64}$.");
  const linhas = await c.db.query(
    `SELECT id_atualizacao, id_solicitacao, atualizado_em, campos, situacao FROM atualizacoes
     WHERE id_solicitacao IN (SELECT value FROM json_each(?))
     ORDER BY atualizado_em_utc, enfileirado_em, id_atualizacao`,
    [JSON.stringify(ids)],
  );
  return json({
    atualizacoes: linhas.map(l => ({
      id_atualizacao: String(l.id_atualizacao),
      id_solicitacao: String(l.id_solicitacao),
      atualizado_em: String(l.atualizado_em),
      campos: JSON.parse(String(l.campos)) as unknown,
      situacao: String(l.situacao),
    })),
  });
}

async function contar(c: Contexto, tabela: "casos" | "atualizacoes"): Promise<Record<string, number>> {
  const contagem: Record<string, number> = Object.fromEntries(SITUACOES.map(s => [s, 0]));
  for (const l of await c.db.query(`SELECT situacao, COUNT(*) AS n FROM ${tabela} GROUP BY situacao`)) contagem[String(l.situacao)] = Number(l.n);
  return contagem;
}

const COLUNAS_DO_LOTE = "id, situacao, desfecho, casos, atualizacoes, clears, gravados, recusados, erro, criado_em, disparado_em, terminado_em";

// Diagnóstico: quantos itens em cada situação, o lote em andamento, o último terminado, os últimos recusados e a
// configuração (sem valor de segredo).
export async function estado(c: Contexto): Promise<Response> {
  const andamento = await c.db.um(`SELECT ${COLUNAS_DO_LOTE} FROM lotes WHERE situacao IN ('montando', 'disparado') ORDER BY criado_em LIMIT 1`);
  const ultimo = await c.db.um(`SELECT ${COLUNAS_DO_LOTE} FROM lotes WHERE situacao = 'terminado' ORDER BY terminado_em DESC LIMIT 1`);
  const recusados = await c.db.query(
    `SELECT 'caso' AS tipo, id_solicitacao AS id, erro, terminado_em FROM casos WHERE situacao = 'recusado'
     UNION ALL SELECT 'atualizacao', id_atualizacao, erro, terminado_em FROM atualizacoes WHERE situacao = 'recusado'
     ORDER BY terminado_em DESC LIMIT 10`,
  );
  const rodada = await c.db.um("SELECT valor FROM controle WHERE chave = 'ultima_rodada'");
  const cfg = c.cfg;
  return json({
    casos: await contar(c, "casos"),
    atualizacoes: await contar(c, "atualizacoes"),
    lote_em_andamento: andamento ?? null,
    ultimo_lote: ultimo ?? null,
    recusados_recentes: recusados,
    ultima_rodada: rodada ? (JSON.parse(String(rodada.valor)) as unknown) : null,
    config: {
      airflow: cfg.airflow ? { dag_id: cfg.airflow.dagId, task: cfg.airflow.taskResultado, key: cfg.airflow.chaveResultado } : null,
      lote_max: cfg.loteMax,
      chat: Boolean(cfg.chatUrl),
      cron_chave: Boolean(cfg.cronChave),
      tokens: cfg.tokens.length,
      problemas: cfg.problemas,
    },
  });
}
