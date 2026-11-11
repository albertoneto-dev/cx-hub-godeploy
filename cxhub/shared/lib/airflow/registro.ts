import { BRAND_TO_ORG_ID } from '../constants';
import { conferirTokenNoCosmos } from '../cosmos/http';
import { casoNaFila, filaConfigurada } from '../fila/client';
import { consultarDataMart, literalSql, metabaseConfigurado, MetabaseError } from '../metabase/index';
import type { EstadoDoRegistro, RegistroResponse } from '../registro/types';
import { TABELA_RAW } from './raw';

/**
 * O lado do servidor do acompanhamento da lista (ADR-011 e ADR-012): a solicitação vai à fila do Metabase, o lote a
 * leva à raw em até 20 min, e a tag "Gravado no Metabase" pergunta aqui, de 10 em 10 min, se a raw já tem o caso.
 *
 * ⚠️ Server-only.
 */

const LOG = '[Registro]';

/** Um `id_solicitacao` como o CX Hub os gera (UUID; no bot, o `requestId`). Vai para o SQL: nada fora disso passa. */
export const ID_DE_CASO = /^[A-Za-z0-9-]{1,64}$/;
/** Quantos ids uma pergunta aceita (o mesmo `MAX_IDS_POR_CONSULTA` do navegador). */
export const MAX_IDS_DO_REGISTRO = 20;

/** Os casos (a criação) que a raw já tem, entre esses ids. */
export function sqlDosCasosNaRaw(ids: string[]): string {
    return `select distinct e.id_solicitacao from ${TABELA_RAW} e where e.tipo_evento = 'caso' `
        + `and e.id_solicitacao in (${ids.map(literalSql).join(', ')})`;
}

export interface EstadosDeps {
    consultar: typeof consultarDataMart;
    casoNaFila: typeof casoNaFila;
    filaConfigurada: typeof filaConfigurada;
}

const PADRAO: EstadosDeps = { consultar: consultarDataMart, casoNaFila, filaConfigurada };

/**
 * Onde está cada caso: `gravado` quando a raw o tem; fora dela, `recusado` quando a fila diz que a DAG o recusou, e
 * `aguardando` no resto (na fila, no lote em andamento ou na réplica atrasada). A fila que não responde não muda nada:
 * o caso segue aguardando e a próxima rodada pergunta de novo. Erro do Metabase sobe.
 */
export async function estadosNoRegistro(ids: string[], deps: EstadosDeps = PADRAO): Promise<Record<string, EstadoDoRegistro>> {
    const naRaw = new Set((await deps.consultar(sqlDosCasosNaRaw(ids))).map((linha) => String(linha[0])));
    const fora = ids.filter((id) => !naRaw.has(id));
    const recusados = new Set<string>();
    if (fora.length > 0 && deps.filaConfigurada()) {
        await Promise.all(fora.map(async (id) => {
            try {
                if ((await deps.casoNaFila(id))?.situacao === 'recusado') recusados.add(id);
            } catch (erro) {
                console.warn(`${LOG} ${id}: a fila não respondeu (${erro instanceof Error ? erro.message : String(erro)})`);
            }
        }));
    }
    return Object.fromEntries(ids.map((id): [string, EstadoDoRegistro] => [
        id,
        naRaw.has(id) ? 'gravado' : recusados.has(id) ? 'recusado' : 'aguardando',
    ]));
}

export interface PedidoDeRegistro {
    /** O header `Authorization` como veio (o token do login do CX Hub). */
    authorization: string | null;
    /** Os ids dos casos, separados por vírgula, da query. */
    ids: unknown;
}

function resposta(status: number, body: RegistroResponse): { status: number; body: RegistroResponse } {
    return { status, body };
}

/** Os ids da query, sem repetir; `null` quando algum não é id de caso, ou quando são nenhum ou demais. */
function lerIds(ids: unknown): string[] | null {
    if (typeof ids !== 'string') return null;
    const lista = [...new Set(ids.split(',').map((id) => id.trim()).filter(Boolean))];
    if (lista.length === 0 || lista.length > MAX_IDS_DO_REGISTRO || !lista.every((id) => ID_DE_CASO.test(id))) return null;
    return lista;
}

/**
 * O que `GET /api/registro` faz, para a rota continuar fina: confere os ids e o token do login (no Cosmos, como a
 * lista de solicitações) e diz onde está cada caso. Nunca lança.
 */
export async function responderRegistro(
    pedido: PedidoDeRegistro,
    deps: EstadosDeps = PADRAO,
): Promise<{ status: number; body: RegistroResponse }> {
    if (!pedido.authorization) return resposta(401, { code: 'UNAUTHORIZED', message: 'Header Authorization ausente.' });

    const ids = lerIds(pedido.ids);
    if (!ids) {
        return resposta(400, {
            code: 'INVALID_REQUEST',
            message: `ids deve ter de 1 a ${MAX_IDS_DO_REGISTRO} ids de solicitação, separados por vírgula.`,
        });
    }

    // Confere na org da Lescent: o token do CX Hub é o do usuário de serviço, com todas as marcas.
    switch (await conferirTokenNoCosmos(BRAND_TO_ORG_ID.lescent, pedido.authorization)) {
        case 'ok':
            break;
        case 'recusado':
            return resposta(401, { code: 'UNAUTHORIZED', message: 'Token do Cosmos inválido ou expirado.' });
        case 'sem_acesso':
            return resposta(403, { code: 'FORBIDDEN', message: 'O token não tem acesso a esta marca no Cosmos.' });
        case 'timeout':
            return resposta(504, { code: 'API_TIMEOUT', message: 'O Cosmos demorou para conferir o token.' });
        default:
            return resposta(502, { code: 'UNKNOWN_ERROR', message: 'Não foi possível conferir o token no Cosmos.' });
    }

    if (!metabaseConfigurado()) {
        return resposta(503, { code: 'UNAVAILABLE', message: 'O Metabase não está configurado neste ambiente (METABASE_*).' });
    }

    try {
        return resposta(200, { code: 'SUCCESS', message: '', estados: await estadosNoRegistro(ids, deps) });
    } catch (erro) {
        if (erro instanceof MetabaseError && erro.status === 0) {
            console.warn(`${LOG} o Metabase não respondeu a tempo`);
            return resposta(504, { code: 'API_TIMEOUT', message: 'O Metabase não respondeu.' });
        }
        console.error(`${LOG} falha ao ler a raw:`, erro);
        return resposta(502, { code: 'UNKNOWN_ERROR', message: 'Não foi possível ler o registro no Metabase.' });
    }
}
