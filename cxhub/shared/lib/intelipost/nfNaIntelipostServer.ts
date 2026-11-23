import type { Leitura } from '../datamart/pedidoTipos';
import { NF_FORA_DO_DATA_MART_MIN_PRAZO_MS, NF_FORA_DO_DATA_MART_TIMEOUT_MS } from '../nfDaVenda';
import { acessoAoGateway } from '../shopify/gateway';
import {
    caminhoDoEnvio,
    caminhoPeloPedido,
    CONTA_INTELIPOST_NO_GATEWAY,
    lerRespostaDaIntelipost,
    nfDoEnvio,
    pedidoNaIntelipost,
    segmentosDaMarcaNoGateway,
    type MarcaComIntelipost,
    type RespostaDaIntelipost,
} from './gateway';

/**
 * A NF de venda na Intelipost ao vivo, pelo gateway (2026-11-19): cobre a hora entre a NF sair e o envio chegar ao Data
 * Mart. As regras puras estão em `gateway.ts`.
 *
 * ⚠️ **Server-only** (lê a `INTELIPOST_GATEWAY_URL` e a `INTELIPOST_GATEWAY_KEY`, desde 2026-11-23): importe pelo
 * caminho completo. O envio tem nome e endereço da cliente: o corpo nunca vai ao log.
 */

const LOG = '[NF na Intelipost ao vivo]';

/** Uma consulta ao gateway, com o que sobra do prazo (até 4 s). Nunca lança. */
async function consultar(
    url: string,
    chave: string,
    prazo: number,
    agora: () => number,
): Promise<RespostaDaIntelipost> {
    const timeoutMs = Math.min(NF_FORA_DO_DATA_MART_TIMEOUT_MS, prazo - agora());
    if (timeoutMs < NF_FORA_DO_DATA_MART_MIN_PRAZO_MS) return { erro: 'prazo esgotado antes da consulta' };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${chave}`, Accept: 'application/json' },
            signal: controller.signal,
        });
        return lerRespostaDaIntelipost(res.status, await res.json().catch(() => null));
    } catch (erro) {
        return { erro: erro instanceof Error && erro.name === 'AbortError' ? `sem resposta em ${timeoutMs} ms` : 'falha de rede' };
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * A NF do pedido na Intelipost ao vivo: procura pelo `SH…` da marca (`sales_order_number`), e, se o envio enxuto vier
 * sem a NF, lê o envio completo pelo `order_number`. A NF vai sem os zeros à esquerda.
 *
 * Nunca lança. `{ ok: true, dados: null }` só quando a Intelipost respondeu: não há envio do pedido, ou o envio ainda
 * não tem NF. Sem a chave, sem prazo, com a chave recusada, o limite de taxa, o gateway fora ou sem resposta a tempo,
 * volta `{ ok: false }` com o motivo, e a conferência não conclui que o pedido não tem NF.
 */
export async function nfNaIntelipostAoVivo(
    marca: MarcaComIntelipost,
    numeroPedido: string,
    prazo: number,
    agora: () => number = Date.now,
): Promise<Leitura<string | null>> {
    const falhou = (motivo: string): Leitura<string | null> => {
        console.warn(`${LOG} ${marca}: o pedido ${numeroPedido} ficou sem resposta (${motivo})`);
        return { ok: false, motivo };
    };
    const acesso = acessoAoGateway('intelipost');
    if (!acesso.ok) return falhou(acesso.motivo);
    const { chave } = acesso;
    const pedido = pedidoNaIntelipost(marca, numeroPedido);
    if (!CONTA_INTELIPOST_NO_GATEWAY[marca] || !pedido) return falhou('sem a conta da marca ou o número do pedido');

    // A marca no caminho (o contrato do GoAccess); a conta antiga só se o gateway disser que não conhece a rota da marca.
    // O envio completo, se for preciso, vai pelo mesmo caminho que respondeu.
    const segmentos = segmentosDaMarcaNoGateway(marca);
    let base = '';
    let enxuto: RespostaDaIntelipost = { erro: 'nenhuma rota tentada' };
    for (const [i, segmento] of segmentos.entries()) {
        base = `${acesso.base}/${segmento}`;
        enxuto = await consultar(`${base}/${caminhoPeloPedido(pedido)}`, chave, prazo, agora);
        if ('erro' in enxuto && enxuto.rotaDesconhecida) continue;
        if (i > 0) console.warn(`${LOG} ${marca}: o gateway não conhece /${segmentos[0]}; respondeu por /${segmento}`);
        break;
    }
    if ('erro' in enxuto) return falhou(enxuto.erro);
    if ('naoAchou' in enxuto) return { ok: true, dados: null };
    const nf = nfDoEnvio(enxuto.envio);
    if (nf || !enxuto.envio.order_number) return { ok: true, dados: nf };

    const completo = await consultar(`${base}/${caminhoDoEnvio(String(enxuto.envio.order_number))}`, chave, prazo, agora);
    if ('erro' in completo) return falhou(completo.erro);
    return { ok: true, dados: 'envio' in completo ? nfDoEnvio(completo.envio) : null };
}
