import { describe, it, expect } from 'vitest';
import { problemaNaAtualizacao, problemaNoCaso } from '@shared/lib/airflow/contrato';
import type { AtualizacaoCxhub, CasoCxhub, StatusExecucaoCxhub } from '@shared/lib/airflow/types';

/**
 * O contrato que a DAG `gobeaute_reenvio_reembolso_etl` aplica a cada item do `conf`, conferido ANTES do
 * disparo: com o registro esperando o run (ADR-008), item fora do contrato seria solicitação perdida depois de o
 * agente esperar. A régua e as mensagens são as do ETL (`ingestion/cxhub/extract.py`), sem o `repr` do Python.
 */

const ID = '6f1c0e2a-1111-2222-3333-444455556666';

const CASO: CasoCxhub = {
    id_solicitacao: ID,
    tipo: 'REEMBOLSO',
    marca: 'kokeshi',
    criado_em: '2026-10-27T17:00:00.000Z',
    numero_pedido: 'SH9000001KS',
};

/** O contrato confere o valor que vai no `conf`, inclusive o que o TypeScript não deixaria passar. */
const caso = (campos: Record<string, unknown>) => ({ ...CASO, ...campos }) as unknown as CasoCxhub;
const atualizacao = (campos: Record<string, unknown>) => campos as unknown as AtualizacaoCxhub;

describe('problemaNoCaso', () => {
    it('caso com os obrigatórios em ordem passa', () => {
        expect(problemaNoCaso(CASO)).toBeNull();
    });

    it('caso com os campos opcionais (inclusive os que a DAG ainda vai aceitar) passa', () => {
        expect(problemaNoCaso({
            ...CASO,
            tipo: 'REENVIO',
            valor: 'R$ 112,84',
            skus: 'SKU1;SKU2',
            automacao: true,
            produtos_reenvio: 'SKU1 - 1;SKU2 - 2',
            transportadora_reenvio: 'Jadlog',
            tipo_solicitacao: 'Cashback',
            ticket_transportadora: 'T-123',
        })).toBeNull();
    });

    it('obrigatório vazio, só com espaço, nulo ou ausente é recusado com o nome do campo', () => {
        expect(problemaNoCaso(caso({ numero_pedido: '' }))).toBe('sem numero_pedido');
        expect(problemaNoCaso(caso({ id_solicitacao: '   ' }))).toBe('sem id_solicitacao');
        expect(problemaNoCaso(caso({ marca: null }))).toBe('sem marca');
        expect(problemaNoCaso(caso({ criado_em: undefined }))).toBe('sem criado_em');
    });

    it('todos os obrigatórios que faltam vão juntos, na ordem do contrato', () => {
        expect(problemaNoCaso(caso({ numero_pedido: '', criado_em: undefined, tipo: ' ' })))
            .toBe('sem tipo, criado_em, numero_pedido');
    });

    it.each(['REENVIO', 'REEMBOLSO', 'CANCELAMENTO'])('aceita o tipo %s', (tipo) => {
        expect(problemaNoCaso(caso({ tipo }))).toBeNull();
    });

    it.each(['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria'])('aceita a marca %s', (marca) => {
        expect(problemaNoCaso(caso({ marca }))).toBeNull();
    });

    it('tipo e marca valem sem diferença de maiúsculas nem espaço nas pontas, como na DAG', () => {
        expect(problemaNoCaso(caso({ tipo: 'reenvio', marca: 'LESCENT' }))).toBeNull();
        expect(problemaNoCaso(caso({ tipo: ' Cancelamento ', marca: ' Rituaria ' }))).toBeNull();
    });

    it('tipo fora do vocabulário é recusado com o valor que veio', () => {
        expect(problemaNoCaso(caso({ tipo: 'TROCA' }))).toBe('tipo desconhecido: TROCA');
    });

    it('marca fora do vocabulário é recusada com o valor que veio', () => {
        expect(problemaNoCaso(caso({ marca: 'gocase' }))).toBe('marca desconhecida: gocase');
    });

    it('o tipo é conferido antes da marca', () => {
        expect(problemaNoCaso(caso({ tipo: 'TROCA', marca: 'gocase' }))).toBe('tipo desconhecido: TROCA');
    });

    it.each([
        '2026-10-27T17:00:00.000Z',
        '2026-10-27T14:00:00-03:00',
        '2026-10-27T14:00:00',
        '2026-10-27T14:00',
    ])('criado_em ISO com data e hora passa, com ou sem fuso: %s', (criado_em) => {
        expect(problemaNoCaso({ ...CASO, criado_em })).toBeNull();
    });

    it.each([
        '27/10/2026 14:00',
        '2026-10-27',
        '2026-10-27T25:00:00',
        '2026-13-01T10:00',
        'ontem',
    ])('criado_em fora de ISO 8601 (ou data impossível) é recusado: %s', (criado_em) => {
        expect(problemaNoCaso({ ...CASO, criado_em })).toBe(`criado_em fora de ISO 8601: ${criado_em}`);
    });
});

describe('problemaNaAtualizacao', () => {
    it('cancelar e editar o reembolso passam', () => {
        expect(problemaNaAtualizacao(ID, { status_execucao: 'Cancelado', responsavel_execucao: 'Ana' })).toBeNull();
        expect(problemaNaAtualizacao(ID, { valor: 59.9, motivo: 'Extravio' })).toBeNull();
        expect(problemaNaAtualizacao(ID, { status_execucao: 'Realizado', data_execucao: '29/10/2026', cod_nfd: 'NFD-1' })).toBeNull();
    });

    it('sem id_solicitacao (vazio ou só espaço) é recusado antes de qualquer outra conferência', () => {
        expect(problemaNaAtualizacao('', { motivo: 'Extravio' })).toBe('sem id_solicitacao');
        expect(problemaNaAtualizacao('   ', atualizacao({ status: 'Cancelado' }))).toBe('sem id_solicitacao');
    });

    it('campo desconhecido falha o run, então é recusado — o exemplo da DAG: status no lugar de status_execucao', () => {
        expect(problemaNaAtualizacao(ID, atualizacao({ status: 'Cancelado' }))).toBe('campo desconhecido: status');
    });

    it('os campos desconhecidos vão todos, em ordem alfabética, mesmo com um campo válido junto', () => {
        expect(problemaNaAtualizacao(ID, atualizacao({ zeta: 1, motivo: 'Extravio', alfa: 2 })))
            .toBe('campo desconhecido: alfa, zeta');
    });

    it('cliente, cidade e cep não são do contrato do CX Hub: dado pessoal não vai nem na atualização', () => {
        expect(problemaNaAtualizacao(ID, atualizacao({ cidade: 'Vila Velha', uf: 'ES', cep: '29100-000' })))
            .toBe('campo desconhecido: cep, cidade');
        expect(problemaNaAtualizacao(ID, atualizacao({ cliente: 'Fulana de Tal' }))).toBe('campo desconhecido: cliente');
    });

    it('os campos que a planilha guardava (ADR-008) já são aceitos na atualização', () => {
        expect(problemaNaAtualizacao(ID, {
            produtos_reenvio: 'SKU1 - 1',
            transportadora_reenvio: 'Jadlog',
            tipo_solicitacao: 'Reenvio',
            escopo_reembolso: 'SKU01 - 1;Frete',
            excecao_politica: true,
            ticket_transportadora: 'T-123',
            tratativa: 'Reembolso',
        })).toBeNull();
    });

    it('sem nenhum campo do caso ou da execução não há o que atualizar', () => {
        expect(problemaNaAtualizacao(ID, {})).toBe('nada para atualizar');
    });

    it('undefined não vai no JSON e não conta; null vai, e conta como campo enviado (como na DAG)', () => {
        expect(problemaNaAtualizacao(ID, { motivo: undefined, valor: undefined })).toBe('nada para atualizar');
        expect(problemaNaAtualizacao(ID, atualizacao({ motivo: null }))).toBeNull();
    });

    it('campos de identidade são aceitos, mas sozinhos não atualizam nada', () => {
        const identidade = atualizacao({
            id_solicitacao: ID,
            tipo: 'REEMBOLSO',
            marca: 'lescent',
            criado_em: '2026-10-27T17:00:00.000Z',
            numero_pedido: 'SH9000105LC',
            automacao: false,
        });

        expect(problemaNaAtualizacao(ID, identidade)).toBe('nada para atualizar');
        expect(problemaNaAtualizacao(ID, { ...identidade, motivo: 'Extravio' })).toBeNull();
    });

    it.each(['Realizado', 'cancelado', ' PENDENTE '])('status_execucao no vocabulário, sem diferença de maiúsculas: %j', (status) => {
        expect(problemaNaAtualizacao(ID, { status_execucao: status as StatusExecucaoCxhub })).toBeNull();
    });

    it('status_execucao fora do vocabulário é recusado com o valor que veio', () => {
        expect(problemaNaAtualizacao(ID, { status_execucao: 'Feito' as StatusExecucaoCxhub }))
            .toBe('status_execucao fora de Realizado, Cancelado, Pendente: Feito');
    });

    it('status_execucao nulo é recusado, como na DAG', () => {
        expect(problemaNaAtualizacao(ID, atualizacao({ status_execucao: null })))
            .toBe('status_execucao fora de Realizado, Cancelado, Pendente: null');
    });

    it('campo desconhecido é conferido antes do vocabulário do status', () => {
        expect(problemaNaAtualizacao(ID, atualizacao({ status_execucao: 'Feito', status: 'Feito' })))
            .toBe('campo desconhecido: status');
    });
});

describe('campos com vocabulário ou tipo fixo (tipo_solicitacao, tratativa, excecao_politica)', () => {
    it.each([
        ['tipo_solicitacao', 'Reenvio'],
        ['tipo_solicitacao', 'CASHBACK'],
        ['tratativa', 'reembolso'],
        ['tratativa', ' Reenvio '],
    ])('%s = %j passa: a DAG compara sem caixa', (campo, valor) => {
        expect(problemaNoCaso(caso({ [campo]: valor }))).toBeNull();
        expect(problemaNaAtualizacao(ID, atualizacao({ [campo]: valor }))).toBeNull();
    });

    it.each([
        ['tipo_solicitacao', 'Troca'],
        ['tratativa', '-'],
        ['tratativa', 'Cancelamento'],
    ])('%s = %j falharia o run sem retry: recusado na hora, com o valor', (campo, valor) => {
        const esperado = `${campo} fora do vocabulário da DAG: ${valor}`;
        expect(problemaNoCaso(caso({ [campo]: valor }))).toBe(esperado);
        expect(problemaNaAtualizacao(ID, atualizacao({ [campo]: valor }))).toBe(esperado);
    });

    it('texto vazio e null passam: a DAG grava como nulo', () => {
        expect(problemaNoCaso(caso({ tipo_solicitacao: '', tratativa: null }))).toBeNull();
    });

    it.each([true, false, null, undefined])('excecao_politica %j passa', (valor) => {
        expect(problemaNoCaso(caso({ excecao_politica: valor }))).toBeNull();
    });

    it.each(['true', 'sim', 1])('excecao_politica %j não é booleano: recusado, porque a DAG falharia o run', (valor) => {
        expect(problemaNoCaso(caso({ excecao_politica: valor }))).toBe(
            `excecao_politica precisa ser booleano: ${JSON.stringify(valor)}`,
        );
    });
});
