import type { SupportedBrand } from '../../../shared/lib/constants';
import type { CelulaDaPlanilha } from './refundSheetPort';

/**
 * Onde, na planilha de reembolso de cada marca, o CX Hub lê e escreve: sempre achado pelo NOME do cabeçalho, nunca
 * pela posição (a ordem das colunas varia por marca e a operação mexe nelas).
 *
 * Os nomes são os do cabeçalho real de cada planilha: status, data e responsável da execução, que o backoffice
 * preenche, e valor e motivo, que o CX Hub reescreve na edição. Nas outras cinco marcas são os que a DAG antiga das
 * planilhas lia (`reenvio_reembolso_config.py`, repo do Airflow); a **Rituária é a exceção**: os nomes dela vêm do
 * cabeçalho real da planilha (`Status Reembolso` e `Responsável reembolso`, com r minúsculo), não dessa DAG. A comparação ignora maiúsculas e espaços (nas pontas e repetidos, inclusive o espaço que não quebra). A coluna
 * `Executor` NÃO é o responsável da execução.
 *
 * Puro: pode ir para o navegador.
 */

export interface NomesDasColunasDoReembolso {
    /** Status da execução (`Realizado`, `Cancelado`, `Pendente`). */
    status: string;
    /** Quando o reembolso foi feito, `dd/mm/aaaa`. */
    data: string;
    /** Quem executou. */
    responsavel: string;
    /** `null` = o nome do cabeçalho não é conhecido com segurança para a marca: a edição não escreve o valor. */
    valor: string | null;
    /** `null` = idem, para o motivo. */
    motivo: string | null;
}

export const COLUNAS_DO_REEMBOLSO: Record<SupportedBrand, NomesDasColunasDoReembolso> = {
    lescent: {
        status: 'Status do reembolso',
        data: 'Data de Execução',
        responsavel: 'Responsável Reembolso',
        valor: 'Valor do reembolso',
        motivo: 'Motivo da solicitação do reembolso?',
    },
    kokeshi: {
        status: 'Status Reembolso',
        data: 'Data de Execução',
        responsavel: 'Responsável Reembolso',
        valor: 'Valor do reembolso',
        motivo: 'Motivo da solicitação do reembolso?',
    },
    bysamia: {
        status: 'Status',
        data: 'Data de Execução',
        responsavel: 'Responsável Reembolso',
        valor: 'Valor do reembolso',
        motivo: 'Motivo da Solicitação',
    },
    aua: {
        status: 'Status',
        data: 'Realizada em',
        responsavel: 'Responsável Reembolso',
        valor: 'Valor do reembolso',
        motivo: 'Motivo da Solicitação',
    },
    barbours: {
        status: 'Status',
        data: 'Data de Execução',
        responsavel: 'Responsável Reembolso',
        valor: 'Valor do reembolso',
        motivo: 'Motivo da Solicitação',
    },
    rituaria: {
        status: 'Status Reembolso',
        data: 'Data de Execução',
        responsavel: 'Responsável reembolso',
        valor: 'Valor do reembolso',
        motivo: 'Motivo da Solicitação',
    },
};

const normalizar = (valor: CelulaDaPlanilha | undefined): string =>
    valor === null || valor === undefined ? '' : String(valor).replace(/\s+/g, ' ').trim().toLowerCase();

/** O índice (0-based) da primeira coluna com esse nome no cabeçalho, ou `null`. */
function colunaPorNome(cabecalho: CelulaDaPlanilha[], nome: string | null): number | null {
    const alvo = normalizar(nome);
    if (!alvo) return null;
    const indice = cabecalho.findIndex((celula) => normalizar(celula) === alvo);
    return indice === -1 ? null : indice;
}

export interface ColunasDaExecucao {
    status: number;
    data: number;
    responsavel: number;
}

/** As colunas da execução, cada uma `null` quando não está no cabeçalho: quem escreve grava as que existem. */
export type ColunasPossiveisDaExecucao = { [campo in keyof ColunasDaExecucao]: number | null };

export function colunasDaExecucao(cabecalho: CelulaDaPlanilha[], marca: SupportedBrand): ColunasPossiveisDaExecucao {
    const nomes = COLUNAS_DO_REEMBOLSO[marca];
    return {
        status: colunaPorNome(cabecalho, nomes.status),
        data: colunaPorNome(cabecalho, nomes.data),
        responsavel: colunaPorNome(cabecalho, nomes.responsavel),
    };
}

/** As três colunas da execução, ou `null` quando falta alguma no cabeçalho: o que ler exige (sincronizar). */
export function colunasDoReembolso(cabecalho: CelulaDaPlanilha[], marca: SupportedBrand): ColunasDaExecucao | null {
    const { status, data, responsavel } = colunasDaExecucao(cabecalho, marca);
    return status === null || data === null || responsavel === null ? null : { status, data, responsavel };
}

/** Só a coluna do status (o que cancelar precisa), ou `null`. */
export function colunaDoStatus(cabecalho: CelulaDaPlanilha[], marca: SupportedBrand): number | null {
    return colunaPorNome(cabecalho, COLUNAS_DO_REEMBOLSO[marca].status);
}

export interface ColunasDaEdicao {
    /** `null` = sem coluna de valor na marca, ou ela não está no cabeçalho. */
    valor: number | null;
    motivo: number | null;
}

/** As colunas que a edição reescreve. Cada uma pode faltar sem derrubar a outra. */
export function colunasDaEdicao(cabecalho: CelulaDaPlanilha[], marca: SupportedBrand): ColunasDaEdicao {
    const nomes = COLUNAS_DO_REEMBOLSO[marca];
    return { valor: colunaPorNome(cabecalho, nomes.valor), motivo: colunaPorNome(cabecalho, nomes.motivo) };
}

/** Os nomes de cabeçalho, entre os `campos` pedidos, que não existem na planilha: o que a mensagem de erro mostra. */
export function colunasQueFaltam(
    cabecalho: CelulaDaPlanilha[],
    marca: SupportedBrand,
    campos: readonly (keyof NomesDasColunasDoReembolso)[],
): string[] {
    const nomes = COLUNAS_DO_REEMBOLSO[marca];
    return campos.flatMap((campo) => {
        const nome = nomes[campo];
        return nome !== null && colunaPorNome(cabecalho, nome) === null ? [nome] : [];
    });
}

export type SituacaoNaPlanilha = 'realizado' | 'cancelado' | 'pendente' | 'outro';

/**
 * O que o backoffice marcou no status. Só os três valores do vocabulário contam; o resto ("Com Pendência", "Enviado
 * financeiro", vazio...) é texto livre da operação: `outro`, nada a sincronizar com a gold.
 */
export function situacaoNaPlanilha(valor: CelulaDaPlanilha | undefined): SituacaoNaPlanilha {
    const texto = normalizar(valor);
    if (texto === 'realizado' || texto === 'cancelado' || texto === 'pendente') return texto;
    return 'outro';
}

/** O dia 0 do número serial do Google Sheets (e do Excel moderno): 30/12/1899. */
const EPOCA_DO_SERIAL_UTC = Date.UTC(1899, 11, 30);
/** 31/12/9999, o último dia que o Sheets representa. */
const ULTIMO_SERIAL = 2_958_465;
const MS_POR_DIA = 86_400_000;

function dataDoSerial(serial: number): string | null {
    if (!Number.isFinite(serial) || serial < 1 || serial > ULTIMO_SERIAL) return null;
    const data = new Date(EPOCA_DO_SERIAL_UTC + Math.floor(serial) * MS_POR_DIA);
    const dia = String(data.getUTCDate()).padStart(2, '0');
    const mes = String(data.getUTCMonth() + 1).padStart(2, '0');
    return `${dia}/${mes}/${data.getUTCFullYear()}`;
}

/**
 * A data de execução como `dd/mm/aaaa`, ou `null` quando a célula não é uma data (vazia, texto livre, dia que não
 * existe). Aceita dia e mês sem zero à esquerda e `aaaa-mm-dd`. Aceita também o **número serial** da data (dias
 * desde 30/12/1899, a parte da hora é ignorada), que é como o Google devolve uma célula de data lida sem
 * formatação: a leitura da gestão pede o texto formatado, mas isto cobre o serial por garantia.
 */
export function dataDaPlanilha(valor: CelulaDaPlanilha | undefined): string | null {
    if (typeof valor === 'number') return dataDoSerial(valor);
    const texto = typeof valor === 'string' ? valor.trim() : '';
    const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(texto);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
    const [dia, mes, ano] = br ? [br[1], br[2], br[3]] : iso ? [iso[3], iso[2], iso[1]] : [];
    if (!dia || !mes || !ano) return null;

    const d = Number(dia);
    const m = Number(mes);
    const a = Number(ano);
    const data = new Date(Date.UTC(a, m - 1, d));
    if (data.getUTCFullYear() !== a || data.getUTCMonth() !== m - 1 || data.getUTCDate() !== d) return null;
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${ano}`;
}
