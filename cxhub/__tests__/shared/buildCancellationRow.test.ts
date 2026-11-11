import { describe, it, expect } from 'vitest';
import { buildCancellationRow, prepararCancelamento } from '@shared/lib/cancellation';
import type { CancellationPayload } from '@shared/lib/cancellation';

const PAYLOAD: CancellationPayload = {
    brand: 'lescent',
    'Responsável': 'Maria Silva',
    'Nome do(a) cliente': 'João Santos',
    'Número do pedido (Shopify)': '#SHOPIFY220183',
    'Observações': 'Produto avariado',
    'Número da NF': '123456',
    'CD de origem': 'Unilog SP',
    'Status': 'Solicitar no CD',
    'Local da Tratativa': 'CD',
    'Tratativa': 'Reenvio',
};

const CARIMBO = '27/10/2026 15:00:00';
const fonte = prepararCancelamento(PAYLOAD, CARIMBO);

describe('prepararCancelamento', () => {
    it('leva os campos do payload e o carimbo do servidor', () => {
        expect(fonte).toEqual({
            carimbo: CARIMBO,
            responsavel: 'Maria Silva',
            nomeCliente: 'João Santos',
            numeroPedido: '#SHOPIFY220183',
            observacoes: 'Produto avariado',
            numeroNF: '123456',
            cdOrigem: 'Unilog SP',
            tratativa: 'Reenvio',
        });
    });

    it('Bot ⇒ tratativa é sempre "Reembolso" (node Edit Fields do n8n)', () => {
        expect(prepararCancelamento({ ...PAYLOAD, 'Responsável': 'Bot', 'Tratativa': '' }, CARIMBO).tratativa).toBe('Reembolso');
    });
});

// Linhas esperadas transcritas dos code nodes `Create <Marca> Row` do `[PROD] [AUX] - Cancelamento CXHub`
describe('buildCancellationRow — paridade com o n8n', () => {
    it('Lescent: e-mail vazio + Status/Local FIXOS (o payload não chega)', () => {
        expect(buildCancellationRow('lescent', fonte)).toEqual([
            CARIMBO, null, 'Maria Silva', 'João Santos', '#SHOPIFY220183', 'Produto avariado', '123456',
            'Unilog SP', 'Reenvio', 'Solicitar na  transportadora', 'Transportador',
        ]);
    });

    it('Kokeshi: e-mail vazio, sem colunas de status', () => {
        expect(buildCancellationRow('kokeshi', fonte)).toEqual([
            CARIMBO, null, 'Maria Silva', 'João Santos', '#SHOPIFY220183', 'Produto avariado', '123456', 'Unilog SP', 'Reenvio',
        ]);
    });

    it.each(['bysamia', 'aua', 'barbours'] as const)('%s: layout curto, sem e-mail', (marca) => {
        expect(buildCancellationRow(marca, fonte)).toEqual([
            CARIMBO, 'Maria Silva', 'João Santos', '#SHOPIFY220183', 'Produto avariado', '123456', 'Unilog SP', 'Reenvio',
        ]);
    });

    it('Rituária: colunas puladas nos índices 2, 3 e 6', () => {
        expect(buildCancellationRow('rituaria', fonte)).toEqual([
            CARIMBO, 'Maria Silva', null, null, 'João Santos', '#SHOPIFY220183', null, 'Produto avariado', '123456', 'Unilog SP', 'Reenvio',
        ]);
    });

    it('campo ausente vira célula vazia, não "undefined"', () => {
        const incompleto = { ...fonte, observacoes: undefined as unknown as string };
        expect(buildCancellationRow('bysamia', incompleto)[4]).toBeNull();
    });
});
