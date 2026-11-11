// A fila mora neste mesmo Worker. O cliente da fila portado do CX Hub (cxhub/shared/lib/fila/client.ts) fala HTTP
// com ela; este transporte entrega a requisição feita para a origem interna ao roteador da fila (servidor/app.ts),
// sem rede nem gateway, com o mesmo contrato da chamada de fora: x-cxhub-fila-token, validação, idempotência e códigos
// de resposta. Qualquer outra URL (uma fila de fora, se CXHUB_FILA_URL for cadastrado) vai ao fetch de sempre.

import type { TransporteDaFila } from "../cxhub/shared/lib/fila/client";
import { tratar } from "../servidor/app";
import type { Dependencias } from "../servidor/contexto";
import { ORIGEM_DA_FILA_NO_WORKER } from "./ambiente";

export function transporteDaFilaNoWorker(depsDaFila: () => Dependencias): TransporteDaFila {
  return async (url, init) => {
    if (!url.startsWith(`${ORIGEM_DA_FILA_NO_WORKER}/`)) return fetch(url, init);
    return tratar(new Request(url, init), depsDaFila());
  };
}
