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
// E /api/saude, a saúde de cada função para o Monitor da Black (api/saude/): o desfecho de cada uma é anotado onde
// ela termina, e gravado no env.DB no fim da requisição, em segundo plano.
// Liga os segredos do app (env) às dependências reais e passa cada requisição para a parte dela.

// Primeiro import de propósito: o process.env que o código do CX Hub lê precisa existir antes de ele ser avaliado.
import { atualizarAmbiente } from "./api/ambiente";
import { CAMINHO_DA_CACHE, leitorComCache, rotaDaCacheDaRotaDados } from "./api/cacheDaRotaDados";
import { ehCaminhoDosDocs, servirDocs } from "./api/docs";
import { transporteDaFilaNoWorker } from "./api/filaNoWorker";
import { type ContextoDoWorker, tratarNaApi } from "./api/roteador";
import { fetchSemMedidor, instalarMedidorDoFetch } from "./api/saude/medidor";
import { anotarPelaResposta } from "./api/saude/pontos";
import { desfechoDaCache, desfechoDaRodada, desfechoDoBackoffice } from "./api/saude/regras";
import { anotarSaude, gravarObservacoes, retirarPendentes } from "./api/saude/registro";
import { CAMINHO_DA_SAUDE, responderSaude } from "./api/saude/rota";
import { ehCaminhoDoBackoffice, tratar as tratarNoBackoffice } from "./backoffice/servidor/app";
import { banco as bancoDoBackoffice } from "./backoffice/servidor/banco";
import { rodadaDoBackoffice } from "./backoffice/servidor/conferencia";
import { lerConfig as lerConfigDoBackoffice, type Segredos as SegredosDoBackoffice } from "./backoffice/servidor/config";
import type { Dependencias as DependenciasDoBackoffice } from "./backoffice/servidor/contexto";
import { usarFonteDaRotaDados } from "./backoffice/servidor/rotaDados";
import { usarTransporteDaFila } from "./cxhub/shared/lib/fila/client";
import { buscarDadosDoFormulario, buscarDadosDoFormularioAoVivo, usarLeitorDaRotaDados } from "./cxhub/shared/lib/formDataApi";
import { tratar } from "./servidor/app";
import { type Banco, banco, type BancoBruto } from "./servidor/banco";
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
const CAMINHO_DA_RODADA = "/api/v1/interno/lote";

// ─── Saúde: a gravação do que cada requisição anotou (api/saude/registro.ts) ─────────────────────────────────────

/** Grava em segundo plano o que foi anotado até aqui. Nunca lança nem atrasa a resposta. */
function descarregarSaude(db: Banco | null, ctx?: ContextoDoWorker): void {
  try {
    const obs = retirarPendentes();
    if (!obs.length || !db) return;
    const gravacao = gravarObservacoes(db, obs);
    ctx?.waitUntil(gravacao);
  } catch {
    // O registro nunca derruba a resposta.
  }
}

/**
 * O ctx que as rotas recebem: cada tarefa do after() grava, ao terminar, o que anotou. Sem isso, o que ela anotasse
 * depois da resposta (a planilha gravada em segundo plano, por exemplo) só iria ao banco na requisição seguinte.
 */
function ctxQueGravaASaude(db: Banco | null, ctx?: ContextoDoWorker): ContextoDoWorker | undefined {
  if (!ctx || !db) return ctx;
  return { waitUntil: p => ctx.waitUntil(Promise.resolve(p).finally(() => descarregarSaude(db, ctx))) };
}

async function atender(request: Request, env: Env, deps: Dependencias, ctx: ContextoDoWorker | undefined, db: Banco | null): Promise<Response> {
  const bruto = new URL(request.url).pathname;
  const caminho = bruto.replace(/\/+$/, "");
  if (caminho === CAMINHO_DA_SAUDE) {
    return responderSaude(request, {
      db, agora: Date.now(), airflow: deps.cfg.airflow, metabase: lerConfigDoBackoffice(env).metabase,
      busca: fetchSemMedidor(), depois: p => ctx?.waitUntil(p),
    });
  }
  if (bruto.startsWith("/api/v1/")) {
    const resposta = await tratar(request, deps);
    // A rodada do lote pelo resumo dela: "OK", ou as etapas que falharam. A rodada que não rodou não conta.
    if (caminho === CAMINHO_DA_RODADA && request.method === "POST") await anotarPelaResposta("fila_rodada", resposta, desfechoDaRodada);
    return resposta;
  }
  if (ehCaminhoDoBackoffice(caminho)) {
    const resposta = await tratarNoBackoffice(request, dependenciasDoBackoffice(env));
    // Salvar (POST) e desfazer (DELETE) uma edição; as leituras da tela já passam pelas dependências medidas.
    if (request.method === "POST" || request.method === "DELETE") {
      const d = desfechoDoBackoffice(resposta.status);
      anotarSaude("backoffice", d.resultado, { erro: d.erro });
    }
    return resposta;
  }
  if (caminho === CAMINHO_DA_CACHE) {
    const resposta = await rotaDaCacheDaRotaDados(request, deps, origem => buscarDadosDoFormularioAoVivo(origem, TEMPO_DA_ROTA_DADOS_NO_CRON_MS));
    if (request.method === "POST") await anotarPelaResposta("cache_rota_dados", resposta, desfechoDaCache);
    return resposta;
  }
  return tratarNaApi(request, ctx);
}

const worker = {
  async fetch(request: Request, env: Env, ctx?: ContextoDoWorker): Promise<Response> {
    const caminho = new URL(request.url).pathname;
    if (ehCaminhoDosDocs(caminho)) return servirDocs(request);
    // A cada requisição: quem trocou o fetch global recebe o medidor de novo; o já medido não é medido duas vezes.
    instalarMedidorDoFetch();
    atualizarAmbiente(env as unknown as Record<string, unknown>);
    const deps = dependenciasDaFila(env);
    depsAtuais = deps;
    const db = env.DB ? deps.db : null;
    try {
      return await atender(request, env, deps, ctxQueGravaASaude(db, ctx), db);
    } finally {
      descarregarSaude(db, ctx);
    }
  },
};

export default worker;
