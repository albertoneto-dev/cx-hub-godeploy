// As 23 rotas que o CX Hub tem na Vercel, nos mesmos caminhos e métodos, com o código portado em cxhub/app/api.
// Cada rota recebe o que recebia do Next: a requisição com nextUrl e { params } (os [id] do caminho, já decodificados).
//
// Autenticação: o app é "authenticated" no GoDeploy, e o Authorization pertence ao gateway (a chave gdk_ de quem chama
// de servidor). O token do Cosmos, que as rotas do CX Hub leem no Authorization, chega no x-cosmos-token e é posto no
// Authorization só para a rota; uma gdk_ que o gateway deixe passar não chega a ela (iria ao Cosmos como token).
//
// Quando a rota responde, as tarefas que o after() deixou rodando vão para o ctx.waitUntil (api/next-server.ts).

import * as authLogin from "../cxhub/app/api/auth/login/route";
import * as cancellationSubmit from "../cxhub/app/api/cancellation/submit/route";
import * as cosmosCarriers from "../cxhub/app/api/cosmos/carriers/route";
import * as cosmosOrder from "../cxhub/app/api/cosmos/orders/[id]/route";
import * as cosmosOrders from "../cxhub/app/api/cosmos/orders/route";
import * as cosmosProduct from "../cxhub/app/api/cosmos/products/[id]/route";
import * as cosmosProducts from "../cxhub/app/api/cosmos/products/route";
import * as cosmosResendCancel from "../cxhub/app/api/cosmos/resends/[id]/cancel/route";
import * as cosmosResend from "../cxhub/app/api/cosmos/resends/[id]/route";
import * as cosmosResends from "../cxhub/app/api/cosmos/resends/route";
import * as datamartProducts from "../cxhub/app/api/datamart/products/route";
import * as logisticaSubmit from "../cxhub/app/api/logistica/submit/route";
import * as reenvioBot from "../cxhub/app/api/reenvio/bot/route";
import * as refundCancel from "../cxhub/app/api/refund/cancel/route";
import * as refundComplete from "../cxhub/app/api/refund/complete/route";
import * as refundSubmit from "../cxhub/app/api/refund/submit/route";
import * as refundSync from "../cxhub/app/api/refund/sync/route";
import * as refundUpdate from "../cxhub/app/api/refund/update/route";
import * as registro from "../cxhub/app/api/registro/route";
import * as resendData from "../cxhub/app/api/resend/data/route";
import * as sheetsAppend from "../cxhub/app/api/sheets/append/route";
import * as shopifyOrders from "../cxhub/app/api/shopify/orders/route";
import * as solicitacoes from "../cxhub/app/api/solicitacoes/route";
import { decodificar, erro } from "../servidor/http";
import { type NextRequest, tarefasPendentes } from "./next-server";

type Handler = (req: NextRequest, contexto: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;

/** O ctx do Worker: só o waitUntil interessa aqui. */
export type ContextoDoWorker = { waitUntil(promessa: Promise<unknown>): void };

const ROTAS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["/api/auth/login", authLogin],
  ["/api/cancellation/submit", cancellationSubmit],
  ["/api/cosmos/carriers", cosmosCarriers],
  ["/api/cosmos/orders", cosmosOrders],
  ["/api/cosmos/orders/[id]", cosmosOrder],
  ["/api/cosmos/products", cosmosProducts],
  ["/api/cosmos/products/[id]", cosmosProduct],
  ["/api/cosmos/resends", cosmosResends],
  ["/api/cosmos/resends/[id]", cosmosResend],
  ["/api/cosmos/resends/[id]/cancel", cosmosResendCancel],
  ["/api/datamart/products", datamartProducts],
  ["/api/logistica/submit", logisticaSubmit],
  ["/api/reenvio/bot", reenvioBot],
  ["/api/refund/cancel", refundCancel],
  ["/api/refund/complete", refundComplete],
  ["/api/refund/submit", refundSubmit],
  ["/api/refund/sync", refundSync],
  ["/api/refund/update", refundUpdate],
  ["/api/registro", registro],
  ["/api/resend/data", resendData],
  ["/api/sheets/append", sheetsAppend],
  ["/api/shopify/orders", shopifyOrders],
  ["/api/solicitacoes", solicitacoes],
];

const METODOS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

type Rota = { caminho: string; padrao: RegExp; nomes: string[]; handlers: Map<string, Handler> };

// "/api/cosmos/resends/[id]/cancel" → /^\/api\/cosmos\/resends\/([^/]+)\/cancel$/, nomes ["id"].
function compilar(caminho: string, modulo: Record<string, unknown>): Rota {
  const nomes: string[] = [];
  const fonte = caminho
    .split("/")
    .map((parte) => {
      const m = /^\[(\w+)\]$/.exec(parte);
      if (!m) return parte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      nomes.push(m[1]);
      return "([^/]+)";
    })
    .join("/");
  const handlers = new Map<string, Handler>();
  for (const metodo of METODOS) if (typeof modulo[metodo] === "function") handlers.set(metodo, modulo[metodo] as Handler);
  return { caminho, padrao: new RegExp(`^${fonte}$`), nomes, handlers };
}

const TABELA = ROTAS.map(([caminho, modulo]) => compilar(caminho, modulo));

/** Os caminhos e métodos que o app atende (o diagnóstico e os testes leem daqui). */
export const ROTAS_DA_API = TABELA.map((r) => ({ caminho: r.caminho, metodos: [...r.handlers.keys()] }));

/** Os headers como a rota do CX Hub espera: o token do Cosmos no Authorization, e nada do gateway nele. */
export function headersParaARota(origem: Headers): Headers {
  const headers = new Headers(origem);
  const tokenDoCosmos = headers.get("x-cosmos-token")?.trim();
  if (tokenDoCosmos) headers.set("authorization", /^bearer\s/i.test(tokenDoCosmos) ? tokenDoCosmos : `Bearer ${tokenDoCosmos}`);
  else if (/^bearer\s+gdk_/i.test(headers.get("authorization") ?? "")) headers.delete("authorization");
  headers.delete("x-cosmos-token");
  return headers;
}

function requisicaoDaRota(req: Request, url: URL): NextRequest {
  const nova = new Request(req, { headers: headersParaARota(req.headers) });
  Object.defineProperty(nova, "nextUrl", { value: url, enumerable: false });
  return nova as NextRequest;
}

async function despachar(req: Request, url: URL, caminho: string): Promise<Response> {
  for (const rota of TABELA) {
    const m = rota.padrao.exec(caminho);
    if (!m) continue;
    const handler = rota.handlers.get(req.method);
    if (!handler) {
      const permitidos = [...rota.handlers.keys()].join(", ");
      return erro(405, "METHOD_NOT_ALLOWED", `Use ${permitidos} nesta rota.`, { allow: permitidos });
    }
    const params = Object.fromEntries(rota.nomes.map((nome, i) => [nome, decodificar(m[i + 1])]));
    return handler(requisicaoDaRota(req, url), { params: Promise.resolve(params) });
  }
  return erro(404, "NOT_FOUND", `Rota não encontrada: ${caminho}.`);
}

/** Atende uma requisição às rotas do CX Hub (o worker.ts manda para cá tudo o que não é /api/v1, a fila). */
export async function tratarNaApi(req: Request, ctx?: ContextoDoWorker): Promise<Response> {
  const inicio = Date.now();
  const url = new URL(req.url);
  const caminho = url.pathname.replace(/\/+$/, "") || "/";
  let resposta: Response;
  try {
    resposta = await despachar(req, url, caminho);
  } catch (falha) {
    // No Next, exceção solta virava 500 sem corpo JSON; aqui vira o 500 do contrato, com a pilha no log.
    console.error(`falha em ${req.method} ${caminho}:`, falha instanceof Error ? falha.stack || falha.message : falha);
    resposta = erro(500, "UNKNOWN_ERROR", "Erro interno. Veja o log do app.");
  } finally {
    const pendentes = tarefasPendentes();
    if (pendentes) ctx?.waitUntil(pendentes);
  }
  console.log(`${req.method} ${caminho} → ${resposta.status} em ${Date.now() - inicio} ms`);
  return resposta;
}
