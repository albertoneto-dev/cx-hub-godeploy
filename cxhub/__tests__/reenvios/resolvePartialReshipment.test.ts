import { describe, it, expect } from 'vitest';
import { resolvePartialReshipment } from '@modules/reenvios/actions/resolvePartialReshipment';
import type { NormalizedProduct } from '@shared/types';

// Pedido do exemplo do Portal de Cancelamento: 3 linhas, a cliente desistiu do sérum (KS05007).
// A 4ª linha é um kit com 2 componentes, para cobrir a expansão.
function produto(overrides: Partial<NormalizedProduct>): NormalizedProduct {
    return { id: '0', product_id: 0, nome: 'Produto', sku: 'SKU', quantidade: 1, preco: '10.00', ...overrides };
}

const PRODUTOS: NormalizedProduct[] = [
    produto({ id: '9912001', product_id: 101, sku: 'KS01002', nome: 'Tônico', quantidade: 1 }),
    produto({ id: '9912002', product_id: 102, sku: 'KS03010', nome: 'Máscara', quantidade: 2 }),
    produto({ id: '9912003', product_id: 103, sku: 'KS05007', nome: 'Sérum', quantidade: 1 }),
    produto({
        id: '9912004', product_id: 104, sku: 'KSKIT01', nome: 'Kit Rotina', quantidade: 2, isKit: true,
        kitComponents: [
            produto({ id: '9912004-a', product_id: 201, sku: 'KS07001', quantidade: 1 }),
            produto({ id: '9912004-b', product_id: 202, sku: 'KS07002', quantidade: 2 }),
        ],
    }),
];

describe('resolvePartialReshipment: itens válidos', () => {
    it('seleciona só as linhas pedidas, com a quantidade pedida (exemplo do portal)', () => {
        const r = resolvePartialReshipment(PRODUTOS, [
            { sku: 'KS01002', quantity: 1, lineItemId: 9912001 },
            { sku: 'KS03010', quantity: 2, lineItemId: 9912002 },
        ]);

        expect(r).toEqual({
            ok: true,
            produtosReenviar: ['9912001', '9912002'],
            quantidadesReenviar: { '9912001': 1, '9912002': 2 },
            itens: [{ sku: 'KS01002', quantity: 1 }, { sku: 'KS03010', quantity: 2 }],
        });
    });

    it('acha a linha pelo SKU quando lineItemId não vem', () => {
        const r = resolvePartialReshipment(PRODUTOS, [{ sku: 'KS03010', quantity: 1 }]);

        expect(r.ok && r.produtosReenviar).toEqual(['9912002']);
        expect(r.ok && r.quantidadesReenviar).toEqual({ '9912002': 1 });
    });

    it('compara SKU sem diferenciar maiúscula/minúscula nem espaço', () => {
        const r = resolvePartialReshipment(PRODUTOS, [{ sku: ' ks01002 ', quantity: 1 }]);

        expect(r.ok && r.produtosReenviar).toEqual(['9912001']);
    });

    it('kit: expande os componentes como a tela (componente = quantidade do kit × quantidade no kit)', () => {
        const r = resolvePartialReshipment(PRODUTOS, [{ sku: 'KSKIT01', quantity: 1, lineItemId: 9912004 }]);

        expect(r.ok && r.produtosReenviar).toEqual(['9912004', '9912004-a', '9912004-b']);
        expect(r.ok && r.quantidadesReenviar).toEqual({ '9912004': 1, '9912004-a': 1, '9912004-b': 2 });
    });
});

describe('resolvePartialReshipment: recusa com motivo claro', () => {
    it('lista vazia ou ausente', () => {
        expect(resolvePartialReshipment(PRODUTOS, [])).toMatchObject({ ok: false });
        expect(resolvePartialReshipment(PRODUTOS, undefined)).toMatchObject({ ok: false });
        expect(resolvePartialReshipment(PRODUTOS, 'x')).toMatchObject({ ok: false });
    });

    it('SKU que não está no pedido', () => {
        const r = resolvePartialReshipment(PRODUTOS, [{ sku: 'KS99999', quantity: 1 }]);

        expect(r).toMatchObject({ ok: false });
        expect(!r.ok && r.motivo).toContain('KS99999');
    });

    it('lineItemId que não é do pedido', () => {
        const r = resolvePartialReshipment(PRODUTOS, [{ sku: 'KS01002', quantity: 1, lineItemId: 123 }]);

        expect(!r.ok && r.motivo).toContain('123');
    });

    it('lineItemId de uma linha com outro SKU', () => {
        const r = resolvePartialReshipment(PRODUTOS, [{ sku: 'KS01002', quantity: 1, lineItemId: 9912002 }]);

        expect(r).toMatchObject({ ok: false });
    });

    it('quantidade acima da original', () => {
        const r = resolvePartialReshipment(PRODUTOS, [{ sku: 'KS03010', quantity: 3 }]);

        expect(!r.ok && r.motivo).toContain('KS03010');
    });

    it('quantidade zero, negativa ou não inteira', () => {
        for (const quantity of [0, -1, 1.5, '1', null]) {
            expect(resolvePartialReshipment(PRODUTOS, [{ sku: 'KS01002', quantity }])).toMatchObject({ ok: false });
        }
    });

    it('SKU ausente', () => {
        expect(resolvePartialReshipment(PRODUTOS, [{ quantity: 1 }])).toMatchObject({ ok: false });
    });

    it('a mesma linha duas vezes', () => {
        const r = resolvePartialReshipment(PRODUTOS, [
            { sku: 'KS01002', quantity: 1 },
            { sku: 'KS01002', quantity: 1, lineItemId: 9912001 },
        ]);

        expect(r).toMatchObject({ ok: false });
    });

    it('SKU repetido em duas linhas sem lineItemId para desempatar', () => {
        const repetido = [...PRODUTOS, produto({ id: '9912009', sku: 'KS01002', quantidade: 1 })];

        const r = resolvePartialReshipment(repetido, [{ sku: 'KS01002', quantity: 1 }]);

        expect(!r.ok && r.motivo).toContain('lineItemId');
    });

    it('junta todos os problemas numa mensagem só', () => {
        const r = resolvePartialReshipment(PRODUTOS, [
            { sku: 'KS99999', quantity: 1 },
            { sku: 'KS03010', quantity: 5 },
        ]);

        expect(!r.ok && r.motivo).toContain('KS99999');
        expect(!r.ok && r.motivo).toContain('KS03010');
    });
});
