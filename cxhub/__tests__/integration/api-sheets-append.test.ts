import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ADR-012: quem registra (fila do Metabase e planilha) é o processResend, que tem teste próprio. Aqui só a fiação da rota e a guarda do INV-02
// que o postResendWebhook aplica por cima — por isso ele é substituído.
vi.mock('@modules/reenvios/actions/processResend', () => ({ processResend: vi.fn() }));

import { POST, maxDuration } from '../../app/api/sheets/append/route';
import { processResend } from '@modules/reenvios/actions/processResend';
import type { SheetsAppendResponse } from '@modules/reenvios/types';
import { createRequest } from '../helpers/api-test-utils';

const processResendMock = vi.mocked(processResend);

const SAMPLE_DATA = {
    timestamp: '2024-01-01',
    dataSolicitacao: '2024-01-01',
    tipoSolicitacao: 'Reenvio',
    responsavel: 'Teste',
    origemReclamacao: 'Email',
    idAtendimento: '123',
    cdOrigem: 'SP',
    nomeCliente: 'Cliente',
    telefoneCliente: '11999999999',
    enderecoCliente: 'Rua Teste, 123',
    cep: '01001-000',
    estado: 'SP',
    numeroPedido: '#220183',
    numeroNF: '123456',
    chaveNF: 'chave-acesso',
    cosmosId: '42',
    produtoComProblema: 'Produto A',
    produtoReenviar: 'Produto A',
    loteProduto: 'Lote 1',
    problemaProduto: 'Danificado',
    transportadoraOriginal: 'PAC',
    transportadoraReenvio: 'PAC',
    devolucao: 'Não',
    ticketTransportadora: '',
    statusPedido: 'Entregue',
    ReenvioCompleto: 'Sim',
    valorReenvio: '100.00',
    status: 'Realizado',
    codNfd: 'Pendente',
    automacao: 'Automação',
    erp: '',
    comentarios: '',
};

function postar(body: unknown) {
    return POST(createRequest('http://localhost/api/sheets/append', { method: 'POST', body }));
}

describe('POST /api/sheets/append', () => {
    beforeEach(() => {
        processResendMock.mockReset();
        vi.stubEnv('TIMEOUT', '10000');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('entrega o pedido da tela ao processResend e devolve a resposta dele', async () => {
        vi.stubEnv('TIMEOUT', '7000');
        const fetchSpy = vi.spyOn(global, 'fetch');
        const resposta: SheetsAppendResponse = { code: 'SUCCESS', message: 'Reenvio registrado com sucesso.', sentToAPI: true };
        processResendMock.mockResolvedValue({ body: resposta, status: 200 });

        const res = await postar({ brand: 'kokeshi', data: SAMPLE_DATA, token: 'token-do-agente' });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(resposta);
        expect(processResendMock).toHaveBeenCalledTimes(1);
        expect(processResendMock.mock.calls[0][0]).toEqual({
            brand: 'kokeshi',
            data: SAMPLE_DATA,
            token: 'token-do-agente',
            testMode: undefined,
            timeoutMs: 7000,
            // A tela não manda id nem prazo: o processResend gera o id e usa o prazo padrão da fila.
            idSolicitacao: undefined,
            prazoFila: undefined,
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('o maxDuration cabe o dedup, o Cosmos, a fila e a planilha com folga', () => {
        expect(maxDuration).toBe(120);
    });

    it('um assincrono que ainda venha no corpo (tela antiga) é ignorado, sem 400', async () => {
        processResendMock.mockResolvedValue({ body: { code: 'SUCCESS', message: 'ok', sentToAPI: true }, status: 200 });

        const res = await postar({ brand: 'kokeshi', data: SAMPLE_DATA, token: 'token-do-agente', assincrono: 'true' });

        expect(res.status).toBe(200);
        expect(processResendMock.mock.calls[0][0]).not.toHaveProperty('assincrono');
    });

    it('falha do processResend volta com o status e o corpo dele', async () => {
        const resposta: SheetsAppendResponse = {
            code: 'UNKNOWN_ERROR',
            message: 'Não foi possível consultar as solicitações recentes — nada foi registrado nem reenviado. Tente novamente.',
            sentToAPI: false,
            reason: 'RECORD_UNAVAILABLE',
        };
        processResendMock.mockResolvedValue({ body: resposta, status: 503 });

        const res = await postar({ brand: 'kokeshi', data: SAMPLE_DATA, token: 'token-do-agente' });

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual(resposta);
    });

    it('retorna 400 para brand invalida, sem chegar ao processResend', async () => {
        const res = await postar({ brand: 'xyz', data: SAMPLE_DATA });

        expect(res.status).toBe(400);
        expect(processResendMock).not.toHaveBeenCalled();
    });

    it('retorna 400 se data faltando', async () => {
        const res = await postar({ brand: 'lescent' });

        expect(res.status).toBe(400);
        expect(processResendMock).not.toHaveBeenCalled();
    });

    it('retorna 400 UNKNOWN_ERROR quando testMode nao e boolean', async () => {
        const res = await postar({ brand: 'lescent', data: SAMPLE_DATA, testMode: 'true' });

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('UNKNOWN_ERROR');
        expect(processResendMock).not.toHaveBeenCalled();
    });

    it('repassa SUCCESS_TEST_MODE sem degradar para UNKNOWN_ERROR', async () => {
        processResendMock.mockResolvedValue({
            body: { code: 'SUCCESS_TEST_MODE', message: 'modo de teste', sentToAPI: false },
            status: 200,
        });

        const res = await postar({ brand: 'lescent', data: SAMPLE_DATA, testMode: true });

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ code: 'SUCCESS_TEST_MODE', sentToAPI: false });
        expect(processResendMock.mock.calls[0][0].testMode).toBe(true);
    });

    it('INV-02: barra com 502 quando testMode=true e a resposta indica reenvio real', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        processResendMock.mockResolvedValue({
            body: { code: 'SUCCESS', message: 'ok', sentToAPI: true },
            status: 200,
        });

        const res = await postar({ brand: 'lescent', data: SAMPLE_DATA, testMode: true });

        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ code: 'UNKNOWN_ERROR', sentToAPI: false, reason: 'TEST_MODE_VIOLATION' });
    });

    it('retorna 500 se o processResend lançar', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        processResendMock.mockRejectedValue(new Error('boom'));

        const res = await postar({ brand: 'lescent', data: SAMPLE_DATA });

        expect(res.status).toBe(500);
        expect((await res.json()).code).toBe('UNKNOWN_ERROR');
    });
});
