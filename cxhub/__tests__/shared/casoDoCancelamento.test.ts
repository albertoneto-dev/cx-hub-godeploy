import { describe, it, expect } from 'vitest';
import { casoDoCancelamento, type CancellationPayload } from '@shared/lib/cancellation';

const DATA: CancellationPayload = {
    brand: 'rituaria',
    'Responsável': 'Agente Teste',
    'Nome do(a) cliente': 'Cliente Teste',
    'Número do pedido (Shopify)': 'SH9000003RT',
    'Observações': 'Observação livre que não vai para a gold',
    'Número da NF': '12345',
    'CD de origem': 'CD ES',
    'Status': 'Pendente',
    'Local da Tratativa': 'Unilog',
    'Tratativa': 'Reenvio',
};

function caso(data: CancellationPayload = DATA) {
    return casoDoCancelamento({
        brand: 'rituaria', data,
        idSolicitacao: 'id-3', criadoEm: new Date('2026-10-27T17:05:03.000Z'),
    });
}

describe('casoDoCancelamento', () => {
    it('vira um caso CANCELAMENTO próprio, só com os campos que têm coluna', () => {
        expect(caso()).toEqual({
            id_solicitacao: 'id-3',
            tipo: 'CANCELAMENTO',
            marca: 'rituaria',
            criado_em: '2026-10-27T17:05:03.000Z',
            numero_pedido: 'SH9000003RT',
            nf: '12345',
            cd_origem: 'CD ES',
            responsavel: 'Agente Teste',
            tratativa: 'Reenvio',
        });
    });

    it('aberto pelo Bot, a tratativa é sempre Reembolso (regra do n8n)', () => {
        expect(caso({ ...DATA, 'Responsável': 'Bot', 'Tratativa': 'Reenvio' }).tratativa).toBe('Reembolso');
    });

    it('a tratativa vai na grafia da DAG', () => {
        expect(caso({ ...DATA, 'Tratativa': 'REEMBOLSO' as CancellationPayload['Tratativa'] }).tratativa).toBe('Reembolso');
    });

    it.each(['-', '', 'Outro'])('tratativa %j não vai: fora do vocabulário, a DAG falharia o run', (valor) => {
        expect(caso({ ...DATA, 'Tratativa': valor as CancellationPayload['Tratativa'] }).tratativa).toBeUndefined();
    });

    it('nunca leva o nome do cliente nem as observações (texto livre)', () => {
        const c = caso();
        expect(c).not.toHaveProperty('cliente');
        expect(c).not.toHaveProperty('observacoes');
        expect(JSON.stringify(c)).not.toMatch(/Cliente Teste|Observação livre/);
    });
});
