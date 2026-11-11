// `import type`: o módulo do Airflow é server-only, e este arquivo entra no barrel do cancelamento.
import type { CasoCxhub } from '../airflow/types';
import type { MarcaCxHub } from '../constants';
import type { CancellationPayload } from './types';

export interface CasoDoCancelamentoInput {
    /** Marca sem Cosmos só pelo reembolso do Bot (ADR-015), e o caso dela vai só à fila. */
    brand: MarcaCxHub;
    data: CancellationPayload;
    idSolicitacao: string;
    criadoEm: Date;
}

/**
 * `Reenvio` ou `Reembolso`, na grafia da DAG. Outro valor (o "-" do formulário antigo, de um chamador externo) faria
 * o run falhar sem retry, então fica de fora.
 */
function tratativa(data: CancellationPayload): string | undefined {
    // O Bot só chega aqui pelo reembolso (regra do node "Edit Fields" do n8n).
    if (data['Responsável'] === 'Bot') return 'Reembolso';
    const valor = String(data['Tratativa'] ?? '').trim().toLowerCase();
    if (valor === 'reenvio') return 'Reenvio';
    if (valor === 'reembolso') return 'Reembolso';
    return undefined;
}

/**
 * O caso CANCELAMENTO de uma solicitação — próprio, mesmo quando nasce junto de um reenvio ou reembolso. É o
 * que o backend direto grava na gold no lugar da linha da planilha (ADR-008), sem o nome do cliente.
 *
 * Ficam de fora `Status` e `Local da Tratativa` (a execução entra depois, pelas atualizações) e as observações
 * (texto livre: a DAG não lê essa coluna nem nas planilhas de cancelamento).
 */
export function casoDoCancelamento(input: CasoDoCancelamentoInput): CasoCxhub {
    const { brand, data, idSolicitacao, criadoEm } = input;
    return {
        id_solicitacao: idSolicitacao,
        tipo: 'CANCELAMENTO',
        marca: brand,
        criado_em: criadoEm.toISOString(),
        numero_pedido: data['Número do pedido (Shopify)'],
        nf: data['Número da NF'],
        cd_origem: data['CD de origem'],
        responsavel: data['Responsável'],
        tratativa: tratativa(data),
    };
}
