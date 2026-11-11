import type { NormalizedProduct } from '../types/index';

export interface SelectionResult {
    selectedIds: string[];
    quantidades: Record<string, number>;
}

/**
 * Evaluates whether a kit should be "fully selected" as a unit.
 * A kit is complete when all components are selected AND have proportional quantities.
 */
export function evaluateKitCompleteness(
    kit: NormalizedProduct,
    currentSelected: string[],
    currentQuantidades: Record<string, number>
): SelectionResult {
    if (!kit.kitComponents) return { selectedIds: currentSelected, quantidades: currentQuantidades };

    const componentIds = kit.kitComponents.map(c => c.id);
    const areAllSelected = componentIds.every(cid => currentSelected.includes(cid));

    let newSelected = [...currentSelected];
    const newQuantidades = { ...currentQuantidades };

    if (areAllSelected) {
        const effectiveQtys = kit.kitComponents.map(c => {
            const qty = currentQuantidades[c.id];
            if (!qty || c.quantidade === 0) return 0;
            return Math.round(qty / c.quantidade);
        });

        const allSame = effectiveQtys.length > 0 && effectiveQtys.every(q => q === effectiveQtys[0]);

        if (allSame && effectiveQtys[0] > 0) {
            if (!newSelected.includes(kit.id)) {
                newSelected.push(kit.id);
            }
            newQuantidades[kit.id] = effectiveQtys[0];
        } else {
            newSelected = newSelected.filter(sid => sid !== kit.id);
            delete newQuantidades[kit.id];
        }
    } else {
        newSelected = newSelected.filter(sid => sid !== kit.id);
        delete newQuantidades[kit.id];
    }

    return { selectedIds: newSelected, quantidades: newQuantidades };
}

/** Toggle an entire kit (select/deselect all components + parent) */
export function computeToggleKit(
    kit: NormalizedProduct,
    selectedIds: string[],
    quantidades: Record<string, number>,
): SelectionResult {
    if (!kit.kitComponents) return { selectedIds, quantidades };

    const componentIds = kit.kitComponents.map(c => c.id);
    const allIds = [kit.id, ...componentIds];
    const areAllComponentsSelected = componentIds.every(id => selectedIds.includes(id));

    let newSelected = [...selectedIds];
    const newQuantidades = { ...quantidades };

    if (areAllComponentsSelected) {
        newSelected = newSelected.filter(id => !allIds.includes(id));
        allIds.forEach(id => delete newQuantidades[id]);
    } else {
        const toAdd = allIds.filter(id => !newSelected.includes(id));
        newSelected = [...newSelected, ...toAdd];
        newQuantidades[kit.id] = kit.quantidade;
        kit.kitComponents!.forEach(c => {
            newQuantidades[c.id] = kit.quantidade * c.quantidade;
        });
    }

    return { selectedIds: newSelected, quantidades: newQuantidades };
}

/** Toggle an individual component within a kit */
export function computeToggleComponent(
    kit: NormalizedProduct,
    selectedIds: string[],
    quantidades: Record<string, number>,
    componentId: string,
): SelectionResult {
    if (!kit.kitComponents) return { selectedIds, quantidades };

    let newSelected = [...selectedIds];
    const newQuantidades = { ...quantidades };

    if (newSelected.includes(componentId)) {
        newSelected = newSelected.filter(id => id !== componentId);
        delete newQuantidades[componentId];
    } else {
        newSelected.push(componentId);
        const comp = kit.kitComponents!.find(c => c.id === componentId);
        newQuantidades[componentId] = comp ? kit.quantidade * comp.quantidade : kit.quantidade;
    }

    const result = evaluateKitCompleteness(kit, newSelected, newQuantidades);
    return { selectedIds: result.selectedIds, quantidades: result.quantidades };
}

/** Toggle a normal (non-kit) product */
export function computeToggleProduto(
    produtos: NormalizedProduct[],
    selectedIds: string[],
    quantidades: Record<string, number>,
    id: string,
): SelectionResult {
    const isRemoving = selectedIds.includes(id);
    const newList = isRemoving
        ? selectedIds.filter(p => p !== id)
        : [...selectedIds, id];

    const newQuantidades = { ...quantidades };
    if (isRemoving) {
        delete newQuantidades[id];
    } else {
        const produto = produtos.find(p => p.id === id);
        if (produto) {
            newQuantidades[id] = produto.quantidade;
        }
    }

    return { selectedIds: newList, quantidades: newQuantidades };
}

/** Update quantity for an individual product/component, re-evaluating parent kit completeness.
 *  When the updated ID is a kit, propagate the new quantity to all components proportionally. */
export function computeUpdateQuantidade(
    produtos: NormalizedProduct[],
    selectedIds: string[],
    quantidades: Record<string, number>,
    id: string,
    quantidade: number,
): SelectionResult {
    const newQuantidades = { ...quantidades, [id]: quantidade };
    let newSelected = [...selectedIds];

    // Check if the updated ID is a kit itself — propagate to components
    for (const p of produtos) {
        if (p.id === id && p.kitComponents) {
            p.kitComponents.forEach(c => {
                newQuantidades[c.id] = quantidade * c.quantidade;
            });
            return { selectedIds: newSelected, quantidades: newQuantidades };
        }
    }

    // Otherwise check if it's a component — re-evaluate parent kit completeness
    for (const p of produtos) {
        if (p.kitComponents) {
            const isComponent = p.kitComponents.some(c => c.id === id);
            if (isComponent) {
                const result = evaluateKitCompleteness(p, newSelected, newQuantidades);
                newSelected = result.selectedIds;
                Object.assign(newQuantidades, result.quantidades);
                break;
            }
        }
    }

    return { selectedIds: newSelected, quantidades: newQuantidades };
}

// ─── Product resolution (kit vs component dedup) ─────────────────────

/** SKUs hardcoded de brindes da marca Kokeshi */
export const KOKESHI_GIFT_SKUS = ['KS99043', 'KS03012'];

export interface ResolvedProduct {
    id: string;
    sku: string;
    isGift: boolean;
    kitComponentSkus?: Array<{ sku: string; id: string }>;
}

/**
 * Resolves which products/components to include given a set of selected IDs.
 * When a kit is selected, only the kit is returned (with its componentSkus);
 * individual components are only returned if the parent kit is NOT selected.
 */
export function resolveSelectedProducts(
    selectedProductIds: string[],
    produtos: NormalizedProduct[]
): ResolvedProduct[] {
    const result: ResolvedProduct[] = [];
    const selectedSet = new Set(selectedProductIds);

    for (const id of selectedProductIds) {
        const mainProduct = produtos.find(p => p.id === id);

        if (mainProduct) {
            const isGiftByName = mainProduct.nome.toLowerCase().includes('brinde');
            const isGiftBySku = KOKESHI_GIFT_SKUS.includes(mainProduct.sku.toUpperCase());
            const isGift = isGiftByName || isGiftBySku;

            if (mainProduct.isKit && mainProduct.kitComponents) {
                result.push({
                    id: mainProduct.id,
                    sku: mainProduct.sku,
                    isGift,
                    kitComponentSkus: mainProduct.kitComponents.map(c => ({ sku: c.sku, id: c.id })),
                });
            } else {
                result.push({
                    id: mainProduct.id,
                    sku: mainProduct.sku,
                    isGift,
                });
            }
            continue;
        }

        // Check if it's a kit component
        for (const p of produtos) {
            if (p.kitComponents) {
                const component = p.kitComponents.find(c => c.id === id);
                if (component) {
                    // Only include if the parent kit is NOT selected
                    if (!selectedSet.has(p.id)) {
                        const compIsGiftByName = component.nome.toLowerCase().includes('brinde');
                        const compIsGiftBySku = KOKESHI_GIFT_SKUS.includes(component.sku.toUpperCase());
                        result.push({
                            id: component.id,
                            sku: component.sku,
                            isGift: compIsGiftByName || compIsGiftBySku,
                        });
                    }
                    break;
                }
            }
        }
    }

    return result;
}
