import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    atualizacaoDoCaso,
    execucaoDoSemExecucao,
    registrarFalhaDaTela,
    tentativaSemExecucao,
    type EstadoDeps,
} from '@shared/lib/fila';
import type { AtualizacaoNaFila, CasoNaFila } from '@shared/lib/fila/types';
import type { CasoCxhub } from '@shared/lib/airflow';

/** A solicitação sem execução (REGISTRAR_FALHA_DA_TELA, 2026-11-27): quando o id que a tela manda pode ser refeito. */

const CRIADO_EM = '2026-11-27T13:00:00.000Z';
const CASO: CasoNaFila = {
    idSolicitacao: 'caso-1',
    tipo: 'REENVIO',
    marca: 'kokeshi',
    numeroPedido: 'SH1753209KS',
    criadoEm: CRIADO_EM,
    responsavel: 'Ana',
    situacao: 'pendente',
};

function marca(campos: AtualizacaoNaFila['campos']): AtualizacaoNaFila {
    return { idAtualizacao: 'a-1', idSolicitacao: 'caso-1', atualizadoEm: '2026-11-27T13:00:01.000Z', campos, situacao: 'pendente' };
}

function deps(caso: CasoNaFila | null, atualizacoes: AtualizacaoNaFila[]): EstadoDeps {
    return {
        solicitacaoRecenteNaRaw: vi.fn(),
        reembolsoMaisRecenteNaRaw: vi.fn(),
        casoPorIdNaRaw: vi.fn().mockResolvedValue(null),
        casosDoPedidoNaFila: vi.fn(),
        casoNaFila: vi.fn().mockResolvedValue(caso),
        atualizacoesNaFila: vi.fn().mockResolvedValue(atualizacoes),
        agora: () => Date.parse(CRIADO_EM),
    };
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('tentativaSemExecucao', () => {
    it.each([
        ['não realizado (Cancelado)', 'nao_realizado'],
        ['a conferir (Pendente)', 'a_conferir'],
    ] as const)('o caso %s do mesmo pedido ⇒ o id e o criado_em (o carimbo da linha)', async (_, desfecho) => {
        const d = deps(CASO, [marca(execucaoDoSemExecucao(desfecho))]);

        const anterior = await tentativaSemExecucao('caso-1', 'REENVIO', 'kokeshi', 'SH1753209KS', d);

        expect(anterior).toEqual({ idSolicitacao: 'caso-1', criadoEm: new Date(CRIADO_EM) });
    });

    it.each<[string, string | undefined, CasoNaFila | null, AtualizacaoNaFila[], string]>([
        ['sem id', undefined, CASO, [marca(execucaoDoSemExecucao('nao_realizado'))], 'SH1753209KS'],
        ['id fora do formato', 'caso 1; drop', CASO, [marca(execucaoDoSemExecucao('nao_realizado'))], 'SH1753209KS'],
        ['caso que não existe', 'caso-1', null, [], 'SH1753209KS'],
        ['caso de outro pedido', 'caso-1', CASO, [marca(execucaoDoSemExecucao('nao_realizado'))], 'SH1748696KS'],
        ['caso de outro tipo', 'caso-1', { ...CASO, tipo: 'REEMBOLSO' }, [marca(execucaoDoSemExecucao('nao_realizado'))], 'SH1753209KS'],
        ['caso que deu certo (sem marca)', 'caso-1', CASO, [], 'SH1753209KS'],
        ['caso que já foi refeito com sucesso', 'caso-1', CASO, [marca({ status_execucao: 'Pendente', responsavel_execucao: 'Automação' })], 'SH1753209KS'],
        ['caso cancelado por uma pessoa', 'caso-1', CASO, [marca({ status_execucao: 'Cancelado', responsavel_execucao: 'Ana' })], 'SH1753209KS'],
    ])('%s ⇒ null (segue como solicitação nova, com o dedup)', async (_, id, caso, atualizacoes, pedido) => {
        expect(await tentativaSemExecucao(id, 'REENVIO', 'kokeshi', pedido, deps(caso, atualizacoes))).toBeNull();
    });

    it('erro de leitura sobe (quem chama responde como no dedup)', async () => {
        const d = deps(CASO, []);
        vi.mocked(d.casoNaFila).mockRejectedValue(new Error('a fila não respondeu'));

        await expect(tentativaSemExecucao('caso-1', 'REENVIO', 'kokeshi', 'SH1753209KS', d)).rejects.toThrow('a fila não respondeu');
    });
});

describe('atualizacaoDoCaso', () => {
    it('leva os campos do caso sem a identidade nem o automacao, com a execução por cima', () => {
        const caso: CasoCxhub = {
            id_solicitacao: 'x', tipo: 'REENVIO', marca: 'kokeshi', criado_em: CRIADO_EM, numero_pedido: 'SH1KS',
            automacao: true, nf: '123', valor: '10,00',
        };

        expect(atualizacaoDoCaso(caso, { status_execucao: 'Cancelado' })).toEqual({ nf: '123', valor: '10,00', status_execucao: 'Cancelado' });
    });
});

describe('registrarFalhaDaTela', () => {
    it.each([['on', true], [' ON ', true], ['', false], ['off', false], ['true', false]])('"%s" ⇒ %s', (valor, esperado) => {
        vi.stubEnv('REGISTRAR_FALHA_DA_TELA', valor);
        expect(registrarFalhaDaTela()).toBe(esperado);
    });
});
