import { vi, type Mock } from 'vitest';
import type { CasoNaRaw } from '@shared/lib/airflow';
import type { AlertContext } from '@shared/lib/alerts';
import type { RefundGestaoDeps } from '@modules/reembolsos/actions/refundGestaoDeps';
import { CRIADO_EM_EXEMPLO, PEDIDO_EXEMPLO, PlanilhaFalsa } from './planilha-reembolso-falsa';

/**
 * As dependências da gestão do reembolso para o teste: planilha em memória, fila, raw e Chat falsos (nada vai à fila,
 * nenhuma consulta, nenhum aviso de verdade). `agora` é um instante em que o dia de São Paulo (30/10/2026) difere do
 * dia UTC (31/10), para o teste provar que a data de execução sai no fuso certo.
 */

export const AGORA = new Date('2026-10-31T01:30:00Z');
export const HOJE_EM_SP = '30/10/2026';
/** O instante-limite de cada etapa da planilha nos testes: o teste confere que a gestão o repassa à planilha. */
export const PRAZO_DA_PLANILHA = 1_900_000_015_000;

/** Um id de solicitação de exemplo: UUID fixo, o formato que a rota exige. */
export const ID_EXEMPLO = '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f';

export interface DepsFalsas extends RefundGestaoDeps {
    planilha: PlanilhaFalsa;
    buscarReembolsoMaisRecente: Mock<RefundGestaoDeps['buscarReembolsoMaisRecente']>;
    buscarCasoPorId: Mock<RefundGestaoDeps['buscarCasoPorId']>;
    enfileirarAtualizacao: Mock<RefundGestaoDeps['enfileirarAtualizacao']>;
    configuracaoQueFalta: Mock<RefundGestaoDeps['configuracaoQueFalta']>;
    avisar: Mock<(contexto: AlertContext) => Promise<unknown>>;
}

/** O caso de reembolso que a raw devolve para o id: aberto, a menos que o teste diga outra coisa. */
export function casoNaRaw(sobrescritas: Partial<CasoNaRaw> = {}): CasoNaRaw {
    return {
        idSolicitacao: ID_EXEMPLO,
        tipo: 'REEMBOLSO',
        marca: 'lescent',
        numeroPedido: PEDIDO_EXEMPLO,
        criadoEm: CRIADO_EM_EXEMPLO,
        status: 'aberto',
        dataExecucao: null,
        responsavelExecucao: null,
        ...sobrescritas,
    };
}

export function depsFalsas(planilha: PlanilhaFalsa = new PlanilhaFalsa()): DepsFalsas {
    return {
        planilha,
        buscarReembolsoMaisRecente: vi.fn<RefundGestaoDeps['buscarReembolsoMaisRecente']>().mockResolvedValue(null),
        buscarCasoPorId: vi.fn<RefundGestaoDeps['buscarCasoPorId']>().mockResolvedValue(casoNaRaw()),
        enfileirarAtualizacao: vi.fn<RefundGestaoDeps['enfileirarAtualizacao']>().mockResolvedValue({ status: 'enfileirado' }),
        prazoDaPlanilha: vi.fn<RefundGestaoDeps['prazoDaPlanilha']>().mockReturnValue(PRAZO_DA_PLANILHA),
        configuracaoQueFalta: vi.fn<RefundGestaoDeps['configuracaoQueFalta']>().mockReturnValue(null),
        avisar: vi.fn<(contexto: AlertContext) => Promise<unknown>>().mockResolvedValue(true),
        agora: () => AGORA,
    };
}
