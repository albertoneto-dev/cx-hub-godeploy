// `import type`: o módulo do Airflow é server-only, e este arquivo entra no barrel das actions.
import type { CasoCxhub } from '../../../shared/lib/airflow/types';
import type {
    ResendSubmissionData,
    MarcaCxHub,
} from '../types/index';


export interface CasoDoReenvioInput {
    brand: MarcaCxHub;
    /** O que foi registrado — no caminho do bot degradado, já sem os campos de automação. */
    data: ResendSubmissionData;
    /** O que o fluxo confirmou, não o que se pediu: ERP que recusou não é reenvio pela automação. */
    automacao: boolean;
    idSolicitacao: string;
    criadoEm: Date;
}

/** `Reenvio` ou `Cashback`, na grafia da DAG. Outro valor faria o run falhar sem retry, então fica de fora. */
function tipoSolicitacao(valor: string | undefined): string | undefined {
    const tipo = (valor ?? '').trim().toLowerCase();
    if (tipo === 'reenvio') return 'Reenvio';
    if (tipo === 'cashback') return 'Cashback';
    return undefined;
}

/**
 * O caso REENVIO de uma solicitação — o que o backend direto grava na gold no lugar da linha da planilha
 * (ADR-008). Leva o que a linha levava, menos o dado pessoal do cliente e os comentários (texto livre).
 *
 * De-para conferido com o que a DAG das planilhas lia de cada coluna (`reenvio_reembolso_config.py`):
 * `transportadora` é a do pedido ORIGINAL e `motivo` é "Qual foi o problema do produto?".
 */
export function casoDoReenvio(input: CasoDoReenvioInput): CasoCxhub {
    const { brand, data, automacao, idSolicitacao, criadoEm } = input;
    return {
        id_solicitacao: idSolicitacao,
        // Cashback sai deste mesmo formulário e, nas planilhas e no Supabase, sempre contou como REENVIO.
        tipo: 'REENVIO',
        marca: brand,
        criado_em: criadoEm.toISOString(),
        numero_pedido: data.numeroPedido,
        data_pedido: data.data_criacao,
        nf: data.numeroNF,
        chave_nf: data.chaveNF,
        valor: data.valorReenvio,
        motivo: data.problemaProduto,
        skus: data.produtoComProblema,
        uf: data.estado,
        cd_origem: data.cdOrigem,
        status_pedido: data.statusPedido,
        transportadora: data.transportadoraOriginal,
        lote: data.loteProduto,
        erp: data.erp,
        pedido_completo: data.ReenvioCompleto === 'Sim',
        devolucao: data.devolucao === 'Sim',
        responsavel: data.responsavel,
        origem: data.origemReclamacao,
        id_atendimento: data.idAtendimento,
        automacao,
        produtos_reenvio: data.produtoReenviar,
        transportadora_reenvio: data.transportadoraReenvio,
        tipo_solicitacao: tipoSolicitacao(data.tipoSolicitacao),
        ticket_transportadora: data.ticketTransportadora,
    };
}
