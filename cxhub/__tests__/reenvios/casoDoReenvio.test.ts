import { describe, it, expect } from 'vitest';
import { casoDoReenvio } from '@modules/reenvios/actions/casoDoReenvio';
import type { ResendSubmissionData } from '@modules/reenvios/types';

/**
 * Campos que a DAG lê no `conf.casos` (guia da DAG, seção 1), mais os que a planilha guardava e a DAG passa a
 * aceitar (ADR-008). Nenhum outro pode sair daqui — e nenhum dado pessoal do cliente.
 */
const CAMPOS_DO_CONTRATO = new Set([
    'id_solicitacao', 'tipo', 'marca', 'criado_em', 'numero_pedido', 'data_pedido', 'nf', 'chave_nf', 'valor',
    'motivo', 'skus', 'uf', 'cd_origem', 'status_pedido', 'transportadora', 'lote', 'erp', 'pedido_completo',
    'devolucao', 'responsavel', 'origem', 'id_atendimento', 'automacao',
    'produtos_reenvio', 'transportadora_reenvio', 'tipo_solicitacao', 'escopo_reembolso', 'excecao_politica',
    'ticket_transportadora', 'tratativa',
]);

const DATA: ResendSubmissionData = {
    timestamp: '27/10/2026, 14:00:00',
    dataSolicitacao: '27/10/2026',
    data_criacao: '06/10/2026',
    tipoSolicitacao: 'Reenvio',
    responsavel: 'Agente Teste',
    origemReclamacao: 'Chat Atendimento',
    idAtendimento: 'https://app.exemplo/conversations/123456',
    cdOrigem: 'CD ES',
    nomeCliente: 'Cliente Teste',
    telefoneCliente: '(11) 99999-0000',
    enderecoCliente: 'Rua A, 1, Centro, Vitória/ES',
    cep: '29000-000',
    estado: 'ES',
    numeroPedido: 'SH9000001KS',
    numeroNF: '12345',
    chaveNF: '3226',
    cosmosId: '987',
    produtoComProblema: 'SKU-A;SKU-B',
    produtoReenviar: 'SKU-A - 1',
    loteProduto: 'L01',
    problemaProduto: 'Produto vazando',
    transportadoraOriginal: 'Jadlog',
    transportadoraReenvio: 'Loggi (Expresso)',
    devolucao: 'Sim',
    ticketTransportadora: '',
    statusPedido: 'Entregue',
    ReenvioCompleto: 'Não',
    valorReenvio: 'R$ 112,84',
    status: 'Realizado',
    codNfd: 'Pendente',
    automacao: 'Automação',
    erp: 'Protheus',
    comentarios: 'Observação livre que não vai para a gold',
    apiData: {
        carrierId: 161,
        carrierServiceName: 'Loggi',
        shippingCost: '0',
        discountAmount: '0.00',
        resendProducts: [{ product_id: 1, quantity: 1, unit_price: '112.84' }],
        shippingAddress: {
            street: 'Rua A', number: '1', complement: '', neighborhood: 'Centro',
            city: 'Vitória', state: 'ES', postal_code: '29000-000',
        },
    },
};

const CRIADO_EM = new Date('2026-10-27T17:05:03.000Z');

function caso(over: Partial<Parameters<typeof casoDoReenvio>[0]> = {}) {
    return casoDoReenvio({
        brand: 'kokeshi', data: DATA, automacao: true, idSolicitacao: 'id-1', criadoEm: CRIADO_EM, ...over,
    });
}

describe('casoDoReenvio', () => {
    it('monta o caso REENVIO com o de-para das planilhas', () => {
        expect(caso()).toEqual({
            id_solicitacao: 'id-1',
            tipo: 'REENVIO',
            marca: 'kokeshi',
            criado_em: '2026-10-27T17:05:03.000Z',
            numero_pedido: 'SH9000001KS',
            data_pedido: '06/10/2026',
            nf: '12345',
            chave_nf: '3226',
            valor: 'R$ 112,84',
            motivo: 'Produto vazando',
            skus: 'SKU-A;SKU-B',
            uf: 'ES',
            cd_origem: 'CD ES',
            status_pedido: 'Entregue',
            transportadora: 'Jadlog',
            lote: 'L01',
            erp: 'Protheus',
            pedido_completo: false,
            devolucao: true,
            responsavel: 'Agente Teste',
            origem: 'Chat Atendimento',
            id_atendimento: 'https://app.exemplo/conversations/123456',
            automacao: true,
            produtos_reenvio: 'SKU-A - 1',
            transportadora_reenvio: 'Loggi (Expresso)',
            tipo_solicitacao: 'Reenvio',
            ticket_transportadora: '',
        });
    });

    it('nunca leva dado pessoal do cliente nem os comentários (texto livre)', () => {
        const c = caso();
        for (const campo of ['cliente', 'cidade', 'cep', 'telefone', 'endereco', 'observacoes']) {
            expect(c).not.toHaveProperty(campo);
        }
        expect(JSON.stringify(c)).not.toMatch(/Cliente Teste|99999-0000|Rua A|Vitória|29000-000|Observação livre/);
    });

    it('só leva campos do contrato da DAG', () => {
        const chaves = Object.keys(caso());
        expect(chaves.filter(c => !CAMPOS_DO_CONTRATO.has(c))).toEqual([]);
    });

    it('transportadora é a do pedido original, não a escolhida para o reenvio', () => {
        expect(caso().transportadora).toBe('Jadlog');
    });

    it('cashback sai do mesmo formulário e conta como REENVIO, como nas planilhas — o tipo_solicitacao o distingue', () => {
        const c = caso({ data: { ...DATA, tipoSolicitacao: 'Cashback' } });
        expect(c.tipo).toBe('REENVIO');
        expect(c.tipo_solicitacao).toBe('Cashback');
    });

    it.each([['CASHBACK', 'Cashback'], [' reenvio ', 'Reenvio']])(
        'tipo de solicitação %j vai na grafia da DAG (%s)',
        (valor, esperado) => {
            expect(caso({ data: { ...DATA, tipoSolicitacao: valor } }).tipo_solicitacao).toBe(esperado);
        },
    );

    it.each(['', 'Troca'])('tipo de solicitação %j não vai: fora do vocabulário, a DAG falharia o run', (valor) => {
        expect(caso({ data: { ...DATA, tipoSolicitacao: valor } }).tipo_solicitacao).toBeUndefined();
    });

    it('ticket da transportadora vai quando o agente preenche', () => {
        expect(caso({ data: { ...DATA, ticketTransportadora: 'TK-77' } }).ticket_transportadora).toBe('TK-77');
    });

    it('automação vai como veio de quem chama (o que o fluxo confirmou)', () => {
        expect(caso({ automacao: false }).automacao).toBe(false);
    });

    it('reenvio completo e devolução viram booleanos', () => {
        const c = caso({ data: { ...DATA, ReenvioCompleto: 'Sim', devolucao: 'Não' } });
        expect(c.pedido_completo).toBe(true);
        expect(c.devolucao).toBe(false);
    });
});
