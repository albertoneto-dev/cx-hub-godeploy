import type { MarcaCxHub } from '../constants';

/** A tabela que a DAG `gobeaute_reenvio_reembolso_etl` grava e o Metabase lê. */
export const TABELA_GOLD = 'gold.fct_reenvio_reembolso_gobeaute';

/**
 * Código de marca do CX Hub → `sigla` da tabela (`MARCAS_CXHUB` da DAG). As consultas filtram pela sigla
 * porque a `marca` da tabela tem apóstrofo ("Barbour's").
 *
 * As marcas sem Cosmos (ADR-013) usam a sigla **da base consolidada**, que é como a DAG junta o histórico do Supabase:
 * a Denavita é `DV` na base, embora o sufixo do pedido seja `DN`. A Gobeaute (o site multimarca, ADR-014) é `GB`, a
 * sigla proposta para a DAG — a confirmar quando a DAG a aceitar.
 */
export const SIGLA_DA_MARCA: Record<MarcaCxHub, string> = {
    lescent: 'LE',
    kokeshi: 'KO',
    bysamia: 'BS',
    aua: 'AU',
    barbours: 'BB',
    rituaria: 'RT',
    apice: 'AP',
    yenzah: 'YE',
    denavita: 'DV',
    gobeaute: 'GB',
};
