// Os pontos de registro da saúde nas rotas (17/11/2026, ver api/saude/regras.ts): o worker.ts e o api/roteador.ts
// chamam daqui quando a função termina. O desfecho sai do corpo que ela devolve (o `code` dos envios, a lista de
// pedidos da busca, o resumo da rodada do lote), lido de uma cópia: a resposta segue intacta para quem chamou, e nada
// daqui lança.

import { anotarSaude } from "./registro";
import { COMPONENTE_DO_ENVIO, type Desfecho, desfechoDaBusca, desfechoDoEnvio, ROTAS_DE_BUSCA } from "./regras";

async function corpoDe(resposta: Response): Promise<unknown> {
  if (!resposta.body) return null;
  try {
    return await resposta.clone().json();
  } catch {
    return null;
  }
}

/** Anota o desfecho que a resposta traz. `desfecho` null: a chamada não diz nada da função (não anota). */
export async function anotarPelaResposta(
  componente: string,
  resposta: Response,
  desfecho: (status: number, corpo: unknown) => Desfecho | null,
): Promise<void> {
  try {
    const d = desfecho(resposta.status, await corpoDe(resposta));
    if (d) anotarSaude(componente, d.resultado, { erro: d.erro, extra: d.extra });
  } catch {
    // O registro nunca muda o desfecho da chamada.
  }
}

export type MedidaDaRota = { componente: string; tipo: "envio" | "busca"; rota: string };

/** As rotas do CX Hub que a saúde mede: os envios e as buscas de pedido. null: a rota não é medida. */
export function medidaDaRota(caminho: string, metodo: string): MedidaDaRota | null {
  const rota = caminho.replace(/^\/api\//, "");
  if (metodo === "POST" && COMPONENTE_DO_ENVIO[rota]) return { componente: COMPONENTE_DO_ENVIO[rota], tipo: "envio", rota };
  if (metodo === "GET" && ROTAS_DE_BUSCA.some(p => p.test(rota))) return { componente: "consulta_pedido", tipo: "busca", rota };
  return null;
}

/** O ensaio (testMode: true no corpo) não grava, então não prova nada da gravação: não conta. Lê uma cópia do corpo. */
export async function ehEnsaio(req: Request): Promise<boolean> {
  try {
    const corpo = (await req.clone().json()) as { testMode?: unknown } | null;
    return corpo?.testMode === true;
  } catch {
    return false;
  }
}

/** Anota o desfecho de uma rota medida do CX Hub. */
export async function anotarRotaDoHub(medida: MedidaDaRota, resposta: Response): Promise<void> {
  const em = new Date().toISOString();
  await anotarPelaResposta(medida.componente, resposta, (status, corpo) =>
    medida.tipo === "envio" ? desfechoDoEnvio(medida.rota, status, corpo, em) : desfechoDaBusca(medida.rota, status, corpo));
}
