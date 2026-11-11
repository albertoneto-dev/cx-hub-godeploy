const EXPRESS_CARRIERS_LOWER = new Set([
    'dissudes (expresso)',
    'dias log (expresso)',
    'dias log sp (expresso)',
    'diálogo (expresso)',
    'expresso (fallback)',
    'j&t (expresso)',
    'j&t sp (expresso)',
    'logan (expresso)',
    'loggi (expresso)',
    'rede sul (expresso)',
    'clique retire (expresso)',
    'magalog (expresso)',
    'magalog sp (expresso)',
]);

const CD_STATUSES_IN_WAREHOUSE = new Set(['Pronto', 'Integrado', 'Aguardando Produção']);

interface DetermineCancellationStatusInput {
    source: 'cosmos' | 'shopify';
    transportadora: string;
    distributionCenterStatus: string | undefined;
}

interface CancellationStatus {
    status: string;
    local: string;
}

export function determineCancellationStatus(input: DetermineCancellationStatusInput): CancellationStatus {
    if (input.source === 'shopify') {
        return { status: '', local: '' };
    }

    if (EXPRESS_CARRIERS_LOWER.has(input.transportadora.toLowerCase())) {
        return { status: 'Realizado', local: 'Transportador' };
    }

    if (CD_STATUSES_IN_WAREHOUSE.has(input.distributionCenterStatus ?? '')) {
        return { status: 'Pendente', local: 'Unilog' };
    }

    return { status: 'Solicitar na transportadora', local: 'Transportador' };
}
