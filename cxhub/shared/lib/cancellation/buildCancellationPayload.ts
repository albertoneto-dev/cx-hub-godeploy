import { determineCancellationStatus } from './determineCancellationStatus';
import { formatCdOrigem } from '../shopify/index';
import type { CancellationPayload } from './types';

interface BuildCancellationPayloadInput {
    brand: string;
    responsavel: string;
    nomeCliente: string;
    numeroPedido: string;
    observacoes: string;
    numeroNF: string;
    cdOrigem: string;
    source: 'cosmos' | 'shopify';
    transportadora: string;
    distributionCenterStatus: string | undefined;
    tratativa: 'Reenvio' | 'Reembolso';
}

export function buildCancellationPayload(input: BuildCancellationPayloadInput): CancellationPayload {
    const { status, local } = determineCancellationStatus({
        source: input.source,
        transportadora: input.transportadora,
        distributionCenterStatus: input.distributionCenterStatus,
    });

    return {
        brand: input.brand,
        'Responsável': input.responsavel,
        'Nome do(a) cliente': input.nomeCliente,
        'Número do pedido (Shopify)': input.numeroPedido,
        'Observações': input.observacoes,
        'Número da NF': input.numeroNF,
        'CD de origem': formatCdOrigem(input.cdOrigem),
        'Status': status,
        'Local da Tratativa': local,
        'Tratativa': input.tratativa,
    };
}
