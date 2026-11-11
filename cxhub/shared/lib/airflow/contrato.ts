import type { AtualizacaoCxhub, CasoCxhub } from './types';

/**
 * O contrato que o ETL da DAG `gobeaute_reenvio_reembolso_etl` aplica a cada item do `conf`
 * (`src/gobeaute_reenvio_reembolso/config/constants.py` e `ingestion/cxhub/extract.py` no repo do Airflow).
 *
 * Item fora do contrato faz o run falhar sem retry. Com o registro esperando o run gravar (ADR-008), isso
 * seria solicitação perdida depois de o agente esperar — por isso o CX Hub confere ANTES de disparar e recusa
 * na hora, dizendo o campo. **Mudou o contrato na DAG, mude aqui.**
 */

const OBRIGATORIOS_CASO = ['id_solicitacao', 'tipo', 'marca', 'criado_em', 'numero_pedido'] as const;
const IDENTIDADE = [...OBRIGATORIOS_CASO, 'automacao'];
const CAMPOS_CASO = [
    'nf', 'chave_nf', 'valor', 'skus', 'uf', 'cd_origem', 'status_pedido', 'transportadora', 'lote', 'erp',
    'pedido_completo', 'devolucao', 'responsavel', 'origem', 'id_atendimento', 'data_pedido', 'motivo',
    // Os campos que a planilha guardava e a gold não (ADR-008). Dependem da mudança na DAG: até ela aceitar,
    // a criação os descarta em silêncio e a atualização que os mandar falha o run.
    'produtos_reenvio', 'transportadora_reenvio', 'tipo_solicitacao', 'escopo_reembolso', 'excecao_politica',
    'ticket_transportadora', 'tratativa',
];
const CAMPOS_EXECUCAO = ['status_execucao', 'data_execucao', 'responsavel_execucao', 'cod_nfd'];
const PERMITIDOS_NA_ATUALIZACAO = new Set([...IDENTIDADE, ...CAMPOS_CASO, ...CAMPOS_EXECUCAO]);

const TIPOS = ['REENVIO', 'REEMBOLSO', 'CANCELAMENTO'];
/**
 * As marcas sem Cosmos (ADR-013) e a Gobeaute (ADR-014) dependem de a DAG, a fila e o `rota-dados-cxhub` as aceitarem
 * antes do deploy.
 */
const MARCAS = ['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria', 'apice', 'yenzah', 'denavita', 'gobeaute'];
const STATUS_EXECUCAO = ['realizado', 'cancelado', 'pendente'];
/** Campos novos com vocabulário fechado: valor fora dele falha o run sem retry (a comparação ignora a caixa). */
const VOCABULARIO: Record<string, string[]> = {
    tipo_solicitacao: ['reenvio', 'cashback'],
    tratativa: ['reenvio', 'reembolso'],
};

const texto = (valor: unknown) => (valor === null || valor === undefined ? '' : String(valor).trim());

/** Valor que a DAG não aceita num campo de vocabulário ou tipo fixo. Texto vazio e `null` passam: viram nulo. */
function problemaDeValor(campos: Record<string, unknown>): string | null {
    for (const [campo, aceitos] of Object.entries(VOCABULARIO)) {
        const valor = texto(campos[campo]);
        if (valor && !aceitos.includes(valor.toLowerCase())) return `${campo} fora do vocabulário da DAG: ${campos[campo]}`;
    }
    const excecao = campos.excecao_politica;
    if (excecao !== undefined && excecao !== null && typeof excecao !== 'boolean') {
        return `excecao_politica precisa ser booleano: ${JSON.stringify(excecao)}`;
    }
    return null;
}

/** `null` quando o caso passa no ETL; senão, o primeiro problema, com o campo. */
export function problemaNoCaso(caso: CasoCxhub): string | null {
    const faltando = OBRIGATORIOS_CASO.filter((campo) => !texto(caso[campo]));
    if (faltando.length > 0) return `sem ${faltando.join(', ')}`;
    if (!TIPOS.includes(texto(caso.tipo).toUpperCase())) return `tipo desconhecido: ${caso.tipo}`;
    if (!MARCAS.includes(texto(caso.marca).toLowerCase())) return `marca desconhecida: ${caso.marca}`;
    // O ETL usa `datetime.fromisoformat`: data e hora ISO, com ou sem fuso.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(texto(caso.criado_em)) || Number.isNaN(Date.parse(caso.criado_em))) {
        return `criado_em fora de ISO 8601: ${caso.criado_em}`;
    }
    return problemaDeValor(caso as unknown as Record<string, unknown>);
}

/**
 * `null` quando a atualização passa no ETL. Ao contrário da criação, campo desconhecido FALHA o run.
 *
 * Confere só os `campos`. No lote (ADR-012) o item ainda leva `id_atualizacao` (UUID) e `atualizado_em` (ISO 8601 com
 * fuso, nunca mais de 5 min depois do disparo do run), que o `enfileirarAtualizacao` sempre preenche e a fila põe no
 * item ao montar o `conf` (`docs/fila-cxhub.md`).
 */
export function problemaNaAtualizacao(idSolicitacao: string, atualizacao: AtualizacaoCxhub): string | null {
    if (!texto(idSolicitacao)) return 'sem id_solicitacao';
    const campos = Object.entries(atualizacao).filter(([, valor]) => valor !== undefined).map(([campo]) => campo);
    const desconhecidos = campos.filter((campo) => !PERMITIDOS_NA_ATUALIZACAO.has(campo)).sort();
    if (desconhecidos.length > 0) return `campo desconhecido: ${desconhecidos.join(', ')}`;
    if (!campos.some((campo) => CAMPOS_CASO.includes(campo) || CAMPOS_EXECUCAO.includes(campo))) return 'nada para atualizar';
    if (atualizacao.status_execucao !== undefined && !STATUS_EXECUCAO.includes(texto(atualizacao.status_execucao).toLowerCase())) {
        return `status_execucao fora de Realizado, Cancelado, Pendente: ${atualizacao.status_execucao}`;
    }
    return problemaDeValor(atualizacao as Record<string, unknown>);
}
