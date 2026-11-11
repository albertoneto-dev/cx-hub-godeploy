import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// O Chat nunca é chamado de verdade: o `sendAlert` é substituído, e os testes olham o que ele recebeu.
vi.mock('@shared/lib/alerts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/lib/alerts')>()),
    sendAlert: vi.fn(),
}));

import { formatAlert, sendAlert } from '@shared/lib/alerts';
import type { SupportedBrand } from '@shared/lib/constants';
import { formatarCarimboSP } from '@shared/lib/format';
import {
    JANELA_PLANILHA_MS,
    gravarLinhaNaPlanilha,
    gravarNasPlanilhas,
    prazoDaPlanilha,
    type CasoDaLinha,
    type GravarDeps,
} from '@shared/lib/sheets/gravarLinha';
import { COLUNAS_DO_CASO, __resetCasoNaPlanilha } from '@shared/lib/sheets/casoNaPlanilha';
import { __resetGoogleTokenCache } from '@shared/lib/sheets/googleAuth';
import { resolverPlanilha, type FluxoPlanilha, type SheetCell } from '@shared/lib/sheets';
import { buildResendRow } from '@modules/reenvios/actions/buildResendRow';
import { RESEND_DATA } from '../helpers/resend-fixtures';
import { responder, stubGoogleEnv, URL_DO_TOKEN, intervaloDaLeitura, intervalosDaLeitura } from '../helpers/google-sheets-mock';
import { cabecalhoDoLayout, instalarGoogleFalso } from '../helpers/google-sheets-falso';
import { ateTerminar, ligarRelogioFalso } from '../helpers/relogio-falso';

const alerta = vi.mocked(sendAlert);

const ID = '6f1c0e2a-1111-4222-8333-444455556666';
/** 27/10/2026, 15:00:00 em São Paulo (UTC−3): o `criado_em` do caso e, formatado, o carimbo da linha. */
const CRIADO_EM = new Date('2026-10-27T18:00:00.000Z');
const CARIMBO = formatarCarimboSP(CRIADO_EM);
const MIN = 60_000;
const em = (ms: number) => new Date(CRIADO_EM.getTime() + ms);

const LINHA = buildResendRow('kokeshi', RESEND_DATA, CARIMBO);
/** O caso desta linha: o pedido (sem o `#SHOPIFY`, como a linha o leva) e o `criado_em`. */
const CASO: CasoDaLinha = { idSolicitacao: ID, pedido: RESEND_DATA.numeroPedido, criadoEm: CRIADO_EM };
const CABECALHO = cabecalhoDoLayout('reenvio', 'kokeshi', LINHA.length);
const { pedido: COLUNA_PEDIDO } = COLUNAS_DO_CASO.reenvio.kokeshi;

const prazoFolgado = () => Date.now() + 10_000;
const semEspera: GravarDeps = { esperar: vi.fn(async () => {}) };

const gravar = (linha: SheetCell[] = LINHA, caso: CasoDaLinha = CASO, deps: GravarDeps = semEspera) =>
    gravarLinhaNaPlanilha('reenvio', 'kokeshi', linha, caso, prazoFolgado(), deps);

/** A linha de OUTRO caso do mesmo pedido, ou do mesmo caso em outro horário: o que muda é só o carimbo. */
const comCarimbo = (carimbo: SheetCell, pedido?: SheetCell): SheetCell[] =>
    LINHA.map((celula, i) => (i === 0 ? carimbo : i === COLUNA_PEDIDO && pedido !== undefined ? pedido : celula));

describe('prazoDaPlanilha', () => {
    it('é um instante, a JANELA_PLANILHA_MS adiante de agora', () => {
        const antes = Date.now();
        const prazo = prazoDaPlanilha();
        expect(prazo).toBeGreaterThanOrEqual(antes + JANELA_PLANILHA_MS);
        expect(prazo).toBeLessThanOrEqual(Date.now() + JANELA_PLANILHA_MS);
    });
});

describe('gravarLinhaNaPlanilha', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        __resetCasoNaPlanilha();
        stubGoogleEnv();
        alerta.mockReset().mockResolvedValue(true);
        vi.mocked(semEspera.esperar).mockClear();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    describe('sem a linha do caso na planilha', () => {
        it('anexa a linha como ela é (sem coluna extra) ⇒ gravado, e o carimbo é o criado_em do caso', async () => {
            const google = instalarGoogleFalso(CABECALHO);

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.linhas).toEqual([LINHA]);
            expect(google.linhas[0][0]).toBe(CARIMBO);
            expect(alerta).not.toHaveBeenCalled();
        });

        it('lê só o cabeçalho e as duas colunas (carimbo e pedido), as duas numa requisição — nunca a aba inteira (nome e endereço de toda cliente)', async () => {
            const google = instalarGoogleFalso(CABECALHO);

            await gravar();

            const leituras = vi.mocked(global.fetch).mock.calls
                .map(([url]) => String(url))
                .filter((url) => url.startsWith('https://sheets.googleapis.com/') && !url.includes(':append'))
                .map(intervalosDaLeitura);
            const { aba } = resolverPlanilha('reenvio', 'kokeshi');
            expect(leituras).toEqual([[`'${aba}'!1:1`], [`'${aba}'!A:A`, `'${aba}'!G:G`]]);
            // Uma gravação: o cabeçalho (guardado 10 min), UMA leitura das colunas (eram duas) e o append.
            expect(google.contagem).toEqual({ cabecalho: 1, colunas: 1, appends: 1 });
        });

        it('outro caso do MESMO pedido, em outro horário (10 min antes), não confunde: a linha do caso é anexada', async () => {
            const google = instalarGoogleFalso(CABECALHO, [comCarimbo(formatarCarimboSP(em(-10 * MIN)))]);

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.linhas).toHaveLength(2);
        });

        it('o MESMO horário com outro pedido não confunde', async () => {
            const google = instalarGoogleFalso(CABECALHO, [comCarimbo(CARIMBO, 'SH9999999')]);

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.linhas).toHaveLength(2);
        });

        it('linha em branco ou com carimbo torto na planilha nunca é duplicata', async () => {
            const google = instalarGoogleFalso(CABECALHO, [[], comCarimbo(''), comCarimbo('sem data')]);

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.linhas).toHaveLength(4);
        });

        it('pedido sem nenhum dígito: não há como conferir, então anexa sem ler a planilha', async () => {
            const google = instalarGoogleFalso(CABECALHO);

            await expect(gravar(LINHA, { ...CASO, pedido: '#ABC' })).resolves.toEqual({ status: 'gravado' });

            expect(google.contagem).toEqual({ cabecalho: 0, colunas: 0, appends: 1 });
        });
    });

    describe('com a linha do caso já na planilha (idempotência)', () => {
        it('mesmo pedido e mesmo carimbo ⇒ ja_existia, SEM append', async () => {
            const google = instalarGoogleFalso(CABECALHO, [LINHA]);

            await expect(gravar()).resolves.toEqual({ status: 'ja_existia' });

            expect(google.contagem.appends).toBe(0);
            expect(google.linhas).toHaveLength(1);
        });

        it.each([
            ['30 segundos antes', em(-30_000)],
            ['1 min e 59 s depois', em(2 * MIN - 1_000)],
            ['2 min depois (o limite)', em(2 * MIN)],
        ])('carimbo %s do criado_em ainda é a linha do caso (a tolerância é de 2 min)', async (_nome, carimbo) => {
            const google = instalarGoogleFalso(CABECALHO, [comCarimbo(formatarCarimboSP(carimbo))]);

            await expect(gravar()).resolves.toEqual({ status: 'ja_existia' });

            expect(google.contagem.appends).toBe(0);
        });

        it.each([
            ['2 min e 1 s depois', em(2 * MIN + 1_000)],
            ['3 min antes', em(-3 * MIN)],
        ])('carimbo %s do criado_em já é OUTRO caso: a linha é anexada', async (_nome, carimbo) => {
            const google = instalarGoogleFalso(CABECALHO, [comCarimbo(formatarCarimboSP(carimbo))]);

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.contagem.appends).toBe(1);
        });

        it('o pedido compara só os dígitos: a linha com "#9000105" é a de "SH9000105LC"', async () => {
            const google = instalarGoogleFalso(CABECALHO, [comCarimbo(CARIMBO, '220183')]);

            await expect(gravar()).resolves.toEqual({ status: 'ja_existia' });

            expect(google.contagem.appends).toBe(0);
        });

        it('várias linhas na planilha: acha a certa entre elas', async () => {
            const google = instalarGoogleFalso(CABECALHO, [
                comCarimbo(formatarCarimboSP(em(-10 * MIN))),
                comCarimbo(CARIMBO, 'SH1'),
                LINHA,
                comCarimbo(formatarCarimboSP(em(40 * MIN))),
            ]);

            await expect(gravar()).resolves.toEqual({ status: 'ja_existia' });

            expect(google.contagem.appends).toBe(0);
        });
    });

    describe('o cabeçalho confere com o layout', () => {
        it('cabeçalho que não bate (alguém moveu o pedido de coluna) ⇒ falhou, SEM append e SEM retentativa', async () => {
            const cabecalho = [...CABECALHO];
            cabecalho[COLUNA_PEDIDO] = 'Observações';
            const google = instalarGoogleFalso(cabecalho);

            const resultado = await gravar();

            expect(resultado.status).toBe('falhou');
            expect(resultado.motivo).toContain('não bate com o layout de reenvio/kokeshi');
            expect(google.contagem.appends).toBe(0);
            expect(semEspera.esperar).not.toHaveBeenCalled();
        });

        it('cache: a segunda gravação não lê a linha 1 de novo', async () => {
            const google = instalarGoogleFalso(CABECALHO);

            await gravar(LINHA, { ...CASO, idSolicitacao: 'id-1' });
            await gravar(LINHA, { ...CASO, idSolicitacao: 'id-2', criadoEm: em(30 * MIN) });

            expect(google.contagem.cabecalho).toBe(1);
        });

        it('o cache expira em ~10 min: o cabeçalho é lido de novo (o backoffice pode ter mexido nas colunas)', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
            const google = instalarGoogleFalso(CABECALHO);

            await gravar(LINHA, { ...CASO, idSolicitacao: 'id-1', criadoEm: em(1 * MIN) });
            vi.setSystemTime(new Date('2026-10-30T12:09:00Z'));
            await gravar(LINHA, { ...CASO, idSolicitacao: 'id-2', criadoEm: em(60 * MIN) });
            expect(google.contagem.cabecalho).toBe(1);

            vi.setSystemTime(new Date('2026-10-30T12:11:00Z'));
            await gravar(LINHA, { ...CASO, idSolicitacao: 'id-3', criadoEm: em(120 * MIN) });
            expect(google.contagem.cabecalho).toBe(2);
        });

        it('o cache é por planilha e aba', async () => {
            const google = instalarGoogleFalso(CABECALHO);

            await gravarLinhaNaPlanilha('reenvio', 'kokeshi', LINHA, { ...CASO, idSolicitacao: 'id-1' }, prazoFolgado(), semEspera);
            await gravarLinhaNaPlanilha('reenvio', 'lescent', LINHA, { ...CASO, idSolicitacao: 'id-2', criadoEm: em(60 * MIN) }, prazoFolgado(), semEspera);

            // Cada planilha confere o SEU layout: a Lescent tem o pedido na coluna E (4), não na G (6) da Kokeshi.
            expect(google.contagem.cabecalho).toBe(2);
        });
    });

    describe('falhas e retentativa (até 2 tentativas, sempre conferindo a linha antes)', () => {
        it('rede cai DEPOIS de gravar: a 2ª tentativa confere, acha a linha e NÃO anexa de novo ⇒ gravado, 1 append', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ redeDepoisDeGravar: true });

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.contagem.appends).toBe(1);
            expect(google.contagem.colunas).toBe(2); // as duas colunas (uma requisição), antes de cada tentativa
            expect(google.linhas).toHaveLength(1);
            expect(semEspera.esperar).toHaveBeenCalledWith(500);
        });

        it('rede cai SEM gravar: a 2ª tentativa confere, não acha a linha e anexa ⇒ gravado, 2 appends, 1 linha', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ redeSemGravar: true });

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.contagem.appends).toBe(2);
            expect(google.contagem.colunas).toBe(2);
            expect(google.linhas).toHaveLength(1);
        });

        it('NUNCA anexa sem conferir: se a conferência da 2ª tentativa falha, desiste em vez de arriscar duplicar', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            // O 1º append grava e a resposta se perde; depois disso o Google "cai" para leituras.
            google.appends.push({ redeDepoisDeGravar: true });
            google.leituraFalhaAposAppend = true;

            const resultado = await gravar();

            expect(resultado.status).toBe('falhou');
            expect(resultado.motivo).toContain('ECONNRESET');
            expect(google.contagem.appends).toBe(1);
            expect(google.linhas).toHaveLength(1);
        });

        it('duas tentativas falham ⇒ falhou, com o motivo; nada além de 2 appends', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ redeSemGravar: true }, { redeSemGravar: true }, { redeSemGravar: true });

            const resultado = await gravar();

            expect(resultado.status).toBe('falhou');
            expect(resultado.motivo).toContain('socket hang up');
            expect(google.contagem.appends).toBe(2);
            expect(google.linhas).toHaveLength(0);
        });

        it('4xx (permissão) NÃO é repetido — não melhora tentando', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ status: 403, json: { error: { message: 'The caller does not have permission' } } });

            const resultado = await gravar();

            expect(resultado.status).toBe('falhou');
            expect(resultado.motivo).toContain('The caller does not have permission');
            expect(google.contagem.appends).toBe(1);
            expect(semEspera.esperar).not.toHaveBeenCalled();
        });

        it('5xx que não gravou: quem repete é só o laço, que CONFERE antes ⇒ gravado, 2 appends, 2 conferências, 1 linha', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ status: 503 });

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            // O append em si não se repete sozinho: 1 request por tentativa, e a conferência vem antes de cada uma.
            expect(google.contagem.appends).toBe(2);
            expect(google.contagem.colunas).toBe(2);
            expect(google.linhas).toHaveLength(1);
        });

        it('append repetido depois de 5xx/504 que gravou (o gateway respondeu erro com a escrita feita): a conferência acha a linha e NÃO duplica', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ status: 504, gravou: true });

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.contagem.appends).toBe(1); // nenhum append às cegas, nem dentro do anexarLinha nem no laço
            expect(google.contagem.colunas).toBe(2);
            expect(google.linhas).toEqual([LINHA]);
        });

        it('502 depois de gravar, e a 2ª tentativa também depois de gravar: continua uma linha só', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ status: 502, gravou: true }, { status: 502, gravou: true });

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.linhas).toHaveLength(1);
        });

        it('429 no append também passa pelo laço, que espera a cota (~1 s, ±25%) e confere antes de repetir (o anexarLinha não repete sozinho)', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ status: 429 });

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(google.contagem.appends).toBe(2);
            expect(google.contagem.colunas).toBe(2);
            expect(google.linhas).toHaveLength(1);
            const [[espera]] = vi.mocked(semEspera.esperar).mock.calls;
            expect(espera).toBeGreaterThanOrEqual(750);
            expect(espera).toBeLessThanOrEqual(1_250);
        });

        it('o Retry-After do 429 no append é o piso da espera do laço', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ status: 429, headers: { 'Retry-After': '3' } });

            await expect(gravar()).resolves.toEqual({ status: 'gravado' });

            expect(semEspera.esperar).toHaveBeenCalledWith(3_000);
            expect(google.contagem.appends).toBe(2);
            expect(google.linhas).toHaveLength(1);
        });

        it('Retry-After que não cabe no prazo: desiste na hora, sem esperar à toa e sem outro append', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ status: 429, headers: { 'Retry-After': '30' } });

            const resultado = await gravar();

            expect(resultado.status).toBe('falhou');
            expect(resultado.motivo).toContain('HTTP 429');
            expect(semEspera.esperar).not.toHaveBeenCalled();
            expect(google.contagem.appends).toBe(1);
        });

        describe('a conferência que esbarra na cota (429)', () => {
            /** A aba falsa, mas com a leitura das colunas recusada pela cota. */
            function comCotaEstourada() {
                const google = instalarGoogleFalso(CABECALHO);
                const falso = vi.mocked(global.fetch).getMockImplementation()!;
                const lotes: number[] = [];
                vi.mocked(global.fetch).mockImplementation(async (input, init) => {
                    if (!String(input).includes('values:batchGet')) return falso(input, init);
                    lotes.push(Date.now());
                    return responder({ status: 429, json: { error: { message: 'Quota exceeded for quota metric Read requests' } } });
                });
                return { google, lotes };
            }

            beforeEach(() => {
                ligarRelogioFalso();
                vi.spyOn(Math, 'random').mockReturnValue(0.5);
            });

            it('NÃO é repetida pelo laço: só a escada da leitura (4 leituras em ~7 s), nenhum append, e o motivo diz 429', async () => {
                const { google, lotes } = comCotaEstourada();
                const inicio = Date.now();

                const resultado = await ateTerminar(gravarLinhaNaPlanilha('reenvio', 'kokeshi', LINHA, CASO, inicio + 25_000, semEspera));

                expect(resultado.status).toBe('falhou');
                expect(resultado.motivo).toContain('HTTP 429');
                // Antes: 2 tentativas do laço × 2 do chamarGoogle × 2 colunas = até 8 leituras em ~1,5 s. Agora: 4 leituras.
                expect(lotes.map((t) => t - inicio)).toEqual([0, 1_000, 3_000, 7_000]);
                expect(semEspera.esperar).not.toHaveBeenCalled();
                expect(google.contagem.appends).toBe(0);
            });

            it('a cota que volta no meio da escada: a linha entra, uma vez', async () => {
                const google = instalarGoogleFalso(CABECALHO);
                const falso = vi.mocked(global.fetch).getMockImplementation()!;
                let recusadas = 0;
                vi.mocked(global.fetch).mockImplementation(async (input, init) => {
                    if (String(input).includes('values:batchGet') && recusadas < 2) {
                        recusadas++;
                        return responder({ status: 429 });
                    }
                    return falso(input, init);
                });

                const resultado = await ateTerminar(gravarLinhaNaPlanilha('reenvio', 'kokeshi', LINHA, CASO, Date.now() + 25_000, semEspera));

                expect(resultado).toEqual({ status: 'gravado' });
                expect(google.linhas).toEqual([LINHA]);
                expect(google.contagem.appends).toBe(1);
            });
        });

        it('sem tempo para outra tentativa (prazo quase no fim) ⇒ desiste', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ redeSemGravar: true });

            const resultado = await gravarLinhaNaPlanilha('reenvio', 'kokeshi', LINHA, CASO, Date.now() + 2_000, semEspera);

            expect(resultado.status).toBe('falhou');
            expect(google.contagem.appends).toBe(1);
        });

        it('token do Google recusado ⇒ falhou, sem a chave no motivo, e nenhuma escrita', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            vi.mocked(global.fetch).mockImplementation(async (input) => {
                if (String(input).startsWith(URL_DO_TOKEN)) {
                    return responder({ status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } });
                }
                throw new Error('não deveria chamar mais nada');
            });

            const resultado = await gravar();

            expect(resultado.status).toBe('falhou');
            expect(resultado.motivo).toContain('invalid_grant');
            expect(resultado.motivo).not.toContain('PRIVATE KEY');
            expect(google.contagem.appends).toBe(0);
        });

        it('NUNCA lança: ambiente inválido vira falhou', async () => {
            vi.stubEnv('SHEETS_ENV', '');

            const resultado = await gravar();

            expect(resultado.status).toBe('falhou');
            expect(resultado.motivo).toContain('SHEETS_ENV');
        });

        it('NUNCA lança: nem com o fetch quebrado por inteiro', async () => {
            vi.spyOn(global, 'fetch').mockImplementation(() => {
                throw new Error('fetch quebrado');
            });

            await expect(gravar()).resolves.toMatchObject({ status: 'falhou' });
        });

        it('o motivo é legível e não leva dado pessoal da linha', async () => {
            const google = instalarGoogleFalso(CABECALHO);
            google.appends.push({ status: 500 }, { status: 500 });

            const resultado = await gravar();

            expect(resultado.status).toBe('falhou');
            for (const pessoal of ['NOME', '(11) 99999-0000', 'END', 'CEP']) {
                expect(resultado.motivo).not.toContain(pessoal);
            }
        });
    });
});

describe('gravarNasPlanilhas', () => {
    /** Uma linha com o carimbo e o pedido nas colunas do layout do fluxo e da marca, e um dado pessoal em outra. */
    function linhaNoLayout(fluxo: FluxoPlanilha, marca: SupportedBrand, pedido: string): SheetCell[] {
        const { carimbo, pedido: colunaPedido } = COLUNAS_DO_CASO[fluxo][marca];
        const linha: SheetCell[] = Array.from({ length: 10 }, () => null);
        linha[carimbo] = CARIMBO;
        linha[colunaPedido] = pedido;
        linha[linha.findIndex((celula) => celula === null)] = 'Cliente Teste';
        return linha;
    }

    const PEDIDO = '220183';
    const LINHA_REEMBOLSO = linhaNoLayout('reembolso', 'barbours', PEDIDO);
    const LINHA_CANCEL = linhaNoLayout('cancelamento', 'barbours', PEDIDO);
    const ID_REEMBOLSO = 'aaaaaaaa-1111-4222-8333-000000000001';
    const ID_CANCELAMENTO = 'aaaaaaaa-1111-4222-8333-000000000002';
    const CONTEXTO = { numeroPedido: PEDIDO, idAtendimento: 'T-1', statusDaFila: 'enfileirado' as const };
    const reenvio = (): Parameters<typeof gravarNasPlanilhas>[0][number] => ({
        fluxo: 'reenvio', marca: 'kokeshi', linha: LINHA, idSolicitacao: ID, pedido: CASO.pedido, criadoEm: CRIADO_EM,
    });
    const reembolso = (): Parameters<typeof gravarNasPlanilhas>[0][number] => ({
        fluxo: 'reembolso', marca: 'barbours', linha: LINHA_REEMBOLSO, idSolicitacao: ID_REEMBOLSO, pedido: PEDIDO, criadoEm: CRIADO_EM,
    });
    const cancelamento = (): Parameters<typeof gravarNasPlanilhas>[0][number] => ({
        fluxo: 'cancelamento', marca: 'barbours', linha: LINHA_CANCEL, idSolicitacao: ID_CANCELAMENTO, pedido: PEDIDO, criadoEm: CRIADO_EM,
    });

    beforeEach(() => {
        __resetGoogleTokenCache();
        __resetCasoNaPlanilha();
        stubGoogleEnv();
        alerta.mockReset().mockResolvedValue(true);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('tudo gravado ⇒ ok, sem aviso e sem erro no log', async () => {
        instalarGoogleFalso(CABECALHO);

        const resultado = await gravarNasPlanilhas([reenvio()], CONTEXTO, prazoFolgado(), semEspera);

        expect(resultado).toEqual({ ok: true });
        expect(alerta).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it('a linha do caso já estar na planilha também é ok (ja_existia)', async () => {
        instalarGoogleFalso(CABECALHO, [LINHA]);

        const resultado = await gravarNasPlanilhas([reenvio()], CONTEXTO, prazoFolgado(), semEspera);

        expect(resultado).toEqual({ ok: true });
    });

    it('falhou ⇒ a linha COMPLETA vai ao log (para repor à mão) e o Chat é avisado, sem dado pessoal', async () => {
        const google = instalarGoogleFalso(CABECALHO);
        google.appends.push({ status: 403, json: { error: { message: 'The caller does not have permission' } } });

        const resultado = await gravarNasPlanilhas([reenvio()], CONTEXTO, prazoFolgado(), semEspera);

        expect(resultado).toEqual({ ok: false, motivo: expect.stringContaining('The caller does not have permission') });

        // o log: a linha inteira, na ordem das colunas, e o id
        const erros = vi.mocked(console.error).mock.calls.map((chamada) => String(chamada[0]));
        const registro = erros.find((texto) => texto.includes('linha não gravada'));
        expect(registro).toBeDefined();
        expect(registro).toContain(ID);
        expect(registro).toContain('reenvio/kokeshi');
        expect(registro).toContain(JSON.stringify(LINHA));

        // o aviso: id, marca, pedido — e nada da linha
        expect(alerta).toHaveBeenCalledTimes(1);
        const ctx = alerta.mock.calls[0][0];
        expect(ctx).toMatchObject({
            reason: 'SHEET_WRITE_FAILED',
            requestId: ID,
            brand: 'kokeshi',
            numeroPedido: PEDIDO,
            idAtendimento: 'T-1',
        });
        const card = formatAlert(ctx);
        for (const pessoal of ['NOME', '(11) 99999-0000', 'END', 'CEP', 'CHAVE']) {
            expect(JSON.stringify(ctx)).not.toContain(pessoal);
            expect(card).not.toContain(pessoal);
        }
        expect(card).toContain(ID);
    });

    it('reembolso do Bot: duas linhas, cada uma na sua planilha; se só a segunda falha, só ela é avisada', async () => {
        const planilhaReembolso = resolverPlanilha('reembolso', 'barbours');
        const planilhaCancelamento = resolverPlanilha('cancelamento', 'barbours');
        const gravadas: Array<{ planilha: string; linha: SheetCell[] }> = [];
        vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
            const url = decodeURIComponent(String(input));
            if (url.startsWith(URL_DO_TOKEN)) return responder({ json: { access_token: 't', expires_in: 3600 } });
            if (url.includes(':append')) {
                if (url.includes(planilhaCancelamento.spreadsheetId)) return responder({ status: 403, json: { error: { message: 'sem permissão' } } });
                gravadas.push({ planilha: url, linha: (JSON.parse(String(init?.body)) as { values: SheetCell[][] }).values[0] });
                return responder({});
            }
            // O cabeçalho de cada planilha bate com o layout dela; as colunas lidas (num `values:batchGet`) vêm vazias.
            const intervalo = intervaloDaLeitura(String(input));
            if (intervalo.endsWith('!1:1')) {
                const fluxo = url.includes(planilhaCancelamento.spreadsheetId) ? 'cancelamento' : 'reembolso';
                return responder({ json: { values: [cabecalhoDoLayout(fluxo, 'barbours')] } });
            }
            return responder({ json: { valueRanges: intervalosDaLeitura(String(input)).map((range) => ({ range })) } });
        });

        const resultado = await gravarNasPlanilhas([reembolso(), cancelamento()], CONTEXTO, prazoFolgado(), semEspera);

        expect(resultado).toEqual({ ok: false, motivo: expect.stringContaining('sem permissão') });
        expect(gravadas).toHaveLength(1);
        expect(gravadas[0].planilha).toContain(planilhaReembolso.spreadsheetId);
        expect(alerta).toHaveBeenCalledTimes(1);
        expect(alerta).toHaveBeenCalledWith(expect.objectContaining({ reason: 'SHEET_WRITE_FAILED', requestId: ID_CANCELAMENTO }));
        expect(alerta.mock.calls[0][0].motivo).toContain(`cancelamento (${ID_CANCELAMENTO})`);
        expect(alerta.mock.calls[0][0].motivo).not.toContain(ID_REEMBOLSO);
    });

    it('reembolso do Bot com as DUAS linhas falhando: UM aviso só, listando os dois pares (fluxo, id) — não dois', async () => {
        const google = instalarGoogleFalso(cabecalhoDoLayout('reembolso', 'barbours'));
        google.appends.push({ status: 403, json: { error: { message: 'sem permissão' } } }, { status: 403, json: { error: { message: 'sem permissão' } } });

        const resultado = await gravarNasPlanilhas([reembolso(), cancelamento()], CONTEXTO, prazoFolgado(), semEspera);

        expect(resultado.ok).toBe(false);
        expect(alerta).toHaveBeenCalledTimes(1);
        const ctx = alerta.mock.calls[0][0];
        expect(ctx.reason).toBe('SHEET_WRITE_FAILED');
        expect(ctx.motivo).toContain(`reembolso (${ID_REEMBOLSO})`);
        expect(ctx.motivo).toContain(`cancelamento (${ID_CANCELAMENTO})`);
        expect(ctx.requestId).toContain(ID_REEMBOLSO);
        expect(ctx.requestId).toContain(ID_CANCELAMENTO);
        expect(ctx.detalhe).toContain('reembolso:');
        expect(ctx.detalhe).toContain('cancelamento:');

        // O log guarda cada linha, para repor as duas à mão.
        const erros = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((t) => t.includes('linha não gravada'));
        expect(erros).toHaveLength(2);
        expect(erros.join('\n')).toContain(JSON.stringify(LINHA_REEMBOLSO));
        expect(erros.join('\n')).toContain(JSON.stringify(LINHA_CANCEL));
    });

    it('cabeçalho da aba que não bate com o layout ⇒ o aviso diz isso, e a linha completa vai ao log', async () => {
        const cabecalho = cabecalhoDoLayout('reenvio', 'kokeshi', LINHA.length);
        cabecalho[COLUNA_PEDIDO] = 'Observações';
        instalarGoogleFalso(cabecalho);

        const resultado = await gravarNasPlanilhas([reenvio()], CONTEXTO, prazoFolgado(), semEspera);

        expect(resultado.ok).toBe(false);
        expect(alerta.mock.calls[0][0].detalhe).toContain('não bate com o layout');
        const erros = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((t) => t.includes('linha não gravada'));
        expect(erros.join('\n')).toContain(JSON.stringify(LINHA));
    });

    it('fila que guardou ⇒ o aviso diz "entrou na fila do Metabase"', async () => {
        const google = instalarGoogleFalso(CABECALHO);
        google.appends.push({ status: 403 });

        await gravarNasPlanilhas([reenvio()], CONTEXTO, prazoFolgado(), semEspera);

        expect(alerta.mock.calls[0][0].motivo).toContain('entrou na fila do Metabase');
    });

    it('fila incerta ⇒ o aviso NÃO afirma que a solicitação está na fila: diz que não deu para confirmar', async () => {
        const google = instalarGoogleFalso(CABECALHO);
        google.appends.push({ status: 403 });

        await gravarNasPlanilhas([reenvio()], { ...CONTEXTO, statusDaFila: 'incerto' }, prazoFolgado(), semEspera);

        const { motivo } = alerta.mock.calls[0][0];
        expect(motivo).toContain('Não deu para confirmar a entrada na fila do Metabase');
        expect(motivo).not.toContain('entrou na fila');
    });

    it('o aviso que lançasse não derruba o resultado (INV-06)', async () => {
        const google = instalarGoogleFalso(CABECALHO);
        google.appends.push({ status: 403 });
        alerta.mockRejectedValue(new Error('chat fora do ar'));

        await expect(gravarNasPlanilhas([reenvio()], CONTEXTO, prazoFolgado(), semEspera)).resolves.toMatchObject({ ok: false });
    });

    it('sem linhas ⇒ ok, sem tocar o Google', async () => {
        const spy = vi.spyOn(global, 'fetch');

        await expect(gravarNasPlanilhas([], CONTEXTO)).resolves.toEqual({ ok: true });

        expect(spy).not.toHaveBeenCalled();
    });
});
