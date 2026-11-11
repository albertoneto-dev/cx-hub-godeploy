import { describe, it, expect } from 'vitest';
import { determineCancellationStatus } from '@shared/lib/cancellation/determineCancellationStatus';

describe('determineCancellationStatus', () => {
    // Cenário 1: Pedido Shopify — status e local vazios
    it('returns empty status and local for shopify orders', () => {
        const result = determineCancellationStatus({
            source: 'shopify',
            transportadora: 'Correios',
            distributionCenterStatus: 'Pronto',
        });
        expect(result).toEqual({ status: '', local: '' });
    });

    // Cenário 2: Cosmos + transportadora expressa (Dissudes)
    it('returns Realizado/Transportador for cosmos + express carrier', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'Dissudes (Expresso)',
            distributionCenterStatus: 'Despachado',
        });
        expect(result).toEqual({ status: 'Realizado', local: 'Transportador' });
    });

    // Cenário 15: Cosmos + não expressa + CD "Pronto"
    it('returns Pendente/Unilog for cosmos + non-express + CD Pronto', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'Correios',
            distributionCenterStatus: 'Pronto',
        });
        expect(result).toEqual({ status: 'Pendente', local: 'Unilog' });
    });

    // Cenário 16: Cosmos + não expressa + CD "Integrado"
    it('returns Pendente/Unilog for cosmos + non-express + CD Integrado', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'Correios',
            distributionCenterStatus: 'Integrado',
        });
        expect(result).toEqual({ status: 'Pendente', local: 'Unilog' });
    });

    // Cenário 17: Cosmos + não expressa + CD "Aguardando Produção"
    it('returns Pendente/Unilog for cosmos + non-express + CD Aguardando Produção', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'Correios',
            distributionCenterStatus: 'Aguardando Produção',
        });
        expect(result).toEqual({ status: 'Pendente', local: 'Unilog' });
    });

    // Cenário 18: Cosmos + não expressa + CD "Despachado"
    it('returns Solicitar na transportadora/Transportador for cosmos + non-express + CD Despachado', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'Correios',
            distributionCenterStatus: 'Despachado',
        });
        expect(result).toEqual({ status: 'Solicitar na transportadora', local: 'Transportador' });
    });

    // Cenário 19: Cosmos + não expressa + CD vazio
    it('returns Solicitar na transportadora/Transportador for cosmos + non-express + empty CD status', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'Correios',
            distributionCenterStatus: '',
        });
        expect(result).toEqual({ status: 'Solicitar na transportadora', local: 'Transportador' });
    });

    // Cenário 20: Cosmos + não expressa + CD "Entregue"
    it('returns Solicitar na transportadora/Transportador for cosmos + non-express + CD Entregue', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'Correios',
            distributionCenterStatus: 'Entregue',
        });
        expect(result).toEqual({ status: 'Solicitar na transportadora', local: 'Transportador' });
    });

    // Cenário 21: Cosmos + nome similar mas não exato (sem "(Expresso)")
    it('does not match carrier without exact name — Dissudes (no suffix) falls through to CD logic', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'Dissudes',
            distributionCenterStatus: 'Pronto',
        });
        expect(result).toEqual({ status: 'Pendente', local: 'Unilog' });
    });

    // Case-insensitive carrier match
    it('matches express carrier case-insensitively', () => {
        const result = determineCancellationStatus({
            source: 'cosmos',
            transportadora: 'dissudes (expresso)',
            distributionCenterStatus: 'Despachado',
        });
        expect(result).toEqual({ status: 'Realizado', local: 'Transportador' });
    });
});
