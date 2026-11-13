#!/usr/bin/env node
// Porta o backend do CX Hub (as rotas de app/api que rodavam na Vercel, e as novas) para este app. Copia, do commit dado do repositório do
// CX Hub, o fecho de imports das rotas e os testes que só dependem desse fecho, e muda só os especificadores de
// import do código: os aliases (@/, @shared/, @modules/) viram caminho relativo e next/server vira o adaptador
// api/next-server.ts. Os testes ficam como estão (o vitest.config.ts resolve os aliases). As adaptações ao Worker
// são feitas à mão depois, por cima desta cópia; rodar de novo com --saida <pasta vazia> regera a cópia crua, para
// comparar com o que está no repo (diff -r).
//
// Uso (Node ≥ 22, no WSL): node ferramentas/portar-do-cxhub.mjs --cxhub <repo do CX Hub> --rev <commit> [--saida <pasta>]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 ? process.argv[i + 1] : padrao;
};
const CXHUB = arg("cxhub");
const REV = arg("rev");
const SAIDA = path.resolve(arg("saida", path.join(path.dirname(new URL(import.meta.url).pathname), "..")));
if (!CXHUB || !REV) {
  console.error("uso: node ferramentas/portar-do-cxhub.mjs --cxhub <repo> --rev <commit> [--saida <pasta>]");
  process.exit(2);
}

const git = (...a) => execFileSync("git", ["-C", CXHUB, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const commit = git("rev-parse", REV).trim();
const arquivos = new Set(git("ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean));
const lidos = new Map();
const ler = arq => {
  if (!lidos.has(arq)) lidos.set(arq, git("show", `${commit}:${arq}`));
  return lidos.get(arq);
};

// As rotas (mesmos caminhos da Vercel): 22 no commit e8fe51c, 23 desde o 8a1b1a9 (2026-11-11, /api/datamart/products),
// 24 desde o 11cebff (2026-11-12, /api/datamart/order-context, ADR-018).
// Rota nova no CX Hub entra aqui e no api/roteador.ts. O resto entra pelo fecho de imports.
const ROTAS = [
  "app/api/auth/login/route.ts",
  "app/api/cancellation/submit/route.ts",
  "app/api/cosmos/carriers/route.ts",
  "app/api/cosmos/orders/[id]/route.ts",
  "app/api/cosmos/orders/route.ts",
  "app/api/cosmos/products/[id]/route.ts",
  "app/api/cosmos/products/route.ts",
  "app/api/cosmos/resends/[id]/cancel/route.ts",
  "app/api/cosmos/resends/[id]/route.ts",
  "app/api/cosmos/resends/route.ts",
  "app/api/datamart/order-context/route.ts",
  "app/api/datamart/products/route.ts",
  "app/api/logistica/submit/route.ts",
  "app/api/reenvio/bot/route.ts",
  "app/api/refund/cancel/route.ts",
  "app/api/refund/complete/route.ts",
  "app/api/refund/submit/route.ts",
  "app/api/refund/sync/route.ts",
  "app/api/refund/update/route.ts",
  "app/api/registro/route.ts",
  "app/api/resend/data/route.ts",
  "app/api/sheets/append/route.ts",
  "app/api/shopify/orders/route.ts",
  "app/api/solicitacoes/route.ts",
];
// Fora de propósito: app/extravios-gobeaute/ é um protótipo local (ignorado pelo .gitignore do CX Hub, nunca esteve
// na Vercel) que vai para o hub Jornada CX.

// import/export ... from "x", import "x", import("x"), vi.mock("x"): o grupo 1 ou 2 é o especificador.
const RE_IMPORT = /(?:\b(?:import|export)\s[^'"`;]*?\sfrom\s*|\bimport\s*\(?\s*|\bvi\.(?:mock|importActual)\s*\(\s*)(['"])([^'"]+)\1/g;
const EXTERNOS_OK = /^(next\/server|vitest|crypto|node:.+|path|fs|url|util|os)$/;

function resolver(espec, de) {
  let base;
  if (espec.startsWith("@/")) base = espec.slice(2);
  else if (espec.startsWith("@shared/")) base = "shared/" + espec.slice(8);
  else if (espec.startsWith("@modules/")) base = "modules/" + espec.slice(9);
  else if (espec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(de), espec));
  else return { externo: espec };
  for (const c of [base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx", base]) if (arquivos.has(c)) return { arquivo: c };
  return { faltando: espec };
}

const especificadores = fonte => [...fonte.matchAll(RE_IMPORT)].map(m => m[2]);

// Fecho a partir de uma lista de arquivos: tudo o que eles importam do repositório, sem distinguir import de tipo
// (os tipos também são precisos para o tsc).
function fecho(inicio) {
  const vistos = new Set();
  const externos = new Set();
  const faltando = new Set();
  const pilha = [...inicio];
  while (pilha.length) {
    const arq = pilha.pop();
    if (vistos.has(arq)) continue;
    vistos.add(arq);
    for (const e of especificadores(ler(arq))) {
      const r = resolver(e, arq);
      if (r.arquivo) pilha.push(r.arquivo);
      else if (r.externo) externos.add(r.externo);
      else faltando.add(`${e} (em ${arq})`);
    }
  }
  return { vistos, externos, faltando };
}

const codigo = fecho(ROTAS);
if (codigo.faltando.size) {
  console.error("imports sem arquivo no fecho do código:\n" + [...codigo.faltando].join("\n"));
  process.exit(1);
}

// Testes: entram os que só alcançam o código portado, os próprios helpers e módulos externos conhecidos.
const testes = [...arquivos].filter(a => /^__tests__\/.*\.test\.ts$/.test(a) && !a.startsWith("__tests__/e2e/"));
const deTeste = new Set();
const testesFora = [];
for (const t of testes) {
  const f = fecho([t]);
  const fora = [...f.vistos].filter(a => !a.startsWith("__tests__/") && !codigo.vistos.has(a));
  const extFora = [...f.externos].filter(e => !EXTERNOS_OK.test(e));
  if (fora.length || extFora.length || f.faltando.size) {
    testesFora.push(`${t}: ${[...fora, ...extFora, ...f.faltando].slice(0, 3).join(", ")}`);
    continue;
  }
  for (const a of f.vistos) if (a.startsWith("__tests__/")) deTeste.add(a);
}

// next/server → o adaptador do app (api/next-server.ts), relativo a cada arquivo.
function relativo(deArq, paraArq) {
  let r = path.posix.relative(path.posix.dirname(deArq), paraArq).replace(/\.tsx?$/, "");
  if (!r.startsWith(".")) r = "./" + r;
  return r;
}
// Import citado em comentário (linha que começa com // ou *) fica como está.
const emComentario = (s, pos) => /^\s*(?:\/\/|\/?\*)/.test(s.slice(s.lastIndexOf("\n", pos) + 1, pos));
function reescrever(arq, fonte) {
  const destino = "cxhub/" + arq;
  return fonte.replace(RE_IMPORT, (todo, aspas, espec, pos, s) => {
    if (emComentario(s, pos)) return todo;
    let novo = null;
    if (espec === "next/server") novo = relativo(destino, "api/next-server.ts");
    else if (/^@(?:shared|modules)?\//.test(espec)) novo = relativo(arq, resolver(espec, arq).arquivo);
    return novo ? todo.replace(`${aspas}${espec}${aspas}`, `${aspas}${novo}${aspas}`) : todo;
  });
}

const gravar = (rel, conteudo) => {
  const alvo = path.join(SAIDA, rel);
  mkdirSync(path.dirname(alvo), { recursive: true });
  writeFileSync(alvo, conteudo);
};

const listaCodigo = [...codigo.vistos].sort();
for (const a of listaCodigo) gravar("cxhub/" + a, reescrever(a, ler(a)));
const listaTestes = [...deTeste].sort();
for (const a of listaTestes) gravar("cxhub/" + a, ler(a));

gravar("cxhub/ORIGEM.md", [
  "# Origem desta pasta",
  "",
  `Cópia do backend do CX Hub (repositório \`rpaiagogroup/cx-hub\`), commit \`${commit}\`, feita por`,
  `\`ferramentas/portar-do-cxhub.mjs\`: o fecho de imports das ${ROTAS.length} rotas de app/api do CX Hub e os testes que só`,
  "dependem dele, com os mesmos caminhos relativos do CX Hub. O script só troca especificadores de import no código",
  "(aliases → caminho relativo; `next/server` → `api/next-server.ts`); as adaptações ao Worker vieram à mão, depois.",
  "Para ver só elas: rode o script com `--saida <pasta vazia>` e compare com `diff -r <pasta>/cxhub cxhub`.",
  "",
  `Código (${listaCodigo.length} arquivos) e testes (${listaTestes.length} arquivos). Testes que ficaram de fora (dependem de`,
  "código que não roda no servidor):",
  "",
  ...testesFora.sort().map(t => `- ${t}`),
  "",
].join("\n"));

console.log(`commit ${commit}`);
console.log(`código: ${listaCodigo.length} arquivos; externos: ${[...codigo.externos].sort().join(", ")}`);
console.log(`testes: ${listaTestes.length} arquivos (${listaTestes.filter(a => a.endsWith(".test.ts")).length} de teste); fora: ${testesFora.length}`);
for (const t of testesFora) console.log(`  fora: ${t}`);
