// Roteamento do backoffice. Quem chama precisa de um autor (x-usuario-email de quem chama de servidor, ou o e-mail que
// o gateway do GoDeploy põe no login: servidor/acesso.ts) em toda rota. O worker.ts passa as dependências reais; os
// testes passam falsos.
//
// Adaptações do app cx-hub (backoffice/ORIGEM.md): as rotas moram em /api/backoffice (o /api/solicitacoes já é uma rota
// do CX Hub neste app) e não há tela: só o backend. Por dentro, o caminho continua o do app de origem (/api/...). Não há
// lote próprio (fila única): a edição sobe no lote da fila do app, e a conferência dela roda na rodada do cron da fila
// (conferencia.ts).
//
//   GET    /api/backoffice/eu                           quem chama, a janela de edição e o tamanho da página
//   GET    /api/backoffice/solicitacoes?tipo=&marca=&status=&busca=&cursor=&contar=1    uma página da gold (por cursor)
//   GET    /api/backoffice/solicitacoes/:chave          a linha, as edições guardadas e os dados do cliente
//   POST   /api/backoffice/solicitacoes/:chave/edicoes  salva uma edição (vai à DAG no próximo lote) e/ou o cliente
//   DELETE /api/backoffice/edicoes/:id                  desfaz uma edição pendente ou dispensa uma recusada
//   GET    /api/backoffice/estado                       diagnóstico das edições, da fila e dos lotes

import { conferirAcesso, usuarioDaChamada } from "./acesso";
import { garantirEsquema } from "./banco";
import type { Contexto, Dependencias } from "./contexto";
import { descartarEdicao, registrarEdicao } from "./edicoes";
import { decodificar, erro } from "./http";
import { MetabaseErro } from "./metabase";
import { estado, eu, listar, verCaso } from "./rotas";

const metodoErrado = (permitidos: string) => erro(405, "METHOD_NOT_ALLOWED", `Use ${permitidos} nesta rota.`, { allow: permitidos });

const SEM_METABASE = "O app está sem a configuração do Metabase (METABASE_URL, METABASE_API_KEY e METABASE_DATABASE_ID).";

/** Onde as rotas do backoffice moram neste app. */
export const PREFIXO_DO_BACKOFFICE = "/api/backoffice";

export const ehCaminhoDoBackoffice = (caminho: string) => caminho === PREFIXO_DO_BACKOFFICE || caminho.startsWith(`${PREFIXO_DO_BACKOFFICE}/`);

export async function tratar(req: Request, deps: Dependencias): Promise<Response> {
  const url = new URL(req.url);
  const publico = url.pathname.replace(/\/+$/, "") || "/";
  if (!ehCaminhoDoBackoffice(publico)) return erro(404, "NOT_FOUND", "Não encontrado.");
  // "/api/backoffice/eu" → "/api/eu": o caminho que as rotas do app de origem conhecem.
  const caminho = `/api${publico.slice(PREFIXO_DO_BACKOFFICE.length)}`;
  const inicio = Date.now();
  const usuario = usuarioDaChamada(req);
  const resposta = usuario.invalido
    ? erro(400, "INVALID_REQUEST", "x-usuario-email precisa ser um e-mail.")
    : await rotear({ ...deps, req, url, agora: deps.relogio.agora(), usuario: usuario.email }, caminho);
  // Sem a query string: a busca pode ter número de pedido.
  console.log(`${req.method} ${publico} → ${resposta.status} em ${Date.now() - inicio} ms`);
  return resposta;
}

async function rotear(c: Contexto, caminho: string): Promise<Response> {
  const metodo = c.req.method;
  try {
    const negado = conferirAcesso(c);
    if (negado) return negado;
    await garantirEsquema(c.db);
    if (caminho === "/api/eu") return metodo === "GET" ? eu(c) : metodoErrado("GET");
    if (caminho === "/api/estado") return metodo === "GET" ? await estado(c) : metodoErrado("GET");

    const edicao = caminho.match(/^\/api\/edicoes\/([^/]+)$/);
    if (edicao) return metodo === "DELETE" ? await descartarEdicao(c, decodificar(edicao[1])) : metodoErrado("DELETE");

    const solicitacao = caminho.match(/^\/api\/solicitacoes(?:\/([^/]+)(\/edicoes)?)?$/);
    if (!solicitacao) return erro(404, "NOT_FOUND", "Rota não encontrada.");
    const m = c.cfg.metabase;
    if (!m) return erro(503, "UNAVAILABLE", SEM_METABASE);
    const [, chave, edicoes] = solicitacao;
    if (!chave) return metodo === "GET" ? await listar(c, m) : metodoErrado("GET");
    if (!edicoes) return metodo === "GET" ? await verCaso(c, m, decodificar(chave)) : metodoErrado("GET");
    return metodo === "POST" ? await registrarEdicao(c, m, decodificar(chave)) : metodoErrado("POST");
  } catch (err) {
    if (err instanceof MetabaseErro) {
      console.error(`Metabase: ${err.message}`);
      return erro(err.transitorio ? 503 : 502, "METABASE_ERROR", `O Metabase não respondeu como esperado (${err.message}). Tente de novo em instantes.`);
    }
    // O que sobra aqui é o banco (env.DB fora, limite do mês): as escritas são idempotentes, repetir é seguro.
    console.error(`falha em ${metodo} ${caminho}:`, (err as Error)?.stack || err);
    return erro(503, "UNAVAILABLE", "O app não conseguiu ler ou gravar agora. Repetir é seguro.");
  }
}
