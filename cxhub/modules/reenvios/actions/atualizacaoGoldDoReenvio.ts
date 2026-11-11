// `import type`: o módulo do Airflow é server-only, e este arquivo entra no barrel das actions.
import type { AlteracaoGold, LocalizadorCasoGold } from '../../../shared/lib/airflow/types';
import type { SupportedBrand } from '../../../shared/lib/constants';
import type { ResendManagementResponse, ResendUpdateRequest } from '../types/management';

export type AtualizacaoGoldDoReenvioInput =
    | { acao: 'cancelado'; brand: SupportedBrand; resposta: ResendManagementResponse; handledBy: string }
    | { acao: 'editado'; brand: SupportedBrand; resposta: ResendManagementResponse; pedido: ResendUpdateRequest };

/**
 * Reenvio cancelado ou editado no Cosmos ⇒ atualização da gold. `null` quando não há o que levar: o Cosmos
 * não confirmou, ou a edição não mexeu em coluna da gold.
 *
 * Cancelar marca `status_execucao = Cancelado` na hora; sem isso, o acompanhamento só veria o cancelamento
 * quando a cópia do Cosmos no data mart fosse atualizada (guia da DAG, seção 1). Na edição, só a UF do
 * endereço de entrega tem coluna (`uf` é a do reenvio); cidade e CEP são dado pessoal e não vão (ADR-008).
 * Transportadora também não: na gold, `transportadora` é a do pedido ORIGINAL, como no de-para da criação.
 */
export function atualizacaoGoldDoReenvio(input: AtualizacaoGoldDoReenvioInput): AlteracaoGold | null {
    const pedido = input.resposta.order;
    if (input.resposta.code !== 'SUCCESS' || !pedido) return null;

    const localizador: LocalizadorCasoGold = {
        tipo: 'REENVIO',
        marca: input.brand,
        pedidoReenvio: pedido.external_id,
        reenvioCriadoEm: pedido.created_at,
    };

    if (input.acao === 'cancelado') {
        return {
            localizador,
            evento: 'cancelado',
            atualizacao: { status_execucao: 'Cancelado', responsavel_execucao: input.handledBy },
        };
    }

    // A UF como ficou no Cosmos depois da edição (mesclada com o endereço que já existia), não só o pedido.
    const uf = pedido.shipping?.address?.state;
    if (!input.pedido.shippingAddress || !uf) return null;
    return { localizador, evento: 'editado', atualizacao: { uf } };
}
