import { problemaNaAtualizacao, problemaNoCaso } from '../airflow/contrato';
import type { AtualizacaoCxhub, CasoCxhub, TipoCasoCxhub } from '../airflow/types';
import { valorEmReais } from '../airflow/listarCasos';
import type { AtualizacaoNaFila, CasoAbertoNaFila, CasoNaFila, ResultadoFila, SituacaoNaFila } from './types';

/**
 * Cliente da fila do app GoDeploy `cx-hub` ([ADR-012](docs/decisions/ADR-012-gravacao-em-lote-pela-fila.md), contrato
 * em `docs/fila-cxhub.md`). O CX Hub não dispara mais a DAG: entrega cada caso e cada atualização à fila, e o cron
 * do app leva tudo à DAG num lote a cada 20 min.
 *
 * Servidor a servidor, com duas credenciais, como o `formDataApi.ts`: o `x-cxhub-fila-token` é do app, e a chave
 * `gdk_` vai no `Authorization` porque é o gateway do GoDeploy que a confere (sem ela, o app local, sem gateway).
 *
 * As duas escritas são idempotentes no app (por `id_solicitacao` e por `id_atualizacao`), então repetir uma escrita
 * sem resposta clara é seguro: é o que a retentativa faz.
 *
 * ⚠️ Server-only: lê os segredos.
 */

const LOG = '[Fila]';

/** Por tentativa. A fila só grava uma linha no env.DB: mais que isso é o app fora do ar. */
export const FILA_TIMEOUT_MS = 8_000;
/** Menos que isso até o prazo não vale começar uma tentativa. */
const MINIMO_POR_TENTATIVA_MS = 1_000;
const TENTATIVAS = 2;
/** O que uma escrita na fila pode levar, com a retentativa: o que as rotas reservam no `maxDuration`. */
export const JANELA_FILA_MS = TENTATIVAS * FILA_TIMEOUT_MS;

/** Instante-limite de uma escrita na fila, contando de agora. */
export function prazoDaFila(): number {
    return Date.now() + JANELA_FILA_MS;
}

const SITUACOES: readonly SituacaoNaFila[] = ['pendente', 'enviado', 'gravado', 'recusado'];
const TIPOS: readonly TipoCasoCxhub[] = ['REENVIO', 'REEMBOLSO', 'CANCELAMENTO'];

/** Falha de uma chamada à fila. `status` 0 = rede ou timeout. */
export class FilaError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'FilaError';
    }

    /** Rede, timeout ou 5xx: a escrita pode ter chegado, e repetir é seguro. */
    get transitorio(): boolean {
        return this.status === 0 || this.status >= 500;
    }
}

export function filaConfigurada(): boolean {
    return Boolean(process.env.CXHUB_FILA_URL?.trim() && process.env.CXHUB_FILA_TOKEN?.trim());
}

/**
 * Por onde a chamada sai. No app GoDeploy `cx-hub` a fila mora no mesmo Worker, e o `api/filaNoWorker.ts` troca o
 * transporte para entregar a requisição ao roteador dela sem rede; nos testes, é o `fetch` global.
 */
export type TransporteDaFila = (url: string, init: RequestInit) => Promise<Response>;
let transporte: TransporteDaFila = (url, init) => fetch(url, init);

export function usarTransporteDaFila(t: TransporteDaFila): void {
    transporte = t;
}

async function chamar(metodo: 'GET' | 'POST', caminho: string, corpo: unknown, timeoutMs: number): Promise<unknown> {
    const base = (process.env.CXHUB_FILA_URL ?? '').trim().replace(/\/+$/, '');
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'x-cxhub-fila-token': (process.env.CXHUB_FILA_TOKEN ?? '').trim(),
    };
    const chave = process.env.CXHUB_FILA_GODEPLOY_KEY?.trim();
    if (chave) headers.Authorization = `Bearer ${chave}`;
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
        // `manual`: sem a chave certa o gateway responde 302 para a tela de login, que não pode virar "sucesso".
        res = await transporte(`${base}${caminho}`, {
            method: metodo,
            headers,
            body: corpo === undefined ? undefined : JSON.stringify(corpo),
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (erro) {
        const timeout = erro instanceof Error && (erro.name === 'TimeoutError' || erro.name === 'AbortError');
        throw new FilaError(timeout ? `a fila não respondeu em ${timeoutMs}ms` : 'a fila está inalcançável', 0);
    }

    const json: unknown = await res.json().catch(() => null);
    const code = typeof (json as { code?: unknown } | null)?.code === 'string' ? ` ${(json as { code: string }).code}` : '';
    if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
        throw new FilaError(
            `a fila recusou a credencial (HTTP ${res.status}${code}): confira CXHUB_FILA_GODEPLOY_KEY e CXHUB_FILA_TOKEN`,
            res.status,
        );
    }
    if (!res.ok) throw new FilaError(`a fila respondeu HTTP ${res.status}${code}`, res.status);
    return json;
}

/** Leitura com uma retentativa no transitório (ler duas vezes não muda nada). Erro sobe como `FilaError`. */
async function ler(caminho: string): Promise<unknown> {
    if (!filaConfigurada()) throw new FilaError('a fila não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)', 0);
    try {
        return await chamar('GET', caminho, undefined, FILA_TIMEOUT_MS);
    } catch (erro) {
        if (!(erro instanceof FilaError) || !erro.transitorio) throw erro;
        console.warn(`${LOG} GET ${caminho.split('?')[0]}: ${erro.message} — tentando de novo`);
        return chamar('GET', caminho, undefined, FILA_TIMEOUT_MS);
    }
}

/** Escrita idempotente: repete o transitório até `TENTATIVAS` vezes dentro do `prazo`. Nunca lança. */
async function escrever(caminho: string, corpo: unknown, prazo: number): Promise<ResultadoFila> {
    if (!filaConfigurada()) return { status: 'recusado', motivo: 'a fila não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)' };
    let ultimo: FilaError | null = null;
    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
        const restante = prazo - Date.now();
        if (restante < MINIMO_POR_TENTATIVA_MS) break;
        try {
            await chamar('POST', caminho, corpo, Math.min(FILA_TIMEOUT_MS, restante));
            return { status: 'enfileirado' };
        } catch (erro) {
            const falha = erro instanceof FilaError ? erro : new FilaError(String(erro), 0);
            if (!falha.transitorio) return { status: 'recusado', motivo: falha.message };
            console.warn(`${LOG} POST ${caminho}: tentativa ${tentativa} sem resposta clara (${falha.message})`);
            ultimo = falha;
        }
    }
    // Sem nenhuma tentativa, nada saiu: recusa certa. Com alguma, pode ter chegado.
    return ultimo
        ? { status: 'incerto', motivo: ultimo.message }
        : { status: 'recusado', motivo: 'sem tempo para entregar à fila' };
}

/** O que não foi guardado vai para o log inteiro: é dele que sai a reposição à mão. Sem dado pessoal (ADR-008). */
function logarSeNaoEnfileirou(o: string, corpo: unknown, resultado: ResultadoFila): void {
    if (resultado.status !== 'enfileirado') {
        console.error(`${LOG} ${o}: ${resultado.status} — ${resultado.motivo} | ${JSON.stringify(corpo)}`);
    }
}

/**
 * Entrega à fila os casos de uma solicitação (o reembolso do Bot manda dois: o reembolso e o cancelamento). Confere
 * o contrato da DAG antes: um caso fora dele seria recusado no lote, 20 min depois, sem ninguém na tela. Nunca lança.
 */
export async function enfileirarCasos(casos: CasoCxhub[], prazo: number): Promise<ResultadoFila> {
    if (casos.length === 0) return { status: 'recusado', motivo: 'nenhum caso para enfileirar' };
    const corpo = { casos };
    const problema = casos.map((caso) => problemaNoCaso(caso)).find((p) => p !== null);
    const resultado: ResultadoFila = problema
        ? { status: 'recusado', motivo: `fora do contrato da DAG: ${problema}` }
        : await escrever('/api/v1/casos', corpo, prazo);
    logarSeNaoEnfileirou(`casos ${casos.map((c) => c.id_solicitacao).join(', ')}`, corpo, resultado);
    return resultado;
}

/**
 * Entrega à fila uma alteração de um caso (cancelar, editar, concluir, sincronizar), com id e instante próprios: no
 * lote, todas as alterações dividem o mesmo run, e é o `atualizado_em` que as ordena. Nunca lança.
 */
export async function enfileirarAtualizacao(
    idSolicitacao: string,
    campos: AtualizacaoCxhub,
    prazo: number,
    agora: Date = new Date(),
): Promise<ResultadoFila> {
    const corpo = {
        atualizacoes: [{ id_atualizacao: crypto.randomUUID(), id_solicitacao: idSolicitacao, atualizado_em: agora.toISOString(), campos }],
    };
    const problema = problemaNaAtualizacao(idSolicitacao, campos);
    const resultado: ResultadoFila = problema
        ? { status: 'recusado', motivo: `fora do contrato da DAG: ${problema}` }
        : await escrever('/api/v1/atualizacoes', corpo, prazo);
    logarSeNaoEnfileirou(`atualização de ${idSolicitacao}`, corpo, resultado);
    return resultado;
}

const texto = (valor: unknown): string => (typeof valor === 'string' ? valor.trim() : '');

function situacao(valor: unknown): SituacaoNaFila {
    const s = texto(valor) as SituacaoNaFila;
    if (!SITUACOES.includes(s)) throw new FilaError(`situação desconhecida na resposta da fila: ${String(valor)}`, 502);
    return s;
}

function casoDaResposta(bruto: unknown): CasoNaFila {
    const c = (bruto ?? {}) as Record<string, unknown>;
    const tipo = texto(c.tipo).toUpperCase() as TipoCasoCxhub;
    if (!texto(c.id_solicitacao) || !TIPOS.includes(tipo)) throw new FilaError('caso fora do contrato na resposta da fila', 502);
    return {
        idSolicitacao: texto(c.id_solicitacao),
        tipo,
        marca: texto(c.marca).toLowerCase(),
        numeroPedido: texto(c.numero_pedido),
        criadoEm: texto(c.criado_em),
        responsavel: texto(c.responsavel) || null,
        situacao: situacao(c.situacao),
    };
}

function lista(json: unknown, campo: string): unknown[] {
    const valor = (json as Record<string, unknown> | null)?.[campo];
    if (!Array.isArray(valor)) throw new FilaError(`resposta da fila sem a lista "${campo}"`, 502);
    return valor;
}

/** Os casos de um tipo, marca e pedido (só os dígitos) que a fila guarda, o mais novo primeiro. Erro sobe. */
export async function casosDoPedidoNaFila(tipo: TipoCasoCxhub, marca: string, pedido: string): Promise<CasoNaFila[]> {
    const digitos = pedido.replace(/\D/g, '');
    if (!digitos) return [];
    const query = new URLSearchParams({ tipo, marca, pedido: digitos });
    const casos = lista(await ler(`/api/v1/casos?${query}`), 'casos').map(casoDaResposta);
    return casos.sort((a, b) => Date.parse(b.criadoEm) - Date.parse(a.criadoEm));
}

/**
 * Os casos de um tipo que a raw talvez ainda não mostre (na fila, no lote, recusados, ou gravados há menos de 1 h), o
 * mais novo primeiro: o que a lista de solicitações junta à raw. `404` (o app ainda sem a rota) é fila vazia. Erro sobe.
 */
export async function casosAbertosNaFila(filtro: {
    tipo: TipoCasoCxhub;
    marca?: string;
    pedido?: string;
}): Promise<CasoAbertoNaFila[]> {
    const query = new URLSearchParams({ tipo: filtro.tipo });
    if (filtro.marca) query.set('marca', filtro.marca);
    const digitos = (filtro.pedido ?? '').replace(/\D/g, '');
    if (digitos) query.set('pedido', digitos);
    let json: unknown;
    try {
        json = await ler(`/api/v1/casos/abertos?${query}`);
    } catch (erro) {
        if (erro instanceof FilaError && erro.status === 404) return [];
        throw erro;
    }
    return lista(json, 'casos').map((bruto): CasoAbertoNaFila => {
        const c = (bruto ?? {}) as Record<string, unknown>;
        return { ...casoDaResposta(bruto), valor: valorEmReais(c.valor), motivo: texto(c.motivo) || null };
    });
}

/** O caso com esse id na fila, ou `null`. Erro sobe. */
export async function casoNaFila(idSolicitacao: string): Promise<CasoNaFila | null> {
    const json = await ler(`/api/v1/casos/${encodeURIComponent(idSolicitacao)}`);
    const caso = (json as { caso?: unknown } | null)?.caso;
    if (caso === undefined) throw new FilaError('resposta da fila sem o campo "caso"', 502);
    return caso === null ? null : casoDaResposta(caso);
}

/** As atualizações que a fila guarda para esses casos, em ordem de `atualizado_em`. Erro sobe. */
export async function atualizacoesNaFila(idsSolicitacao: string[]): Promise<AtualizacaoNaFila[]> {
    if (idsSolicitacao.length === 0) return [];
    const query = new URLSearchParams({ ids: idsSolicitacao.join(',') });
    const atualizacoes = lista(await ler(`/api/v1/atualizacoes?${query}`), 'atualizacoes').map((bruto): AtualizacaoNaFila => {
        const a = (bruto ?? {}) as Record<string, unknown>;
        if (!texto(a.id_atualizacao) || !texto(a.id_solicitacao) || Number.isNaN(Date.parse(texto(a.atualizado_em)))) {
            throw new FilaError('atualização fora do contrato na resposta da fila', 502);
        }
        return {
            idAtualizacao: texto(a.id_atualizacao),
            idSolicitacao: texto(a.id_solicitacao),
            atualizadoEm: texto(a.atualizado_em),
            campos: (a.campos ?? {}) as AtualizacaoCxhub,
            situacao: situacao(a.situacao),
        };
    });
    return atualizacoes.sort((a, b) => Date.parse(a.atualizadoEm) - Date.parse(b.atualizadoEm));
}
