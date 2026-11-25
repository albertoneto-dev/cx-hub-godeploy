import { SIGLA_DA_MARCA, TABELA_GOLD } from '../../../shared/lib/airflow/gold';
import type { SolicitacaoRecente } from '../../../shared/lib/airflow/raw';
import type { MarcaCxHub } from '../../../shared/lib/constants';
import { listarSolicitacoesNoRegistro, solicitacaoRecenteNoRegistro } from '../../../shared/lib/fila/index';
import { formatarCarimboSP } from '../../../shared/lib/format';
import { consultarDataMart, literalSql } from '../../../shared/lib/metabase/index';
import type { SolicitacaoListada } from '../../../shared/lib/solicitacoes/types';

/**
 * Os reenvios que um pedido já tem, para quem quer saber antes de pedir outro: `GET /api/reenvio/existente`
 * (2026-11-24, decisão deste app). Vale para as 10 marcas e, na Ápice, na Yenzah, na Denavita e na Gobeaute, é a única
 * consulta que existe: elas não têm ERP, e o reenvio é feito pela operação a partir do registro. Nas marcas do Cosmos,
 * o reenvio já criado lá (`-R-n`) se confere no `GET /api/cosmos/resends`.
 *
 * Três leituras em paralelo:
 * - **o bloqueio**: o `solicitacaoRecenteNoRegistro`, a mesma função do dedup do `processResend` (o reenvio das últimas
 *   24 h não cancelado, na fila ou na raw). Por isso o GET nunca discorda do POST: o `bloqueiaNovo` é o
 *   `DUPLICATE_RESEND` que um reenvio novo levaria agora;
 * - **o registro do CX Hub**: a raw e a fila (`listarSolicitacoesNoRegistro`; com o pedido, todo o histórico dele). O caso
 *   que a DAG recusou fica de fora, como no dedup: ele nunca virou reenvio;
 * - **o histórico**: as linhas da gold que não são do CX Hub (a `chave_unica` sem `cxhub|`), as do Supabase, de antes do
 *   CX Hub. As do CX Hub a gold copia da raw de hora em hora, então o registro já as tem, e mais novas. Em 24/11 só as 6
 *   marcas do Cosmos tinham histórico (de 11/2025 a 28/10/2026); nas outras a gold é só do CX Hub, e a consulta volta
 *   vazia. Ela é feita assim mesmo: custa 25 ms, e um histórico que a DAG trouxer depois aparece sem mudar nada aqui.
 *
 * O bloqueio e o registro são o que a resposta promete: se um deles falha, a função lança (`MetabaseError` ou
 * `FilaError`), e a rota responde o erro. O histórico é complemento: sem ele, a resposta sai com `historicoLido: false`.
 *
 * ⚠️ Server-only (lê a fila e o Metabase com os segredos do app): fora do barrel.
 */

const LOG = '[Reenvio existente]';

/** Até quantas páginas do registro (20 casos cada) a consulta lê. Em 24/11, o pedido com mais reenvios no CX Hub tinha 4. */
const MAX_PAGINAS_DO_REGISTRO = 5;
/** Até quantas linhas do histórico. Em 24/11, o pedido com mais reenvios no histórico tinha 22. */
export const LIMITE_DO_HISTORICO = 50;

export interface ReenvioDoPedido {
    /** `cxhub`: o registro do CX Hub (a raw e a fila); `historico`: a gold, de antes do CX Hub (o Supabase). */
    fonte: 'cxhub' | 'historico';
    /** O `id_solicitacao` do caso no CX Hub, ou a `chave_unica` da linha no histórico. */
    id: string;
    /** O número do pedido como foi registrado. */
    numeroPedido: string;
    /** `aaaa-mm-ddThh:mm:ss`, em hora de São Paulo, sem fuso. */
    dataSolicitacao: string;
    motivo: string | null;
    /** No CX Hub, `Realizado`, `Cancelado` ou `Pendente`; no histórico, o texto que a planilha tinha. `null` sem execução. */
    statusExecucao: string | null;
    /** Quem registrou a solicitação. */
    responsavel: string | null;
    /** Só no CX Hub: o caso ainda na fila (`pendente`) ou num lote em andamento (`enviado`). `null` no gravado. */
    situacaoNaFila: 'pendente' | 'enviado' | null;
}

/** O reenvio que faria o POST de um reenvio novo responder `DUPLICATE_RESEND`. */
export interface BloqueioDoReenvio {
    idSolicitacao: string;
    responsavel: string | null;
    /** ISO 8601, em UTC: quando a fila recebeu o caso, ou quando o lote o levou à raw. */
    solicitadoEm: string;
}

export interface ReenviosDoPedido {
    bloqueiaNovo: boolean;
    bloqueadoPor: BloqueioDoReenvio | null;
    /** O registro do CX Hub e o histórico juntos, o mais recente primeiro. */
    reenvios: ReenvioDoPedido[];
    /** `false` quando a gold não respondeu: a lista tem só o registro do CX Hub. */
    historicoLido: boolean;
}

export type ReenvioExistenteCode = 'SUCCESS' | 'INVALID_REQUEST' | 'UNAVAILABLE' | 'API_TIMEOUT' | 'UNKNOWN_ERROR';

export interface ReenvioExistenteResponse extends Partial<ReenviosDoPedido> {
    code: ReenvioExistenteCode;
    message: string;
    marca?: MarcaCxHub;
    /** Os dígitos do pedido: é por eles que o registro e o histórico são comparados. */
    pedido?: string;
}

export interface DepsDosReenviosDoPedido {
    solicitacaoRecente: (marca: MarcaCxHub, pedido: string) => Promise<SolicitacaoRecente | null>;
    listarRegistro: typeof listarSolicitacoesNoRegistro;
    consultar: (sql: string) => Promise<unknown[][]>;
}

const PADRAO: DepsDosReenviosDoPedido = {
    solicitacaoRecente: (marca, pedido) => solicitacaoRecenteNoRegistro('REENVIO', marca, pedido),
    listarRegistro: listarSolicitacoesNoRegistro,
    consultar: (sql) => consultarDataMart(sql),
};

const digitos = (pedido: string) => pedido.replace(/\D/g, '');

const texto = (valor: unknown): string | null => {
    const limpo = valor === null || valor === undefined ? '' : String(valor).trim();
    return limpo || null;
};

/**
 * As linhas do histórico do pedido na gold: as do tipo, da sigla da marca e dos dígitos do pedido que não vieram do
 * CX Hub. O `numero_pedido` do Supabase tem de tudo (`716185`, `#716185`, `716185 Concluído`, `SH716185KS`), e só os
 * dígitos o comparam. A data sai como texto, sem passar pelo fuso do Metabase: a coluna já é hora de São Paulo.
 */
export function sqlDoHistoricoDeReenvios(marca: MarcaCxHub, pedido: string): string {
    return `select chave_unica, numero_pedido,
       to_char(data_solicitacao, 'YYYY-MM-DD"T"HH24:MI:SS') as data_solicitacao,
       nullif(btrim(motivo), '') as motivo,
       nullif(btrim(status_execucao), '') as status_execucao,
       nullif(btrim(responsavel_atendimento), '') as responsavel
from ${TABELA_GOLD}
where tipo = 'REENVIO'
  and sigla = ${literalSql(SIGLA_DA_MARCA[marca])}
  and chave_unica not like 'cxhub|%'
  and regexp_replace(numero_pedido, '[^0-9]', '', 'g') = ${literalSql(digitos(pedido))}
order by data_solicitacao desc, chave_unica desc
limit ${LIMITE_DO_HISTORICO}`;
}

function doRegistro(s: SolicitacaoListada): ReenvioDoPedido {
    return {
        fonte: 'cxhub',
        id: s.idSolicitacao,
        numeroPedido: s.numeroPedido,
        dataSolicitacao: s.dataSolicitacao,
        motivo: s.motivo,
        statusExecucao: s.statusExecucao,
        responsavel: s.responsavel,
        situacaoNaFila: s.situacaoNaFila === 'pendente' || s.situacaoNaFila === 'enviado' ? s.situacaoNaFila : null,
    };
}

async function lerRegistro(marca: MarcaCxHub, pedido: string, listar: DepsDosReenviosDoPedido['listarRegistro']) {
    const lidas: SolicitacaoListada[] = [];
    for (let pagina = 1; pagina <= MAX_PAGINAS_DO_REGISTRO; pagina++) {
        const { solicitacoes, paginacao } = await listar({ tipo: 'REENVIO', marca, pedido }, pagina);
        lidas.push(...solicitacoes);
        if (pagina >= paginacao.totalPaginas) break;
    }
    return lidas.filter((s) => s.situacaoNaFila !== 'recusado').map(doRegistro);
}

async function lerHistorico(marca: MarcaCxHub, pedido: string, consultar: DepsDosReenviosDoPedido['consultar']) {
    const linhas = await consultar(sqlDoHistoricoDeReenvios(marca, pedido));
    return linhas.flatMap(([chave, numero, data, motivo, status, responsavel]): ReenvioDoPedido[] =>
        typeof chave === 'string' && chave && typeof data === 'string' && data
            ? [{
                fonte: 'historico',
                id: chave,
                numeroPedido: String(numero ?? ''),
                dataSolicitacao: data,
                motivo: texto(motivo),
                statusExecucao: texto(status),
                responsavel: texto(responsavel),
                situacaoNaFila: null,
            }]
            : []);
}

/** O mais recente primeiro; o id desempata. As duas fontes trazem a data no mesmo formato, então o texto ordena. */
function maisRecentePrimeiro(a: ReenvioDoPedido, b: ReenvioDoPedido): number {
    if (a.dataSolicitacao !== b.dataSolicitacao) return a.dataSolicitacao < b.dataSolicitacao ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function reenviosDoPedido(
    marca: MarcaCxHub,
    pedido: string,
    deps: DepsDosReenviosDoPedido = PADRAO,
): Promise<ReenviosDoPedido> {
    const [bloqueio, registro, historico] = await Promise.allSettled([
        deps.solicitacaoRecente(marca, pedido),
        lerRegistro(marca, pedido, deps.listarRegistro),
        lerHistorico(marca, pedido, deps.consultar),
    ]);
    if (bloqueio.status === 'rejected') throw bloqueio.reason;
    if (registro.status === 'rejected') throw registro.reason;
    if (historico.status === 'rejected') {
        const motivo = historico.reason instanceof Error ? historico.reason.message : String(historico.reason);
        console.warn(`${LOG} ${marca} ${digitos(pedido)}: o histórico da gold não respondeu — ${motivo.slice(0, 200)}`);
    }

    const recente = bloqueio.value;
    return {
        bloqueiaNovo: recente !== null,
        bloqueadoPor: recente
            ? { idSolicitacao: recente.idSolicitacao, responsavel: texto(recente.responsavel), solicitadoEm: recente.solicitadoEm }
            : null,
        reenvios: [...registro.value, ...(historico.status === 'fulfilled' ? historico.value : [])].sort(maisRecentePrimeiro),
        historicoLido: historico.status === 'fulfilled',
    };
}

/** O instante em hora de São Paulo (`dd/MM/aaaa hh:mm:ss`), ou o texto como veio, se não for data. */
function carimbo(iso: string): string {
    return Number.isNaN(Date.parse(iso)) ? iso : formatarCarimboSP(new Date(iso));
}

/** A frase da resposta: o que um reenvio novo encontraria, e se o histórico ficou de fora. */
export function mensagemDosReenvios(r: ReenviosDoPedido): string {
    const partes: string[] = [];
    if (r.bloqueadoPor) {
        const quem = r.bloqueadoPor.responsavel ? ` feito por ${r.bloqueadoPor.responsavel}` : '';
        partes.push(`Um reenvio novo seria barrado: já existe um reenvio para o pedido${quem} em ${carimbo(r.bloqueadoPor.solicitadoEm)}.`);
    } else if (r.reenvios.length === 0) {
        partes.push('Nenhum reenvio registrado para o pedido.');
    } else {
        const n = r.reenvios.length;
        partes.push(`O pedido tem ${n} ${n === 1 ? 'reenvio registrado' : 'reenvios registrados'}, e nenhum barra um novo: `
            + 'só barra o reenvio das últimas 24 h que não foi cancelado.');
    }
    if (!r.historicoLido) partes.push('O histórico de antes do CX Hub (a gold) não respondeu: a lista tem só o registro do CX Hub.');
    return partes.join(' ');
}
