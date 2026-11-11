import { describe, it, expect } from 'vitest';
import {
    evaluateKitCompleteness,
    computeToggleKit,
    computeToggleComponent,
    computeToggleProduto,
    computeUpdateQuantidade,
} from '@shared/lib/productSelectionLogic';
import type { NormalizedProduct } from '@shared/types';

// ─── Factories ───────────────────────────────────────────────────────

function makeProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
    return {
        id: 'p1',
        product_id: 1,
        nome: 'Produto Teste',
        sku: 'SKU001',
        quantidade: 2,
        preco: '50.00',
        ...overrides,
    };
}

function makeKit(): NormalizedProduct {
    return makeProduct({
        id: 'kit1',
        nome: 'Kit Teste',
        sku: 'KIT001',
        quantidade: 1,
        isKit: true,
        kitComponents: [
            makeProduct({ id: 'comp1', nome: 'Componente A', sku: 'COMP-A', quantidade: 2, preco: '20.00' }),
            makeProduct({ id: 'comp2', nome: 'Componente B', sku: 'COMP-B', quantidade: 3, preco: '10.00' }),
        ],
    });
}

// ─── evaluateKitCompleteness ─────────────────────────────────────────

describe('evaluateKitCompleteness', () => {
    it('retorna sem mudanças se não é kit', () => {
        const product = makeProduct();
        const result = evaluateKitCompleteness(product, ['p1'], { p1: 1 });
        expect(result.selectedIds).toEqual(['p1']);
    });

    it('ativa kit quando todos componentes selecionados com qtd proporcional', () => {
        const kit = makeKit();
        // comp1 qty=2 (2*1=2), comp2 qty=3 (3*1=3) → effective: 2/2=1, 3/3=1 → same → kit qty=1
        const result = evaluateKitCompleteness(kit, ['comp1', 'comp2'], { comp1: 2, comp2: 3 });
        expect(result.selectedIds).toContain('kit1');
        expect(result.quantidades['kit1']).toBe(1);
    });

    it('não ativa kit quando componentes tem qtds não proporcionais', () => {
        const kit = makeKit();
        // comp1: 4/2=2, comp2: 3/3=1 → different → kit not activated
        const result = evaluateKitCompleteness(kit, ['comp1', 'comp2'], { comp1: 4, comp2: 3 });
        expect(result.selectedIds).not.toContain('kit1');
    });

    it('não ativa kit quando nem todos componentes estão selecionados', () => {
        const kit = makeKit();
        const result = evaluateKitCompleteness(kit, ['comp1'], { comp1: 2 });
        expect(result.selectedIds).not.toContain('kit1');
    });

    it('remove kit do selected quando componente é deselecionado', () => {
        const kit = makeKit();
        // Kit was previously selected, now comp2 removed
        const result = evaluateKitCompleteness(kit, ['kit1', 'comp1'], { kit1: 1, comp1: 2 });
        expect(result.selectedIds).not.toContain('kit1');
        expect(result.quantidades['kit1']).toBeUndefined();
    });
});

// ─── computeToggleKit ────────────────────────────────────────────────

describe('computeToggleKit', () => {
    it('seleciona kit inteiro quando nada selecionado', () => {
        const kit = makeKit();
        const result = computeToggleKit(kit, [], {});
        expect(result.selectedIds).toContain('kit1');
        expect(result.selectedIds).toContain('comp1');
        expect(result.selectedIds).toContain('comp2');
        expect(result.quantidades['kit1']).toBe(1);
        expect(result.quantidades['comp1']).toBe(2); // 1 * 2
        expect(result.quantidades['comp2']).toBe(3); // 1 * 3
    });

    it('remove kit inteiro quando todos já selecionados', () => {
        const kit = makeKit();
        const result = computeToggleKit(kit, ['kit1', 'comp1', 'comp2'], { kit1: 1, comp1: 2, comp2: 3 });
        expect(result.selectedIds).not.toContain('kit1');
        expect(result.selectedIds).not.toContain('comp1');
        expect(result.selectedIds).not.toContain('comp2');
        expect(result.quantidades['kit1']).toBeUndefined();
        expect(result.quantidades['comp1']).toBeUndefined();
    });

    it('seleciona tudo quando apenas parcialmente selecionado', () => {
        const kit = makeKit();
        const result = computeToggleKit(kit, ['comp1'], { comp1: 2 });
        expect(result.selectedIds).toContain('kit1');
        expect(result.selectedIds).toContain('comp1');
        expect(result.selectedIds).toContain('comp2');
    });

    it('não duplica IDs já selecionados', () => {
        const kit = makeKit();
        const result = computeToggleKit(kit, ['comp1'], { comp1: 2 });
        const comp1Count = result.selectedIds.filter(id => id === 'comp1').length;
        expect(comp1Count).toBe(1);
    });

    it('retorna sem mudanças quando produto não é kit', () => {
        const product = makeProduct();
        const result = computeToggleKit(product, ['p1'], { p1: 2 });
        expect(result.selectedIds).toEqual(['p1']);
    });
});

// ─── computeToggleComponent ──────────────────────────────────────────

describe('computeToggleComponent', () => {
    it('adiciona componente e seta quantidade padrão', () => {
        const kit = makeKit();
        const result = computeToggleComponent(kit, [], {}, 'comp1');
        expect(result.selectedIds).toContain('comp1');
        expect(result.quantidades['comp1']).toBe(2); // kit.quantidade(1) * comp.quantidade(2)
    });

    it('remove componente quando já selecionado', () => {
        const kit = makeKit();
        const result = computeToggleComponent(kit, ['comp1'], { comp1: 2 }, 'comp1');
        expect(result.selectedIds).not.toContain('comp1');
        expect(result.quantidades['comp1']).toBeUndefined();
    });

    it('ativa kit automaticamente quando último componente é selecionado', () => {
        const kit = makeKit();
        // comp1 já está selecionado, agora toggle comp2
        const result = computeToggleComponent(kit, ['comp1'], { comp1: 2 }, 'comp2');
        expect(result.selectedIds).toContain('comp1');
        expect(result.selectedIds).toContain('comp2');
        expect(result.selectedIds).toContain('kit1'); // auto-activated
    });

    it('desativa kit quando componente é removido', () => {
        const kit = makeKit();
        const result = computeToggleComponent(
            kit,
            ['kit1', 'comp1', 'comp2'],
            { kit1: 1, comp1: 2, comp2: 3 },
            'comp2',
        );
        expect(result.selectedIds).not.toContain('kit1');
        expect(result.selectedIds).not.toContain('comp2');
        expect(result.selectedIds).toContain('comp1');
    });
});

// ─── computeToggleProduto ────────────────────────────────────────────

describe('computeToggleProduto', () => {
    it('adiciona produto e seta quantidade padrão', () => {
        const products = [makeProduct({ id: 'p1', quantidade: 3 })];
        const result = computeToggleProduto(products, [], {}, 'p1');
        expect(result.selectedIds).toEqual(['p1']);
        expect(result.quantidades['p1']).toBe(3);
    });

    it('remove produto e limpa quantidade', () => {
        const products = [makeProduct({ id: 'p1', quantidade: 3 })];
        const result = computeToggleProduto(products, ['p1'], { p1: 3 }, 'p1');
        expect(result.selectedIds).toEqual([]);
        expect(result.quantidades['p1']).toBeUndefined();
    });

    it('não afeta outros produtos selecionados', () => {
        const products = [
            makeProduct({ id: 'p1', quantidade: 2 }),
            makeProduct({ id: 'p2', quantidade: 1 }),
        ];
        const result = computeToggleProduto(products, ['p1'], { p1: 2 }, 'p2');
        expect(result.selectedIds).toEqual(['p1', 'p2']);
        expect(result.quantidades['p1']).toBe(2);
        expect(result.quantidades['p2']).toBe(1);
    });
});

// ─── computeUpdateQuantidade ─────────────────────────────────────────

describe('computeUpdateQuantidade', () => {
    it('atualiza quantidade de produto normal', () => {
        const products = [makeProduct({ id: 'p1', quantidade: 5 })];
        const result = computeUpdateQuantidade(products, ['p1'], { p1: 5 }, 'p1', 3);
        expect(result.quantidades['p1']).toBe(3);
        expect(result.selectedIds).toEqual(['p1']);
    });

    it('reavalia kit quando quantidade de componente muda para proporcional', () => {
        const kit = makeKit();
        const products = [kit];
        // Both selected but with non-proportional qtys. Change comp1 to make proportional.
        // comp1: 4/2=2, comp2: 6/3=2 → same → kit activates with qty 2
        const result = computeUpdateQuantidade(
            products,
            ['comp1', 'comp2'],
            { comp1: 2, comp2: 6 },
            'comp1', 4,
        );
        expect(result.selectedIds).toContain('kit1');
        expect(result.quantidades['kit1']).toBe(2);
    });

    it('desativa kit quando quantidade de componente quebra proporcionalidade', () => {
        const kit = makeKit();
        const products = [kit];
        // comp1: 3/2=1.5 rounds to 2, comp2: 3/3=1 → 2≠1 → kit deactivated
        const result = computeUpdateQuantidade(
            products,
            ['kit1', 'comp1', 'comp2'],
            { kit1: 1, comp1: 2, comp2: 3 },
            'comp1', 3,
        );
        expect(result.selectedIds).not.toContain('kit1');
    });

    it('propaga quantidade do kit para todos os componentes proporcionalmente', () => {
        const kit = makeKit();
        const products = [kit];
        // Kit ativo com qty 1, comp1: 2 (1*2), comp2: 3 (1*3). Change kit qty to 4.
        const result = computeUpdateQuantidade(
            products,
            ['kit1', 'comp1', 'comp2'],
            { kit1: 1, comp1: 2, comp2: 3 },
            'kit1', 4,
        );
        expect(result.quantidades['kit1']).toBe(4);
        expect(result.quantidades['comp1']).toBe(8);  // 4 * 2
        expect(result.quantidades['comp2']).toBe(12); // 4 * 3
    });
});

// ─── Kit quantity propagation (cenário completo) ─────────────────────

describe('kit quantity propagation (cenário completo)', () => {
    // Kit com 3 componentes: A=1, B=2, C=1 (pedido com 5 kits)
    function makeKitABC(): NormalizedProduct {
        return makeProduct({
            id: 'kitX',
            nome: 'Kit X',
            sku: 'KITX',
            quantidade: 5,
            isKit: true,
            kitComponents: [
                makeProduct({ id: 'itemA', nome: 'Item A', sku: 'A', quantidade: 1, preco: '10.00' }),
                makeProduct({ id: 'itemB', nome: 'Item B', sku: 'B', quantidade: 2, preco: '15.00' }),
                makeProduct({ id: 'itemC', nome: 'Item C', sku: 'C', quantidade: 1, preco: '20.00' }),
            ],
        });
    }

    it('toggle kit seleciona com qtd max e componentes proporcionais', () => {
        const kit = makeKitABC();
        const result = computeToggleKit(kit, [], {});
        expect(result.selectedIds).toContain('kitX');
        expect(result.quantidades['kitX']).toBe(5);
        expect(result.quantidades['itemA']).toBe(5);  // 5 * 1
        expect(result.quantidades['itemB']).toBe(10); // 5 * 2
        expect(result.quantidades['itemC']).toBe(5);  // 5 * 1
    });

    it('re-toggle kit após qtds parciais reseta para qtd max proporcionais', () => {
        const kit = makeKitABC();
        // Estado parcial: qtds desproporcionais, kit desmarcado
        const selected = ['itemA', 'itemB', 'itemC'];
        const qtds = { itemA: 2, itemB: 3, itemC: 2 };

        // Desmarcar todos primeiro
        const deselected = computeToggleKit(kit, selected, qtds);
        expect(deselected.selectedIds).toHaveLength(0);

        // Marcar novamente: deve voltar para qtd max
        const reselected = computeToggleKit(kit, deselected.selectedIds, deselected.quantidades);
        expect(reselected.quantidades['kitX']).toBe(5);
        expect(reselected.quantidades['itemA']).toBe(5);
        expect(reselected.quantidades['itemB']).toBe(10);
        expect(reselected.quantidades['itemC']).toBe(5);
    });

    it('mudar qtd do kit de 5 para 4 propaga para componentes', () => {
        const kit = makeKitABC();
        const products = [kit];
        const selected = ['kitX', 'itemA', 'itemB', 'itemC'];
        const qtds = { kitX: 5, itemA: 5, itemB: 10, itemC: 5 };

        const result = computeUpdateQuantidade(products, selected, qtds, 'kitX', 4);
        expect(result.quantidades['kitX']).toBe(4);
        expect(result.quantidades['itemA']).toBe(4);  // 4 * 1
        expect(result.quantidades['itemB']).toBe(8);  // 4 * 2
        expect(result.quantidades['itemC']).toBe(4);  // 4 * 1
    });

    it('seleção proporcional dos componentes ativa kit automaticamente', () => {
        const kit = makeKitABC();

        // Selecionar A e C com qtd 2
        let selected = ['itemA', 'itemC'];
        let qtds: Record<string, number> = { itemA: 2, itemC: 2 };

        // Selecionar B com qtd proporcional (2*2=4)
        computeToggleComponent(kit, selected, qtds, 'itemB');
        // itemB recebe kit.quantidade * comp.quantidade = 5 * 2 = 10, que não é proporcional a 2
        // Então o kit não ativa automaticamente aqui. Vamos ajustar para qtd proporcional manualmente:
        selected = ['itemA', 'itemB', 'itemC'];
        qtds = { itemA: 2, itemB: 4, itemC: 2 }; // 2/1=2, 4/2=2, 2/1=2 → tudo 2

        const evaluated = evaluateKitCompleteness(kit, selected, qtds);
        expect(evaluated.selectedIds).toContain('kitX');
        expect(evaluated.quantidades['kitX']).toBe(2);
    });

    it('mudar qtd do kit de 2 para 4 com componentes proporcionais', () => {
        const kit = makeKitABC();
        const products = [kit];
        const selected = ['kitX', 'itemA', 'itemB', 'itemC'];
        const qtds = { kitX: 2, itemA: 2, itemB: 4, itemC: 2 };

        const result = computeUpdateQuantidade(products, selected, qtds, 'kitX', 4);
        expect(result.quantidades['kitX']).toBe(4);
        expect(result.quantidades['itemA']).toBe(4);  // 4 * 1
        expect(result.quantidades['itemB']).toBe(8);  // 4 * 2
        expect(result.quantidades['itemC']).toBe(4);  // 4 * 1
    });
});
