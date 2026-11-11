// App GoDeploy cx-hub: o backend do CX Hub, duas partes no mesmo Worker.
//   - /api/v1/*: a fila que acumula as solicitações do CX Hub e dispara a DAG do Airflow em lote (servidor/;
//     docs/fila-cxhub.md no repositório do CX Hub), com o cron do GoDeploy.
//   - o resto: as 23 rotas que o CX Hub tem na Vercel (cxhub/, portadas; api/ é a cola com o Worker). Elas entregam
//     casos e atualizações à fila sem rede (api/filaNoWorker.ts).
// Liga os segredos do app (env) às dependências reais e passa cada requisição para a parte dela.

// Primeiro import de propósito: o process.env que o código do CX Hub lê precisa existir antes de ele ser avaliado.
import { atualizarAmbiente } from "./api/ambiente";
import { transporteDaFilaNoWorker } from "./api/filaNoWorker";
import { type ContextoDoWorker, tratarNaApi } from "./api/roteador";
import { usarTransporteDaFila } from "./cxhub/shared/lib/fila/client";
import { tratar } from "./servidor/app";
import { banco, type BancoBruto } from "./servidor/banco";
import { lerConfig, type Segredos } from "./servidor/config";
import type { Busca, Dependencias } from "./servidor/contexto";
import { relogioDoSistema } from "./servidor/tempo";

interface Env extends Segredos {
  DB: BancoBruto;
}

// Cada problema de configuração da fila vai uma vez por isolate para o log (sem o valor dos segredos).
const avisados = new Set<string>();

// O fetch global chamado solto: no Workers, guardá-lo como método de outro objeto dá "Illegal invocation".
const busca: Busca = (entrada, init) => fetch(entrada, init);

function dependenciasDaFila(env: Env): Dependencias {
  const cfg = lerConfig(env);
  for (const p of cfg.problemas) {
    if (avisados.has(p)) continue;
    avisados.add(p);
    console.warn(`configuração: ${p}`);
  }
  return { db: banco(env.DB), cfg, relogio: relogioDoSistema, fetch: busca };
}

// As da última requisição: o env é o mesmo para todas as do isolate (um segredo trocado chega na próxima).
let depsAtuais: Dependencias | null = null;

usarTransporteDaFila(transporteDaFilaNoWorker(() => {
  if (!depsAtuais) throw new Error("a fila foi chamada antes de o worker receber uma requisição");
  return depsAtuais;
}));

const worker = {
  async fetch(request: Request, env: Env, ctx?: ContextoDoWorker): Promise<Response> {
    atualizarAmbiente(env as unknown as Record<string, unknown>);
    const deps = dependenciasDaFila(env);
    depsAtuais = deps;
    if (new URL(request.url).pathname.startsWith("/api/v1/")) return tratar(request, deps);
    return tratarNaApi(request, ctx);
  },
};

export default worker;
