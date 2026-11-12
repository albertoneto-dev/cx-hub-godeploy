// A página /docs: a documentação da API para quem integra, no visual do Gogroup (azul protagonista, acento lima, Poppins,
// cantos arredondados, blocos de cor chapada). Duas partes: o guia do que muda para quem chamava o CX Hub na Vercel e
// cada endpoint no estilo Swagger (headers, parâmetros, corpo, respostas por status com exemplo), gerado da
// especificação em api/docsRotas.ts. Sem script; a única coisa de fora é a fonte Poppins do Google Fonts. A página vai
// no pacote do Worker porque o docs/ do repositório não sobe ao GoDeploy, e o app é "authenticated": só quem tem
// login no GoDeploy (ou uma gdk_ do app) a vê.

import { erro } from "../servidor/http";
import { type CampoDoCorpo, type Endpoint, ENDPOINTS, GRUPOS, type Parametro, type Resposta } from "./docsRotas";

/** O caminho da página, com ou sem a barra no fim. */
export const ehCaminhoDosDocs = (caminho: string) => caminho === "/docs" || caminho === "/docs/";

const CABECALHOS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Sem script nenhum. De fora, só a Poppins (o CSS no fonts.googleapis.com e os arquivos no fonts.gstatic.com).
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src data:; base-uri 'none'; form-action 'none'",
};

/** Responde a página (GET e HEAD); outro método leva o 405 do contrato. */
export function servirDocs(req: Request): Response {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return erro(405, "METHOD_NOT_ALLOWED", "Use GET, HEAD nesta rota.", { allow: "GET, HEAD" });
  }
  return new Response(req.method === "HEAD" ? null : PAGINA_DOS_DOCS, { headers: CABECALHOS });
}

// ─── Texto ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Texto da especificação para HTML: escapado, e o que vem entre crases vira código. */
const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

/** A âncora de um endpoint: "POST /api/cosmos/resends/{id}/cancel" → "post-api-cosmos-resends-id-cancel". */
export const ancoraDoEndpoint = (e: Pick<Endpoint, "method" | "path">) =>
  `${e.method}${e.path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");

/** JSON indentado, com chaves, textos, números e literais em spans para a cor. */
function jsonRealcado(valor: unknown): string {
  const texto = JSON.stringify(valor, null, 2) ?? "null";
  const token = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let saida = "";
  let ultimo = 0;
  for (const m of texto.matchAll(token)) {
    const pos = m.index ?? 0;
    saida += esc(texto.slice(ultimo, pos));
    if (m[1]) saida += m[2] ? `<span class="j-chave">${esc(m[1])}</span>${m[2]}` : `<span class="j-texto">${esc(m[1])}</span>`;
    else if (m[3]) saida += `<span class="j-literal">${m[3]}</span>`;
    else saida += `<span class="j-numero">${m[4]}</span>`;
    ultimo = pos + m[0].length;
  }
  return saida + esc(texto.slice(ultimo));
}

const blocoJson = (valor: unknown) => `<pre class="codigo"><code>${jsonRealcado(valor)}</code></pre>`;

// ─── Endpoints ──────────────────────────────────────────────────────────────────────────────────────────────────────

// As rotas que não conferiam credencial nenhuma na Vercel (docs/api.md).
const ABERTAS_NA_VERCEL = new Set([
  "/api/auth/login", "/api/cancellation/submit", "/api/refund/submit", "/api/sheets/append",
  "/api/logistica/submit", "/api/resend/data", "/api/shopify/orders",
]);

// As rotas que nasceram aqui: não havia equivalente na Vercel.
const ehRotaNova = (path: string) => path.startsWith("/api/backoffice/") || path.startsWith("/api/interno/");

function mudancaNoGoDeploy(e: Endpoint): { titulo: string; texto: string } | null {
  if (e.path.startsWith("/api/v1/")) return null;
  if (ehRotaNova(e.path)) return { titulo: "Novo no GoDeploy.", texto: "Esta rota não existia na Vercel." };
  if (e.routeHeader === "x-cosmos-token") {
    return { titulo: "Mudou no GoDeploy.", texto: "O token do Cosmos ia no `Authorization`. Agora vai no `x-cosmos-token`, e o `Authorization` leva a `gdk_`." };
  }
  if (e.routeHeader === "x-bot-secret") {
    return { titulo: "Mudou no GoDeploy.", texto: "O `x-bot-secret` continua e agora vai junto da `gdk_` no `Authorization`. Com um só, a chamada é recusada." };
  }
  if (ABERTAS_NA_VERCEL.has(e.path)) return { titulo: "Mudou no GoDeploy.", texto: "Era aberta na Vercel. Agora exige a `gdk_` no `Authorization`." };
  return null;
}

const DESCRICAO_DO_HEADER: Record<string, string> = {
  "x-cosmos-token": "O `credentials.token` do `POST /api/auth/login`, com ou sem `Bearer ` na frente.",
  "x-bot-secret": "O segredo do bot (`BOT_RESEND_SECRET`). Ausente ou errado: 401.",
  "x-cxhub-fila-token": "Um dos tokens aceitos pela fila (`CXHUB_FILA_TOKENS`).",
  "x-usuario-email":
    "O e-mail de quem está na tela de quem chama (a agente na Central de Tickets): o autor das edições. Obrigatório na " +
    "chamada de servidor; sem ele, vale só o e-mail que o gateway põe no login do navegador. Fora do formato de e-mail: 400.",
};

// As rotas de rodada, que o cron do GoDeploy chama com o X-Godeploy-Cron no lugar do header da rota.
const ROTAS_DE_CRON = new Set(["/api/v1/interno/lote", "/api/backoffice/interno/lote", "/api/interno/rota-dados"]);

function marcaObrigatorio(r: CampoDoCorpo["required"]): string {
  if (r === true) return `<span class="obrig">obrigatório</span>`;
  if (r === "condicional") return `<span class="cond">condicional</span>`;
  return `<span class="opc">opcional</span>`;
}

const listaDeValores = (valores?: string[]) =>
  valores?.length ? `<div class="valores">${valores.map((v) => `<code>${esc(v)}</code>`).join(" ")}</div>` : "";

function tabelaDeCampos(campos: CampoDoCorpo[]): string {
  const linhas = campos.map((c) => `<tr>
      <td><code class="campo">${esc(c.name)}</code>${marcaObrigatorio(c.required)}</td>
      <td class="tipo">${esc(c.type)}</td>
      <td>${inline(c.description)}${listaDeValores(c.enum)}</td>
    </tr>`);
  return `<div class="tabela-rolavel"><table class="esquema">
    <thead><tr><th>Campo</th><th>Tipo</th><th>Descrição</th></tr></thead>
    <tbody>${linhas.join("")}</tbody></table></div>`;
}

function tabelaDeParametros(params: Parametro[]): string {
  const linhas = params.map((p) => `<tr>
      <td><code class="campo">${esc(p.name)}</code>${marcaObrigatorio(p.required)}</td>
      <td class="tipo">${esc(p.in)}</td>
      <td class="tipo">${esc(p.type)}</td>
      <td>${inline(p.description)}${listaDeValores(p.enum)}</td>
    </tr>`);
  return `<div class="tabela-rolavel"><table class="esquema">
    <thead><tr><th>Nome</th><th>Em</th><th>Tipo</th><th>Descrição</th></tr></thead>
    <tbody>${linhas.join("")}</tbody></table></div>`;
}

function tabelaDeHeaders(e: Endpoint): string {
  const linhas: string[] = [
    `<tr><td><code class="campo">Authorization</code>${marcaObrigatorio(true)}</td>
      <td><code>Bearer gdk_…</code>: a chave do GoDeploy para o app <code>cx-hub</code>. O gateway confere antes do app.</td></tr>`,
  ];
  if (e.routeHeader) {
    const extra = ROTAS_DE_CRON.has(e.path) ? " O cron do GoDeploy usa o `X-Godeploy-Cron` no lugar dele." : "";
    const obrigatorio = e.routeHeader === "x-usuario-email" ? "condicional" : true;
    linhas.push(`<tr><td><code class="campo">${e.routeHeader}</code>${marcaObrigatorio(obrigatorio)}</td>
      <td>${inline(DESCRICAO_DO_HEADER[e.routeHeader] + extra)}</td></tr>`);
  }
  const jaListados = new Set(["authorization", "content-type", e.routeHeader ?? ""]);
  for (const p of e.params.filter((p) => p.in === "header" && !jaListados.has(p.name.toLowerCase()))) {
    linhas.push(`<tr><td><code class="campo">${esc(p.name)}</code>${marcaObrigatorio(p.required)}</td><td>${inline(p.description)}</td></tr>`);
  }
  if (e.requestBody) {
    linhas.push(`<tr><td><code class="campo">Content-Type</code>${marcaObrigatorio(true)}</td>
      <td><code>${esc(e.requestBody.contentType)}</code></td></tr>`);
  }
  return `<div class="tabela-rolavel"><table class="esquema">
    <thead><tr><th>Header</th><th>Valor</th></tr></thead><tbody>${linhas.join("")}</tbody></table></div>`;
}

const classeDoStatus = (status: number) => `s${Math.floor(status / 100)}xx`;

function blocoDeResposta(r: Resposta): string {
  return `<div class="resposta">
    <div class="resposta-cab"><span class="status ${classeDoStatus(r.status)}">${r.status}</span><p>${inline(r.description)}</p></div>
    ${r.fields?.length ? tabelaDeCampos(r.fields) : ""}
    ${r.example !== undefined ? blocoJson(r.example) : ""}
  </div>`;
}

function blocoDoEndpoint(e: Endpoint): string {
  const metodo = e.method.toLowerCase();
  const consultas = e.params.filter((p) => p.in !== "header");
  const mudanca = mudancaNoGoDeploy(e);
  return `<details class="op op-${metodo}" id="${ancoraDoEndpoint(e)}" open>
  <summary>
    <span class="verbo">${e.method}</span>
    <code class="rota">${esc(e.path)}</code>
    <span class="op-resumo">${inline(e.summary)}</span>
    ${e.routeHeader ? `<span class="chave-da-rota" title="Header da rota">${e.routeHeader}</span>` : ""}
  </summary>
  <div class="op-corpo">
    <p class="op-descricao">${inline(e.description)}</p>
    ${mudanca ? `<p class="mudou"><strong>${mudanca.titulo}</strong> ${inline(mudanca.texto)}</p>` : ""}
    <h4 class="rotulo">Headers</h4>
    ${tabelaDeHeaders(e)}
    ${consultas.length ? `<h4 class="rotulo">Parâmetros</h4>${tabelaDeParametros(consultas)}` : ""}
    ${e.requestBody ? `<h4 class="rotulo">Corpo da requisição <span class="tipo-conteudo">${esc(e.requestBody.contentType)}</span></h4>
      ${tabelaDeCampos(e.requestBody.fields)}
      <p class="sub-rotulo">Exemplo</p>${blocoJson(e.requestBody.example)}` : ""}
    <h4 class="rotulo">Respostas</h4>
    <div class="respostas">${e.responses.map(blocoDeResposta).join("")}</div>
    ${e.notes?.length ? `<div class="notas"><p class="sub-rotulo">Observações</p><ul>${e.notes.map((n) => `<li>${inline(n)}</li>`).join("")}</ul></div>` : ""}
  </div>
</details>`;
}

const endpointsDoGrupo = (tag: string) => ENDPOINTS.filter((e) => e.tag === tag);
const ancoraDoGrupo = (tag: string) => "grupo-" + tag.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-");

function secaoDoGrupo(g: { tag: string; descricao: string }): string {
  const lista = endpointsDoGrupo(g.tag);
  if (!lista.length) return "";
  return `<section class="grupo" id="${ancoraDoGrupo(g.tag)}">
  <div class="grupo-cab"><h2>${esc(g.tag)}</h2><p>${inline(g.descricao)}</p></div>
  ${lista.map(blocoDoEndpoint).join("\n")}
</section>`;
}

// ─── Navegação ──────────────────────────────────────────────────────────────────────────────────────────────────────

const GUIA: ReadonlyArray<readonly [string, string]> = [
  ["resumo", "Resumo da migração"],
  ["autenticacao", "Autenticação"],
  ["exemplos", "Antes e depois"],
  ["respostas", "Respostas que mudaram"],
  ["igual", "O que não mudou"],
  ["comportamento", "Comportamento"],
  ["backoffice", "Backoffice"],
  ["crons", "Crons e cache"],
  ["problemas", "Problemas comuns"],
];

function navegacao(): string {
  const guia = GUIA.map(([id, nome]) => `<a href="#${id}">${nome}</a>`).join("");
  const grupos = GRUPOS.filter((g) => endpointsDoGrupo(g.tag).length).map((g) => `
    <a class="nav-grupo" href="#${ancoraDoGrupo(g.tag)}">${esc(g.tag)}</a>
    ${endpointsDoGrupo(g.tag).map((e) => `<a class="nav-op" href="#${ancoraDoEndpoint(e)}"><span class="mini mini-${e.method.toLowerCase()}">${e.method}</span><span class="nav-rota">${esc(e.path)}</span></a>`).join("")}`);
  return `<p class="nav-titulo">Guia de migração</p>${guia}<p class="nav-titulo">Endpoints</p>${grupos.join("")}`;
}

// ─── Guia (o que muda para quem chamava a Vercel) ───────────────────────────────────────────────────────────────────

const GUIA_HTML = `
<section class="bloco" id="resumo">
  <p class="sobrelinha">Comece por aqui</p>
  <h2>Resumo da migração</h2>
  <p class="intro">Cinco ajustes em quem chama a API: Typebot, n8n, Central de Tickets ou outro app. Os caminhos, os
  métodos e os corpos continuam os mesmos.</p>
  <ol class="passos">
    <li><strong>Troque o endereço</strong>
      <span><code>https://cx-hub.vercel.app</code> → <code>https://cx-hub.devgogroup.com</code>. O resto do caminho fica igual.</span></li>
    <li><strong>Mande a chave do GoDeploy em toda chamada de servidor</strong>
      <span><code>Authorization: Bearer gdk_…</code>, uma chave de API do GoDeploy emitida para o app <code>cx-hub</code>. A de
      outro app não serve.</span></li>
    <li><strong>Mova o token do Cosmos para o <code>x-cosmos-token</code></strong>
      <span>Ele ia no <code>Authorization</code>, que agora é da chave do GoDeploy. Vale para as rotas do Cosmos, do Data Mart,
      da gestão de reembolso, do registro e das solicitações.</span></li>
    <li><strong>No bot de reenvio, mande as duas chaves</strong>
      <span>A <code>gdk_</code> e o <code>x-bot-secret</code>. Com uma só, a chamada é recusada.</span></li>
    <li><strong>Espere até 150 s no <code>/api/reenvio/bot</code></strong>
      <span>O bot faz o trabalho dele em até 150 s. Um timeout menor no cliente corta a chamada no meio.</span></li>
  </ol>
</section>

<section class="bloco" id="autenticacao">
  <p class="sobrelinha">Duas conferências</p>
  <h2>Autenticação</h2>
  <p class="intro">Na Vercel, cada rota conferia a própria credencial. No GoDeploy, a chamada passa antes pelo gateway da
  plataforma, que usa o <code>Authorization</code>. Por isso a credencial da rota foi para outro header.</p>
  <div class="camadas">
    <div class="camada camada-branca"><span class="camada-num">1</span><b>Quem chama</b>
      <p>Servidor com a chave <code>gdk_</code>, ou navegador com login no GoDeploy.</p></div>
    <div class="camada camada-azul"><span class="camada-num">2</span><b>Gateway do GoDeploy</b>
      <p>Confere a <code>gdk_</code> ou a sessão. Sem elas, a chamada não chega ao app.</p></div>
    <div class="camada camada-lima"><span class="camada-num">3</span><b>Rota do CX Hub</b>
      <p>Confere o header dela: <code>x-cosmos-token</code>, <code>x-bot-secret</code> ou <code>x-cxhub-fila-token</code>.</p></div>
  </div>

  <h3>Como passar pelo gateway</h3>
  <div class="tabela-rolavel"><table class="marca">
    <thead><tr><th>Quem chama</th><th>Como passa</th></tr></thead>
    <tbody>
      <tr><td>Servidor (Typebot, n8n, Central de Tickets, outro app)</td>
        <td><code>Authorization: Bearer gdk_…</code>, chave de API do GoDeploy para o app <code>cx-hub</code></td></tr>
      <tr><td>Navegador numa página deste domínio</td><td>A sessão de login do GoDeploy (qualquer pessoa do grupo)</td></tr>
      <tr><td>Página de outro domínio, pelo navegador</td><td>Não funciona: o app não responde aos headers de CORS</td></tr>
    </tbody>
  </table></div>

  <h3>O header de cada rota</h3>
  <div class="tabela-rolavel"><table class="marca">
    <thead><tr><th>Rotas</th><th>Vercel (antes)</th><th>GoDeploy (agora)</th></tr></thead>
    <tbody>
      <tr>
        <td><code>/api/cosmos/*</code>, <code>/api/datamart/products</code>, <code>/api/refund/cancel</code>,
          <code>/api/refund/update</code>, <code>/api/refund/complete</code>, <code>/api/refund/sync</code>,
          <code>/api/registro</code>, <code>/api/solicitacoes</code></td>
        <td><code>Authorization: Bearer &lt;token do Cosmos&gt;</code></td>
        <td><code>x-cosmos-token: &lt;token do Cosmos&gt;</code>, com ou sem o <code>Bearer </code> na frente</td>
      </tr>
      <tr><td><code>/api/reenvio/bot</code></td><td><code>x-bot-secret</code></td>
        <td><code>x-bot-secret</code>, igual, <strong>junto da</strong> <code>gdk_</code></td></tr>
      <tr>
        <td><code>/api/auth/login</code>, <code>/api/cancellation/submit</code>, <code>/api/refund/submit</code>,
          <code>/api/sheets/append</code>, <code>/api/logistica/submit</code>, <code>/api/resend/data</code>,
          <code>/api/shopify/orders</code></td>
        <td>Nenhum: a rota era aberta</td><td>Nenhum header da rota. Basta passar pelo gateway.</td>
      </tr>
      <tr><td><code>/api/v1/*</code> (a fila)</td><td>Já estava no GoDeploy</td><td><code>x-cxhub-fila-token</code>, sem mudança</td></tr>
      <tr><td><code>/api/backoffice/*</code> (o backoffice)</td><td>Não existia: era o app <code>backoffice-hub</code>, só pelo
        navegador</td><td><code>x-usuario-email: &lt;e-mail de quem está na tela&gt;</code>, o autor das edições</td></tr>
      <tr><td><code>/api/interno/rota-dados</code> (a cache)</td><td>Não existia</td>
        <td><code>x-cxhub-fila-token</code>, ou o cron do GoDeploy</td></tr>
    </tbody>
  </table></div>
  <p class="aviso">O token do Cosmos é o <code>credentials.token</code> que o <code>POST /api/auth/login</code> devolve. O app o
  põe no <code>Authorization</code> só para a rota. A <code>gdk_</code> é tirada antes e nunca chega ao Cosmos.</p>
</section>

<section class="bloco" id="exemplos">
  <p class="sobrelinha">Na prática</p>
  <h2>Antes e depois</h2>
  <p class="intro">Os corpos não mudam. O que está marcado é o que muda na chamada.</p>

  <h3>Rota que usa o token do Cosmos</h3>
  <div class="comparacao">
    <div class="lado lado-antes"><p class="lado-cab">Vercel · antes</p>
<pre class="codigo"><code>curl "https://<mark>cx-hub.vercel.app</mark>/api/cosmos/orders?brand=lescent&amp;orderId=12345" \\
  -H "<mark>Authorization: Bearer &lt;token do Cosmos&gt;</mark>"</code></pre></div>
    <div class="lado lado-agora"><p class="lado-cab">GoDeploy · agora</p>
<pre class="codigo"><code>curl "https://<mark>cx-hub.devgogroup.com</mark>/api/cosmos/orders?brand=lescent&amp;orderId=12345" \\
  -H "<mark>Authorization: Bearer gdk_&lt;chave do app cx-hub&gt;</mark>" \\
  -H "<mark>x-cosmos-token: &lt;token do Cosmos&gt;</mark>"</code></pre></div>
  </div>

  <h3>Bot de reenvio</h3>
  <div class="comparacao">
    <div class="lado lado-antes"><p class="lado-cab">Vercel · antes</p>
<pre class="codigo"><code>curl -X POST "https://<mark>cx-hub.vercel.app</mark>/api/reenvio/bot" \\
  -H "x-bot-secret: &lt;BOT_RESEND_SECRET&gt;" \\
  -H "content-type: application/json" \\
  -d '{ …o mesmo corpo de sempre… }'</code></pre></div>
    <div class="lado lado-agora"><p class="lado-cab">GoDeploy · agora</p>
<pre class="codigo"><code>curl -X POST "https://<mark>cx-hub.devgogroup.com</mark>/api/reenvio/bot" \\
  -H "<mark>Authorization: Bearer gdk_&lt;chave do app cx-hub&gt;</mark>" \\
  -H "x-bot-secret: &lt;BOT_RESEND_SECRET&gt;" \\
  -H "content-type: application/json" \\
  <mark>--max-time 160</mark> \\
  -d '{ …o mesmo corpo de sempre… }'</code></pre></div>
  </div>

  <h3>Rota que era aberta</h3>
  <div class="comparacao">
    <div class="lado lado-antes"><p class="lado-cab">Vercel · antes</p>
<pre class="codigo"><code>curl -X POST "https://<mark>cx-hub.vercel.app</mark>/api/refund/submit" \\
  -H "content-type: application/json" \\
  -d '{ …o mesmo corpo de sempre… }'</code></pre></div>
    <div class="lado lado-agora"><p class="lado-cab">GoDeploy · agora</p>
<pre class="codigo"><code>curl -X POST "https://<mark>cx-hub.devgogroup.com</mark>/api/refund/submit" \\
  -H "<mark>Authorization: Bearer gdk_&lt;chave do app cx-hub&gt;</mark>" \\
  -H "content-type: application/json" \\
  -d '{ …o mesmo corpo de sempre… }'</code></pre></div>
  </div>
</section>

<section class="bloco" id="respostas">
  <p class="sobrelinha">Erros</p>
  <h2>Respostas que mudaram</h2>
  <p class="intro">As respostas de sucesso e os erros que cada rota já devolvia (<code>{ "error": "…" }</code> com 400, 401,
  500 ou 504) são os mesmos. Mudam as recusas do gateway e os erros que o Next devolvia sozinho, que agora vêm em JSON no
  formato <code>{ "code", "message" }</code>.</p>
  <div class="tabela-rolavel"><table class="marca">
    <thead><tr><th>Situação</th><th>Vercel (antes)</th><th>GoDeploy (agora)</th></tr></thead>
    <tbody>
      <tr><td>Chamada sem a chave <code>gdk_</code></td><td>A rota respondia: era aberta ou conferia a credencial dela</td>
        <td><span class="status s3xx">302</span> para o login do GoDeploy, antes de chegar ao app. Um cliente que segue o
          redirecionamento (o <code>fetch</code> faz isso por padrão) recebe a página de login em HTML, não JSON.</td></tr>
      <tr><td>Chave <code>gdk_</code> de outro app</td><td>—</td><td><span class="status s4xx">403</span> do gateway</td></tr>
      <tr><td>Caminho que não existe</td><td>404 do Next, sem JSON</td>
        <td><span class="status s4xx">404</span> <code>{ "code": "NOT_FOUND", "message": "Rota não encontrada: …" }</code></td></tr>
      <tr><td>Método errado (ex.: <code>GET</code> numa rota só de <code>POST</code>)</td><td>405 do Next, sem JSON</td>
        <td><span class="status s4xx">405</span> <code>{ "code": "METHOD_NOT_ALLOWED", "message": "Use POST nesta rota." }</code> e o
          header <code>Allow</code></td></tr>
      <tr><td>Erro inesperado no código</td><td>500 sem corpo JSON</td>
        <td><span class="status s5xx">500</span> <code>{ "code": "UNKNOWN_ERROR", "message": "Erro interno. Veja o log do app." }</code></td></tr>
      <tr><td>Barra no fim do caminho (<code>/api/registro/</code>)</td><td>Tratada pelo Next</td><td>A mesma rota, sem redirecionamento</td></tr>
    </tbody>
  </table></div>
</section>

<section class="bloco" id="igual">
  <p class="sobrelinha">Continua igual</p>
  <h2>O que não mudou</h2>
  <ul class="lista">
    <li>Os corpos das requisições e das respostas de sucesso, campo a campo, nas 23 rotas.</li>
    <li>O contrato do <code>code</code> e do <code>reason</code>: um <strong>200 com <code>code</code> de erro</strong>
      (<code>SHEETS_ERROR</code>, <code>UNKNOWN_ERROR</code>) quer dizer "registrado, não repita".</li>
    <li>Os valores do <code>reason</code> do bot, que o Typebot usa para decidir o que responder à cliente.</li>
    <li>O <code>testMode: true</code>, que não grava nada.</li>
    <li>O bloqueio de duplicata em 24 h no <code>/api/sheets/append</code> e no <code>/api/refund/submit</code>.</li>
  </ul>
</section>

<section class="bloco" id="comportamento">
  <p class="sobrelinha">Por trás</p>
  <h2>Comportamento que mudou</h2>
  <p class="intro">O contrato é o mesmo, mas estes pontos podem aparecer no resultado.</p>
  <div class="tabela-rolavel"><table class="marca">
    <thead><tr><th>Assunto</th><th>O que muda</th></tr></thead>
    <tbody>
      <tr><td>Rituária no <code>/api/shopify/orders</code></td><td>O pedido vem do integrations-gateway, que só enxerga os
        <strong>últimos 60 dias</strong>. Um pedido mais antigo volta como não encontrado. No Cosmos e no bot, a Rituária
        segue igual.</td></tr>
      <tr><td>Modo simulado</td><td>O <code>COSMOS_RESEND_SIMULADO</code> da Vercel não existe aqui: este app é a produção.
        Para ensaiar, use <code>testMode: true</code>.</td></tr>
      <tr><td>Tempo de execução</td><td>Não há o <code>maxDuration</code> da Vercel. O bot continua planejando o trabalho para
        150 s, então o cliente precisa esperar pelo menos isso.</td></tr>
      <tr><td>Avisos de erro</td><td>O que ia ao grupo do Google Chat vai a um canal do Slack, com o mesmo texto.</td></tr>
      <tr><td>Fila de registro</td><td>As rotas entregam casos à fila dentro do próprio app, sem chamada de rede.</td></tr>
      <tr><td>Listas do formulário (rota dados)</td><td>O <code>/api/resend/data</code> e as marcas do bot leem de uma cache no
        <code>env.DB</code>, renovada a cada 5 min. Com a rota dados fora, servem a última resposta boa por até 24 h (na
        Vercel, a chamada falhava).</td></tr>
      <tr><td>Log</td><td>Cada chamada às rotas deixa uma linha <code>MÉTODO caminho → status em N ms</code> (sem a query
        string) no log do app no GoDeploy.</td></tr>
    </tbody>
  </table></div>
</section>

<section class="bloco" id="backoffice">
  <p class="sobrelinha">Rotas novas</p>
  <h2>Backoffice de reenvio e reembolso</h2>
  <p class="intro">O backend do antigo app <code>backoffice-hub</code> mora aqui, em <code>/api/backoffice</code>, com as mesmas
  regras de negócio. Quem monta a tela (a Central de Tickets) chama pelo servidor, com a <code>gdk_</code> deste app e o
  <code>x-usuario-email</code> da agente. Os detalhes de cada rota estão no grupo Backoffice, mais abaixo.</p>
  <ol class="passos">
    <li><strong>Liste</strong>
      <span><code>GET /api/backoffice/solicitacoes?tipo=REEMBOLSO&amp;contar=1</code> traz a primeira página (50 linhas) e o
      total. O <code>proximo</code> leva à página seguinte: guarde a pilha de cursores para voltar.</span></li>
    <li><strong>Abra o caso</strong>
      <span><code>GET /api/backoffice/solicitacoes/{chave}</code> traz a linha, as edições guardadas, o cliente e, se a linha se
      edita, os motivos, o pedido (os itens que viram checkbox) e o catálogo do mimo.</span></li>
    <li><strong>Edite</strong>
      <span><code>POST /api/backoffice/solicitacoes/{chave}/edicoes</code>, só com o que mudou: os campos digitados, os itens
      marcados do pedido e, no reenvio, os dados do cliente.</span></li>
    <li><strong>Espere o lote</strong>
      <span>O cron leva a edição à DAG em até 10 min. Até o Metabase mostrá-la, a lista a aplica por cima, com
      <code>aguardando</code>.</span></li>
    <li><strong>Desfaça, se precisar</strong>
      <span><code>DELETE /api/backoffice/edicoes/{id}</code> enquanto a edição estiver pendente, ou para dispensar uma
      recusada.</span></li>
  </ol>

  <h3>Quem chama</h3>
  <div class="tabela-rolavel"><table class="marca">
    <thead><tr><th>Chamada</th><th>Autor das edições</th><th>Proteção de escrita</th></tr></thead>
    <tbody>
      <tr><td>Servidor (a Central), com a <code>gdk_</code> e o <code>x-usuario-email</code></td><td>O
        <code>x-usuario-email</code></td><td>Não se aplica: a chamada não tem <code>Origin</code></td></tr>
      <tr><td>Navegador, com o login do GoDeploy</td><td>O e-mail do login</td>
        <td><code>x-backoffice: 1</code> e a origem do app (senão 403)</td></tr>
      <tr><td><code>x-usuario-email</code> fora do formato de e-mail</td><td>—</td><td>400, sem cair no dono da chave</td></tr>
    </tbody>
  </table></div>

  <h3>O que trava a edição</h3>
  <p class="intro">Uma linha só se edita quando todas valem; senão, <code>422 NOT_EDITABLE</code> com o motivo em
  <code>bloqueio</code>. As regras olham a linha já com as edições guardadas por cima: marcar Cancelado trava na hora.</p>
  <ul class="lista">
    <li>É caso do CX Hub (<code>chave_unica</code> = <code>cxhub|&lt;id&gt;</code>): o histórico das planilhas não se edita.</li>
    <li>É reenvio ou reembolso, e foi solicitado há até 30 dias.</li>
    <li>Não está Cancelado e, se é reembolso, não está Realizado.</li>
    <li>Se é reenvio, o Cosmos ainda não o registrou (<code>reenvio_no_cosmos</code>).</li>
  </ul>

  <h3>O que se edita</h3>
  <div class="tabela-rolavel"><table class="marca">
    <thead><tr><th>Campo</th><th>Reenvio</th><th>Reembolso</th><th>Como</th></tr></thead>
    <tbody>
      <tr><td><code>status_execucao</code></td><td>sim</td><td>sim</td><td>Pendente, Realizado ou Cancelado</td></tr>
      <tr><td><code>data_execucao</code></td><td>sim</td><td>sim</td><td>aaaa-mm-dd, até hoje</td></tr>
      <tr><td><code>responsavel_execucao</code>, <code>cod_nfd</code></td><td>sim</td><td>sim</td><td>Texto</td></tr>
      <tr><td><code>motivo</code></td><td>sim</td><td>sim</td><td>Um da lista da rota dados</td></tr>
      <tr><td><code>skus</code>, <code>produtos_reenvio</code></td><td>sim</td><td>—</td>
        <td>Itens marcados do pedido (do kit, os itens); no SKU do reenvio, também o mimo do catálogo, de 1 a 10</td></tr>
      <tr><td><code>escopo_reembolso</code></td><td>—</td><td>sim</td><td>Itens marcados do pedido e o frete</td></tr>
      <tr><td><code>valor</code></td><td>—</td><td>sim</td>
        <td>Sai dos itens marcados, até o total do pedido; digitado só com exceção à política</td></tr>
      <tr><td><code>uf</code></td><td>sim</td><td>—</td><td>UF de destino</td></tr>
      <tr><td>Cliente (<code>nome</code> a <code>cidade</code>)</td><td>sim</td><td>—</td>
        <td>Fica só no app: o Metabase não guarda dado pessoal</td></tr>
    </tbody>
  </table></div>
</section>

<section class="bloco" id="crons">
  <p class="sobrelinha">Rotinas</p>
  <h2>Crons e cache</h2>
  <div class="tabela-rolavel"><table class="marca">
    <thead><tr><th>Rota</th><th>Agenda</th><th>O que faz</th></tr></thead>
    <tbody>
      <tr><td><code>POST /api/v1/interno/lote</code></td><td>A cada 20 min</td><td>Manda os casos e as atualizações da fila à DAG</td></tr>
      <tr><td><code>POST /api/backoffice/interno/lote</code></td><td>A cada 10 min</td><td>Manda as edições do backoffice à DAG</td></tr>
      <tr><td><code>POST /api/interno/rota-dados</code></td><td>A cada 5 min</td><td>Renova a cache das listas da rota dados</td></tr>
    </tbody>
  </table></div>
  <p class="aviso">A cache da rota dados vale por 15 min: nesse tempo, o formulário, o bot e o backoffice nem chamam a rota
  dados. Mais velha, a leitura busca ao vivo e guarda; com a rota dados fora, serve a última resposta boa por até 24 h. Cada
  rota de cron aceita no máximo uma chamada sem assinatura a cada 30 s, com uma trava por rota.</p>
</section>

<section class="bloco" id="problemas">
  <p class="sobrelinha">Deu erro?</p>
  <h2>Problemas comuns</h2>
  <div class="tabela-rolavel"><table class="marca">
    <thead><tr><th>O que aparece</th><th>Causa provável</th><th>O que fazer</th></tr></thead>
    <tbody>
      <tr><td>302, ou HTML de login no lugar do JSON</td><td>Falta a chave <code>gdk_</code></td>
        <td>Mande <code>Authorization: Bearer gdk_…</code> do app <code>cx-hub</code></td></tr>
      <tr><td>403 antes de chegar à rota</td><td>A <code>gdk_</code> é de outro app</td><td>Use uma chave emitida para o app <code>cx-hub</code></td></tr>
      <tr><td><code>401 { "error": "Missing authorization header" }</code> numa rota do Cosmos</td>
        <td>O token do Cosmos não foi no <code>x-cosmos-token</code></td><td>Mande o token no <code>x-cosmos-token</code></td></tr>
      <tr><td>401 vindo do Cosmos (ex.: <code>{ "error": "Cosmos API error: 401" }</code>)</td><td>O token do Cosmos venceu</td>
        <td>Faça o <code>POST /api/auth/login</code> de novo</td></tr>
      <tr><td><code>401 { "message": "Não autorizado." }</code> no bot</td><td><code>x-bot-secret</code> ausente ou errado</td>
        <td>Confira o valor do <code>x-bot-secret</code></td></tr>
      <tr><td><code>503 { "message": "Endpoint não configurado." }</code> no bot</td>
        <td>O <code>BOT_RESEND_SECRET</code> não está cadastrado no app</td><td>Cadastre o segredo no GoDeploy</td></tr>
      <tr><td>O bot estoura o tempo</td><td>O timeout do cliente é menor que 150 s</td><td>Aumente para pelo menos 160 s</td></tr>
      <tr><td><code>404 { "code": "NOT_FOUND" }</code></td><td>Caminho digitado errado</td><td>Confira na lista de endpoints ao lado</td></tr>
      <tr><td>Pedido da Rituária não encontrado no <code>/api/shopify/orders</code></td><td>O pedido tem mais de 60 dias</td>
        <td>Busque pelo Cosmos (<code>/api/cosmos/orders</code>)</td></tr>
    </tbody>
  </table></div>
</section>`;

// ─── Estilo (tokens da marca Gogroup) ───────────────────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --azul: #2659a5; --lima: #d7d900; --amarelo: #f8ae13; --vermelho: #e5273c; --rosa: #e61782; --ceu: #3dbfef;
  --branco: #ffffff; --preto: #1a1a1a;
  --fundo: #f2f2f2; --linha: #e2e2e2; --suave: #595959; --zebra: #f7f7f7;
  --azul-claro: #e9eff8; --lima-claro: #f6f6d2; --amarelo-claro: #fef2d9;
  --fonte: "Poppins", Arial, Helvetica, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --r-sm: 8px; --r-md: 16px; --r-lg: 28px;
  color-scheme: light;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 20px; }
body { margin: 0; background: var(--fundo); color: var(--preto); font: 400 15px/1.6 var(--fonte); -webkit-text-size-adjust: 100%; }
a { color: var(--azul); }
code { font: 500 0.86em/1.45 var(--mono); background: var(--zebra); border: 1px solid var(--linha); padding: 1px 6px; border-radius: 6px; overflow-wrap: break-word; }
h2, h3, h4 { font-family: var(--fonte); }

.layout { display: grid; grid-template-columns: 272px minmax(0, 1fr); gap: 28px; max-width: 1380px; margin: 0 auto; padding: 24px; }

/* Navegação lateral */
.lateral { position: sticky; top: 24px; align-self: start; max-height: calc(100vh - 48px); overflow-y: auto;
  background: var(--branco); border-radius: var(--r-lg); padding: 22px 14px 22px 18px; }
.lateral-cab { display: flex; align-items: center; gap: 10px; padding: 0 6px 16px; margin-bottom: 8px; border-bottom: 1px solid var(--linha); }
.selo-api { width: 36px; height: 36px; border-radius: 12px; background: var(--lima); color: var(--azul); display: grid; place-items: center;
  font-weight: 700; font-size: 13px; letter-spacing: .5px; flex: none; }
.lateral-cab strong { display: block; font-weight: 700; font-size: 15px; line-height: 1.2; color: var(--azul); }
.lateral-cab span { font-size: 12px; color: var(--suave); }
.lateral nav a, .menu-movel nav a { display: block; text-decoration: none; color: var(--preto); font-size: 13.5px; padding: 5px 8px; border-radius: var(--r-sm); }
.lateral nav a:hover, .menu-movel nav a:hover { background: var(--azul-claro); color: var(--azul); }
.nav-titulo { margin: 16px 8px 6px; font-size: 11px; font-weight: 600; letter-spacing: 1.4px; text-transform: uppercase; color: var(--azul); }
nav a.nav-grupo { margin-top: 10px; font-weight: 600; }
nav a.nav-op { display: flex; align-items: flex-start; gap: 8px; padding: 4px 8px 4px 14px; }
.nav-rota { font: 500 12px/1.5 var(--mono); color: var(--suave); overflow-wrap: anywhere; }
nav a.nav-op:hover .nav-rota { color: var(--azul); }
.mini { flex: none; width: 44px; text-align: center; font: 700 10px/1.9 var(--mono); border-radius: 6px; margin-top: 1px; }
.mini-get { background: var(--azul); color: var(--branco); }
.mini-post { background: var(--lima); color: var(--azul); }
.mini-patch, .mini-put { background: var(--amarelo); color: var(--preto); }
.mini-delete { background: var(--vermelho); color: var(--branco); }
.menu-movel { display: none; }

/* Topo */
.hero { position: relative; overflow: hidden; background: var(--azul); color: var(--branco); border-radius: var(--r-lg); padding: 48px 48px 40px; margin-bottom: 24px; }
.hero::after { content: ""; position: absolute; right: -70px; top: -70px; width: 240px; height: 240px; border-radius: 50%; background: var(--lima); }
.hero::before { content: ""; position: absolute; right: 130px; top: 120px; width: 64px; height: 64px; border-radius: 50%; border: 6px solid var(--ceu); }
.hero > * { position: relative; z-index: 1; max-width: 760px; }
.hero .sobrelinha { color: var(--lima); }
.hero h1 { margin: 0 0 16px; font-weight: 700; font-size: clamp(34px, 5vw, 54px); line-height: 1.05; letter-spacing: -1px; }
.hero .lead { margin: 0 0 24px; font-size: 17px; }
.pilulas { display: flex; flex-wrap: wrap; gap: 8px; }
.pilula { border-radius: 999px; padding: 6px 16px; font-weight: 600; font-size: 13px; background: var(--branco); color: var(--azul); }
.pilula-lima { background: var(--lima); }
.pilula code { background: none; border: 0; padding: 0; font-size: 12.5px; color: inherit; }

/* Blocos do guia */
.bloco { background: var(--branco); border-radius: var(--r-lg); padding: 34px 36px; margin-bottom: 24px; }
.sobrelinha { margin: 0 0 6px; font-weight: 600; font-size: 12.5px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--azul); }
.bloco h2, .grupo-cab h2 { margin: 0 0 8px; font-weight: 700; font-size: 30px; line-height: 1.15; color: var(--azul); }
.bloco h3 { margin: 28px 0 10px; font-weight: 600; font-size: 18px; }
.intro { margin: 0 0 20px; color: var(--suave); max-width: 780px; }
.passos { list-style: none; counter-reset: passo; margin: 0; padding: 0; display: grid; gap: 10px; }
.passos li { counter-increment: passo; position: relative; padding: 16px 18px 16px 64px; background: var(--zebra); border-radius: var(--r-md); }
.passos li::before { content: counter(passo); position: absolute; left: 16px; top: 15px; width: 32px; height: 32px; border-radius: 50%;
  background: var(--lima); color: var(--azul); display: grid; place-items: center; font-weight: 700; }
.passos strong { display: block; font-weight: 600; margin-bottom: 2px; }
.passos span { color: var(--suave); }
.camadas { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 8px; }
.camada { position: relative; border-radius: var(--r-md); padding: 18px 18px 18px 60px; }
.camada b { display: block; font-weight: 700; margin-bottom: 4px; }
.camada p { margin: 0; font-size: 14px; }
.camada-num { position: absolute; left: 16px; top: 16px; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; }
.camada-branca { background: var(--zebra); }
.camada-branca .camada-num { background: var(--azul); color: var(--branco); }
.camada-azul { background: var(--azul); color: var(--branco); }
.camada-azul .camada-num { background: var(--lima); color: var(--azul); }
.camada-azul code { background: var(--branco); color: var(--azul); border: 0; }
.camada-lima { background: var(--lima); color: var(--azul); }
.camada-lima .camada-num { background: var(--azul); color: var(--lima); }
.camada-lima code { background: var(--branco); border: 0; }
.aviso { margin: 16px 0 0; padding: 14px 18px; border-radius: var(--r-md); background: var(--amarelo-claro); border-left: 6px solid var(--amarelo); }
.lista { margin: 0; padding-left: 20px; }
.lista li { margin-bottom: 8px; }

/* Tabelas */
.tabela-rolavel { overflow-x: auto; border-radius: var(--r-md); border: 1px solid var(--linha); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 11px 16px; text-align: left; vertical-align: top; }
table.marca thead th { background: var(--azul); color: var(--branco); font-weight: 600; font-size: 13px; }
table.marca tbody tr:nth-child(even) { background: var(--zebra); }
table.esquema { font-size: 13.5px; }
table.esquema thead th { background: var(--zebra); color: var(--azul); font-weight: 600; font-size: 11.5px; letter-spacing: 1px; text-transform: uppercase; border-bottom: 1px solid var(--linha); }
table.esquema td { border-bottom: 1px solid var(--linha); }
table.esquema tr:last-child td { border-bottom: 0; }
table.esquema td:first-child { width: 30%; }
code.campo { background: none; border: 0; padding: 0; font-weight: 600; color: var(--preto); }
.obrig, .cond, .opc { display: block; margin-top: 2px; font-size: 11px; font-weight: 600; letter-spacing: .3px; }
.obrig { color: var(--vermelho); }
.cond { color: #a35f00; }
.opc { color: var(--suave); font-weight: 400; }
td.tipo { font: 500 12.5px/1.5 var(--mono); color: var(--azul); white-space: nowrap; }
.valores { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
.valores code { font-size: 11.5px; background: var(--azul-claro); border-color: transparent; color: var(--azul); }

/* Código */
.codigo { margin: 0; padding: 16px 18px; background: var(--preto); color: #ededed; border-radius: var(--r-md); overflow: auto; max-height: 460px;
  font: 400 13px/1.6 var(--mono); }
.codigo code { background: none; border: 0; padding: 0; font: inherit; color: inherit; overflow-wrap: normal; }
.codigo mark { background: var(--lima); color: var(--preto); border-radius: 4px; padding: 0 3px; }
.j-chave { color: var(--ceu); }
.j-texto { color: var(--lima); }
.j-numero, .j-literal { color: var(--amarelo); }
.comparacao { display: grid; gap: 10px; margin-bottom: 8px; }
.lado { border-radius: var(--r-md); overflow: hidden; background: var(--preto); }
.lado .codigo { border-radius: 0; }
.lado-cab { margin: 0; padding: 8px 18px; font-weight: 600; font-size: 13px; }
.lado-antes .lado-cab { background: var(--zebra); color: var(--suave); }
.lado-agora .lado-cab { background: var(--lima); color: var(--azul); }

/* Endpoints, no estilo do Swagger */
.grupo { margin: 44px 0 0; }
.grupo-cab { padding: 0 6px 14px; }
.grupo-cab p { margin: 0; color: var(--suave); }
.op { --cor: var(--azul); --fundo-op: var(--azul-claro); background: var(--branco); border: 2px solid var(--cor); border-radius: var(--r-md);
  margin-bottom: 14px; overflow: hidden; }
.op-post { --cor: var(--lima); --fundo-op: var(--lima-claro); }
.op-patch, .op-put { --cor: var(--amarelo); --fundo-op: var(--amarelo-claro); }
.op-delete { --cor: var(--vermelho); --fundo-op: #fde4e7; }
.op:target { outline: 4px solid var(--rosa); outline-offset: 3px; }
.op > summary { list-style: none; cursor: pointer; display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px;
  padding: 12px 16px; background: var(--fundo-op); }
.op > summary::-webkit-details-marker { display: none; }
.op > summary::after { content: ""; margin-left: auto; width: 9px; height: 9px; border-right: 2.5px solid var(--azul);
  border-bottom: 2.5px solid var(--azul); transform: rotate(-45deg); flex: none; }
.op[open] > summary::after { transform: rotate(45deg); }
.verbo { min-width: 74px; text-align: center; border-radius: var(--r-sm); padding: 5px 10px; font: 700 13px/1.2 var(--mono); letter-spacing: .5px; }
.op-get .verbo { background: var(--azul); color: var(--branco); }
.op-post .verbo { background: var(--lima); color: var(--azul); }
.op-patch .verbo, .op-put .verbo { background: var(--amarelo); color: var(--preto); }
.op-delete .verbo { background: var(--vermelho); color: var(--branco); }
code.rota { background: none; border: 0; padding: 0; font: 700 15px/1.4 var(--mono); color: var(--preto); }
.op-resumo { flex: 1 1 220px; color: var(--suave); font-size: 14px; }
.chave-da-rota { font: 600 11.5px/1.6 var(--mono); padding: 2px 10px; border-radius: 999px; background: var(--branco); color: var(--azul); border: 1.5px solid var(--azul); }
.op-corpo { padding: 18px 20px 22px; }
.op-descricao { margin: 0 0 12px; }
.mudou { margin: 0 0 6px; padding: 10px 14px; border-radius: var(--r-sm); background: var(--lima-claro); border-left: 6px solid var(--lima); font-size: 14px; }
.rotulo { display: flex; align-items: center; gap: 10px; margin: 22px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--fundo);
  font-weight: 600; font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--azul); }
.tipo-conteudo { font: 600 11px/1.6 var(--mono); letter-spacing: 0; text-transform: none; padding: 1px 8px; border-radius: 999px; background: var(--zebra); color: var(--suave); }
.sub-rotulo { margin: 14px 0 6px; font-weight: 600; font-size: 12px; color: var(--suave); }
.respostas { display: grid; gap: 12px; }
.resposta { border: 1px solid var(--linha); border-radius: var(--r-md); padding: 12px 14px; display: grid; gap: 10px; }
.resposta-cab { display: flex; align-items: flex-start; gap: 12px; }
.resposta-cab p { margin: 2px 0 0; font-size: 14px; }
.status { flex: none; display: inline-block; min-width: 50px; text-align: center; border-radius: var(--r-sm); padding: 2px 8px; font: 700 13px/1.6 var(--mono); }
.s2xx { background: var(--lima); color: var(--azul); }
.s3xx { background: var(--ceu); color: var(--preto); }
.s4xx { background: var(--amarelo); color: var(--preto); }
.s5xx { background: var(--vermelho); color: var(--branco); }
.notas { margin-top: 16px; padding: 4px 16px 10px; border-radius: var(--r-md); background: var(--amarelo-claro); }
.notas ul { margin: 0; padding-left: 18px; font-size: 14px; }
.notas li { margin-bottom: 4px; }

footer { margin: 40px 0 8px; padding: 18px 6px 0; border-top: 1px solid var(--linha); color: var(--suave); font-size: 13px; }

@media (max-width: 1000px) {
  .layout { grid-template-columns: minmax(0, 1fr); padding: 16px; gap: 16px; }
  .lateral { display: none; }
  .menu-movel { display: block; position: sticky; top: 8px; z-index: 5; background: var(--branco); border-radius: var(--r-md); border: 2px solid var(--azul); }
  .menu-movel > summary { cursor: pointer; padding: 10px 16px; font-weight: 600; color: var(--azul); }
  .menu-movel nav { max-height: 60vh; overflow-y: auto; padding: 0 10px 12px; }
}
@media (max-width: 640px) {
  .hero { padding: 32px 22px 28px; }
  .hero::after, .hero::before { display: none; }
  .bloco { padding: 24px 18px; }
  .bloco h2, .grupo-cab h2 { font-size: 24px; }
  .camadas { grid-template-columns: 1fr; }
  .op-corpo { padding: 14px 12px 18px; }
  /* No celular, cada linha do esquema vira um cartão: nome e obrigatoriedade, o tipo, e a descrição embaixo. */
  table.esquema thead { display: none; }
  table.esquema, table.esquema tbody, table.esquema tr, table.esquema td { display: block; width: auto; }
  table.esquema tr { padding: 10px 14px; border-bottom: 1px solid var(--linha); }
  table.esquema tr:last-child { border-bottom: 0; }
  table.esquema td, table.esquema td:first-child { padding: 2px 0; border: 0; width: auto; }
  td.tipo { white-space: normal; }
}
`;

// ─── A página ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Ícone da aba: um quadrado azul com um círculo lima (não é o logo, que fica fora desta página).
const ICONE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' " +
  "fill='%232659a5'/%3E%3Ccircle cx='16' cy='16' r='7' fill='%23d7d900'/%3E%3C/svg%3E";

function montarPagina(): string {
  const conta = (prefixo: string) => ENDPOINTS.filter((e) => e.path.startsWith(prefixo)).length;
  const daFila = conta("/api/v1/");
  const doBackoffice = conta("/api/backoffice/");
  const internas = conta("/api/interno/");
  const rotasDoHub = ENDPOINTS.length - daFila - doBackoffice - internas;
  const nav = navegacao();
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gogroup · CX Hub API</title>
<meta name="description" content="Documentação da API do CX Hub no GoDeploy: o que muda para quem chamava a Vercel e cada endpoint com requisição e resposta.">
<link rel="icon" href="${ICONE}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&amp;display=swap">
<style>${CSS}</style>
</head>
<body>
<div class="layout">
<aside class="lateral" aria-label="Navegação">
  <div class="lateral-cab"><span class="selo-api" aria-hidden="true">API</span><div><strong>CX Hub</strong><span>no GoDeploy</span></div></div>
  <nav>${nav}</nav>
</aside>
<main>
  <details class="menu-movel"><summary>Navegar na documentação</summary><nav>${nav}</nav></details>
  <header class="hero">
    <p class="sobrelinha">CX Hub · API no GoDeploy</p>
    <h1>Documentação da API</h1>
    <p class="lead">O backend do CX Hub saiu da Vercel e foi para o GoDeploy. Os caminhos, os métodos e os corpos são os
    mesmos; mudam o endereço, os headers de autenticação e algumas respostas de erro. Há também rotas novas, só daqui: o
    backoffice de reenvio e reembolso e a cache da rota dados. Abaixo, o guia e cada endpoint com a requisição e as
    respostas.</p>
    <div class="pilulas">
      <span class="pilula pilula-lima"><code>https://cx-hub.devgogroup.com</code></span>
      <span class="pilula">${rotasDoHub} rotas do CX Hub · ${daFila} da fila · ${doBackoffice} do backoffice · ${internas} ${internas === 1 ? "interna" : "internas"}</span>
      <span class="pilula">Código do CX Hub: 8a1b1a9</span>
    </div>
  </header>
  ${GUIA_HTML}
  ${GRUPOS.map(secaoDoGrupo).join("\n")}
  <footer>Esta página vem do próprio app (<code>api/docs.ts</code> e <code>api/docsRotas.ts</code>) e é atualizada junto com o
  código. Os exemplos são fictícios, e a página não traz nenhuma chave ou segredo: para os valores, fale com quem administra
  o app <code>cx-hub</code> no GoDeploy.</footer>
</main>
</div>
</body>
</html>
`;
}

export const PAGINA_DOS_DOCS = montarPagina();
