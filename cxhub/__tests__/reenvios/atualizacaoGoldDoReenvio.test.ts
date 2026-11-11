import { describe, it, expect } from 'vitest';
import { atualizacaoGoldDoReenvio } from '@modules/reenvios/actions/atualizacaoGoldDoReenvio';
import type { CosmosDetailedOrder } from '@shared/types';
import type { ResendManagementResponse } from '@modules/reenvios/types';

/**
 * O que o cancelar e o editar do reenvio levam à gold. O caso é achado pelo -R-n e pela data em que o Cosmos
 * o criou; do endereço de entrega, só a UF tem coluna na gold (cidade e CEP são dado pessoal).
 */

const PEDIDO = {
    id: 42,
    external_id: 'SH12345LC-R-1',
    origin: 'resend',
    created_at: '2026-10-20T14:05:03-03:00',
    shipping: {
        name: 'Cliente Teste',
        phone: '11900000000',
        address: {
            street: 'Rua Nova', number: '200', complement: '', neighborhood: 'Centro',
            city: 'São Paulo', state: 'SP', postal_code: '01000-000',
        },
        service_name: 'NORMAL_J&T',
        cost: '12.5',
    },
} as unknown as CosmosDetailedOrder;

const OK: ResendManagementResponse = { code: 'SUCCESS', message: '', order: PEDIDO };

const LOCALIZADOR = {
    tipo: 'REENVIO',
    marca: 'lescent',
    pedidoReenvio: 'SH12345LC-R-1',
    reenvioCriadoEm: '2026-10-20T14:05:03-03:00',
};

describe('atualizacaoGoldDoReenvio', () => {
    it('cancelado ⇒ status Cancelado, com o agente como responsável pela execução', () => {
        expect(atualizacaoGoldDoReenvio({ acao: 'cancelado', brand: 'lescent', resposta: OK, handledBy: 'Ana' })).toEqual({
            localizador: LOCALIZADOR,
            evento: 'cancelado',
            atualizacao: { status_execucao: 'Cancelado', responsavel_execucao: 'Ana' },
        });
    });

    it('endereço editado ⇒ só a UF, como ficou no Cosmos (não só o que foi pedido); cidade e CEP não vão', () => {
        const alteracao = atualizacaoGoldDoReenvio({
            acao: 'editado', brand: 'lescent', resposta: OK,
            pedido: { handledBy: 'Ana', shippingAddress: { street: 'Rua Nova', number: '200' } },
        });

        expect(alteracao).toEqual({
            localizador: LOCALIZADOR,
            evento: 'editado',
            atualizacao: { uf: 'SP' },
        });
    });

    it('endereço editado sem UF no pedido do Cosmos não leva nada', () => {
        const semUf = {
            ...PEDIDO,
            shipping: { ...PEDIDO.shipping, address: { ...PEDIDO.shipping!.address, state: '' } },
        } as unknown as CosmosDetailedOrder;

        expect(atualizacaoGoldDoReenvio({
            acao: 'editado', brand: 'lescent', resposta: { ...OK, order: semUf },
            pedido: { handledBy: 'Ana', shippingAddress: { street: 'Rua Nova', number: '200' } },
        })).toBeNull();
    });

    it('transportadora ou cliente editados não têm coluna na gold', () => {
        expect(atualizacaoGoldDoReenvio({
            acao: 'editado', brand: 'lescent', resposta: OK, pedido: { handledBy: 'Ana', carrierId: 161 },
        })).toBeNull();
        expect(atualizacaoGoldDoReenvio({
            acao: 'editado', brand: 'lescent', resposta: OK, pedido: { handledBy: 'Ana', customer: { phone: '11911111111' } },
        })).toBeNull();
    });

    it('sem a confirmação do Cosmos não leva nada', () => {
        const recusado: ResendManagementResponse = { code: 'RESEND_LOCKED', message: 'faturamento começou' };
        expect(atualizacaoGoldDoReenvio({ acao: 'cancelado', brand: 'lescent', resposta: recusado, handledBy: 'Ana' })).toBeNull();
        expect(atualizacaoGoldDoReenvio({
            acao: 'cancelado', brand: 'lescent', resposta: { code: 'SUCCESS', message: '' }, handledBy: 'Ana',
        })).toBeNull();
    });
});
