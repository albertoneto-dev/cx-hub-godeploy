// Quem chama. No app de origem (backoffice-hub), só o navegador chamava: o gateway do GoDeploy põe o e-mail de quem
// está logado em x-godeploy-user-email (e descarta o que vier de fora com o mesmo nome: nota do
// cx-rota-dados-godeploy/src/auth.ts), e esse e-mail é o autor de cada edição.
//
// Adaptação do app cx-hub (backoffice/ORIGEM.md): aqui quem chama é sobretudo outro servidor (a Central de Tickets),
// com a chave gdk_ deste app. Nesse caso o gateway põe no x-godeploy-user-email o dono da chave, não a pessoa que está
// na tela de lá; por isso quem chama manda essa pessoa em x-usuario-email, que vale mais. Só chega aqui quem passou
// pelo gateway (gdk_ deste app ou login do GoDeploy), e nenhuma página de outro site consegue mandar esse cabeçalho
// (sem CORS, o navegador nem faz a chamada).

import type { Contexto } from "./contexto";
import { erro } from "./http";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailDoGateway = (req: Request): string | null =>
  (req.headers.get("x-godeploy-user-email") || "").trim().toLowerCase() || null;

// O autor da chamada: o x-usuario-email de quem chama de servidor, senão o e-mail do gateway. Cabeçalho presente e
// fora do formato de e-mail é "invalido": a chamada é recusada, em vez de cair no dono da chave em silêncio.
export function usuarioDaChamada(req: Request): { email: string | null; invalido: boolean } {
  const doChamador = (req.headers.get("x-usuario-email") || "").trim().toLowerCase();
  if (doChamador) return EMAIL.test(doChamador) && doChamador.length <= 254 ? { email: doChamador, invalido: false } : { email: null, invalido: true };
  return { email: emailDoGateway(req), invalido: false };
}

export function conferirAcesso(c: Contexto): Response | null {
  if (!c.usuario) return erro(401, "UNAUTHORIZED", "Sem o usuário: mande x-usuario-email (chamada de servidor) ou entre pelo login do GoDeploy.");
  return null;
}

// Escrita feita pelo navegador (salvar, descartar, rodar o lote à mão). O cabeçalho próprio obriga o navegador a
// perguntar antes (preflight) numa chamada de outro site, que o app não autoriza; a origem confere o resto.
// Adaptação do app cx-hub: sem Origin, a chamada é de servidor (o navegador sempre manda Origin em POST e DELETE) e não
// carrega a sessão de ninguém, que é o que esta proteção defende; passa.
export function problemaNaEscrita(c: Contexto): string | null {
  const origem = c.req.headers.get("origin");
  if (!origem) return null;
  if (c.req.headers.get("x-backoffice") !== "1") return "Cabeçalho x-backoffice ausente.";
  const aceitas = new Set([c.url.origin]);
  if (c.cfg.origemApp) aceitas.add(c.cfg.origemApp);
  if (!aceitas.has(origem)) return "Origem da requisição não permitida.";
  return null;
}
