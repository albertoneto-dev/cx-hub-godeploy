import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// O Chat nunca é chamado de verdade: o `sendAlert` é substituído, e os testes olham o que ele recebeu.
vi.mock('@shared/lib/alerts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/alerts')>()),
    sendAlert: vi.fn(),
}));

import { sendAlert } from '@shared/lib/alerts';
import { formatarCarimboSP } from '@shared/lib/format';
import { gravarLinhaNaPlanilha, gravarNasPlanilhas, type CasoDaLinha, type GravarDeps } from '@shared/lib/sheets/gravarLinha';
import { __resetCasoNaPlanilha } from '@shared/lib/sheets/casoNaPlanilha';
import { CABECALHO_ESPERADO } from '@shared/lib/sheets/cabecalhos';
import { __resetGoogleTokenCache } from '@shared/lib/sheets/googleAuth';
import type { SheetCell } from '@shared/lib/sheets';
import { buildResendRow } from '@modules/reenvios/actions/buildResendRow';
import { buildRefundRow, COLUNA_DA_CHAVE_PIX, prepararReembolso } from '@modules/reembolsos/actions/buildRefundRow';
import type { RefundSubmissionData } from '@modules/reembolsos/types';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { stubGoogleEnv } from '../helpers/google-sheets-mock';
import { cabecalhoDoLayout, instalarGoogleFalso } from '../helpers/google-sheets-falso';
import { ateTerminar, ligarRelogioFalso } from '../helpers/relogio-falso';

/**
 * A gravação nas planilhas das marcas sem Cosmos (ADR-013): o cabeçalho conferido inteiro antes de gravar, as fórmulas
 * da operação escritas na linha nova (pelo `updatedRange` do append, ou pela conferência quando ele não vem) e a chave
 * Pix fora do log. O Google é o falso em memória de `google-sheets-falso.ts`: nada sai da máquina.
 */

const alerta = vi.mocked(sendAlert);

const ID = '6f1c0e2a-1111-4222-8333-444455556666';
const CRIADO_EM = new Date('2026-11-05T18:00:00.000Z');
const CARIMBO = formatarCarimboSP(CRIADO_EM);
const PEDIDO = 'SH1629891AP';

const DATA = { ...RESEND_DATA, numeroPedido: PEDIDO, cdOrigem: 'CD ES', estado: 'RJ', ReenvioCompleto: 'Sim' };
const LINHA = buildResendRow('apice', DATA, CARIMBO);
const CASO: CasoDaLinha = { idSolicitacao: ID, pedido: PEDIDO, criadoEm: CRIADO_EM };
const CABECALHO: SheetCell[] = [...(CABECALHO_ESPERADO.reenvio?.apice ?? [])];

const semEspera: GravarDeps = { esperar: vi.fn(async () => {}) };
const prazo = () => Date.now() + 10_000;

/** Uma linha de outro pedido, já na planilha. */
const outraLinha = (pedido: string): SheetCell[] => LINHA.map((celula, i) => (i === 8 ? pedido : celula));

beforeEach(() => {
    __resetGoogleTokenCache();
    __resetCasoNaPlanilha();
    stubGoogleEnv();
    // As planilhas das marcas sem Cosmos só existem em produção, por enquanto (sem cópia de staging).
    vi.stubEnv('SHEETS_ENV', 'prod');
    alerta.mockReset().mockResolvedValue(true);
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('gravarLinhaNaPlanilha — marcas sem Cosmos', () => {
    it('anexa a linha e escreve as fórmulas da operação na linha que o append devolveu, como fórmula (USER_ENTERED)', async () => {
        const aba = instalarGoogleFalso(CABECALHO);
        aba.appends.push({ status: 200, json: { updates: { updatedRange: "'Respostas ao formulário'!A2:Z2" } } });

        const resultado = await gravarLinhaNaPlanilha('reenvio', 'apice', LINHA, CASO, prazo(), semEspera);

        expect(resultado).toEqual({ status: 'gravado' });
        expect(aba.contagem.appends).toBe(1);
        expect(aba.atualizacoes).toHaveLength(1);
        expect(aba.atualizacoes[0].valueInputOption).toBe('USER_ENTERED');
        expect(aba.atualizacoes[0].celulas).toEqual([
            { range: "'Respostas ao formulário'!AA2", valor: '=WORKDAY(Z2; 3)' },
            { range: "'Respostas ao formulário'!AH2", valor: '=IF(AE2="";"Pendente";WEEKNUM(AE2;15)-1)' },
            { range: "'Respostas ao formulário'!AI2", valor: '=WEEKNUM(A2;15)-1' },
            { range: "'Respostas ao formulário'!AJ2", valor: '=MONTH(A2)' },
            { range: "'Respostas ao formulário'!AK2", valor: '=YEAR(A2)' },
            { range: "'Respostas ao formulário'!AN2", valor: '=IF(AE2="";"";NETWORKDAYS(Z2;AE2)-1)' },
        ]);
        // A linha anexada não tocou nenhuma coluna da operação além da "Data solicitação" (Z).
        expect(aba.linhas[0].slice(0, 26)).toEqual(LINHA);
    });

    it('sem o updatedRange na resposta, acha o número da linha pela conferência (pedido + carimbo)', async () => {
        const aba = instalarGoogleFalso(CABECALHO, [outraLinha('SH1AP'), outraLinha('SH2AP')]);

        const resultado = await gravarLinhaNaPlanilha('reenvio', 'apice', LINHA, CASO, prazo(), semEspera);

        expect(resultado).toEqual({ status: 'gravado' });
        // Cabeçalho na 1, duas linhas antes: a nova é a 4.
        expect(aba.atualizacoes[0].celulas[0]).toEqual({ range: "'Respostas ao formulário'!AA4", valor: '=WORKDAY(Z4; 3)' });
    });

    it('a linha que já estava lá (tentativa anterior) também recebe as fórmulas, sem novo append', async () => {
        const aba = instalarGoogleFalso(CABECALHO, [outraLinha('SH1AP'), [...LINHA]]);

        const resultado = await gravarLinhaNaPlanilha('reenvio', 'apice', LINHA, CASO, prazo(), semEspera);

        expect(resultado).toEqual({ status: 'ja_existia' });
        expect(aba.contagem.appends).toBe(0);
        expect(aba.atualizacoes[0].celulas[0].range).toBe("'Respostas ao formulário'!AA3");
    });

    it('cabeçalho com uma coluna inserida no meio ⇒ falha fechada: nada é anexado, e o motivo diz a coluna', async () => {
        const comColunaInserida = [...CABECALHO.slice(0, 9), 'Coluna nova', ...CABECALHO.slice(9)];
        const aba = instalarGoogleFalso(comColunaInserida);

        const resultado = await gravarLinhaNaPlanilha('reenvio', 'apice', LINHA, CASO, prazo(), semEspera);

        expect(resultado.status).toBe('falhou');
        expect(resultado.motivo).toContain('a coluna J tem o cabeçalho "Coluna nova", e o CX Hub espera "CD de Origem"');
        expect(aba.contagem.appends).toBe(0);
        expect(aba.atualizacoes).toHaveLength(0);
    });

    it('espaço sobrando nas pontas do cabeçalho e coluna nova no fim não barram', async () => {
        const aba = instalarGoogleFalso([...CABECALHO.map((c) => ` ${String(c)} `), 'Coluna 41']);

        expect(await gravarLinhaNaPlanilha('reenvio', 'apice', LINHA, CASO, prazo(), semEspera)).toEqual({ status: 'gravado' });
        expect(aba.contagem.appends).toBe(1);
    });

    it('as fórmulas falham ⇒ sem_formulas: a linha está lá, e o motivo diz o número dela', async () => {
        const aba = instalarGoogleFalso(CABECALHO);
        aba.appends.push({ status: 200, json: { updates: { updatedRange: "'Respostas ao formulário'!A2:Z2" } } });
        const falso = vi.mocked(fetch).getMockImplementation()!;
        vi.mocked(fetch).mockImplementation(async (input, init) => (String(input).includes('values:batchUpdate')
            ? new Response(JSON.stringify({ error: { message: 'sem permissão' } }), { status: 403 })
            : falso(input, init)));

        const resultado = await gravarLinhaNaPlanilha('reenvio', 'apice', LINHA, CASO, prazo(), semEspera);

        expect(resultado.status).toBe('sem_formulas');
        expect(resultado.motivo).toMatch(/^a linha 2 entrou, mas as fórmulas da operação não: .*HTTP 403/);
        expect(aba.linhas).toHaveLength(1);
    });

    it('as 6 marcas do Cosmos seguem sem fórmula nenhuma (comportamento de antes)', async () => {
        const linha = buildResendRow('kokeshi', RESEND_DATA, CARIMBO);
        const aba = instalarGoogleFalso(cabecalhoDoLayout('reenvio', 'kokeshi', linha.length));

        const resultado = await gravarLinhaNaPlanilha('reenvio', 'kokeshi', linha, { ...CASO, pedido: RESEND_DATA.numeroPedido }, prazo(), semEspera);

        expect(resultado).toEqual({ status: 'gravado' });
        expect(aba.atualizacoes).toHaveLength(0);
    });
});

describe('gravarNasPlanilhas — marcas sem Cosmos', () => {
    const CONTEXTO = { numeroPedido: PEDIDO, idAtendimento: 'T-1', statusDaFila: 'enfileirado' as const };

    it('só as fórmulas faltaram ⇒ linhasGravadas, o aviso diz que a linha ENTROU, e o log não leva a linha', async () => {
        // A cota recusa as fórmulas até o fim: o `values:batchUpdate` (repetir é inofensivo) espera a cota em escada,
        // no relógio falso, antes de desistir.
        ligarRelogioFalso();
        instalarGoogleFalso(CABECALHO);
        const falso = vi.mocked(fetch).getMockImplementation()!;
        let tentativasDasFormulas = 0;
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            if (!String(input).includes('values:batchUpdate')) return falso(input, init);
            tentativasDasFormulas++;
            return new Response(JSON.stringify({ error: { message: 'cota' } }), { status: 429 });
        });

        const resultado = await ateTerminar(gravarNasPlanilhas(
            [{ fluxo: 'reenvio', marca: 'apice', linha: LINHA, ...CASO }], CONTEXTO, Date.now() + 25_000, semEspera));

        expect(tentativasDasFormulas).toBe(4);
        expect(resultado).toEqual({ ok: false, motivo: expect.stringContaining('entrou, mas as fórmulas'), linhasGravadas: true });
        expect(alerta).toHaveBeenCalledTimes(1);
        expect(alerta.mock.calls[0][0].motivo).toBe(
            `A solicitação entrou na fila do Metabase, mas a linha entrou na planilha sem as fórmulas de prazo e SLA (complete à mão): reenvio (${ID})`,
        );
        const logs = vi.mocked(console.error).mock.calls.map((chamada) => chamada.join(' '));
        expect(logs.some((log) => log.includes('linha sem as fórmulas da operação'))).toBe(true);
        expect(logs.some((log) => log.includes('NOME'))).toBe(false);
    });

    it('a linha que falhou vai ao log para repor à mão, mas SEM a chave Pix', async () => {
        const dados: RefundSubmissionData = {
            brand: 'apice', data_criacao: '20/10/2026', handledBy: 'Ana', sourceChannel: 'Chat Atendimento',
            supportTicketId: 'T-1', originWarehouse: 'CD ES', customerName: 'Cliente', invoiceNumber: '555',
            nfeAccessKey: 'CHAVE', batchNumber: 'L1', ecommerceOrderId: PEDIDO, policyException: false, refundAmount: 94.82,
            refundReason: 'Ruptura de Estoque', refundScope: 'Frete', requiresReturn: false, carrierTicketId: null,
            carrierName: 'J&T', orderStatus: 'Pedido não foi enviado', isFullRefund: false, notes: null,
            pixKey: 'cliente.secreta@exemplo.com',
        };
        const linha = buildRefundRow('apice', prepararReembolso(dados, CARIMBO));
        const aba = instalarGoogleFalso([...(CABECALHO_ESPERADO.reembolso?.apice ?? [])]);
        aba.appends.push({ status: 403, json: { error: { message: 'sem permissão' } } });

        const resultado = await gravarNasPlanilhas(
            [{ fluxo: 'reembolso', marca: 'apice', linha, ...CASO, colunasSensiveis: [COLUNA_DA_CHAVE_PIX.apice] }],
            CONTEXTO, prazo(), semEspera);

        expect(resultado).toEqual({ ok: false, motivo: expect.stringContaining('HTTP 403') });
        const logs = vi.mocked(console.error).mock.calls.map((chamada) => chamada.join(' ')).join('\n');
        expect(logs).toContain('linha não gravada');
        expect(logs).toContain('[omitido]');
        expect(logs).toContain('Ruptura de Estoque');
        expect(logs).not.toContain('cliente.secreta@exemplo.com');
        expect(JSON.stringify(alerta.mock.calls)).not.toContain('cliente.secreta@exemplo.com');
    });
});
