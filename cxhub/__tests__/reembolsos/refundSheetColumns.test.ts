import { describe, it, expect } from 'vitest';
import type { SupportedBrand } from '@shared/lib/constants';
import {
    COLUNAS_DO_REEMBOLSO,
    colunaDoStatus,
    colunasDaEdicao,
    colunasDaExecucao,
    colunasDoReembolso,
    colunasQueFaltam,
    dataDaPlanilha,
    situacaoNaPlanilha,
} from '@modules/reembolsos/actions/refundSheetColumns';

/**
 * As colunas da planilha de reembolso, achadas pelo NOME do cabeçalho. Os nomes abaixo estão escritos por extenso
 * (e não lidos da tabela) para o teste pegar um nome trocado na tabela.
 */

const MARCAS: SupportedBrand[] = ['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria'];

/**
 * Os nomes de cabeçalho de cada marca, mais os de valor e motivo. Em cinco marcas são os que a DAG antiga das planilhas
 * lia; os da Rituária são os do cabeçalho real da planilha, não os dessa DAG.
 */
const NOMES: Record<SupportedBrand, { status: string; data: string; responsavel: string; valor: string; motivo: string }> = {
    lescent: { status: 'Status do reembolso', data: 'Data de Execução', responsavel: 'Responsável Reembolso', valor: 'Valor do reembolso', motivo: 'Motivo da solicitação do reembolso?' },
    kokeshi: { status: 'Status Reembolso', data: 'Data de Execução', responsavel: 'Responsável Reembolso', valor: 'Valor do reembolso', motivo: 'Motivo da solicitação do reembolso?' },
    bysamia: { status: 'Status', data: 'Data de Execução', responsavel: 'Responsável Reembolso', valor: 'Valor do reembolso', motivo: 'Motivo da Solicitação' },
    aua: { status: 'Status', data: 'Realizada em', responsavel: 'Responsável Reembolso', valor: 'Valor do reembolso', motivo: 'Motivo da Solicitação' },
    barbours: { status: 'Status', data: 'Data de Execução', responsavel: 'Responsável Reembolso', valor: 'Valor do reembolso', motivo: 'Motivo da Solicitação' },
    rituaria: { status: 'Status Reembolso', data: 'Data de Execução', responsavel: 'Responsável reembolso', valor: 'Valor do reembolso', motivo: 'Motivo da Solicitação' },
};

/** Um cabeçalho com colunas de enchimento antes, no meio e depois, para provar que a posição não importa. */
function cabecalhoDe(marca: SupportedBrand, sem: string[] = []): string[] {
    const n = NOMES[marca];
    const colunas = ['Carimbo de data/hora', 'Número do pedido', n.valor, 'Executor', n.motivo, n.status, 'Observações', n.data, n.responsavel, 'Semana'];
    return colunas.filter((c) => !sem.includes(c));
}

describe.each(MARCAS)('colunas de %s', (marca) => {
    const n = NOMES[marca];
    const cabecalho = cabecalhoDe(marca);

    it('acha status, data e responsável pelo nome, em qualquer posição', () => {
        expect(colunasDoReembolso(cabecalho, marca)).toEqual({
            status: cabecalho.indexOf(n.status),
            data: cabecalho.indexOf(n.data),
            responsavel: cabecalho.indexOf(n.responsavel),
        });
    });

    it('acha cada coluna da execução separada, e a que falta é null sem derrubar as outras (é o que o concluir grava)', () => {
        expect(colunasDaExecucao(cabecalho, marca)).toEqual({
            status: cabecalho.indexOf(n.status),
            data: cabecalho.indexOf(n.data),
            responsavel: cabecalho.indexOf(n.responsavel),
        });
        expect(colunasDaExecucao(cabecalhoDe(marca, [n.data]), marca)).toEqual({
            status: cabecalhoDe(marca, [n.data]).indexOf(n.status),
            data: null,
            responsavel: cabecalhoDe(marca, [n.data]).indexOf(n.responsavel),
        });
        expect(colunasDaExecucao([], marca)).toEqual({ status: null, data: null, responsavel: null });
    });

    it('acha valor e motivo para a edição', () => {
        expect(colunasDaEdicao(cabecalho, marca)).toEqual({
            valor: cabecalho.indexOf(n.valor),
            motivo: cabecalho.indexOf(n.motivo),
        });
    });

    it('acha só o status, que é o que cancelar precisa', () => {
        expect(colunaDoStatus(cabecalho, marca)).toBe(cabecalho.indexOf(n.status));
    });

    it.each(['status', 'data', 'responsavel'] as const)('sem a coluna de %s, devolve null', (campo) => {
        expect(colunasDoReembolso(cabecalhoDe(marca, [n[campo]]), marca)).toBeNull();
    });

    it('cabeçalho vazio devolve null', () => {
        expect(colunasDoReembolso([], marca)).toBeNull();
        expect(colunaDoStatus([], marca)).toBeNull();
        expect(colunasDaEdicao([], marca)).toEqual({ valor: null, motivo: null });
    });

    it('a tabela do código tem estes mesmos nomes', () => {
        expect(COLUNAS_DO_REEMBOLSO[marca]).toEqual(n);
    });
});

describe('nomes que a marca tem de diferente', () => {
    it('Auá guarda a data em "Realizada em"; "Data de Execução" não serve', () => {
        const aua = ['Status', 'Realizada em', 'Responsável Reembolso'];
        expect(colunasDoReembolso(aua, 'aua')).toEqual({ status: 0, data: 1, responsavel: 2 });
        expect(colunasDoReembolso(['Status', 'Data de Execução', 'Responsável Reembolso'], 'aua')).toBeNull();
    });

    it('Rituária usa "Status Reembolso" e "Responsável reembolso" (r minúsculo), os do cabeçalho real; a comparação aceita as duas caixas', () => {
        const base = ['Status Reembolso', 'Data de Execução'];
        expect(colunasDoReembolso([...base, 'Responsável reembolso'], 'rituaria')).toEqual({ status: 0, data: 1, responsavel: 2 });
        expect(colunasDoReembolso([...base, 'Responsável Reembolso'], 'rituaria')).toEqual({ status: 0, data: 1, responsavel: 2 });
    });

    it('cada marca tem o nome do seu status: Lescent "Status do reembolso", Kokeshi "Status Reembolso", as outras "Status"', () => {
        expect(colunaDoStatus(['Status'], 'lescent')).toBeNull();
        expect(colunaDoStatus(['Status do reembolso'], 'lescent')).toBe(0);
        expect(colunaDoStatus(['Status'], 'kokeshi')).toBeNull();
        expect(colunaDoStatus(['Status Reembolso'], 'kokeshi')).toBe(0);
        expect(colunaDoStatus(['Status'], 'bysamia')).toBe(0);
        expect(colunaDoStatus(['Status Reembolso'], 'rituaria')).toBe(0);
        expect(colunaDoStatus(['Status'], 'rituaria')).toBeNull();
    });

    it('a coluna "Executor" NÃO é o responsável da execução', () => {
        expect(colunasDoReembolso(['Status', 'Data de Execução', 'Executor'], 'barbours')).toBeNull();
    });
});

describe('como o cabeçalho é comparado', () => {
    it('ignora maiúsculas, espaços nas pontas e espaços repetidos (inclusive o que não quebra)', () => {
        const cabecalho = ['  STATUS DO  REEMBOLSO ', 'data de execução', 'responsável reembolso'];
        expect(colunasDoReembolso(cabecalho, 'lescent')).toEqual({ status: 0, data: 1, responsavel: 2 });
    });

    it('com duas colunas de mesmo nome, vale a primeira', () => {
        expect(colunaDoStatus(['Status', 'Status'], 'barbours')).toBe(0);
    });

    it('célula que não é texto no cabeçalho não atrapalha', () => {
        expect(colunaDoStatus([null, 7, true, 'Status'], 'barbours')).toBe(3);
    });
});

describe('colunasQueFaltam', () => {
    it('lista os nomes de cabeçalho que não existem, na ordem pedida', () => {
        expect(colunasQueFaltam(['Status'], 'aua', ['status', 'data', 'responsavel'])).toEqual(['Realizada em', 'Responsável Reembolso']);
    });

    it('nada falta quando tudo existe', () => {
        expect(colunasQueFaltam(cabecalhoDe('lescent'), 'lescent', ['status', 'data', 'responsavel', 'valor', 'motivo'])).toEqual([]);
    });
});

describe('situacaoNaPlanilha', () => {
    it.each([
        ['Realizado', 'realizado'],
        ['Cancelado', 'cancelado'],
        ['Pendente', 'pendente'],
    ])('%s é %s', (valor, esperado) => {
        expect(situacaoNaPlanilha(valor)).toBe(esperado);
    });

    it.each(['REALIZADO', 'realizado', ' Realizado ', 'realizado '])('ignora maiúsculas e espaços: %j', (valor) => {
        expect(situacaoNaPlanilha(valor)).toBe('realizado');
    });

    it.each(['Com Pendência', 'Enviado financeiro', 'Realizado parcialmente', 'Em análise', '', '   ', null, undefined, 3, true])(
        'texto livre da operação ou vazio (%j) é "outro"',
        (valor) => {
            expect(situacaoNaPlanilha(valor)).toBe('outro');
        },
    );
});

describe('dataDaPlanilha', () => {
    it.each([
        ['25/10/2026', '25/10/2026'],
        ['5/3/2026', '05/03/2026'],
        [' 05/03/2026 ', '05/03/2026'],
        ['2026-10-25', '25/10/2026'],
        ['29/02/2028', '29/02/2028'],
    ])('lê %j como %s', (valor, esperado) => {
        expect(dataDaPlanilha(valor)).toBe(esperado);
    });

    describe('número serial (dias desde 30/12/1899)', () => {
        it.each([
            [46325, '30/10/2026'],
            [46325.75, '30/10/2026'],
            [46023, '01/01/2026'],
            [36526, '01/01/2000'],
            [61, '01/03/1900'],
            [1, '31/12/1899'],
            [2_958_465, '31/12/9999'],
        ])('lê %s como %s (a hora é ignorada)', (serial, esperado) => {
            expect(dataDaPlanilha(serial)).toBe(esperado);
        });

        it.each([0, -1, 0.5, 2_958_466, 20261025, Number.NaN, Number.POSITIVE_INFINITY])('número fora do que o Sheets representa como data (%s) é null', (serial) => {
            expect(dataDaPlanilha(serial)).toBeNull();
        });

        it('o serial e o texto da mesma data dão o mesmo resultado', () => {
            expect(dataDaPlanilha(46325)).toBe(dataDaPlanilha('30/10/2026'));
        });
    });

    it.each(['', 'ontem', '31/02/2026', '29/02/2027', '32/01/2026', '10/13/2026', '25-10-2026', '25/10/26', null, undefined, true])(
        'o que não é data (%j) é null',
        (valor) => {
            expect(dataDaPlanilha(valor)).toBeNull();
        },
    );
});
