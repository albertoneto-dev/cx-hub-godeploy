// As rotas de leitura da tela: quem sou eu, a página da lista, um caso e o diagnóstico.

import { JANELA_EDICAO_DIAS, TAMANHO_PAGINA, TIPOS, nomeDoEmail, type Tipo } from "../shared/campos";
import { SIGLAS } from "../shared/marcas";
import { FILTROS_STATUS, type Eu, type FiltroStatus, type Pagina } from "../shared/tipos";
import type { ConfigMetabase } from "./config";
import type { Contexto } from "./contexto";
import { casoNoMetabase, comEdicoes, detalheDoCaso, edicoesDasChaves } from "./edicoes";
import { casosDaFila } from "./fila";
import { casoDaLinha, codificarCursor, cursorDoCaso, lerCursor, sqlDaContagem, sqlDaPagina, type Filtro } from "./gold";
import { erro, json } from "./http";
import { consultar } from "./metabase";

const MAX_BUSCA = 100;

export const eu = (c: Contexto) =>
  json({ email: c.usuario!, nome: nomeDoEmail(c.usuario!), janelaDias: JANELA_EDICAO_DIAS, tamanhoPagina: TAMANHO_PAGINA } satisfies Eu);

// GET /api/solicitacoes?tipo=REENVIO|REEMBOLSO[&marca=<sigla>][&status=...][&busca=...][&cursor=...][&contar=1]
export async function listar(c: Contexto, m: ConfigMetabase): Promise<Response> {
  const p = c.url.searchParams;
  const tipo = (p.get("tipo") || "").trim().toUpperCase() as Tipo;
  if (!TIPOS.includes(tipo)) return erro(400, "INVALID_REQUEST", "tipo precisa ser REENVIO ou REEMBOLSO.");
  const sigla = (p.get("marca") || "").trim().toUpperCase();
  if (sigla && !SIGLAS.has(sigla)) return erro(400, "INVALID_REQUEST", `Marca desconhecida: ${sigla}.`);
  const status = (p.get("status") || "").trim();
  if (status && !(FILTROS_STATUS as readonly string[]).includes(status)) return erro(400, "INVALID_REQUEST", `Status desconhecido: ${status}.`);
  const busca = (p.get("busca") || "").trim();
  if (busca.length > MAX_BUSCA) return erro(400, "INVALID_REQUEST", `Busca com mais de ${MAX_BUSCA} caracteres.`);
  const cursorTexto = p.get("cursor");
  const cursor = cursorTexto ? lerCursor(cursorTexto) : null;
  if (cursorTexto && !cursor) return erro(400, "INVALID_REQUEST", "Cursor inválido: volte para a primeira página.");

  const filtro: Filtro = { tipo, sigla: sigla || null, status: (status || null) as FiltroStatus | null, busca: busca || null };
  // Os casos que ainda estão na fila do app entram na consulta como raw virtual (gold.ts): o caso que acabou de chegar
  // já aparece, filtra e se edita.
  const fila = await casosDaFila(c.db, { tipo }, c.agora);
  // A página e a contagem saem juntas na primeira página; nas seguintes, a tela já sabe o total.
  const [linhas, contagem] = await Promise.all([
    consultar(m, c.fetch, sqlDaPagina(filtro, cursor, TAMANHO_PAGINA, fila)),
    p.get("contar") === "1" ? consultar(m, c.fetch, sqlDaContagem(filtro, fila)) : Promise.resolve(null),
  ]);
  const casos = linhas.map(casoDaLinha);
  const pagina = casos.slice(0, TAMANHO_PAGINA);
  const ultima = pagina[pagina.length - 1];
  const seguinte = casos.length > TAMANHO_PAGINA && ultima ? cursorDoCaso(ultima) : null;
  const edicoes = await edicoesDasChaves(c.db, pagina.map(x => String(x.chave_unica)));
  return json({
    itens: pagina.map(x => comEdicoes(x, edicoes.get(String(x.chave_unica)) ?? [], c.agora)),
    proximo: seguinte ? codificarCursor(seguinte) : null,
    total: contagem ? Number(contagem[0]?.[0] ?? 0) : null,
  } satisfies Pagina);
}

// GET /api/solicitacoes/:chave — a linha (com as edições por cima), as edições guardadas e os dados do cliente.
export async function verCaso(c: Contexto, m: ConfigMetabase, chave: string): Promise<Response> {
  const caso = await casoNoMetabase(c, m, chave);
  if (!caso) return erro(404, "NOT_FOUND", "Solicitação não encontrada no Metabase.");
  return json(await detalheDoCaso(c, m, caso));
}

const porSituacao = async (c: Contexto, sql: string) => ({
  pendente: 0, enviado: 0, gravado: 0, recusado: 0,
  ...Object.fromEntries((await c.db.query(sql)).map(l => [String(l.situacao), Number(l.n)])),
});

// GET /api/estado — diagnóstico: as edições do backoffice em cada situação da fila (e a conferência das gravadas), a
// fila inteira (casos e atualizações, do CX Hub também), o lote em andamento e o resumo da última rodada do cron.
// Adaptação do app cx-hub (fila única, backoffice/ORIGEM.md): o lote e a rodada são os da fila do app.
export async function estado(c: Contexto): Promise<Response> {
  const edicoes = await porSituacao(c, "SELECT a.situacao, COUNT(*) AS n FROM bo_autoria b JOIN atualizacoes a ON a.id_atualizacao = b.id_atualizacao GROUP BY a.situacao");
  const conferencia = Object.fromEntries((await c.db.query(
    `SELECT coalesce(b.conferida, 'esperando') AS conferida, COUNT(*) AS n FROM bo_autoria b JOIN atualizacoes a ON a.id_atualizacao = b.id_atualizacao
     WHERE a.situacao = 'gravado' GROUP BY 1`,
  )).map(l => [String(l.conferida), Number(l.n)]));
  const casos = await porSituacao(c, "SELECT situacao, COUNT(*) AS n FROM casos GROUP BY situacao");
  const atualizacoes = await porSituacao(c, "SELECT situacao, COUNT(*) AS n FROM atualizacoes GROUP BY situacao");
  const lote = await c.db.um("SELECT id, situacao, casos, atualizacoes, clears, disparado_em, criado_em FROM lotes WHERE situacao IN ('montando', 'disparado') ORDER BY criado_em LIMIT 1");
  const ultimos = await c.db.query("SELECT id, desfecho, casos, atualizacoes, gravados, recusados, erro, terminado_em FROM lotes WHERE situacao = 'terminado' ORDER BY terminado_em DESC LIMIT 5");
  const rodada = await c.db.um("SELECT valor FROM controle WHERE chave = 'ultima_rodada'");
  let ultimaRodada: unknown = null;
  try {
    ultimaRodada = rodada ? JSON.parse(String(rodada.valor)) : null;
  } catch {
    ultimaRodada = String(rodada?.valor);
  }
  return json({
    edicoes: { ...edicoes, conferencia: { esperando: 0, na_raw: 0, atrasada: 0, ...conferencia } },
    fila: { casos, atualizacoes },
    loteEmAndamento: lote ?? null,
    ultimosLotes: ultimos,
    ultimaRodada,
    configuracao: { metabase: Boolean(c.cfg.metabase), rotaDados: Boolean(c.cfg.rotaDados), problemas: c.cfg.problemas },
  });
}
