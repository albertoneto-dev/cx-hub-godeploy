import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { problemaNaAtualizacao } from '@shared/lib/airflow/contrato';
import type { ReembolsoNaRaw } from '@shared/lib/airflow';
import { MetabaseError } from '@shared/lib/metabase';
import { cancelarReembolsoNaGold, editarReembolsoNaGold } from '@modules/reembolsos/actions/refundGold';
import { NO_PROXIMO_LOTE } from '@modules/reembolsos/actions/refundGestaoComum';
import type { RefundCancelRequest, RefundUpdateRequest } from '@modules/reembolsos/types/management';
import { ID_EXEMPLO, PRAZO_DA_PLANILHA, depsFalsas, type DepsFalsas } from '../helpers/refund-gestao-deps';
import { CRIADO_EM_EXEMPLO, PEDIDO_EXEMPLO, PlanilhaFalsa } from '../helpers/planilha-reembolso-falsa';

/**
 * Cancelar e editar reembolso: a alteração vai à fila do Metabase primeiro (ADR-012) e a planilha só é escrita depois
 * de a fila aceitar; antes dela, a planilha é só lida, para o `Realizado` que o backoffice marcou lá travar a ação.
 * Fila, estado (raw + fila), planilha e Chat são falsos: nada vai à fila, nenhuma consulta e nenhuma escrita de verdade.
 */

const ID = ID_EXEMPLO;
const AGENTE = '<agente>';
const PEDIDO = PEDIDO_EXEMPLO;

const CANCELAR: RefundCancelRequest = { brand: 'lescent', ecommerceOrderId: PEDIDO, handledBy: AGENTE, reason: 'Cliente desistiu' };
const EDITAR: RefundUpdateRequest = {
    brand: 'lescent',
    ecommerceOrderId: PEDIDO,
    handledBy: AGENTE,
    changes: { refundAmount: 59.9, refundReason: 'Extravio' },
};

/** A solicitação de reembolso mais recente do pedido, como o registro (raw + fila) a devolve. */
const ALVO: ReembolsoNaRaw = { idSolicitacao: ID, numeroPedido: PEDIDO, status: 'aberto', criadoEm: CRIADO_EM_EXEMPLO };

// Lescent: valor 2, motivo 3, status 4, data 5, responsável 6.
const CABECALHO = [
    'Carimbo de data/hora', 'Número do pedido', 'Valor do reembolso', 'Motivo da solicitação do reembolso?',
    'Status do reembolso', 'Data de Execução', 'Responsável Reembolso',
];
const LINHA = ['28/10/2026 10:00:00', PEDIDO, '139,90', 'Produto avariado', null, null, null];
const COL = { valor: 2, motivo: 3, status: 4 };

const MENSAGEM_PLANILHA_REALIZADA =
    'A planilha já marca este reembolso como Realizado: nada foi alterado. Use "Atualizar acompanhamento" para levar o Realizado da planilha ao Metabase.';

function montar(
    cabecalho: string[] = CABECALHO,
    linha: (string | null)[] | null = [...LINHA],
): { deps: DepsFalsas; planilha: PlanilhaFalsa } {
    const planilha = new PlanilhaFalsa().adicionarAba('lescent', cabecalho);
    if (linha) planilha.adicionarCaso('lescent', linha);
    const deps = depsFalsas(planilha);
    deps.buscarReembolsoMaisRecente.mockResolvedValue(ALVO);
    return { deps, planilha };
}

/** A linha do caso com o status que o backoffice marcou na planilha. */
const comStatusNaPlanilha = (status: string | null) => [...LINHA.slice(0, COL.status), status, null, null];

describe('gestão de reembolso na fila do Metabase e na planilha (ADR-010, ADR-012)', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('cancelar', () => {
        it('acha a solicitação mais recente do pedido e enfileira Cancelado com quem cancelou', async () => {
            const { deps } = montar();

            expect(await cancelarReembolsoNaGold(CANCELAR, deps)).toEqual({
                status: 200,
                body: { code: 'SUCCESS', message: `Reembolso cancelado. ${NO_PROXIMO_LOTE}` },
            });

            expect(deps.buscarReembolsoMaisRecente).toHaveBeenCalledWith('lescent', PEDIDO);
            expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
            const [id, atualizacao] = deps.enfileirarAtualizacao.mock.calls[0];
            expect(id).toBe(ID);
            // O motivo do cancelamento é texto livre: não vai ao Metabase.
            expect(atualizacao).toStrictEqual({ status_execucao: 'Cancelado', responsavel_execucao: AGENTE });
            expect(problemaNaAtualizacao(id, atualizacao)).toBeNull();
            expect(deps.avisar).not.toHaveBeenCalled();
        });

        it('antes da fila a planilha só é lida; depois que a fila aceitou, marca Cancelado na coluna do status', async () => {
            const { deps, planilha } = montar();
            deps.enfileirarAtualizacao.mockImplementation(async () => {
                // Na hora de enfileirar a planilha foi lida (a trava do Realizado), mas ainda não escrita.
                expect(planilha.chamadas).toEqual(['acharLinhaDoCaso', 'lerCabecalho', 'lerLinha']);
                expect(planilha.escritas).toEqual([]);
                return { status: 'enfileirado' };
            });

            await cancelarReembolsoNaGold(CANCELAR, deps);

            expect(planilha.escritas).toEqual([{ marca: 'lescent', linha: 2, coluna: COL.status, valor: 'Cancelado' }]);
            // Só o status: valor e motivo continuam como estavam.
            expect(planilha.valoresDaLinha('lescent', 2)).toEqual([...LINHA.slice(0, COL.status), 'Cancelado', null, null]);
            expect(planilha.prazos.every((prazo) => prazo === PRAZO_DA_PLANILHA)).toBe(true);
        });

        it('cada marca marca o status na coluna que é dela (Kokeshi: "Status Reembolso")', async () => {
            const planilha = new PlanilhaFalsa().adicionarAba('kokeshi', ['Número do pedido', 'Status', 'Status Reembolso']);
            planilha.adicionarCaso('kokeshi', [PEDIDO, 'texto da operação', null]);
            const deps = depsFalsas(planilha);
            deps.buscarReembolsoMaisRecente.mockResolvedValue(ALVO);

            await cancelarReembolsoNaGold({ ...CANCELAR, brand: 'kokeshi' }, deps);

            expect(planilha.valoresDaLinha('kokeshi', 2)).toEqual([PEDIDO, 'texto da operação', 'Cancelado']);
        });

        describe('o registro já tem a solicitação cancelada: a planilha é reescrita antes da trava (repetir conserta)', () => {
            const JA_CANCELADA = 'A solicitação mais recente deste pedido já está cancelada: não dá mais para alterar.';

            it('planilha atrasada ⇒ reescreve Cancelado e responde 422 dizendo que a planilha foi atualizada', async () => {
                const { deps, planilha } = montar();
                deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status: 'cancelado' });

                expect(await cancelarReembolsoNaGold(CANCELAR, deps)).toEqual({
                    status: 422,
                    body: { code: 'ALREADY_EXECUTED', message: `${JA_CANCELADA} A planilha foi atualizada para Cancelado.` },
                });

                expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
                expect(planilha.escritas).toEqual([{ marca: 'lescent', linha: 2, coluna: COL.status, valor: 'Cancelado' }]);
                expect(deps.avisar).not.toHaveBeenCalled();
            });

            it('planilha já marca Cancelado ⇒ só a trava, sem escrever de novo', async () => {
                const { deps, planilha } = montar(CABECALHO, comStatusNaPlanilha('Cancelado'));
                deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status: 'cancelado' });

                expect(await cancelarReembolsoNaGold(CANCELAR, deps)).toEqual({
                    status: 422,
                    body: { code: 'ALREADY_EXECUTED', message: JA_CANCELADA },
                });
                expect(planilha.escritas).toEqual([]);
            });

            it('planilha marca Realizado ⇒ ela vence: NÃO é reescrita como Cancelado, e a mensagem manda sincronizar', async () => {
                const { deps, planilha } = montar(CABECALHO, comStatusNaPlanilha('Realizado'));
                deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status: 'cancelado' });

                expect(await cancelarReembolsoNaGold(CANCELAR, deps)).toEqual({
                    status: 422,
                    body: { code: 'ALREADY_EXECUTED', message: MENSAGEM_PLANILHA_REALIZADA },
                });
                expect(planilha.escritas).toEqual([]);
                expect(planilha.valoresDaLinha('lescent', 2)[COL.status]).toBe('Realizado');
            });

            it('a planilha não responde ao escrever ⇒ a trava leva SHEET_WRITE_FAILED e manda ajustar à mão, e avisa o Chat', async () => {
                const { deps, planilha } = montar();
                planilha.falhaEm.add('atualizarCelulas');
                deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status: 'cancelado' });

                expect(await cancelarReembolsoNaGold(CANCELAR, deps)).toEqual({
                    status: 422,
                    body: {
                        code: 'ALREADY_EXECUTED',
                        reason: 'SHEET_WRITE_FAILED',
                        message: `${JA_CANCELADA} A planilha não foi atualizada (a planilha não respondeu): ajuste à mão.`,
                    },
                });
                expect(deps.avisar).toHaveBeenCalledTimes(1);
                expect(deps.avisar.mock.calls[0][0]).toMatchObject({
                    reason: 'SHEET_WRITE_FAILED',
                    requestId: ID,
                    brand: 'lescent',
                    numeroPedido: PEDIDO,
                });
            });

            it('a linha não está na planilha ⇒ a trava leva SHEET_ROW_NOT_FOUND', async () => {
                const { deps } = montar(CABECALHO, null);
                deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status: 'cancelado' });

                const resposta = await cancelarReembolsoNaGold(CANCELAR, deps);

                expect(resposta.status).toBe(422);
                expect(resposta.body.reason).toBe('SHEET_ROW_NOT_FOUND');
                expect(deps.avisar.mock.calls[0][0]).toMatchObject({ reason: 'SHEET_ROW_NOT_FOUND', agruparPor: 'reembolso/lescent' });
            });
        });
    });

    describe('editar', () => {
        it('manda só valor e motivo, para a solicitação mais recente do pedido', async () => {
            const { deps } = montar();

            expect(await editarReembolsoNaGold(EDITAR, deps)).toEqual({
                status: 200,
                body: { code: 'SUCCESS', message: `Reembolso atualizado. ${NO_PROXIMO_LOTE}` },
            });

            expect(deps.buscarReembolsoMaisRecente).toHaveBeenCalledWith('lescent', PEDIDO);
            expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
            const [id, atualizacao] = deps.enfileirarAtualizacao.mock.calls[0];
            expect(id).toBe(ID);
            expect(atualizacao).toStrictEqual({ valor: 59.9, motivo: 'Extravio' });
            expect(problemaNaAtualizacao(id, atualizacao)).toBeNull();
        });

        it.each([
            ['só o valor', { refundAmount: 12.5 }, { valor: 12.5 }],
            ['só o motivo', { refundReason: 'Avaria' }, { motivo: 'Avaria' }],
        ])('%s ⇒ só ele na atualização', async (_o, changes, esperado) => {
            const { deps } = montar();

            await editarReembolsoNaGold({ ...EDITAR, changes }, deps);

            expect(deps.enfileirarAtualizacao.mock.calls[0][1]).toStrictEqual(esperado);
        });

        it('depois que a fila aceitou, reescreve o valor (como NÚMERO, não texto) e o motivo nas colunas deles', async () => {
            const { deps, planilha } = montar();

            await editarReembolsoNaGold(EDITAR, deps);

            expect(planilha.escritas).toEqual([
                { marca: 'lescent', linha: 2, coluna: COL.valor, valor: 59.9 },
                { marca: 'lescent', linha: 2, coluna: COL.motivo, valor: 'Extravio' },
            ]);
            expect(typeof planilha.escritas[0].valor).toBe('number');
            expect(planilha.valoresDaLinha('lescent', 2)[COL.status]).toBeNull();
        });

        it.each([
            ['só o valor', { refundAmount: 7 }, [{ coluna: COL.valor, valor: 7 }]],
            ['só o motivo', { refundReason: 'Avaria' }, [{ coluna: COL.motivo, valor: 'Avaria' }]],
        ])('%s ⇒ só essa célula muda na planilha', async (_o, changes, esperado) => {
            const { deps, planilha } = montar();

            await editarReembolsoNaGold({ ...EDITAR, changes }, deps);

            expect(planilha.escritas.map(({ coluna, valor }) => ({ coluna, valor }))).toEqual(esperado);
        });

        it('só observações ⇒ 422 INVALID_REQUEST, sem consultar, enfileirar nem tocar a planilha', async () => {
            const { deps, planilha } = montar();

            expect(await editarReembolsoNaGold({ ...EDITAR, changes: { notes: 'Cliente ligou de novo' } }, deps)).toEqual({
                status: 422,
                body: { code: 'INVALID_REQUEST', message: 'As observações não são mais guardadas: nada foi alterado.' },
            });

            expect(deps.buscarReembolsoMaisRecente).not.toHaveBeenCalled();
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
            expect(planilha.chamadas).toEqual([]);
        });

        it('observações junto com o valor ⇒ enfileira só o valor e avisa que as observações não são mais guardadas', async () => {
            const { deps, planilha } = montar();

            const resultado = await editarReembolsoNaGold(
                { ...EDITAR, changes: { refundAmount: 59.9, notes: 'Cliente ligou de novo' } },
                deps,
            );

            expect(resultado).toEqual({
                status: 200,
                body: { code: 'SUCCESS', message: `Reembolso atualizado. As observações não são mais guardadas. ${NO_PROXIMO_LOTE}` },
            });
            expect(deps.enfileirarAtualizacao.mock.calls[0][1]).toStrictEqual({ valor: 59.9 });
            expect(planilha.escritas).toEqual([{ marca: 'lescent', linha: 2, coluna: COL.valor, valor: 59.9 }]);
        });

        it('coluna do motivo que não está no cabeçalho: escreve o valor e avisa do motivo (SHEET_WRITE_FAILED)', async () => {
            const { deps, planilha } = montar(CABECALHO.filter((c) => c !== 'Motivo da solicitação do reembolso?'));

            const resultado = await editarReembolsoNaGold(EDITAR, deps);

            expect(resultado.status).toBe(200);
            expect(resultado.body.code).toBe('SUCCESS');
            expect(resultado.body.reason).toBe('SHEET_WRITE_FAILED');
            expect(resultado.body.message).toContain('"Motivo da solicitação do reembolso?"');
            expect(planilha.escritas).toEqual([{ marca: 'lescent', linha: 2, coluna: COL.valor, valor: 59.9 }]);
            expect(deps.avisar).toHaveBeenCalledTimes(1);
        });

        it('já cancelada no registro ⇒ 422 sem reescrever a planilha (a edição não acerta planilha)', async () => {
            const { deps, planilha } = montar();
            deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status: 'cancelado' });

            expect(await editarReembolsoNaGold(EDITAR, deps)).toEqual({
                status: 422,
                body: {
                    code: 'ALREADY_EXECUTED',
                    message: 'A solicitação mais recente deste pedido já está cancelada: não dá mais para alterar.',
                },
            });
            expect(planilha.escritas).toEqual([]);
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        });
    });

    describe.each([
        ['cancelar', (deps: DepsFalsas) => cancelarReembolsoNaGold(CANCELAR, deps), 'Reembolso cancelado', 'cancelar o reembolso'],
        ['editar', (deps: DepsFalsas) => editarReembolsoNaGold(EDITAR, deps), 'Reembolso atualizado', 'editar o reembolso'],
    ])('%s: o que trava ou falha', (_operacao, alterar, feito, acao) => {
        it('faltou configuração (planilha ou fila) ⇒ 503 antes de consultar qualquer coisa', async () => {
            const { deps, planilha } = montar();
            deps.configuracaoQueFalta.mockReturnValue('as planilhas não estão configuradas (GOOGLE_PLANILHAS_EMAIL, GOOGLE_PLANILHAS_TOKEN e SHEETS_ENV)');

            const resultado = await alterar(deps);

            expect(resultado.status).toBe(503);
            expect(resultado.body.code).toBe('UNKNOWN_ERROR');
            expect(resultado.body.message).toContain(acao);
            expect(resultado.body.message).toContain('GOOGLE_PLANILHAS_EMAIL');
            expect(resultado.body.message).toContain('nada foi alterado');
            expect(deps.buscarReembolsoMaisRecente).not.toHaveBeenCalled();
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
            expect(planilha.chamadas).toEqual([]);
        });

        it('consulta ao registro (raw ou fila) que falha ⇒ 502 UNKNOWN_ERROR, nada alterado', async () => {
            const { deps, planilha } = montar();
            deps.buscarReembolsoMaisRecente.mockRejectedValue(new MetabaseError(0, 'Metabase não respondeu em 5s'));

            expect(await alterar(deps)).toEqual({
                status: 502,
                body: { code: 'UNKNOWN_ERROR', message: 'Não foi possível consultar a solicitação. Nada foi alterado.' },
            });
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
            expect(planilha.chamadas).toEqual([]);
        });

        it('pedido sem reembolso registrado pelo CX Hub ⇒ 404 NOT_FOUND', async () => {
            const { deps, planilha } = montar();
            deps.buscarReembolsoMaisRecente.mockResolvedValue(null);

            expect(await alterar(deps)).toEqual({
                status: 404,
                body: { code: 'NOT_FOUND', message: 'Nenhuma solicitação de reembolso deste pedido.' },
            });
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
            expect(planilha.chamadas).toEqual([]);
        });

        it('reembolso já realizado no registro ⇒ 422 ALREADY_EXECUTED, planilha intocada', async () => {
            const { deps, planilha } = montar();
            deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status: 'realizado' });

            expect(await alterar(deps)).toEqual({
                status: 422,
                body: { code: 'ALREADY_EXECUTED', message: 'O reembolso já foi executado: não dá mais para alterar.' },
            });
            expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
            expect(planilha.chamadas).toEqual([]);
        });

        describe('a planilha vence: o Realizado que o backoffice marcou lá trava, sem enfileirar nada', () => {
            it.each(['aberto', 'pendente'])('planilha Realizado e registro %s ⇒ 422 sugerindo "Atualizar acompanhamento"', async (status) => {
                const { deps, planilha } = montar(CABECALHO, comStatusNaPlanilha('Realizado'));
                deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status });

                expect(await alterar(deps)).toEqual({
                    status: 422,
                    body: { code: 'ALREADY_EXECUTED', message: MENSAGEM_PLANILHA_REALIZADA },
                });

                expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
                expect(planilha.escritas).toEqual([]);
                expect(deps.avisar).not.toHaveBeenCalled();
            });

            it('lê a linha pelo id do caso, com o prazo da etapa, e ignora maiúsculas e espaços do status', async () => {
                const { deps, planilha } = montar(CABECALHO, comStatusNaPlanilha('  REALIZADO '));

                expect((await alterar(deps)).status).toBe(422);
                expect(planilha.chamadas).toEqual(['acharLinhaDoCaso', 'lerCabecalho', 'lerLinha']);
                expect(planilha.prazos.every((prazo) => prazo === PRAZO_DA_PLANILHA)).toBe(true);
            });

            it.each(['Pendente', 'Cancelado', 'Com Pendência', 'Enviado financeiro', null])('planilha com %j não trava', async (status) => {
                const { deps } = montar(CABECALHO, comStatusNaPlanilha(status));

                expect((await alterar(deps)).status).toBe(200);
                expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
            });

            it.each([
                ['a leitura da linha que falha', 'lerLinha' as const],
                ['a leitura do cabeçalho que falha', 'lerCabecalho' as const],
            ])('planilha ilegível não bloqueia: %s', async (_nome, metodo) => {
                const { deps, planilha } = montar(CABECALHO, comStatusNaPlanilha('Realizado'));
                planilha.falhaEm.add(metodo);

                const resultado = await alterar(deps);

                // Segue como se a planilha não dissesse nada: a alteração é enfileirada.
                expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
                expect(resultado.status).toBe(200);
            });

            it('cabeçalho sem a coluna do status não bloqueia', async () => {
                const { deps } = montar(CABECALHO.filter((c) => c !== 'Status do reembolso'), comStatusNaPlanilha('Realizado').filter((_, i) => i !== COL.status));

                await alterar(deps);

                expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
            });
        });

        it.each(['aberto', 'pendente'])('status %s não trava: a alteração é enfileirada', async (status) => {
            const { deps } = montar();
            deps.buscarReembolsoMaisRecente.mockResolvedValue({ ...ALVO, status });

            expect((await alterar(deps)).status).toBe(200);
            expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
        });

        it('fila incerta ⇒ 504 mandando repetir (não duplica), avisando que a planilha NÃO foi atualizada, e a planilha fica sem escrita', async () => {
            const { deps, planilha } = montar();
            deps.enfileirarAtualizacao.mockResolvedValue({ status: 'incerto', motivo: 'a fila respondeu HTTP 502' });

            expect(await alterar(deps)).toEqual({
                status: 504,
                body: {
                    code: 'API_TIMEOUT',
                    message:
                        'Não deu para confirmar a entrada da alteração na fila do Metabase (a fila respondeu HTTP 502). '
                        + 'A planilha não foi atualizada. Repita a ação: repetir não duplica a alteração.',
                },
            });
            expect(planilha.escritas).toEqual([]);
            expect(planilha.chamadas).not.toContain('atualizarCelulas');
        });

        it('fila recusou ⇒ 502 SHEETS_ERROR, com o motivo, planilha sem escrita', async () => {
            const { deps, planilha } = montar();
            deps.enfileirarAtualizacao.mockResolvedValue({ status: 'recusado', motivo: 'a fila respondeu HTTP 400 INVALID_REQUEST' });

            expect(await alterar(deps)).toEqual({
                status: 502,
                body: { code: 'SHEETS_ERROR', message: 'Não foi possível registrar a alteração (a fila respondeu HTTP 400 INVALID_REQUEST).' },
            });
            expect(planilha.escritas).toEqual([]);
        });

        it('linha do id não está na planilha ⇒ SUCCESS (a fila aceitou) com SHEET_ROW_NOT_FOUND, e o Chat é avisado agrupado por marca', async () => {
            const { deps, planilha } = montar(CABECALHO, null);

            const resultado = await alterar(deps);

            expect(resultado.status).toBe(200);
            expect(resultado.body).toEqual({
                code: 'SUCCESS',
                reason: 'SHEET_ROW_NOT_FOUND',
                message: `${feito} na fila do Metabase, mas a planilha não foi atualizada (a linha do caso não está na planilha). Atualize a planilha à mão.`,
            });
            expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
            expect(planilha.escritas).toEqual([]);

            expect(deps.avisar).toHaveBeenCalledTimes(1);
            expect(deps.avisar.mock.calls[0][0]).toMatchObject({
                reason: 'SHEET_ROW_NOT_FOUND',
                requestId: ID,
                brand: 'lescent',
                numeroPedido: PEDIDO,
                agruparPor: 'reembolso/lescent',
            });
        });

        it('planilha que falha ⇒ SUCCESS (a fila aceitou) com SHEET_WRITE_FAILED, e UM aviso no Chat, por caso', async () => {
            const { deps, planilha } = montar();
            planilha.falhaEm.add('atualizarCelulas');

            const resultado = await alterar(deps);

            expect(resultado.status).toBe(200);
            expect(resultado.body.code).toBe('SUCCESS');
            expect(resultado.body.reason).toBe('SHEET_WRITE_FAILED');
            expect(resultado.body.message).toContain(`${feito} na fila do Metabase, mas a planilha não foi atualizada`);

            expect(deps.avisar).toHaveBeenCalledTimes(1);
            const aviso = deps.avisar.mock.calls[0][0];
            expect(aviso).toMatchObject({ reason: 'SHEET_WRITE_FAILED', requestId: ID, brand: 'lescent', numeroPedido: PEDIDO });
            expect(aviso.agruparPor).toBeUndefined();
            expect(aviso.motivo).toContain(resultado.body.message);
        });

        it('cabeçalho sem a coluna ⇒ SUCCESS com SHEET_WRITE_FAILED, nada escrito, e avisa o Chat', async () => {
            const { deps, planilha } = montar(['Número do pedido'], [PEDIDO]);

            const resultado = await alterar(deps);

            expect(resultado.body.code).toBe('SUCCESS');
            expect(resultado.body.reason).toBe('SHEET_WRITE_FAILED');
            expect(planilha.escritas).toEqual([]);
            expect(deps.avisar).toHaveBeenCalledTimes(1);
        });

        it('o aviso nunca altera a resposta: Chat que lança não vira erro', async () => {
            const { deps, planilha } = montar();
            planilha.falhaEm.add('atualizarCelulas');
            deps.avisar.mockRejectedValue(new Error('Chat fora do ar'));

            const resultado = await alterar(deps);

            expect(resultado.status).toBe(200);
            expect(resultado.body.reason).toBe('SHEET_WRITE_FAILED');
        });

        it('sucesso inteiro não avisa o Chat', async () => {
            const { deps } = montar();

            expect((await alterar(deps)).body).not.toHaveProperty('reason');
            expect(deps.avisar).not.toHaveBeenCalled();
        });
    });
});

describe('cancelar e editar acham a linha pelo pedido da solicitação e pelo horário em que ela foi criada', () => {
    const MIN = 60_000;
    const em = (ms: number) => new Date(CRIADO_EM_EXEMPLO.getTime() + ms);

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** Duas linhas do mesmo pedido: a de um caso antigo (outro carimbo) e a deste caso. */
    function montarComDuasLinhas() {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        const antiga = planilha.adicionarCaso('lescent', [...LINHA], { pedido: PEDIDO, criadoEm: em(-10 * MIN) });
        const certa = planilha.adicionarCaso('lescent', [...LINHA], { pedido: PEDIDO, criadoEm: em(15_000) });
        const deps = depsFalsas(planilha);
        deps.buscarReembolsoMaisRecente.mockResolvedValue(ALVO);
        return { planilha, deps, antiga, certa };
    }

    it('a planilha recebe o pedido e o criado_em que o registro devolveu para a solicitação', async () => {
        const { deps, planilha } = montar();

        await cancelarReembolsoNaGold(CANCELAR, deps);

        expect(planilha.casosProcurados.length).toBeGreaterThan(0);
        for (const caso of planilha.casosProcurados) {
            expect(caso).toEqual({ idSolicitacao: ID, pedido: PEDIDO, criadoEm: CRIADO_EM_EXEMPLO });
        }
    });

    it.each([
        ['cancelar', (deps: DepsFalsas) => cancelarReembolsoNaGold(CANCELAR, deps), COL.status, 'Cancelado'],
        ['editar', (deps: DepsFalsas) => editarReembolsoNaGold(EDITAR, deps), COL.valor, 59.9],
    ])('%s: com duas linhas do mesmo pedido, escreve na do carimbo certo e deixa a outra como estava', async (_nome, alterar, coluna, valor) => {
        const { deps, planilha, antiga, certa } = montarComDuasLinhas();

        const resposta = await alterar(deps);

        expect(resposta.body).not.toHaveProperty('reason');
        expect(planilha.escritas.every((escrita) => escrita.linha === certa)).toBe(true);
        expect(planilha.valoresDaLinha('lescent', certa)[coluna]).toBe(valor);
        expect(planilha.valoresDaLinha('lescent', antiga)).toEqual(LINHA);
    });

    it.each([
        ['cancelar', (deps: DepsFalsas) => cancelarReembolsoNaGold(CANCELAR, deps)],
        ['editar', (deps: DepsFalsas) => editarReembolsoNaGold(EDITAR, deps)],
    ])('%s: carimbo fora da tolerância (3 min) ⇒ a linha não é achada: a fila aceita, a resposta leva SHEET_ROW_NOT_FOUND e o Chat é avisado', async (_nome, alterar) => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        planilha.adicionarCaso('lescent', [...LINHA], { pedido: PEDIDO, criadoEm: em(3 * MIN) });
        const deps = depsFalsas(planilha);
        deps.buscarReembolsoMaisRecente.mockResolvedValue(ALVO);

        const resposta = await alterar(deps);

        expect(resposta.status).toBe(200);
        expect(resposta.body.reason).toBe('SHEET_ROW_NOT_FOUND');
        expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
        expect(planilha.escritas).toEqual([]);
        expect(deps.avisar.mock.calls[0][0]).toMatchObject({ reason: 'SHEET_ROW_NOT_FOUND', agruparPor: 'reembolso/lescent' });
    });

    it('o Realizado marcado na linha CERTA trava; o de outra linha do mesmo pedido (outro caso) não', async () => {
        const planilha = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        // Outro caso do mesmo pedido, já Realizado: não é o desta solicitação.
        planilha.adicionarCaso('lescent', comStatusNaPlanilha('Realizado'), { pedido: PEDIDO, criadoEm: em(-10 * MIN) });
        planilha.adicionarCaso('lescent', [...LINHA], { pedido: PEDIDO, criadoEm: CRIADO_EM_EXEMPLO });
        const deps = depsFalsas(planilha);
        deps.buscarReembolsoMaisRecente.mockResolvedValue(ALVO);

        expect((await cancelarReembolsoNaGold(CANCELAR, deps)).status).toBe(200);

        const trancada = new PlanilhaFalsa().adicionarAba('lescent', CABECALHO);
        trancada.adicionarCaso('lescent', comStatusNaPlanilha('Realizado'), { pedido: PEDIDO, criadoEm: CRIADO_EM_EXEMPLO });
        const depsTrancadas = depsFalsas(trancada);
        depsTrancadas.buscarReembolsoMaisRecente.mockResolvedValue(ALVO);

        expect((await cancelarReembolsoNaGold(CANCELAR, depsTrancadas)).status).toBe(422);
    });
});
