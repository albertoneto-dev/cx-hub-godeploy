// App GoDeploy cx-hub: a fila que acumula as solicitações do CX Hub e dispara a DAG do Airflow em lote
// (docs/fila-cxhub.md no repositório do CX Hub). Entrada do Worker: liga os segredos do app (env) às dependências
// reais e passa cada requisição para servidor/app.ts.

import { tratar } from "./servidor/app";
import { banco, type BancoBruto } from "./servidor/banco";
import { lerConfig, type Segredos } from "./servidor/config";
import type { Busca } from "./servidor/contexto";
import { relogioDoSistema } from "./servidor/tempo";

interface Env extends Segredos {
  DB: BancoBruto;
}

// Cada problema de configuração vai uma vez por isolate para o log (sem o valor dos segredos).
const avisados = new Set<string>();

// O fetch global chamado solto: no Workers, guardá-lo como método de outro objeto dá "Illegal invocation".
const busca: Busca = (entrada, init) => fetch(entrada, init);

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cfg = lerConfig(env);
    for (const p of cfg.problemas) {
      if (avisados.has(p)) continue;
      avisados.add(p);
      console.warn(`configuração: ${p}`);
    }
    return tratar(request, { db: banco(env.DB), cfg, relogio: relogioDoSistema, fetch: busca });
  },
};

export default worker;
