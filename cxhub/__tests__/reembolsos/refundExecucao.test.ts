import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { problemaNaAtualizacao } from '@shared/lib/airflow/contrato';
import { concluirReembolso, sincronizarReembolso } from '@modules/reembolsos/actions/refundExecucao';
import { NO_PROXIMO_LOTE } from '@modules/reembolsos/actions/refundGestaoComum';
import type { RefundExecutionRequest } from '@modules/reembolsos/types/management';
import {
    HOJE_EM_SP,
    ID_EXEMPLO,
    PRAZO_DA_PLANILHA,
    casoNaRaw,
    depsFalsas,
    type DepsFalsas,
} from '../helpers/refund-gestao-deps';
import { CRIADO_EM_EXEMPLO, PEDIDO_EXEMPLO, PlanilhaFalsa } from '../helpers/planilha-reembolso-falsa';

/**
 * Marcar como concluído e atualizar o acompanhamento. Planilha em memória, fila, estado (raw + fila) e Chat falsos: nada
 * vai à fila, nenhuma consulta e nenhum aviso de verdade. O id é um UUID fixo de exemplo (a rota exige UUID); o agente, um marcador.
 */

const ID = ID_EXEMPLO;
const AGENTE = '<agente>';
const PEDIDO: RefundExecutionRequest = { brand: 'lescent', idSolicitacao: ID, handledBy: AGENTE };

// Lescent: status 4, data 5, responsável 6.
const CABECALHO = [
    'Carimbo de data/hora', 'Número do pedido', 'Valor do reembolso', 'Motivo da solicitação do reembolso?',
    'Status do reembolso', 'Data de Execução', 'Responsável Reembolso',
];
const COL = { status: 4, data: 5, responsavel: 6 };

/** A linha do caso na planilha: o que o backoffice preencheu (status, data, responsável) vem por parâmetro. */
function linhaDoCaso(status: string | null, data: string | number | null = null, responsavel: string | null = null) {
    return ['28/10/2026 10:00:00', PEDIDO_EXEMPLO, '59,90', 'Extravio', status, data, responsavel];
}

function montar(linha: ReturnType<typeof linhaDoCaso> | null = linhaDoCaso(null)): { deps: DepsFalsas; planilha: PlanilhaFalsa } {
    const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
    if (linha) planilha.adicionarCaso('lescent', linha);
    return { deps: depsFalsas(planilha), planilha };
}

const MENSAGEM_PLANILHA_REALIZADA =
    'A planilha já marca este reembolso como Realizado: nada foi alterado. Use "Atualizar acompanhamento" para levar o Realizado da planilha ao Metabase.';

let erroLog: MockInstance;
let log: MockInstance;

beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    erroLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('concluirReembolso', () => {
    it('enfileira Realizado, com a data de hoje em São Paulo e o agente, e depois acompanha a planilha', async () => {
        const { deps, planilha } = montar();
        // Antes da fila só se LÊ a planilha (a trava do Realizado); nada é escrito até a fila aceitar.
        deps.enfileirarAtualizacao.mockImplementation(async () => {
            expect(planilha.chamadas).not.toContain('atualizarCelulas');
            expect(planilha.escritas).toEqual([]);
            return { status: 'enfileirado' };
        });

        expect(await concluirReembolso(PEDIDO, deps)).toEqual({
            status: 200,
            body: { code: 'SUCCESS', message: `Reembolso marcado como concluído. ${NO_PROXIMO_LOTE}` },
        });

        expect(deps.buscarCasoPorId).toHaveBeenCalledWith(ID);
        expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
        const [id, atualizacao] = deps.enfileirarAtualizacao.mock.calls[0];
        expect(id).toBe(ID);
        expect(atualizacao).toStrictEqual({ status_execucao: 'Realizado', data_execucao: HOJE_EM_SP, responsavel_execucao: AGENTE });
        expect(problemaNaAtualizacao(id, atualizacao)).toBeNull();

        expect(planilha.escritas).toEqual([
            { marca: 'lescent', linha: 2, coluna: COL.status, valor: 'Realizado' },
            { marca: 'lescent', linha: 2, coluna: COL.data, valor: HOJE_EM_SP },
            { marca: 'lescent', linha: 2, coluna: COL.responsavel, valor: AGENTE },
        ]);
        expect(planilha.valoresDaLinha('lescent', 2).slice(COL.status)).toEqual(['Realizado', HOJE_EM_SP, AGENTE]);
        expect(deps.avisar).not.toHaveBeenCalled();
    });

    it('toda chamada à planilha leva o prazo da etapa', async () => {
        const { deps, planilha } = montar();

        await concluirReembolso(PEDIDO, deps);

        expect(planilha.chamadas).toEqual([
            // a leitura que trava o Realizado da planilha (antes da fila)
            'acharLinhaDoCaso', 'lerCabecalho', 'lerLinha',
            // a escrita (depois da fila)
            'acharLinhaDoCaso', 'lerCabecalho', 'atualizarCelulas',
        ]);
        expect(planilha.prazos.every((prazo) => prazo === PRAZO_DA_PLANILHA)).toBe(true);
    });

    describe('o id é amarrado ao tipo e à marca', () => {
        it.each([
            ['id que a raw não conhece', null],
            ['id de um reenvio', casoNaRaw({ tipo: 'REENVIO' })],
            ['id de um cancelamento', casoNaRaw({ tipo: 'CANCELAMENTO' })],
            ['id de um reembolso de outra marca', casoNaRaw({ marca: 'kokeshi' })],
        ])('%s ⇒ 404 NOT_FOUND, sem enfileirar e sem tocar a planilha', async (_nome, caso) => {
            const { deps, planilha } = montar();
            deps.buscarCasoPorId.mockResolvedValue(caso);

            expect(await concluirReembolso(PEDIDO, deps)).toEqual({
                status: 404,
                body: { code: 'NOT_FOUND', message: 'Nenhuma solicitação de reembolso com este id nesta marca. Nada foi alterado.' },
            });

            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
            expect(planilha.chamadas).toEqual([]);
            expect(deps.avisar).not.toHaveBeenCalled();
        });
    });

    describe('o caso já está Realizado no registro: a planilha é reescrita antes da trava (repetir conserta)', () => {
        const JA_REALIZADO = 'O reembolso já foi marcado como realizado: não dá para concluir de novo.';

        it('planilha atrasada: reescreve Realizado com a data e o responsável que o caso tem, não os de hoje', async () => {
            const { deps, planilha } = montar();
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'realizado', dataExecucao: '29/10/2026', responsavelExecucao: '<outra-pessoa>' }));

            expect(await concluirReembolso(PEDIDO, deps)).toEqual({
                status: 422,
                body: { code: 'ALREADY_EXECUTED', message: `${JA_REALIZADO} A planilha foi atualizada para Realizado.` },
            });

            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
            expect(planilha.escritas).toEqual([
                { marca: 'lescent', linha: 2, coluna: COL.status, valor: 'Realizado' },
                { marca: 'lescent', linha: 2, coluna: COL.data, valor: '29/10/2026' },
                { marca: 'lescent', linha: 2, coluna: COL.responsavel, valor: '<outra-pessoa>' },
            ]);
            expect(deps.avisar).not.toHaveBeenCalled();
        });

        it('o caso sem data nem responsável: reescreve só o status, sem inventar a data de hoje', async () => {
            const { deps, planilha } = montar();
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'realizado' }));

            const resposta = await concluirReembolso(PEDIDO, deps);

            expect(resposta.status).toBe(422);
            expect(planilha.escritas).toEqual([{ marca: 'lescent', linha: 2, coluna: COL.status, valor: 'Realizado' }]);
        });

        it('a data do caso em outro formato (aaaa-mm-dd) vai como dd/mm/aaaa', async () => {
            const { deps, planilha } = montar();
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'realizado', dataExecucao: '2026-10-29' }));

            await concluirReembolso(PEDIDO, deps);

            expect(planilha.escritas).toContainEqual({ marca: 'lescent', linha: 2, coluna: COL.data, valor: '29/10/2026' });
        });

        it('a planilha já marca Realizado: nada fora de sincronia, só a trava', async () => {
            const { deps, planilha } = montar(linhaDoCaso('Realizado', '29/10/2026', '<outra-pessoa>'));
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'realizado' }));

            expect(await concluirReembolso(PEDIDO, deps)).toEqual({
                status: 422,
                body: { code: 'ALREADY_EXECUTED', message: JA_REALIZADO },
            });
            expect(planilha.escritas).toEqual([]);
        });

        it('a planilha marca Cancelado: ela vence, então não é reescrita e a mensagem manda sincronizar', async () => {
            const { deps, planilha } = montar(linhaDoCaso('Cancelado'));
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'realizado' }));

            const resposta = await concluirReembolso(PEDIDO, deps);

            expect(resposta.status).toBe(422);
            expect(resposta.body.code).toBe('ALREADY_EXECUTED');
            expect(resposta.body.message).toContain('a planilha marca Cancelado');
            expect(resposta.body.message).toContain('Atualizar acompanhamento');
            expect(planilha.escritas).toEqual([]);
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        });

        it('a planilha não responde ao escrever: a trava leva SHEET_WRITE_FAILED, manda ajustar à mão e avisa o Chat', async () => {
            const { deps, planilha } = montar();
            planilha.falhaEm.add('atualizarCelulas');
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'realizado' }));

            const resposta = await concluirReembolso(PEDIDO, deps);

            expect(resposta).toEqual({
                status: 422,
                body: {
                    code: 'ALREADY_EXECUTED',
                    reason: 'SHEET_WRITE_FAILED',
                    message: `${JA_REALIZADO} A planilha não foi atualizada (a planilha não respondeu): ajuste à mão.`,
                },
            });
            expect(deps.avisar).toHaveBeenCalledTimes(1);
            expect(deps.avisar.mock.calls[0][0]).toMatchObject({ reason: 'SHEET_WRITE_FAILED', requestId: ID, brand: 'lescent' });
        });

        it('a linha do caso não está na planilha: a trava leva SHEET_ROW_NOT_FOUND', async () => {
            const { deps } = montar(null);
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'realizado' }));

            const resposta = await concluirReembolso(PEDIDO, deps);

            expect(resposta.status).toBe(422);
            expect(resposta.body.reason).toBe('SHEET_ROW_NOT_FOUND');
            expect(deps.avisar.mock.calls[0][0]).toMatchObject({ reason: 'SHEET_ROW_NOT_FOUND', agruparPor: 'reembolso/lescent' });
        });
    });

    it('caso já cancelado ⇒ 422 ALREADY_EXECUTED, sem enfileirar e sem escrever na planilha', async () => {
        const { deps, planilha } = montar();
        deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'cancelado' }));

        expect(await concluirReembolso(PEDIDO, deps)).toEqual({
            status: 422,
            body: { code: 'ALREADY_EXECUTED', message: 'A solicitação já está cancelada: não dá para marcá-la como concluída.' },
        });

        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        expect(planilha.escritas).toEqual([]);
    });

    it.each(['aberto', 'pendente'])('caso %s não trava: conclui', async (status) => {
        const { deps } = montar();
        deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status }));

        expect((await concluirReembolso(PEDIDO, deps)).status).toBe(200);
        expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
    });

    describe('a planilha vence: o Realizado que o backoffice marcou lá trava, mesmo com o registro diferente', () => {
        it.each(['aberto', 'pendente', 'cancelado'])(
            'planilha Realizado e registro %s ⇒ 422 sugerindo "Atualizar acompanhamento", sem enfileirar e sem escrever',
            async (status) => {
                const { deps, planilha } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));
                deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status }));

                expect(await concluirReembolso(PEDIDO, deps)).toEqual({
                    status: 422,
                    body: { code: 'ALREADY_EXECUTED', message: MENSAGEM_PLANILHA_REALIZADA },
                });

                expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
                expect(planilha.escritas).toEqual([]);
            },
        );

        it.each([
            ['com a linha sem o id (SHEET_ROW_NOT_FOUND já é avisado ao escrever)', null as ReturnType<typeof linhaDoCaso> | null, undefined],
            ['com a leitura da linha que falha', linhaDoCaso('Realizado'), 'lerLinha' as const],
            ['com a leitura do cabeçalho que falha', linhaDoCaso('Realizado'), 'lerCabecalho' as const],
        ])('planilha ilegível não bloqueia, %s', async (_nome, linha, falhaEm) => {
            const { deps, planilha } = montar(linha);
            if (falhaEm) planilha.falhaEm.add(falhaEm);

            const resposta = await concluirReembolso(PEDIDO, deps);

            // A trava não pôde ler a planilha, então segue como se ela não dissesse nada: enfileira.
            expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
            expect(resposta.status).toBe(200);
            expect(resposta.body.code).toBe('SUCCESS');
        });

        it('planilha sem a coluna do status não bloqueia', async () => {
            const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO.filter((c) => c !== 'Status do reembolso'));
            planilha.adicionarCaso('lescent', linhaDoCaso('Realizado'));
            const deps = depsFalsas(planilha);

            await concluirReembolso(PEDIDO, deps);

            expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
        });
    });

    it('raw que não responde ⇒ 502 UNKNOWN_ERROR, nada alterado', async () => {
        const { deps, planilha } = montar();
        deps.buscarCasoPorId.mockRejectedValue(new Error('Metabase não respondeu'));

        expect(await concluirReembolso(PEDIDO, deps)).toEqual({
            status: 502,
            body: { code: 'UNKNOWN_ERROR', message: 'Não foi possível consultar a solicitação. Nada foi alterado.' },
        });
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        expect(planilha.chamadas).toEqual([]);
    });

    it('faltou configuração (planilha ou fila) ⇒ 503 antes de consultar qualquer coisa', async () => {
        const { deps, planilha } = montar();
        deps.configuracaoQueFalta.mockReturnValue('as planilhas não estão configuradas (GOOGLE_PLANILHAS_EMAIL, GOOGLE_PLANILHAS_TOKEN e SHEETS_ENV)');

        const resposta = await concluirReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(503);
        expect(resposta.body.code).toBe('UNKNOWN_ERROR');
        expect(resposta.body.message).toContain('concluir o reembolso');
        expect(resposta.body.message).toContain('GOOGLE_PLANILHAS_EMAIL');
        expect(resposta.body.message).toContain('nada foi alterado');
        expect(deps.buscarCasoPorId).not.toHaveBeenCalled();
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        expect(planilha.chamadas).toEqual([]);
    });

    it('fila recusou ⇒ 502 SHEETS_ERROR e a planilha não é escrita', async () => {
        const { deps, planilha } = montar();
        deps.enfileirarAtualizacao.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400 INVALID_REQUEST' });

        expect(await concluirReembolso(PEDIDO, deps)).toEqual({
            status: 502,
            body: { code: 'SHEETS_ERROR', message: 'Não foi possível registrar a alteração (a fila respondeu HTTP 400 INVALID_REQUEST).' },
        });
        expect(planilha.escritas).toEqual([]);
        expect(planilha.chamadas).not.toContain('atualizarCelulas');
    });

    it('fila incerta ⇒ 504 mandando repetir (não duplica), avisando que a planilha NÃO foi atualizada, e a planilha fica sem escrita', async () => {
        const { deps, planilha } = montar();
        deps.enfileirarAtualizacao.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });

        const resposta = await concluirReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(504);
        expect(resposta.body.code).toBe('API_TIMEOUT');
        expect(resposta.body.message).toBe(
            'Não deu para confirmar a entrada da alteração na fila do Metabase (a fila respondeu HTTP 502). '
            + 'A planilha não foi atualizada. Repita a ação: repetir não duplica a alteração.',
        );
        expect(planilha.escritas).toEqual([]);
        expect(planilha.chamadas).not.toContain('atualizarCelulas');
    });

    it('linha sem o id na planilha ⇒ SUCCESS com SHEET_ROW_NOT_FOUND, a fila já aceitou, e o Chat é avisado', async () => {
        const { deps, planilha } = montar(null);

        const resposta = await concluirReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(200);
        expect(resposta.body).toEqual({
            code: 'SUCCESS',
            reason: 'SHEET_ROW_NOT_FOUND',
            message:
                'Reembolso concluído na fila do Metabase, mas a planilha não foi atualizada (a linha do caso não está na planilha). Atualize a planilha à mão.',
        });
        expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
        expect(planilha.escritas).toEqual([]);
        // O log leva o id, não dado pessoal.
        expect(erroLog).toHaveBeenCalledWith(expect.stringContaining(ID));

        expect(deps.avisar).toHaveBeenCalledTimes(1);
        expect(deps.avisar.mock.calls[0][0]).toEqual({
            reason: 'SHEET_ROW_NOT_FOUND',
            motivo: `Concluir reembolso: ${resposta.body.message}`,
            requestId: ID,
            brand: 'lescent',
            numeroPedido: 'SH9000105LC',
            agruparPor: 'reembolso/lescent',
        });
    });

    it('planilha fora do ar ao escrever ⇒ SUCCESS com SHEET_WRITE_FAILED e UM aviso no Chat, por caso', async () => {
        const { deps, planilha } = montar();
        planilha.falhaEm.add('atualizarCelulas');

        const resposta = await concluirReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(200);
        expect(resposta.body.code).toBe('SUCCESS');
        expect(resposta.body.reason).toBe('SHEET_WRITE_FAILED');
        expect(resposta.body.message).toContain('Reembolso concluído na fila do Metabase, mas a planilha não foi atualizada');
        expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);

        expect(deps.avisar).toHaveBeenCalledTimes(1);
        const aviso = deps.avisar.mock.calls[0][0];
        expect(aviso).toMatchObject({ reason: 'SHEET_WRITE_FAILED', requestId: ID, brand: 'lescent', numeroPedido: 'SH9000105LC' });
        // Escrita que falhou é por caso: sem agrupar por marca.
        expect(aviso.agruparPor).toBeUndefined();
    });

    it('o aviso nunca altera a resposta: Chat que lança não vira erro', async () => {
        const { deps, planilha } = montar();
        planilha.falhaEm.add('atualizarCelulas');
        deps.avisar.mockRejectedValue(new Error('Chat fora do ar'));

        const resposta = await concluirReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(200);
        expect(resposta.body.reason).toBe('SHEET_WRITE_FAILED');
    });

    it('o aviso não leva dado pessoal: só os campos de identificação do caso', async () => {
        const { deps, planilha } = montar();
        planilha.falhaEm.add('atualizarCelulas');

        await concluirReembolso(PEDIDO, deps);

        const preenchidos = Object.entries(deps.avisar.mock.calls[0][0]).filter(([, valor]) => valor !== undefined);
        expect(preenchidos.map(([campo]) => campo).sort()).toEqual(['brand', 'motivo', 'numeroPedido', 'reason', 'requestId']);
    });

    describe('grava as colunas que existirem e avisa das que faltam', () => {
        it('cabeçalho sem a coluna da data ⇒ escreve o status e o responsável e diz qual coluna faltou (SHEET_WRITE_FAILED)', async () => {
            const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO.filter((c) => c !== 'Data de Execução'));
            planilha.adicionarCaso('lescent', ['28/10/2026 10:00:00', PEDIDO_EXEMPLO, '59,90', 'Extravio', null, null]);
            const deps = depsFalsas(planilha);

            const resposta = await concluirReembolso(PEDIDO, deps);

            expect(resposta.status).toBe(200);
            expect(resposta.body.reason).toBe('SHEET_WRITE_FAILED');
            expect(resposta.body.message).toContain('"Data de Execução"');
            // Sem a coluna da data, o responsável é a 6ª célula (índice 5).
            expect(planilha.escritas).toEqual([
                { marca: 'lescent', linha: 2, coluna: 4, valor: 'Realizado' },
                { marca: 'lescent', linha: 2, coluna: 5, valor: AGENTE },
            ]);
            expect(deps.avisar).toHaveBeenCalledTimes(1);
        });

        it('cabeçalho sem a coluna do status ⇒ escreve data e responsável e diz que faltou o status', async () => {
            const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO.filter((c) => c !== 'Status do reembolso'));
            planilha.adicionarCaso('lescent', ['28/10/2026 10:00:00', PEDIDO_EXEMPLO, '59,90', 'Extravio', null, null]);
            const deps = depsFalsas(planilha);

            const resposta = await concluirReembolso(PEDIDO, deps);

            expect(resposta.body.reason).toBe('SHEET_WRITE_FAILED');
            expect(resposta.body.message).toContain('"Status do reembolso"');
            expect(planilha.escritas.map(({ valor }) => valor)).toEqual([HOJE_EM_SP, AGENTE]);
        });

        it('cabeçalho sem nenhuma das três ⇒ nada é escrito, e a mensagem lista as três', async () => {
            const planilha = new PlanilhaFalsa().adicionarAba('lescent', ['Carimbo de data/hora', 'Número do pedido']);
            planilha.adicionarCaso('lescent', ['28/10/2026 10:00:00', PEDIDO_EXEMPLO]);
            const deps = depsFalsas(planilha);

            const resposta = await concluirReembolso(PEDIDO, deps);

            expect(resposta.body.reason).toBe('SHEET_WRITE_FAILED');
            expect(resposta.body.message).toContain('"Status do reembolso", "Data de Execução", "Responsável Reembolso"');
            expect(planilha.escritas).toEqual([]);
        });
    });

    it('Auá escreve a data em "Realizada em"', async () => {
        const planilha = new PlanilhaFalsa().adicionarAba('aua', ['Número do pedido', 'Status', 'Realizada em', 'Responsável Reembolso']);
        planilha.adicionarCaso('aua', [PEDIDO_EXEMPLO, null, null, null]);
        const deps = depsFalsas(planilha);
        deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ marca: 'aua' }));

        await concluirReembolso({ ...PEDIDO, brand: 'aua' }, deps);

        expect(planilha.valoresDaLinha('aua', 2)).toEqual([PEDIDO_EXEMPLO, 'Realizado', HOJE_EM_SP, AGENTE]);
    });

    it('registra no log quem concluiu', async () => {
        const { deps } = montar();

        await concluirReembolso(PEDIDO, deps);

        expect(log).toHaveBeenCalledWith(expect.stringContaining(`marcado como realizado por ${AGENTE}`));
    });
});

describe('sincronizarReembolso', () => {
    it.each([
        ['Pendente'],
        ['Com Pendência'],
        ['Enviado financeiro'],
        [null],
    ])('planilha com %j ⇒ NO_CHANGE, sem enfileirar (a raw é lida antes, para achar a linha)', async (status) => {
        const { deps, planilha } = montar(linhaDoCaso(status, '25/10/2026', '<responsavel>'));

        expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
            status: 200,
            body: {
                code: 'NO_CHANGE',
                message: 'A planilha ainda não marca o reembolso como Realizado nem como Cancelado: nada para levar ao Metabase.',
            },
        });

        expect(deps.buscarCasoPorId).toHaveBeenCalledWith(ID);
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        expect(planilha.escritas).toEqual([]);
    });

    it.each([
        ['Realizado', 'realizado'],
        ['Cancelado', 'cancelado'],
    ])('planilha %s e raw já %s ⇒ NO_CHANGE, sem enfileirar', async (naPlanilha, naRaw) => {
        const { deps } = montar(linhaDoCaso(naPlanilha, '25/10/2026', '<responsavel>'));
        deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: naRaw }));

        const resposta = await sincronizarReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(200);
        expect(resposta.body.code).toBe('NO_CHANGE');
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
    });

    it('Realizado na planilha com o caso aberto ⇒ enfileira com a data e o responsável da planilha', async () => {
        const { deps, planilha } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));

        expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
            status: 200,
            body: {
                code: 'SUCCESS',
                message: `Acompanhamento atualizado: Realizado (execução em 25/10/2026 por <responsavel>) foi para a fila do Metabase. ${NO_PROXIMO_LOTE}`,
            },
        });

        expect(deps.buscarCasoPorId).toHaveBeenCalledWith(ID);
        expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
        const [id, atualizacao] = deps.enfileirarAtualizacao.mock.calls[0];
        expect(id).toBe(ID);
        expect(atualizacao).toStrictEqual({
            status_execucao: 'Realizado',
            data_execucao: '25/10/2026',
            responsavel_execucao: '<responsavel>',
        });
        expect(problemaNaAtualizacao(id, atualizacao)).toBeNull();
        // Sincronizar só lê a planilha.
        expect(planilha.escritas).toEqual([]);
        expect(planilha.chamadas).not.toContain('atualizarCelulas');
        expect(planilha.prazos.every((p) => p === PRAZO_DA_PLANILHA)).toBe(true);
    });

    describe('a planilha vence: o que o backoffice marcou lá vai à fila mesmo que o registro diga outra coisa', () => {
        it('planilha Realizado com o registro Cancelado ⇒ leva Realizado, com a data e o responsável', async () => {
            const { deps, planilha } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'cancelado' }));

            expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
                status: 200,
                body: {
                    code: 'SUCCESS',
                    message: `Acompanhamento atualizado: Realizado (execução em 25/10/2026 por <responsavel>) foi para a fila do Metabase. ${NO_PROXIMO_LOTE}`,
                },
            });

            expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
            const [id, atualizacao] = deps.enfileirarAtualizacao.mock.calls[0];
            expect(atualizacao).toStrictEqual({
                status_execucao: 'Realizado',
                data_execucao: '25/10/2026',
                responsavel_execucao: '<responsavel>',
            });
            expect(problemaNaAtualizacao(id, atualizacao)).toBeNull();
            expect(planilha.escritas).toEqual([]);
        });

        it('planilha Cancelado com o registro Realizado ⇒ leva Cancelado, sem data (mesmo com data na célula)', async () => {
            const { deps, planilha } = montar(linhaDoCaso('Cancelado', '25/10/2026', '<responsavel>'));
            deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'realizado', dataExecucao: '24/10/2026', responsavelExecucao: '<outra-pessoa>' }));

            expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
                status: 200,
                body: { code: 'SUCCESS', message: `Acompanhamento atualizado: Cancelado (por <responsavel>) foi para a fila do Metabase. ${NO_PROXIMO_LOTE}` },
            });

            expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
            const [id, atualizacao] = deps.enfileirarAtualizacao.mock.calls[0];
            expect(atualizacao).toStrictEqual({ status_execucao: 'Cancelado', responsavel_execucao: '<responsavel>' });
            expect(atualizacao).not.toHaveProperty('data_execucao');
            expect(problemaNaAtualizacao(id, atualizacao)).toBeNull();
            expect(planilha.escritas).toEqual([]);
        });
    });

    it('Realizado na planilha com o caso pendente também leva', async () => {
        const { deps } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));
        deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'pendente' }));

        expect((await sincronizarReembolso(PEDIDO, deps)).body.code).toBe('SUCCESS');
        expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
    });

    it('Cancelado na planilha ⇒ status Cancelado, sem data_execucao (mesmo com data na célula)', async () => {
        const { deps } = montar(linhaDoCaso(' CANCELADO ', '25/10/2026', '<responsavel>'));

        expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
            status: 200,
            body: { code: 'SUCCESS', message: `Acompanhamento atualizado: Cancelado (por <responsavel>) foi para a fila do Metabase. ${NO_PROXIMO_LOTE}` },
        });

        const [id, atualizacao] = deps.enfileirarAtualizacao.mock.calls[0];
        expect(atualizacao).toStrictEqual({ status_execucao: 'Cancelado', responsavel_execucao: '<responsavel>' });
        expect(problemaNaAtualizacao(id, atualizacao)).toBeNull();
    });

    it.each([
        ['data vazia', null, '<responsavel>', { status_execucao: 'Realizado', responsavel_execucao: '<responsavel>' }],
        ['data que não é data', 'semana que vem', '<responsavel>', { status_execucao: 'Realizado', responsavel_execucao: '<responsavel>' }],
        ['responsável vazio', '25/10/2026', null, { status_execucao: 'Realizado', data_execucao: '25/10/2026' }],
        ['responsável só com espaço', '25/10/2026', '   ', { status_execucao: 'Realizado', data_execucao: '25/10/2026' }],
        ['os dois vazios', null, null, { status_execucao: 'Realizado' }],
        ['data como número serial', 46325, '<responsavel>', { status_execucao: 'Realizado', data_execucao: '30/10/2026', responsavel_execucao: '<responsavel>' }],
    ])('%s vai sem o campo (ou normalizada), em vez de mandar lixo', async (_nome, data, responsavel, esperado) => {
        const { deps } = montar(linhaDoCaso('Realizado', data, responsavel));

        expect((await sincronizarReembolso(PEDIDO, deps)).body.code).toBe('SUCCESS');

        const [id, atualizacao] = deps.enfileirarAtualizacao.mock.calls[0];
        expect(atualizacao).toStrictEqual(esperado);
        expect(problemaNaAtualizacao(id, atualizacao)).toBeNull();
    });

    it('nunca manda Pendente para a fila, venha o que vier da planilha', async () => {
        for (const status of ['Pendente', 'pendente', 'Com Pendência', '', null]) {
            const { deps } = montar(linhaDoCaso(status));
            await sincronizarReembolso(PEDIDO, deps);
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        }
    });

    describe('o id é amarrado ao tipo e à marca', () => {
        it.each([
            ['id que a raw não conhece', null],
            ['id de um reenvio', casoNaRaw({ tipo: 'REENVIO' })],
            ['id de um cancelamento', casoNaRaw({ tipo: 'CANCELAMENTO' })],
            ['id de um reembolso de outra marca', casoNaRaw({ marca: 'kokeshi' })],
        ])('%s ⇒ 404 NOT_FOUND, sem enfileirar', async (_nome, caso) => {
            const { deps, planilha } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));
            deps.buscarCasoPorId.mockResolvedValue(caso);

            expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
                status: 404,
                body: { code: 'NOT_FOUND', message: 'Nenhuma solicitação de reembolso com este id nesta marca. Nada foi alterado.' },
            });
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
            // O pedido e o horário vêm da raw: sem o caso certo, a planilha nem é consultada.
            expect(planilha.chamadas).toEqual([]);
        });
    });

    it('linha do caso não achada na planilha ⇒ 404 NOT_FOUND com SHEET_ROW_NOT_FOUND, e o Chat é avisado (agrupado por marca)', async () => {
        const { deps } = montar(null);

        expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
            status: 404,
            body: {
                code: 'NOT_FOUND',
                reason: 'SHEET_ROW_NOT_FOUND',
                message: 'A linha deste caso não está na planilha. Nada foi alterado.',
            },
        });
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        expect(deps.avisar).toHaveBeenCalledTimes(1);
        expect(deps.avisar.mock.calls[0][0]).toMatchObject({
            reason: 'SHEET_ROW_NOT_FOUND',
            requestId: ID,
            brand: 'lescent',
            agruparPor: 'reembolso/lescent',
        });
    });

    it.each(['acharLinhaDoCaso', 'lerCabecalho', 'lerLinha'] as const)('planilha que falha em %s ⇒ 502 SHEETS_ERROR com SHEET_READ_FAILED, sem aviso', async (metodo) => {
        const { deps, planilha } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));
        planilha.falhaEm.add(metodo);

        expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
            status: 502,
            body: { code: 'SHEETS_ERROR', reason: 'SHEET_READ_FAILED', message: 'Não foi possível ler a planilha. Nada foi alterado.' },
        });
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        expect(deps.avisar).not.toHaveBeenCalled();
    });

    it('cabeçalho sem a coluna do status ⇒ 502 SHEET_READ_FAILED dizendo qual', async () => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO.filter((c) => c !== 'Status do reembolso'));
        planilha.adicionarCaso('lescent', linhaDoCaso('Realizado'));
        const deps = depsFalsas(planilha);

        const resposta = await sincronizarReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(502);
        expect(resposta.body.reason).toBe('SHEET_READ_FAILED');
        expect(resposta.body.message).toBe('O cabeçalho da planilha não tem a coluna "Status do reembolso". Nada foi alterado.');
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
    });

    it('raw que não responde ⇒ 502 UNKNOWN_ERROR, sem enfileirar', async () => {
        const { deps } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));
        deps.buscarCasoPorId.mockRejectedValue(new Error('Metabase não respondeu'));

        expect(await sincronizarReembolso(PEDIDO, deps)).toEqual({
            status: 502,
            body: { code: 'UNKNOWN_ERROR', message: 'Não foi possível consultar a solicitação. Nada foi alterado.' },
        });
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
    });

    it('faltou configuração ⇒ 503 antes de ler a planilha', async () => {
        const { deps, planilha } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));
        deps.configuracaoQueFalta.mockReturnValue('a fila do Metabase não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)');

        const resposta = await sincronizarReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(503);
        expect(resposta.body.message).toContain('atualizar o acompanhamento');
        expect(resposta.body.message).toContain('CXHUB_FILA_URL');
        expect(planilha.chamadas).toEqual([]);
        expect(deps.buscarCasoPorId).not.toHaveBeenCalled();
    });

    it('fila recusou ⇒ 502 SHEETS_ERROR; incerta ⇒ 504 API_TIMEOUT, sem falar de planilha (ela é a fonte, não foi tocada)', async () => {
        const { deps } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));

        deps.enfileirarAtualizacao.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400 INVALID_REQUEST' });
        expect((await sincronizarReembolso(PEDIDO, deps)).status).toBe(502);

        deps.enfileirarAtualizacao.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });
        const incerta = await sincronizarReembolso(PEDIDO, deps);
        expect(incerta.status).toBe(504);
        expect(incerta.body.code).toBe('API_TIMEOUT');
        expect(incerta.body.message).toBe(
            'Não deu para confirmar a entrada da alteração na fila do Metabase (a fila respondeu HTTP 502). Repita a ação: repetir não duplica a alteração.',
        );
    });

    it('registra no log quem disparou a sincronização', async () => {
        const { deps } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));

        await sincronizarReembolso(PEDIDO, deps);

        expect(log).toHaveBeenCalledWith(expect.stringContaining(`sincronizado com a planilha por ${AGENTE}: Realizado`));
        expect(log).toHaveBeenCalledWith(expect.stringContaining(ID));
    });
});

describe('a linha do caso se acha pelo pedido e pelo horário (o carimbo é o criado_em do caso)', () => {
    const MIN = 60_000;
    const em = (ms: number) => new Date(CRIADO_EM_EXEMPLO.getTime() + ms);

    /** Uma planilha com várias linhas do mesmo pedido (e de outro), cada uma com o seu carimbo; devolve o número de cada. */
    function montarComVariasLinhas() {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        const outroCaso = planilha.adicionarCaso('lescent', linhaDoCaso(null), { pedido: PEDIDO_EXEMPLO, criadoEm: em(-10 * MIN) });
        const certa = planilha.adicionarCaso('lescent', linhaDoCaso(null), { pedido: PEDIDO_EXEMPLO, criadoEm: em(30_000) });
        const outroPedido = planilha.adicionarCaso('lescent', linhaDoCaso(null), { pedido: 'SH9999999LC', criadoEm: CRIADO_EM_EXEMPLO });
        return { planilha, deps: depsFalsas(planilha), outroCaso, certa, outroPedido };
    }

    it('o registro entrega o pedido e o criado_em, e a planilha os recebe para achar a linha (concluir e sincronizar)', async () => {
        const { deps, planilha } = montar(linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'));

        await concluirReembolso(PEDIDO, deps);
        await sincronizarReembolso(PEDIDO, deps);

        expect(planilha.casosProcurados.length).toBeGreaterThan(0);
        for (const caso of planilha.casosProcurados) {
            expect(caso).toEqual({ idSolicitacao: ID, pedido: PEDIDO_EXEMPLO, criadoEm: CRIADO_EM_EXEMPLO });
        }
    });

    it('duas linhas do mesmo pedido com carimbos diferentes ⇒ concluir escreve na do carimbo certo, não na outra nem na de outro pedido', async () => {
        const { deps, planilha, outroCaso, certa, outroPedido } = montarComVariasLinhas();

        const resposta = await concluirReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(200);
        expect(resposta.body).not.toHaveProperty('reason');
        expect(planilha.escritas.map((e) => e.linha)).toEqual([certa, certa, certa]);
        expect(planilha.valoresDaLinha('lescent', certa)[COL.status]).toBe('Realizado');
        expect(planilha.valoresDaLinha('lescent', outroCaso)[COL.status]).toBeNull();
        expect(planilha.valoresDaLinha('lescent', outroPedido)[COL.status]).toBeNull();
    });

    it('duas linhas do mesmo pedido ⇒ sincronizar lê a do carimbo certo (a outra, Cancelado, é de outro caso)', async () => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        planilha.adicionarCaso('lescent', linhaDoCaso('Cancelado', null, '<outra-pessoa>'), { pedido: PEDIDO_EXEMPLO, criadoEm: em(-10 * MIN) });
        planilha.adicionarCaso('lescent', linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'), { pedido: PEDIDO_EXEMPLO, criadoEm: em(30_000) });
        const deps = depsFalsas(planilha);

        const resposta = await sincronizarReembolso(PEDIDO, deps);

        expect(resposta.body.code).toBe('SUCCESS');
        expect(deps.enfileirarAtualizacao.mock.calls[0][1]).toStrictEqual({
            status_execucao: 'Realizado',
            data_execucao: '25/10/2026',
            responsavel_execucao: '<responsavel>',
        });
    });

    it('com duas linhas dentro da janela, vale a de carimbo mais próximo', async () => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        planilha.adicionarCaso('lescent', linhaDoCaso(null), { pedido: PEDIDO_EXEMPLO, criadoEm: em(-90_000) });
        const maisPerto = planilha.adicionarCaso('lescent', linhaDoCaso(null), { pedido: PEDIDO_EXEMPLO, criadoEm: em(20_000) });
        const deps = depsFalsas(planilha);

        await concluirReembolso(PEDIDO, deps);

        expect([...new Set(planilha.escritas.map((e) => e.linha))]).toEqual([maisPerto]);
    });

    it.each([
        ['3 min depois do criado_em', em(3 * MIN)],
        ['3 min antes do criado_em', em(-3 * MIN)],
        ['2 min e 1 s depois (um segundo fora da janela)', em(2 * MIN + 1_000)],
    ])('carimbo fora da tolerância (%s) ⇒ a linha não é achada: SHEET_ROW_NOT_FOUND e aviso no Chat', async (_nome, criadoEm) => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        planilha.adicionarCaso('lescent', linhaDoCaso(null), { pedido: PEDIDO_EXEMPLO, criadoEm });
        const deps = depsFalsas(planilha);

        const resposta = await concluirReembolso(PEDIDO, deps);

        expect(resposta.body.code).toBe('SUCCESS'); // a fila já aceitou
        expect(resposta.body.reason).toBe('SHEET_ROW_NOT_FOUND');
        expect(planilha.escritas).toEqual([]);
        expect(deps.avisar.mock.calls[0][0]).toMatchObject({ reason: 'SHEET_ROW_NOT_FOUND', agruparPor: 'reembolso/lescent' });
    });

    it('no limite exato da tolerância (2 min) a linha ainda é a do caso', async () => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        planilha.adicionarCaso('lescent', linhaDoCaso(null), { pedido: PEDIDO_EXEMPLO, criadoEm: em(2 * MIN) });
        const deps = depsFalsas(planilha);

        const resposta = await concluirReembolso(PEDIDO, deps);

        expect(resposta.body).not.toHaveProperty('reason');
        expect(planilha.escritas).toHaveLength(3);
    });

    it('o pedido compara só os dígitos: a linha com "#9000105" é a do caso "SH9000105LC"', async () => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        planilha.adicionarCaso('lescent', linhaDoCaso(null), { pedido: '#9000105', criadoEm: CRIADO_EM_EXEMPLO });
        const deps = depsFalsas(planilha);

        expect((await concluirReembolso(PEDIDO, deps)).body).not.toHaveProperty('reason');
        expect(planilha.escritas).toHaveLength(3);
    });

    it('sincronizar: carimbo fora da tolerância ⇒ 404 com SHEET_ROW_NOT_FOUND, sem enfileirar', async () => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        planilha.adicionarCaso('lescent', linhaDoCaso('Realizado', '25/10/2026', '<responsavel>'), { pedido: PEDIDO_EXEMPLO, criadoEm: em(5 * MIN) });
        const deps = depsFalsas(planilha);

        const resposta = await sincronizarReembolso(PEDIDO, deps);

        expect(resposta.status).toBe(404);
        expect(resposta.body.reason).toBe('SHEET_ROW_NOT_FOUND');
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
    });
});
