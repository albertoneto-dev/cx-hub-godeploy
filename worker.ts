// App GoDeploy cx-hub: o backend do CX Hub, quatro partes no mesmo Worker.
//   - /api/v1/*: a fila que acumula as solicitações do CX Hub e dispara a DAG do Airflow em lote (servidor/;
//     docs/fila-cxhub.md no repositório do CX Hub), com o cron do GoDeploy.
//   - /api/backoffice/*: o backoffice de reenvio e reembolso (backoffice/, portado do app backoffice-hub): a lista da
//     gold + raw (+ os casos ainda na fila) por cursor e as edições com as regras de lá. A edição é uma atualização da
//     fila acima e sobe no lote dela; a rodada do cron da fila confere as edições gravadas (posRodada).
//   - /api/interno/rota-dados: a rodada do cron que renova a cache da rota dados no env.DB (api/cacheDaRotaDados.ts).
//   - o resto: as 24 rotas do CX Hub (cxhub/, portadas; api/ é a cola com o Worker). Elas entregam
//     casos e atualizações à fila sem rede (api/filaNoWorker.ts) e leem a rota dados pela cache.
// E /docs, a página do que muda para quem chamava a Vercel (api/docs.ts), que não depende de segredo nenhum.
// Liga os segredos do app (env) às dependências reais e passa cada requisição para a parte dela.

// Primeiro import de propósito: o process.env que o código do CX Hub lê precisa existir antes de ele ser avaliado.
import { atualizarAmbiente } from "./api/ambiente";
import { CAMINHO_DA_CACHE, leitorComCache, rotaDaCacheDaRotaDados } from "./api/cacheDaRotaDados";
import { ehCaminhoDosDocs, servirDocs } from "./api/docs";
import { transporteDaFilaNoWorker } from "./api/filaNoWorker";
import { type ContextoDoWorker, tratarNaApi } from "./api/roteador";
import { ehCaminhoDoBackoffice, tratar as tratarNoBackoffice } from "./backoffice/servidor/app";
import { banco as bancoDoBackoffice } from "./backoffice/servidor/banco";
import { rodadaDoBackoffice } from "./backoffice/servidor/conferencia";
import { lerConfig as lerConfigDoBackoffice, type Segredos as SegredosDoBackoffice } from "./backoffice/servidor/config";
import type { Dependencias as DependenciasDoBackoffice } from "./backoffice/servidor/contexto";
import { usarFonteDaRotaDados } from "./backoffice/servidor/rotaDados";
import { usarTransporteDaFila } from "./cxhub/shared/lib/fila/client";
import { buscarDadosDoFormulario, buscarDadosDoFormularioAoVivo, usarLeitorDaRotaDados } from "./cxhub/shared/lib/formDataApi";
import { tratar } from "./servidor/app";
import { banco, type BancoBruto } from "./servidor/banco";
import { lerConfig, type Segredos } from "./servidor/config";
import type { Busca, Dependencias } from "./servidor/contexto";
import { relogioDoSistema } from "./servidor/tempo";

interface Env extends Segredos, SegredosDoBackoffice {
  DB: BancoBruto;
}

// Cada problema de configuração vai uma vez por isolate para o log (sem o valor dos segredos).
const avisados = new Set<string>();
const avisar = (problemas: string[], parte: string) => {
  for (const p of problemas) {
    if (avisados.has(`${parte}|${p}`)) continue;
    avisados.add(`${parte}|${p}`);
    console.warn(`configuração${parte}: ${p}`);
  }
};

// O fetch global chamado solto: no Workers, guardá-lo como método de outro objeto dá "Illegal invocation".
const busca: Busca = (entrada, init) => fetch(entrada, init);

function dependenciasDoBackoffice(env: Env): DependenciasDoBackoffice {
  const cfg = lerConfigDoBackoffice(env);
  avisar(cfg.problemas, " do backoffice");
  return { db: bancoDoBackoffice(env.DB), cfg, relogio: relogioDoSistema, fetch: busca };
}

function dependenciasDaFila(env: Env): Dependencias {
  const cfg = lerConfig(env);
  avisar(cfg.problemas, "");
  return {
    db: banco(env.DB), cfg, relogio: relogioDoSistema, fetch: busca,
    // Fila única: as edições do backoffice sobem no lote da fila, e a rodada do cron confere as gravadas.
    posRodada: (_c, prazo) => rodadaDoBackoffice(dependenciasDoBackoffice(env), prazo),
  };
}

// As da última requisição: o env é o mesmo para todas as do isolate (um segredo trocado chega na próxima).
let depsAtuais: Dependencias | null = null;
const depsDoIsolate = () => {
  if (!depsAtuais) throw new Error("o worker ainda não recebeu uma requisição");
  return depsAtuais;
};

usarTransporteDaFila(transporteDaFilaNoWorker(depsDoIsolate));
// A rota dados pela cache do env.DB: o /api/resend/data, as marcas do bot e os motivos do backoffice.
usarLeitorDaRotaDados(leitorComCache(() => depsDoIsolate().db, () => relogioDoSistema.agora()));
usarFonteDaRotaDados(origem => buscarDadosDoFormulario(origem, 8_000));

const TEMPO_DA_ROTA_DADOS_NO_CRON_MS = 10_000;

const worker = {
  async fetch(request: Request, env: Env, ctx?: ContextoDoWorker): Promise<Response> {
    const caminho = new URL(request.url).pathname;
    if (ehCaminhoDosDocs(caminho)) return servirDocs(request);
    atualizarAmbiente(env as unknown as Record<string, unknown>);
    const deps = dependenciasDaFila(env);
    depsAtuais = deps;
    if (caminho.startsWith("/api/v1/")) return tratar(request, deps);
    if (ehCaminhoDoBackoffice(caminho.replace(/\/+$/, ""))) return tratarNoBackoffice(request, dependenciasDoBackoffice(env));
    if (caminho.replace(/\/+$/, "") === CAMINHO_DA_CACHE) {
      return rotaDaCacheDaRotaDados(request, deps, origem => buscarDadosDoFormularioAoVivo(origem, TEMPO_DA_ROTA_DADOS_NO_CRON_MS));
    }
    return tratarNaApi(request, ctx);
  },
};

export default worker;
