#!/usr/bin/env node
// Conferência do app no workerd (o runtime do Cloudflare, que o GoDeploy usa) antes de publicar. Empacota o worker.ts
// de verdade com o esbuild (platform neutral: um import node:* quebra aqui) e roda no miniflare sem nodejs_compat, em
// duas datas de compatibilidade (uma antiga e a do binário), porque não se sabe a do GoDeploy. O env.DB vira um service
// binding atendido aqui com SQLite; Cosmos, Metabase e Google são falsos atendidos aqui, e o JWT que o WebCrypto do
// workerd assina é conferido com a chave pública pelo crypto do Node. Não sobe nada e não fala com serviço de verdade.
//
// Uso (Node ≥ 22, no WSL): node ferramentas/workerd/conferir.mjs [--ferramentas <pasta com miniflare e esbuild>]
// A pasta padrão é ~/cx-workerd (npm install miniflare@4 esbuild@0.25), fora do repo.

import { createVerify, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--ferramentas");
const ferramentas = i > 0 ? process.argv[i + 1] : path.join(os.homedir(), "cx-workerd");
const exigir = createRequire(path.join(ferramentas, "package.json"));
const carregar = async nome => {
  const m = await import(pathToFileURL(exigir.resolve(nome)).href);
  return m.default && !m.build && !m.Miniflare ? m.default : m;
};
const esbuild = await carregar("esbuild");
const { Miniflare } = await carregar("miniflare");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const APP = "https://cx-hub.devgogroup.com";
const COSMOS = "https://cosmos.test";
const METABASE = "https://metabase.test";
const TOKEN_DA_FILA = "token-da-fila-de-teste";
const EMAIL_GOOGLE = "conferencia@projeto.iam.gserviceaccount.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const chavePrivadaPem = privateKey.export({ type: "pkcs8", format: "pem" });

const pacote = await esbuild.build({
  entryPoints: [path.join(aqui, "entrada.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  write: false,
  logLevel: "silent",
});
const codigo = pacote.outputFiles[0].text;
console.log(`pacote: ${(codigo.length / 1024).toFixed(0)} KB`);

// O que o worker mandou à rede (fora o BANCO), para as conferências.
let saidas = [];

function servicoDoBanco() {
  const sqlite = new DatabaseSync(":memory:");
  return async req => {
    const { sql, params } = await req.json();
    try {
      if (new URL(req.url).pathname === "/query") {
        const rows = sqlite.prepare(sql).all(...params);
        return Response.json({ columns: rows.length ? Object.keys(rows[0]) : [], rows });
      }
      // Como o env.DB do GoDeploy, que conta também as linhas de índice: o dobro.
      return Response.json({ rowsWritten: 2 * Number(sqlite.prepare(sql).run(...params).changes) });
    } catch (erro) {
      return new Response(String(erro), { status: 500 });
    }
  };
}

function jwtValido(assertion) {
  const [cab, corpo, assinatura] = String(assertion).split(".");
  const verificador = createVerify("RSA-SHA256");
  verificador.update(`${cab}.${corpo}`);
  if (!verificador.verify(publicKey, Buffer.from(assinatura, "base64url"))) return "assinatura não confere";
  const claims = JSON.parse(Buffer.from(corpo, "base64url").toString());
  if (claims.iss !== EMAIL_GOOGLE || claims.aud !== TOKEN_URL || !String(claims.scope).includes("spreadsheets")) return "claims erradas";
  return null;
}

async function rede(req) {
  const url = req.url;
  saidas.push({ url, metodo: req.method, authorization: req.headers.get("authorization") });
  if (url.startsWith(`${COSMOS}/organizations/`)) return Response.json([]);
  if (url === `${METABASE}/api/dataset`) return Response.json({ status: "completed", data: { rows: [] } }, { status: 202 });
  if (url === TOKEN_URL) {
    const problema = jwtValido(new URLSearchParams(await req.text()).get("assertion"));
    return problema
      ? Response.json({ error: "invalid_grant", error_description: problema }, { status: 400 })
      : Response.json({ access_token: "token-do-google-falso", expires_in: 3600 });
  }
  return new Response("destino inesperado na conferência", { status: 599 });
}

// O que o Node formata para o mesmo instante, com as mesmas opções do código (cxhub/shared/lib/format.ts e os
// toLocale* de adaptBotPayload.ts e buildSubmissionData.ts).
const instante = new Date(Date.UTC(2026, 10, 10, 15, 4, 5));
const partes = Object.fromEntries(new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).formatToParts(instante).map(p => [p.type, p.value]));
const noNode = {
  carimboSP: `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}:${partes.second}`,
  toLocaleString: instante.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
  toLocaleDateString: instante.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }),
};

let falhas = 0;
const conferir = (nome, ok, detalhe = "") => {
  if (!ok) falhas++;
  console.log(`  ${ok ? "ok " : "FALHOU"} ${nome}${!ok && detalhe ? ` — ${detalhe}` : ""}`);
};

async function rodada(dataDeCompatibilidade) {
  console.log(`\nworkerd, compatibilityDate ${dataDeCompatibilidade}, sem nodejs_compat:`);
  saidas = [];
  const mf = new Miniflare({
    modules: true,
    script: codigo,
    compatibilityDate: dataDeCompatibilidade,
    compatibilityFlags: [],
    bindings: {
      CXHUB_FILA_TOKENS: TOKEN_DA_FILA,
      COSMOS_API_URL: COSMOS,
      METABASE_URL: METABASE,
      METABASE_API_KEY: "chave-do-metabase",
      METABASE_DATABASE_ID: "43",
      GOOGLE_PLANILHAS_EMAIL: EMAIL_GOOGLE,
      GOOGLE_PLANILHAS_TOKEN: chavePrivadaPem,
      SHEETS_ENV: "staging",
    },
    serviceBindings: { BANCO: servicoDoBanco() },
    outboundService: rede,
  });
  try {
    const pedir = (caminho, init) => mf.dispatchFetch(`${APP}${caminho}`, init);

    let r = await pedir("/api/resend/data?origin=nenhuma");
    conferir("rota do CX Hub responde pelo roteador (400 do origin)", r.status === 400 && (await r.json()).error?.startsWith("origin inválido"));

    r = await pedir("/api/nao-existe");
    conferir("rota desconhecida: 404 { code }", r.status === 404 && (await r.json()).code === "NOT_FOUND");

    r = await pedir("/api/backoffice/eu", { headers: { "x-usuario-email": "ana.silva@gocase.com" } });
    conferir("backoffice em /api/backoffice: quem chama pelo x-usuario-email", r.status === 200 && (await r.json()).email === "ana.silva@gocase.com", `HTTP ${r.status}`);

    r = await pedir("/docs");
    conferir("/docs devolve a página em HTML", r.status === 200 && r.headers.get("content-type")?.startsWith("text/html") && (await r.text()).includes("<title>Gogroup · CX Hub API</title>"), `HTTP ${r.status}`);

    r = await pedir("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a", password: "b" }) });
    conferir("corpo chega à rota pelo Request remontado (login sem config: 500 da rota)", r.status === 500 && (await r.json()).error === "Server configuration error");

    const id = `conferencia-${Date.now()}`;
    r = await pedir("/api/v1/casos", {
      method: "POST",
      headers: { "x-cxhub-fila-token": TOKEN_DA_FILA, "content-type": "application/json" },
      body: JSON.stringify({ casos: [{ id_solicitacao: id, tipo: "REEMBOLSO", marca: "lescent", criado_em: "2026-11-10T12:00:00-03:00", numero_pedido: "SH1001", valor: 10, motivo: "Teste", responsavel: "Conferência" }] }),
    });
    conferir("fila (/api/v1/casos) grava no env.DB", r.status === 200 && (await r.json()).code === "ENFILEIRADO", `HTTP ${r.status}`);

    saidas = [];
    r = await pedir(`/api/registro?ids=${id}`, { headers: { "x-cosmos-token": "jwt-do-login", authorization: "Bearer gdk_chave" } });
    const registro = r.status === 200 ? await r.json() : { status: r.status, corpo: await r.text() };
    conferir("rota do CX Hub lê a fila dentro do Worker (registro: aguardando)", registro.estados?.[id] === "aguardando", JSON.stringify(registro));
    conferir("x-cosmos-token vai ao Cosmos como Authorization; a gdk_ não", saidas.some(s => s.url.startsWith(COSMOS) && s.authorization === "Bearer jwt-do-login") && !saidas.some(s => s.authorization?.includes("gdk_")));
    conferir("nada da fila saiu do Worker pela rede", saidas.every(s => s.url.startsWith(COSMOS) || s.url.startsWith(METABASE)), JSON.stringify(saidas.map(s => s.url)));

    r = await pedir("/__conferencias");
    const c = await r.json();
    conferir("sem Node no runtime: process é o do app, Buffer não existe", c.processExiste === "object" && c.bufferExiste === "undefined", JSON.stringify([c.processExiste, c.bufferExiste]));
    conferir("JWT RS256 assinado pelo WebCrypto do workerd confere com a chave pública", c.tokenDoGoogle === "token-do-google-falso", c.tokenDoGoogle);
    for (const k of ["carimboSP", "toLocaleString", "toLocaleDateString"]) {
      conferir(`Intl pt-BR/São Paulo igual ao do Node: ${k} = "${noNode[k]}"`, c[k] === noNode[k], `workerd deu "${c[k]}"`);
    }
  } finally {
    await mf.dispose();
  }
}

await rodada("2024-01-01");
await rodada("2026-07-30");
console.log(falhas ? `\n${falhas} conferência(s) falharam` : "\ntudo conferido no workerd");
process.exit(falhas ? 1 : 0);
