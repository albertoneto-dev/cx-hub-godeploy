import { describe, it, expect } from 'vitest';
import { buildCancellationPayload } from '@shared/lib/cancellation/buildCancellationPayload';

describe('buildCancellationPayload', () => {
    // Cenário 1: Pedido Cosmos com transportadora expressa
    it('builds payload for cosmos order with express carrier', () => {
        const result = buildCancellationPayload({
            brand: 'lescent',
            responsavel: 'Maria Silva',
            nomeCliente: 'João Santos',
            numeroPedido: '#SHOPIFY220183',
            observacoes: 'Cliente reclamou de produto avariado',
            numeroNF: '123456',
            cdOrigem: 'SP',
            source: 'cosmos',
            transportadora: 'Dissudes (Expresso)',
            distributionCenterStatus: 'Despachado',
            tratativa: 'Reenvio',
        });

        expect(result).toEqual({
            brand: 'lescent',
            'Responsável': 'Maria Silva',
            'Nome do(a) cliente': 'João Santos',
            'Número do pedido (Shopify)': '#SHOPIFY220183',
            'Observações': 'Cliente reclamou de produto avariado',
            'Número da NF': '123456',
            'CD de origem': 'CD SP',
            'Status': 'Realizado',
            'Local da Tratativa': 'Transportador',
            'Tratativa': 'Reenvio',
        });
    });

    // Cenário 2: Pedido Shopify — status e local vazios
    it('builds payload for shopify order with empty status and local', () => {
        const result = buildCancellationPayload({
            brand: 'kokeshi',
            responsavel: 'Ana Oliveira',
            nomeCliente: 'Pedro Costa',
            numeroPedido: '#SH330291',
            observacoes: '',
            numeroNF: '',
            cdOrigem: '',
            source: 'shopify',
            transportadora: 'Correios',
            distributionCenterStatus: undefined,
            tratativa: 'Reembolso',
        });

        expect(result).toEqual({
            brand: 'kokeshi',
            'Responsável': 'Ana Oliveira',
            'Nome do(a) cliente': 'Pedro Costa',
            'Número do pedido (Shopify)': '#SH330291',
            'Observações': '',
            'Número da NF': '',
            'CD de origem': '',
            'Status': '',
            'Local da Tratativa': '',
            'Tratativa': 'Reembolso',
        });
    });

    // Cenário 3: Cosmos + não expressa + CD Pronto
    it('builds payload for cosmos order with non-express carrier and CD Pronto', () => {
        const result = buildCancellationPayload({
            brand: 'bysamia',
            responsavel: 'Carlos Lima',
            nomeCliente: 'Mariana Souza',
            numeroPedido: '#SHOPIFY440123',
            observacoes: 'Pedido não enviado',
            numeroNF: '789012',
            cdOrigem: 'MG',
            source: 'cosmos',
            transportadora: 'Correios',
            distributionCenterStatus: 'Pronto',
            tratativa: 'Reenvio',
        });

        expect(result).toEqual({
            brand: 'bysamia',
            'Responsável': 'Carlos Lima',
            'Nome do(a) cliente': 'Mariana Souza',
            'Número do pedido (Shopify)': '#SHOPIFY440123',
            'Observações': 'Pedido não enviado',
            'Número da NF': '789012',
            'CD de origem': 'CD MG',
            'Status': 'Pendente',
            'Local da Tratativa': 'Unilog',
            'Tratativa': 'Reenvio',
        });
    });

    // Cenário 4: Cosmos + não expressa + CD Despachado
    it('builds payload for cosmos order with non-express carrier and CD Despachado', () => {
        const result = buildCancellationPayload({
            brand: 'aua',
            responsavel: 'Fernanda Reis',
            nomeCliente: 'Lucas Almeida',
            numeroPedido: '#SHOPIFY550456',
            observacoes: 'Produto errado',
            numeroNF: '345678',
            cdOrigem: 'RJ',
            source: 'cosmos',
            transportadora: 'Correios',
            distributionCenterStatus: 'Despachado',
            tratativa: 'Reembolso',
        });

        expect(result).toEqual({
            brand: 'aua',
            'Responsável': 'Fernanda Reis',
            'Nome do(a) cliente': 'Lucas Almeida',
            'Número do pedido (Shopify)': '#SHOPIFY550456',
            'Observações': 'Produto errado',
            'Número da NF': '345678',
            'CD de origem': 'CD RJ',
            'Status': 'Solicitar na transportadora',
            'Local da Tratativa': 'Transportador',
            'Tratativa': 'Reembolso',
        });
    });
});
