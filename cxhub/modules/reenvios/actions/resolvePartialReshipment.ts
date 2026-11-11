import type { NormalizedProduct } from '../../../shared/types/index';
import { computeToggleKit, computeUpdateQuantidade } from '../../../shared/lib/productSelectionLogic';

/**
 * Reenvio PARCIAL pedido pelo Portal de Cancelamento (troca: o original é cancelado no CD e reenviado
 * sem o item que a cliente não quer mais).
 *
 * Valida a lista do portal contra as linhas do pedido real e devolve a seleção no MESMO formato que a
 * tela produz (`produtosReenviar` + `quantidadesReenviar`), para o resto do caminho — `buildSubmissionData`,
 * kits, valor, `apiData` — ser o canônico, sem reimplementar nada.
 *
 * Qualquer item que não confira recusa a lista INTEIRA, com todos os problemas numa mensagem: reenviar
 * "o que deu para casar" despacharia uma caixa diferente da que o portal combinou com a cliente.
 */

export type PartialResolution =
    | {
        ok: true;
        produtosReenviar: string[];
        quantidadesReenviar: Record<string, number>;
        /** Eco para a resposta: o que vai no reenvio, com o SKU como está no pedido */
        itens: Array<{ sku: string; quantity: number }>;
    }
    | { ok: false; motivo: string };

interface ItemDoPortal {
    sku?: unknown;
    quantity?: unknown;
    lineItemId?: unknown;
}

const normalizarSku = (sku: string) => sku.trim().toUpperCase();

export function resolvePartialReshipment(produtos: NormalizedProduct[], items: unknown): PartialResolution {
    if (!Array.isArray(items) || items.length === 0) {
        return { ok: false, motivo: 'Reenvio parcial sem itens: reshipment.items é obrigatório e não pode ser vazio' };
    }

    const problemas: string[] = [];
    const linhasUsadas = new Set<string>();
    let selecionados: string[] = [];
    let quantidades: Record<string, number> = {};
    const itens: Array<{ sku: string; quantity: number }> = [];

    items.forEach((bruto: ItemDoPortal, indice) => {
        const rotulo = `item ${indice + 1}`;
        const sku = typeof bruto?.sku === 'string' ? bruto.sku : '';
        const quantity = bruto?.quantity;

        if (!sku.trim()) {
            problemas.push(`${rotulo}: SKU ausente`);
            return;
        }
        if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
            problemas.push(`${sku}: quantidade inválida (${String(quantity)}), precisa ser inteiro ≥ 1`);
            return;
        }

        let linha: NormalizedProduct | undefined;
        if (bruto.lineItemId !== undefined && bruto.lineItemId !== null) {
            linha = produtos.find(p => p.id === String(bruto.lineItemId));
            if (!linha) {
                problemas.push(`${sku}: lineItemId ${String(bruto.lineItemId)} não pertence ao pedido`);
                return;
            }
            if (normalizarSku(linha.sku) !== normalizarSku(sku)) {
                problemas.push(`${sku}: lineItemId ${String(bruto.lineItemId)} é da linha do SKU ${linha.sku}`);
                return;
            }
        } else {
            const candidatas = produtos.filter(p => normalizarSku(p.sku) === normalizarSku(sku));
            if (candidatas.length === 0) {
                problemas.push(`${sku}: SKU não está no pedido`);
                return;
            }
            if (candidatas.length > 1) {
                problemas.push(`${sku}: SKU aparece em ${candidatas.length} linhas do pedido; informe lineItemId`);
                return;
            }
            linha = candidatas[0];
        }

        if (linhasUsadas.has(linha.id)) {
            problemas.push(`${sku}: a mesma linha do pedido foi enviada mais de uma vez`);
            return;
        }
        if (quantity > linha.quantidade) {
            problemas.push(`${sku}: quantidade ${quantity} maior que a do pedido (${linha.quantidade})`);
            return;
        }
        linhasUsadas.add(linha.id);
        itens.push({ sku: linha.sku, quantity });

        // Kit: a mesma mecânica da tela — marca o kit e os componentes, depois ajusta a quantidade
        // (o componente leva quantidade do kit × quantidade dele dentro do kit).
        if (linha.isKit && linha.kitComponents) {
            ({ selectedIds: selecionados, quantidades } = computeToggleKit(linha, selecionados, quantidades));
            ({ selectedIds: selecionados, quantidades } = computeUpdateQuantidade(produtos, selecionados, quantidades, linha.id, quantity));
            return;
        }
        selecionados = [...selecionados, linha.id];
        quantidades = { ...quantidades, [linha.id]: quantity };
    });

    if (problemas.length > 0) {
        return { ok: false, motivo: `Itens do reenvio parcial não conferem com o pedido: ${problemas.join('; ')}` };
    }

    return { ok: true, produtosReenviar: selecionados, quantidadesReenviar: quantidades, itens };
}
