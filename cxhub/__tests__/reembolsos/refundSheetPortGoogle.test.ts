import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatarCarimboSP } from '@shared/lib/format';
import { LayoutDaPlanilhaError, __resetCasoNaPlanilha } from '@shared/lib/sheets/casoNaPlanilha';
import { __resetGoogleTokenCache } from '@shared/lib/sheets/googleAuth';
import { resolverPlanilha, type SheetCell } from '@shared/lib/sheets';
import { cancelarReembolsoNaGold, editarReembolsoNaGold } from '@modules/reembolsos/actions/refundGold';
import { NO_PROXIMO_LOTE } from '@modules/reembolsos/actions/refundGestaoComum';
import { concluirReembolso, sincronizarReembolso } from '@modules/reembolsos/actions/refundExecucao';
import type { RefundGestaoDeps } from '@modules/reembolsos/actions/refundGestaoDeps';
import { planilhaDoReembolsoGoogle } from '@modules/reembolsos/actions/refundSheetPortGoogle';
import { intervaloDaLeitura, intervalosDaLeitura, stubGoogleEnv } from '../helpers/google-sheets-mock';
import { cabecalhoDoLayout, instalarGoogleFalso, serialDaData, type AbaFalsa } from '../helpers/google-sheets-falso';
import { CRIADO_EM_EXEMPLO, PEDIDO_EXEMPLO } from '../helpers/planilha-reembolso-falsa';
import { HOJE_EM_SP, ID_EXEMPLO, casoNaRaw, depsFalsas } from '../helpers/refund-gestao-deps';

/**
 * A planilha de reembolso de verdade (`planilhaDoReembolsoGoogle`) contra o Google falso: achar a linha pelo pedido e
 * pelo horário, ler a linha formatada (a data como texto, não como serial) e escrever data e número com o tipo certo
 * (`USER_ENTERED`), e o resto como texto (`RAW`). Nenhum teste toca o Google: é o `fetch` que é substituído.
 */

// Lescent: carimbo em A, pedido em E; o resto vem do cabeçalho, pelo nome — aqui, bem à direita (a coluna AB passa do Z).
const COL = { motivo: 3, valor: 9, status: 27, data: 28, responsavel: 29 };
const CARIMBO = formatarCarimboSP(CRIADO_EM_EXEMPLO); // 28/10/2026 10:00:00
const ID = ID_EXEMPLO;
const AGENTE = '<agente>';
const prazo = () => Date.now() + 10_000;

function cabecalho(): SheetCell[] {
    const c = cabecalhoDoLayout('reembolso', 'lescent', 30);
    c[COL.motivo] = 'Motivo da solicitação do reembolso?';
    c[COL.valor] = 'Valor do reembolso';
    c[COL.status] = 'Status do reembolso';
    c[COL.data] = 'Data de Execução';
    c[COL.responsavel] = 'Responsável Reembolso';
    return c;
}

/** A linha do caso: carimbo, motivo, pedido, valor, e o que o backoffice preencheu da execução (se preencheu). */
function linha(status: string | null = null, data: number | string | null = null, responsavel: string | null = null): SheetCell[] {
    const l: SheetCell[] = Array.from({ length: 30 }, () => null);
    l[0] = CARIMBO;
    l[COL.motivo] = 'Produto avariado';
    l[4] = PEDIDO_EXEMPLO;
    l[COL.valor] = 139.9;
    l[COL.status] = status;
    l[COL.data] = data;
    l[COL.responsavel] = responsavel;
    return l;
}

/** Uma data de execução preenchida pelo backoffice: no Sheets é um serial, que a tela mostra como `dd/mm/aaaa`. */
function comDataDeExecucao(aba: AbaFalsa, numeroDaLinha: number, data: string): void {
    aba.linhas[numeroDaLinha - 2][COL.data] = serialDaData(data);
    aba.formatados[`${numeroDaLinha}:${COL.data}`] = data;
}

const caso = { pedido: PEDIDO_EXEMPLO, criadoEm: CRIADO_EM_EXEMPLO };

beforeEach(() => {
    __resetGoogleTokenCache();
    __resetCasoNaPlanilha();
    stubGoogleEnv();
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('acharLinhaDoCaso', () => {
    it('acha a linha pelo pedido e pelo horário e devolve o número dela (1 = cabeçalho)', async () => {
        instalarGoogleFalso(cabecalho(), [linha()]);

        await expect(planilhaDoReembolsoGoogle().acharLinhaDoCaso('lescent', caso, prazo())).resolves.toBe(2);
    });

    it('duas linhas do mesmo pedido: a do carimbo certo', async () => {
        const antiga = Object.assign([...linha()], { 0: formatarCarimboSP(new Date(CRIADO_EM_EXEMPLO.getTime() - 10 * 60_000)) });
        instalarGoogleFalso(cabecalho(), [antiga, linha()]);

        await expect(planilhaDoReembolsoGoogle().acharLinhaDoCaso('lescent', caso, prazo())).resolves.toBe(3);
    });

    it('carimbo fora da tolerância ⇒ null', async () => {
        instalarGoogleFalso(cabecalho(), [linha()]);
        const outroHorario = { pedido: PEDIDO_EXEMPLO, criadoEm: new Date(CRIADO_EM_EXEMPLO.getTime() + 3 * 60_000) };

        await expect(planilhaDoReembolsoGoogle().acharLinhaDoCaso('lescent', outroHorario, prazo())).resolves.toBeNull();
    });

    it('cabeçalho que não bate com o layout sobe como erro (não se adivinha a coluna)', async () => {
        const c = cabecalho();
        c[4] = 'Observações';
        instalarGoogleFalso(c, [linha()]);

        await expect(planilhaDoReembolsoGoogle().acharLinhaDoCaso('lescent', caso, prazo())).rejects.toBeInstanceOf(LayoutDaPlanilhaError);
    });

    it('usa a planilha de REEMBOLSO da marca (SHEETS_ENV=staging)', async () => {
        instalarGoogleFalso(cabecalho(), [linha()]);

        await planilhaDoReembolsoGoogle().acharLinhaDoCaso('lescent', caso, prazo());

        const { spreadsheetId, aba } = resolverPlanilha('reembolso', 'lescent', 'staging');
        const urls = vi.mocked(global.fetch).mock.calls.map(([url]) => String(url)).filter((u) => u.includes('googleapis.com/v4'));
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) {
            expect(url).toContain(`/spreadsheets/${spreadsheetId}/values`);
            // O cabeçalho (`values/'aba'!1:1`) e as duas colunas (`values:batchGet?ranges='aba'!A:A&ranges='aba'!E:E`).
            expect(intervalosDaLeitura(url).length).toBeGreaterThan(0);
            for (const intervalo of intervalosDaLeitura(url)) expect(intervalo.startsWith(`'${aba}'!`)).toBe(true);
        }
    });
});

describe('lerCabecalho e lerLinha', () => {
    it('lerCabecalho devolve a linha 1', async () => {
        instalarGoogleFalso(cabecalho(), [linha()]);

        await expect(planilhaDoReembolsoGoogle().lerCabecalho('lescent', prazo())).resolves.toEqual(cabecalho());
    });

    it('lerLinha pede FORMATTED_VALUE: a data de execução chega como texto (30/10/2026), não como número serial', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha('Realizado', null, 'Ana')]);
        comDataDeExecucao(aba, 2, '30/10/2026');

        const valores = await planilhaDoReembolsoGoogle().lerLinha('lescent', 2, prazo());

        expect(valores[COL.data]).toBe('30/10/2026');
        expect(valores[COL.status]).toBe('Realizado');
        expect(valores[COL.responsavel]).toBe('Ana');
        const leitura = vi.mocked(global.fetch).mock.calls.map(([url]) => decodeURIComponent(String(url))).find((u) => u.endsWith("!2:2?valueRenderOption=FORMATTED_VALUE"));
        expect(leitura).toBeDefined();
        expect(leitura).not.toContain('UNFORMATTED_VALUE');
    });

    it('lê só a linha pedida (nunca a aba inteira)', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha(), linha('Realizado')]);

        await planilhaDoReembolsoGoogle().lerLinha('lescent', 3, prazo());

        const leituras = vi.mocked(global.fetch).mock.calls.map(([url]) => intervaloDaLeitura(String(url))).filter((i) => i !== '');
        const { aba: nomeDaAba } = resolverPlanilha('reembolso', 'lescent', 'staging');
        expect(leituras).toEqual([`'${nomeDaAba}'!3:3`]);
        expect(aba.leiturasDeLinha).toBe(1);
    });

    it('linha sem nada devolve lista vazia', async () => {
        instalarGoogleFalso(cabecalho(), [[]]);

        await expect(planilhaDoReembolsoGoogle().lerLinha('lescent', 2, prazo())).resolves.toEqual([]);
    });
});

describe('atualizarCelulas', () => {
    it('data e número vão com USER_ENTERED (viram data e número na planilha); status e texto vão RAW', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha()]);

        await planilhaDoReembolsoGoogle().atualizarCelulas('lescent', [
            { linha: 2, coluna: COL.status, valor: 'Realizado' },
            { linha: 2, coluna: COL.data, valor: '30/10/2026' },
            { linha: 2, coluna: COL.responsavel, valor: AGENTE },
            { linha: 2, coluna: COL.valor, valor: 59.9 },
        ], prazo());

        const raw = aba.atualizacoes.filter((a) => a.valueInputOption === 'RAW');
        const interpretadas = aba.atualizacoes.filter((a) => a.valueInputOption === 'USER_ENTERED');
        expect(aba.atualizacoes).toHaveLength(2);
        expect(raw).toHaveLength(1);
        expect(interpretadas).toHaveLength(1);
        expect(raw[0].celulas.map((c) => c.valor)).toEqual(['Realizado', AGENTE]);
        expect(interpretadas[0].celulas.map((c) => c.valor)).toEqual(['30/10/2026', 59.9]);

        // O que ficou na planilha: data e número de verdade, texto como texto.
        const gravada = aba.linhas[0];
        expect(gravada[COL.data]).toBe(serialDaData('30/10/2026'));
        expect(aba.formatados[`2:${COL.data}`]).toBe('30/10/2026');
        expect(gravada[COL.valor]).toBe(59.9);
        expect(typeof gravada[COL.valor]).toBe('number');
        expect(gravada[COL.status]).toBe('Realizado');
        expect(gravada[COL.responsavel]).toBe(AGENTE);
    });

    it('o valor vai como NÚMERO (59.9), não como o texto "59,90"', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha()]);

        await planilhaDoReembolsoGoogle().atualizarCelulas('lescent', [{ linha: 2, coluna: COL.valor, valor: 59.9 }], prazo());

        expect(aba.atualizacoes[0].celulas[0].valor).toBe(59.9);
        expect(typeof aba.atualizacoes[0].celulas[0].valor).toBe('number');
    });

    it('texto que parece fórmula ou data no meio da frase NÃO é interpretado: vai RAW', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha()]);

        await planilhaDoReembolsoGoogle().atualizarCelulas('lescent', [
            { linha: 2, coluna: COL.motivo, valor: '=HYPERLINK("http://x","clique")' },
            { linha: 2, coluna: COL.responsavel, valor: 'Ana em 30/10/2026' },
        ], prazo());

        expect(aba.atualizacoes).toHaveLength(1);
        expect(aba.atualizacoes[0].valueInputOption).toBe('RAW');
    });

    it('o endereço A1 usa a letra da coluna (a coluna 27 é a AB) e o número da linha, com o nome da aba entre aspas', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha()]);

        await planilhaDoReembolsoGoogle().atualizarCelulas('lescent', [
            { linha: 2, coluna: COL.status, valor: 'Cancelado' },
            { linha: 2, coluna: 0, valor: 'x' },
        ], prazo());

        const { aba: nomeDaAba } = resolverPlanilha('reembolso', 'lescent', 'staging');
        expect(aba.atualizacoes[0].celulas.map((c) => c.range)).toEqual([`'${nomeDaAba}'!AB2`, `'${nomeDaAba}'!A2`]);
    });

    it('só texto ⇒ uma chamada; só data ⇒ uma chamada; nada a escrever ⇒ nenhuma', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha()]);
        const porta = planilhaDoReembolsoGoogle();

        await porta.atualizarCelulas('lescent', [{ linha: 2, coluna: COL.status, valor: 'Cancelado' }], prazo());
        expect(aba.atualizacoes).toHaveLength(1);

        await porta.atualizarCelulas('lescent', [{ linha: 2, coluna: COL.data, valor: '30/10/2026' }], prazo());
        expect(aba.atualizacoes).toHaveLength(2);

        await porta.atualizarCelulas('lescent', [], prazo());
        expect(aba.atualizacoes).toHaveLength(2);
    });

    it('erro do Google sobe (quem chama trata como "a planilha falhou")', async () => {
        instalarGoogleFalso(cabecalho(), [linha()]);
        vi.mocked(global.fetch).mockImplementation(async (input) => {
            if (String(input).startsWith('https://oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
            return new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status: 403 });
        });

        await expect(planilhaDoReembolsoGoogle().atualizarCelulas('lescent', [{ linha: 2, coluna: 0, valor: 'x' }], prazo())).rejects.toThrow('permission');
    });
});

describe('a gestão do reembolso de ponta a ponta, com a porta do Google', () => {
    function montar(): RefundGestaoDeps & ReturnType<typeof depsFalsas> {
        const deps = depsFalsas();
        deps.planilha = planilhaDoReembolsoGoogle() as unknown as typeof deps.planilha;
        deps.prazoDaPlanilha = () => prazo();
        deps.buscarReembolsoMaisRecente.mockResolvedValue({
            idSolicitacao: ID, numeroPedido: PEDIDO_EXEMPLO, status: 'aberto', criadoEm: CRIADO_EM_EXEMPLO,
        });
        return deps;
    }

    it('concluir: a fila, e depois a planilha com o status e o responsável (RAW) e a data de hoje como data de verdade', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha()]);
        const deps = montar();

        const resposta = await concluirReembolso({ brand: 'lescent', idSolicitacao: ID, handledBy: AGENTE }, deps);

        expect(resposta).toEqual({ status: 200, body: { code: 'SUCCESS', message: `Reembolso marcado como concluído. ${NO_PROXIMO_LOTE}` } });
        expect(deps.enfileirarAtualizacao).toHaveBeenCalledTimes(1);
        const gravada = aba.linhas[0];
        expect(gravada[COL.status]).toBe('Realizado');
        expect(gravada[COL.responsavel]).toBe(AGENTE);
        expect(gravada[COL.data]).toBe(serialDaData(HOJE_EM_SP));
        expect(aba.formatados[`2:${COL.data}`]).toBe(HOJE_EM_SP);
        expect(aba.atualizacoes.map((a) => a.valueInputOption)).toEqual(['RAW', 'USER_ENTERED']);
        expect(deps.avisar).not.toHaveBeenCalled();
    });

    it('sincronizar: lê a linha formatada (a data do backoffice como dd/mm/aaaa) e leva à fila, sem escrever na planilha', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha('Realizado', null, 'Ana')]);
        comDataDeExecucao(aba, 2, '25/10/2026');
        const deps = montar();
        deps.buscarCasoPorId.mockResolvedValue(casoNaRaw({ status: 'aberto' }));

        const resposta = await sincronizarReembolso({ brand: 'lescent', idSolicitacao: ID, handledBy: AGENTE }, deps);

        expect(resposta.body.code).toBe('SUCCESS');
        expect(deps.enfileirarAtualizacao.mock.calls[0][1]).toStrictEqual({
            status_execucao: 'Realizado',
            data_execucao: '25/10/2026',
            responsavel_execucao: 'Ana',
        });
        expect(aba.atualizacoes).toEqual([]);
    });

    it('cancelar: marca Cancelado na coluna do status da linha do pedido e do horário certos', async () => {
        const outroCaso = Object.assign([...linha()], { 0: formatarCarimboSP(new Date(CRIADO_EM_EXEMPLO.getTime() - 10 * 60_000)) });
        const aba = instalarGoogleFalso(cabecalho(), [outroCaso, linha()]);
        const deps = montar();

        const resposta = await cancelarReembolsoNaGold({ brand: 'lescent', ecommerceOrderId: PEDIDO_EXEMPLO, handledBy: AGENTE, reason: 'x' }, deps);

        expect(resposta.body).toEqual({ code: 'SUCCESS', message: `Reembolso cancelado. ${NO_PROXIMO_LOTE}` });
        expect(aba.linhas[1][COL.status]).toBe('Cancelado');
        expect(aba.linhas[0][COL.status]).toBeNull();
    });

    it('editar: o valor vai como número (USER_ENTERED) e o motivo como texto (RAW)', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha()]);
        const deps = montar();

        const resposta = await editarReembolsoNaGold({
            brand: 'lescent', ecommerceOrderId: PEDIDO_EXEMPLO, handledBy: AGENTE, changes: { refundAmount: 59.9, refundReason: 'Extravio' },
        }, deps);

        expect(resposta.body).toEqual({ code: 'SUCCESS', message: `Reembolso atualizado. ${NO_PROXIMO_LOTE}` });
        expect(aba.linhas[0][COL.valor]).toBe(59.9);
        expect(aba.formatados[`2:${COL.valor}`]).toBe('59,90');
        expect(aba.linhas[0][COL.motivo]).toBe('Extravio');
        expect(aba.atualizacoes.map((a) => a.valueInputOption)).toEqual(['RAW', 'USER_ENTERED']);
    });

    it('a planilha vence: o Realizado do backoffice trava concluir e cancelar, e quem lê a linha é a porta real', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [linha('Realizado', null, 'Ana')]);
        comDataDeExecucao(aba, 2, '25/10/2026');
        const deps = montar();

        const concluir = await concluirReembolso({ brand: 'lescent', idSolicitacao: ID, handledBy: AGENTE }, deps);
        const cancelar = await cancelarReembolsoNaGold({ brand: 'lescent', ecommerceOrderId: PEDIDO_EXEMPLO, handledBy: AGENTE, reason: 'x' }, deps);

        expect(concluir.status).toBe(422);
        expect(cancelar.status).toBe(422);
        expect(deps.enfileirarAtualizacao).not.toHaveBeenCalled();
        expect(aba.atualizacoes).toEqual([]);
    });

    it('linha que não está na planilha (carimbo fora da tolerância): a fila aceita, a resposta leva SHEET_ROW_NOT_FOUND e o Chat é avisado', async () => {
        const aba = instalarGoogleFalso(cabecalho(), [Object.assign([...linha()], { 0: formatarCarimboSP(new Date(CRIADO_EM_EXEMPLO.getTime() + 5 * 60_000)) })]);
        const deps = montar();

        const resposta = await concluirReembolso({ brand: 'lescent', idSolicitacao: ID, handledBy: AGENTE }, deps);

        expect(resposta.body.code).toBe('SUCCESS');
        expect(resposta.body.reason).toBe('SHEET_ROW_NOT_FOUND');
        expect(aba.atualizacoes).toEqual([]);
        expect(deps.avisar).toHaveBeenCalledTimes(1);
    });
});
