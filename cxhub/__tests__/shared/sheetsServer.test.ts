import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    anexarLinha,
    atualizarCelulas,
    esperaAntesDeRepetir,
    esperaDaCota,
    lerAba,
    lerIntervalos,
    lerRetryAfter,
    SheetsError,
    abaA1,
} from '@shared/lib/sheets/server';
import { __resetGoogleTokenCache } from '@shared/lib/sheets/googleAuth';
import type { PlanilhaDestino } from '@shared/lib/sheets';
import {
    destinoDoAppend,
    intervalosDoLote,
    linhaDoAppend,
    mockGoogle,
    stubGoogleEnv,
    URL_DO_TOKEN,
    type RespostaMock,
} from '../helpers/google-sheets-mock';
import { ateTerminar, ligarRelogioFalso } from '../helpers/relogio-falso';

const DESTINO: PlanilhaDestino = {
    spreadsheetId: 'planilha-123',
    aba: 'Respostas ao formulário 1',
    intervalo: 'A1:H1',
    inserirLinhas: false,
};

const prazoFolgado = () => Date.now() + 10_000;

describe('shared/lib/sheets/server', () => {
    beforeEach(() => {
        __resetGoogleTokenCache();
        stubGoogleEnv();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    describe('anexarLinha', () => {
        it('faz o mesmo values:append USER_ENTERED que os nodes do n8n', async () => {
            const google = mockGoogle();
            await anexarLinha(DESTINO, ['a', null, 3], prazoFolgado());

            const [append] = google.appends();
            expect(append.method).toBe('POST');
            expect(destinoDoAppend(append)).toContain(
                "/spreadsheets/planilha-123/values/'Respostas ao formulário 1'!A1:H1:append?valueInputOption=USER_ENTERED"
            );
            expect(append.url).not.toContain('insertDataOption');
            expect(append.body).toEqual({ majorDimension: 'ROWS', values: [['a', null, 3]] });
            expect(append.headers.Authorization).toBe('Bearer google-token');
        });

        it('manda INSERT_ROWS só onde o n8n mandava', async () => {
            const google = mockGoogle();
            await anexarLinha({ ...DESTINO, inserirLinhas: true }, ['x'], prazoFolgado());
            expect(google.appends()[0].url).toContain('insertDataOption=INSERT_ROWS');
        });

        it('pede o token da conta de serviço uma vez e reusa o cache', async () => {
            const google = mockGoogle();
            await anexarLinha(DESTINO, ['1'], prazoFolgado());
            await anexarLinha(DESTINO, ['2'], prazoFolgado());

            expect(google.tokens()).toHaveLength(1);
            const corpo = new URLSearchParams(google.tokens()[0].body as string);
            expect(corpo.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
            expect(corpo.get('assertion')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
            expect(google.appends().map(linhaDoAppend)).toEqual([['1'], ['2']]);
        });

        it('sem credencial falha FECHADO e sem nenhuma requisição', async () => {
            vi.stubEnv('GOOGLE_PLANILHAS_TOKEN', '');
            const google = mockGoogle();

            const erro = await anexarLinha(DESTINO, ['x'], prazoFolgado()).catch((e) => e);
            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.incerto).toBe(false);
            expect(erro.message).toContain('GOOGLE_PLANILHAS_TOKEN');
            expect(google.chamadas).toHaveLength(0);
        });

        it('falha do token é CERTA — nada foi gravado', async () => {
            mockGoogle({ token: { rede: new Error('ECONNRESET') } });
            const erro = await anexarLinha(DESTINO, ['x'], prazoFolgado()).catch((e) => e);
            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.incerto).toBe(false);
        });

        it('recusa do token (HTTP 400) é CERTA e leva o status', async () => {
            mockGoogle({ token: { status: 400, json: { error: 'invalid_grant' } } });
            const erro = await anexarLinha(DESTINO, ['x'], prazoFolgado()).catch((e) => e);
            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.incerto).toBe(false);
            expect(erro.status).toBe(400);
        });

        it('retenta 503 (o Google disse que não fez)', async () => {
            const google = mockGoogle({ append: [{ status: 503 }, { status: 200 }] });
            await anexarLinha(DESTINO, ['x'], prazoFolgado());
            expect(google.appends()).toHaveLength(2);
        });

        it("retentar 'nenhuma': nem 503 nem 429 são repetidos — quem repete (o gravarLinha) confere a linha do caso antes", async () => {
            const google = mockGoogle({ append: [{ status: 503 }, { status: 200 }] });
            await expect(anexarLinha(DESTINO, ['x'], prazoFolgado(), { retentar: 'nenhuma' })).rejects.toBeInstanceOf(SheetsError);
            expect(google.appends()).toHaveLength(1);

            const google429 = mockGoogle({ append: [{ status: 429 }, { status: 200 }] });
            await expect(anexarLinha(DESTINO, ['x'], prazoFolgado(), { retentar: 'nenhuma' })).rejects.toBeInstanceOf(SheetsError);
            expect(google429.appends()).toHaveLength(1);
        });

        it('5xx deixa o erro como INCERTO (a escrita pode ter sido feita); 4xx é certo', async () => {
            mockGoogle({ append: { status: 504 } });
            const erro5xx = await anexarLinha(DESTINO, ['x'], prazoFolgado(), { retentar: 'nenhuma' }).catch((e) => e);
            expect(erro5xx.incerto).toBe(true);
            expect(erro5xx.status).toBe(504);

            mockGoogle({ append: { status: 403 } });
            const erro4xx = await anexarLinha(DESTINO, ['x'], prazoFolgado(), { retentar: 'nenhuma' }).catch((e) => e);
            expect(erro4xx.incerto).toBe(false);
        });

        it('NÃO retenta 4xx — permissão não melhora tentando', async () => {
            const google = mockGoogle({ append: { status: 403, json: { error: { message: 'The caller does not have permission' } } } });

            const erro = await anexarLinha(DESTINO, ['x'], prazoFolgado()).catch((e) => e);
            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.status).toBe(403);
            expect(erro.incerto).toBe(false);
            expect(erro.message).toContain('does not have permission');
            expect(google.appends()).toHaveLength(1);
        });

        it('NÃO retenta falha de rede na escrita — a 1ª pode ter gravado', async () => {
            const google = mockGoogle({ append: { rede: new Error('socket hang up') } });

            const erro = await anexarLinha(DESTINO, ['x'], prazoFolgado()).catch((e) => e);
            expect(erro.incerto).toBe(true);
            expect(google.appends()).toHaveLength(1);
        });

        it('401 descarta o token em cache: a chamada seguinte pede outro', async () => {
            const google = mockGoogle({ append: [{ status: 401 }, { status: 200 }] });

            await expect(anexarLinha(DESTINO, ['1'], prazoFolgado())).rejects.toBeInstanceOf(SheetsError);
            await anexarLinha(DESTINO, ['2'], prazoFolgado());

            expect(google.tokens()).toHaveLength(2);
        });

        it('prazo já esgotado nem chama o Google', async () => {
            const google = mockGoogle();
            const erro = await anexarLinha(DESTINO, ['x'], Date.now() - 1).catch((e) => e);
            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.incerto).toBe(false);
            expect(google.appends()).toHaveLength(0);
        });
    });

    describe('lerAba', () => {
        it('lê sem formatação, só até a coluna pedida', async () => {
            const google = mockGoogle({ leitura: [['Carimbo'], [46000.5]] });
            const valores = await lerAba('planilha-123', 'Respostas ao formulário', prazoFolgado(), { ate: 'J' });

            expect(valores).toEqual([['Carimbo'], [46000.5]]);
            const url = decodeURIComponent(google.leituras()[0].url);
            expect(url).toContain("/values/'Respostas ao formulário'!A:J?");
            expect(url).toContain('valueRenderOption=UNFORMATTED_VALUE');
            expect(url).toContain('dateTimeRenderOption=SERIAL_NUMBER');
        });

        it('`intervalo` troca o recorte inteiro: só a linha 1, ou só uma coluna', async () => {
            const google = mockGoogle({ leitura: [['Carimbo de data/hora']] });
            await lerAba('planilha-123', 'Respostas ao formulário', prazoFolgado(), { intervalo: '1:1' });
            await lerAba('planilha-123', 'Respostas ao formulário', prazoFolgado(), { intervalo: 'AR:AR' });

            const [cabecalho, coluna] = google.leituras().map((c) => decodeURIComponent(c.url));
            expect(cabecalho).toContain("/values/'Respostas ao formulário'!1:1?");
            expect(coluna).toContain("/values/'Respostas ao formulário'!AR:AR?");
        });

        it('formatado: lê a aba inteira como texto de tela, com o FORMATTED_VALUE explícito (a data não chega como serial)', async () => {
            const google = mockGoogle({ leitura: [] });
            await lerAba('cfg', 'Dados', prazoFolgado(), { formatado: true });
            const url = decodeURIComponent(google.leituras()[0].url);
            expect(url).toMatch(/\/values\/'Dados'\?valueRenderOption=FORMATTED_VALUE$/);
            expect(url).not.toContain('UNFORMATTED_VALUE');
            expect(url).not.toContain('dateTimeRenderOption');
        });

        it('formatado e `intervalo`: uma linha só como texto de tela', async () => {
            const google = mockGoogle({ leitura: [['x']] });
            await lerAba('cfg', 'Dados', prazoFolgado(), { formatado: true, intervalo: '7:7' });
            expect(decodeURIComponent(google.leituras()[0].url)).toBe(
                "https://sheets.googleapis.com/v4/spreadsheets/cfg/values/'Dados'!7:7?valueRenderOption=FORMATTED_VALUE",
            );
        });

        it('retenta falha de rede na leitura (ler de novo não duplica nada)', async () => {
            let leituras = 0;
            vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
                const url = String(input);
                if (url.startsWith('https://oauth2')) {
                    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
                }
                leituras++;
                if (leituras === 1) throw new Error('ECONNRESET');
                return new Response(JSON.stringify({ values: [['ok']] }));
            });

            await expect(lerAba('p', 'aba', prazoFolgado())).resolves.toEqual([['ok']]);
            expect(leituras).toBe(2);
        });

        it('aba vazia devolve lista vazia', async () => {
            mockGoogle({ leitura: { json: {} } });
            await expect(lerAba('p', 'aba', prazoFolgado())).resolves.toEqual([]);
        });
    });

    describe('atualizarCelulas', () => {
        it('values:batchUpdate com RAW — o texto digitado não vira fórmula nem data', async () => {
            const google = mockGoogle();

            await atualizarCelulas('planilha-123', [
                { intervalo: "'Respostas ao formulário'!J57", valor: 150.5 },
                { intervalo: "'Respostas ao formulário'!N57", valor: 'Avaria' },
            ], prazoFolgado());

            const [chamada] = google.atualizacoes();
            expect(chamada.method).toBe('POST');
            expect(chamada.url).toContain('/spreadsheets/planilha-123/values:batchUpdate');
            expect(chamada.headers.Authorization).toBe('Bearer google-token');
            expect(chamada.body).toEqual({
                valueInputOption: 'RAW',
                data: [
                    { range: "'Respostas ao formulário'!J57", values: [[150.5]] },
                    { range: "'Respostas ao formulário'!N57", values: [['Avaria']] },
                ],
            });
        });

        it('`entrada: USER_ENTERED` faz a data e o número virarem data e número na planilha; o padrão continua RAW', async () => {
            const google = mockGoogle();

            await atualizarCelulas('planilha-123', [
                { intervalo: "'Respostas ao formulário'!F7", valor: '30/10/2026' },
                { intervalo: "'Respostas ao formulário'!C7", valor: 59.9 },
            ], prazoFolgado(), { entrada: 'USER_ENTERED' });
            await atualizarCelulas('planilha-123', [{ intervalo: "'Respostas ao formulário'!E7", valor: 'Realizado' }], prazoFolgado());

            const [comEntrada, padrao] = google.atualizacoes();
            expect(comEntrada.body).toEqual({
                valueInputOption: 'USER_ENTERED',
                data: [
                    { range: "'Respostas ao formulário'!F7", values: [['30/10/2026']] },
                    { range: "'Respostas ao formulário'!C7", values: [[59.9]] },
                ],
            });
            expect((padrao.body as { valueInputOption: string }).valueInputOption).toBe('RAW');
        });

        it('repetir é inofensivo, então falha de rede é retentada', async () => {
            let chamadas = 0;
            vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
                if (String(input).startsWith('https://oauth2')) {
                    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
                }
                chamadas++;
                if (chamadas === 1) throw new Error('ECONNRESET');
                return new Response(JSON.stringify({}));
            });

            await atualizarCelulas('p', [{ intervalo: "'aba'!A1", valor: 'x' }], prazoFolgado());

            expect(chamadas).toBe(2);
        });
    });

    describe('lerIntervalos — vários recortes numa requisição só (values:batchGet)', () => {
        const ABA = 'Respostas ao formulário';

        it('uma requisição, sem formatação (UNFORMATTED_VALUE + serial de data), e uma matriz por recorte, na ordem', async () => {
            const google = mockGoogle({
                leitura: (intervalo) => (intervalo.endsWith('!A:A') ? [['Carimbo'], [46000.5]] : [['Número do pedido'], ['SH1LC']]),
            });

            const [carimbos, pedidos] = await lerIntervalos('planilha-123', ABA, ['A:A', 'G:G'], prazoFolgado());

            expect(carimbos).toEqual([['Carimbo'], [46000.5]]);
            expect(pedidos).toEqual([['Número do pedido'], ['SH1LC']]);
            const [leitura, ...outras] = google.leituras();
            expect(outras).toEqual([]);
            expect(leitura.url).toContain('https://sheets.googleapis.com/v4/spreadsheets/planilha-123/values:batchGet?');
            expect(intervalosDoLote(leitura.url)).toEqual([`'${ABA}'!A:A`, `'${ABA}'!G:G`]);
            expect(leitura.url).toContain('valueRenderOption=UNFORMATTED_VALUE');
            expect(leitura.url).toContain('dateTimeRenderOption=SERIAL_NUMBER');
            // O espaço do nome da aba vai como %20, não como `+`.
            expect(leitura.url).toContain("ranges='Respostas%20ao%20formul%C3%A1rio'!A%3AA");
            expect(leitura.headers.Authorization).toBe('Bearer google-token');
        });

        it('recorte vazio (o Google não manda `values`) vira lista vazia', async () => {
            vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
                if (String(input).startsWith(URL_DO_TOKEN)) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
                return new Response(JSON.stringify({ valueRanges: [{ range: "'aba'!A1:A1000" }, { range: "'aba'!G1:G2", values: [['x']] }] }));
            });

            await expect(lerIntervalos('p', 'aba', ['A:A', 'G:G'], prazoFolgado())).resolves.toEqual([[], [['x']]]);
        });

        it.each([
            ['sem valueRanges', {}],
            ['com menos intervalos que os recortes', { valueRanges: [{ values: [['x']] }] }],
        ])('resposta %s ⇒ SheetsError, nunca "coluna vazia" (a conferência não acharia a linha, e a gravação a duplicaria)', async (_nome, corpo) => {
            vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
                if (String(input).startsWith(URL_DO_TOKEN)) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
                return new Response(JSON.stringify(corpo));
            });

            const erro = await lerIntervalos('p', 'aba', ['A:A', 'G:G'], prazoFolgado()).catch((e) => e);

            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.message).toContain('não trouxe os 2 intervalos pedidos');
        });

        it('erro do Google com a semântica de sempre: 4xx é certo e não repete', async () => {
            const google = mockGoogle({ leitura: { status: 403, json: { error: { message: 'The caller does not have permission' } } } });

            const erro = await lerIntervalos('p', 'aba', ['A:A', 'G:G'], prazoFolgado()).catch((e) => e);

            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.status).toBe(403);
            expect(erro.incerto).toBe(false);
            expect(erro.message).toContain('does not have permission');
            expect(google.leituras()).toHaveLength(1);
        });

        it('nenhum recorte ⇒ nenhuma requisição', async () => {
            const google = mockGoogle();
            await expect(lerIntervalos('p', 'aba', [], prazoFolgado())).resolves.toEqual([]);
            expect(google.chamadas).toHaveLength(0);
        });
    });

    describe('a cota (429): espera em escada, com jitter, numa camada só', () => {
        /** Uma resposta só de microtarefas (o `json()` é uma promessa resolvida): o relógio falso mede as esperas exatas. */
        function resposta(r: RespostaMock): Response {
            if (r.rede) throw r.rede;
            const status = r.status ?? 200;
            return { ok: status < 300, status, headers: new Headers(r.headers), json: async () => r.json ?? {} } as unknown as Response;
        }

        const LOTE_OK: RespostaMock = { json: { valueRanges: [{ values: [['x']] }, { values: [['y']] }] } };

        /** O Google que responde a sequência dada (a última se repete) e anota, no relógio falso, quando cada chamada chegou. */
        function googleEmSequencia(respostas: RespostaMock[]) {
            const instantes: number[] = [];
            vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
                if (String(input).startsWith(URL_DO_TOKEN)) return resposta({ json: { access_token: 't', expires_in: 3600 } });
                instantes.push(Date.now());
                return resposta(respostas[Math.min(instantes.length - 1, respostas.length - 1)]);
            });
            return instantes;
        }

        let inicio: number;

        beforeEach(() => {
            ligarRelogioFalso();
            inicio = Date.now();
            // Jitter no meio da faixa: as esperas ficam exatas (1 s, 2 s, 4 s).
            vi.spyOn(Math, 'random').mockReturnValue(0.5);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        const desdeOInicio = (instantes: number[]) => instantes.map((t) => t - inicio);

        it('429 que não passa: tenta 4 vezes, esperando 1 s, 2 s e 4 s, e falha com o 429 (certo: a cota recusou, nada foi lido)', async () => {
            const instantes = googleEmSequencia([{ status: 429, json: { error: { message: 'Quota exceeded' } } }]);

            const erro = await ateTerminar(lerIntervalos('p', 'aba', ['A:A', 'G:G'], inicio + 25_000).catch((e) => e));

            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.status).toBe(429);
            expect(erro.incerto).toBe(false);
            expect(erro.message).toContain('Quota exceeded');
            expect(desdeOInicio(instantes)).toEqual([0, 1_000, 3_000, 7_000]);
        });

        it('a escada para quando a cota volta', async () => {
            const instantes = googleEmSequencia([{ status: 429 }, { status: 429 }, LOTE_OK]);

            await expect(ateTerminar(lerIntervalos('p', 'aba', ['A:A', 'G:G'], inicio + 25_000))).resolves.toEqual([[['x']], [['y']]]);

            expect(desdeOInicio(instantes)).toEqual([0, 1_000, 3_000]);
        });

        it('sempre dentro do prazo: a espera que não deixa 1,5 s para a tentativa seguinte não é feita', async () => {
            const instantes = googleEmSequencia([{ status: 429 }]);

            // 5 s: espera 1 s (sobram 5 s) e 2 s (sobram 4 s); a de 4 s, com 2 s sobrando, não cabe.
            const erro = await ateTerminar(lerIntervalos('p', 'aba', ['A:A'], inicio + 5_000).catch((e) => e));

            expect(erro.status).toBe(429);
            expect(desdeOInicio(instantes)).toEqual([0, 1_000, 3_000]);
        });

        it('o Retry-After do Google é o piso da espera', async () => {
            const instantes = googleEmSequencia([{ status: 429, headers: { 'Retry-After': '3' } }, LOTE_OK]);

            await ateTerminar(lerIntervalos('p', 'aba', ['A:A', 'G:G'], inicio + 25_000));

            expect(desdeOInicio(instantes)).toEqual([0, 3_000]);
        });

        it('Retry-After que passa do prazo: desiste na hora, com o Retry-After no erro, em vez de esperar à toa', async () => {
            const instantes = googleEmSequencia([{ status: 429, headers: { 'Retry-After': '60' } }, LOTE_OK]);

            const erro = await ateTerminar(lerIntervalos('p', 'aba', ['A:A'], inicio + 25_000).catch((e) => e));

            expect(erro.status).toBe(429);
            expect(erro.retryAfterMs).toBe(60_000);
            expect(instantes).toHaveLength(1);
        });

        it('retentarCota: false (a lista, que é informativa): a cota estourada falha na hora; o 5xx ainda é repetido', async () => {
            const instantes = googleEmSequencia([{ status: 429 }, LOTE_OK]);
            const erro = await ateTerminar(lerIntervalos('p', 'aba', ['A:A'], inicio + 25_000, { retentarCota: false }).catch((e) => e));
            expect(erro.status).toBe(429);
            expect(instantes).toHaveLength(1);

            const instantes5xx = googleEmSequencia([{ status: 503 }, LOTE_OK]);
            await ateTerminar(lerIntervalos('p', 'aba', ['A:A', 'G:G'], Date.now() + 25_000, { retentarCota: false }));
            expect(instantes5xx).toHaveLength(2);
        });

        it('o lerAba (cabeçalho, linha da gestão) e o atualizarCelulas (repetir é inofensivo) também esperam a cota', async () => {
            const leituras = googleEmSequencia([{ status: 429 }, { json: { values: [['Carimbo']] } }]);
            await expect(ateTerminar(lerAba('p', 'aba', inicio + 25_000, { intervalo: '1:1' }))).resolves.toEqual([['Carimbo']]);
            expect(desdeOInicio(leituras)).toEqual([0, 1_000]);

            const escritas = googleEmSequencia([{ status: 429 }, { json: {} }]);
            await ateTerminar(atualizarCelulas('p', [{ intervalo: "'aba'!A2", valor: 'x' }], Date.now() + 25_000));
            expect(escritas).toHaveLength(2);
        });

        it("o append com retentar 'nenhuma' não espera a cota: o 429 sobe na hora, com o Retry-After, para quem repete (o gravarLinha)", async () => {
            const instantes = googleEmSequencia([{ status: 429, headers: { 'Retry-After': '2' } }, { json: {} }]);

            const erro = await ateTerminar(anexarLinha(DESTINO, ['x'], inicio + 25_000, { retentar: 'nenhuma' }).catch((e) => e));

            expect(erro).toBeInstanceOf(SheetsError);
            expect(erro.status).toBe(429);
            expect(erro.retryAfterMs).toBe(2_000);
            expect(instantes).toHaveLength(1);
        });

        it('rede e 5xx seguem como antes: 2 tentativas, 500 ms entre elas, e o 5xx continua incerto', async () => {
            const instantes = googleEmSequencia([{ status: 503 }]);

            const erro = await ateTerminar(lerIntervalos('p', 'aba', ['A:A'], inicio + 25_000).catch((e) => e));

            expect(erro.status).toBe(503);
            expect(erro.incerto).toBe(true);
            expect(desdeOInicio(instantes)).toEqual([0, 500]);
        });
    });

    describe('a régua da espera', () => {
        it('esperaDaCota: ~1 s, ~2 s, ~4 s, com jitter de ±25%', () => {
            expect([1, 2, 3].map((tentativa) => esperaDaCota(tentativa, () => 0.5))).toEqual([1_000, 2_000, 4_000]);
            expect([1, 2, 3].map((tentativa) => esperaDaCota(tentativa, () => 0))).toEqual([750, 1_500, 3_000]);
            expect([1, 2, 3].map((tentativa) => esperaDaCota(tentativa, () => 0.999999))).toEqual([1_250, 2_500, 5_000]);
        });

        it('esperaAntesDeRepetir: 500 ms fora da cota, a escada na cota, e o Retry-After como piso', () => {
            vi.spyOn(Math, 'random').mockReturnValue(0.5);

            expect(esperaAntesDeRepetir(undefined, 1)).toBe(500);
            expect(esperaAntesDeRepetir(new SheetsError('rede', true), 1)).toBe(500);
            expect(esperaAntesDeRepetir(new SheetsError('5xx', true, 503), 1)).toBe(500);
            expect(esperaAntesDeRepetir(new SheetsError('cota', false, 429), 1)).toBe(1_000);
            expect(esperaAntesDeRepetir(new SheetsError('cota', false, 429), 3)).toBe(4_000);
            expect(esperaAntesDeRepetir(new SheetsError('cota', false, 429, 5_000), 1)).toBe(5_000);
            expect(esperaAntesDeRepetir(new SheetsError('cota', false, 429, 100), 1)).toBe(1_000);
            expect(esperaAntesDeRepetir(new SheetsError('5xx', true, 503, 3_000), 1)).toBe(3_000);
        });

        it('lerRetryAfter: em segundos ou como data HTTP; o resto não conta', () => {
            expect(lerRetryAfter('3')).toBe(3_000);
            expect(lerRetryAfter(' 0 ')).toBe(0);
            expect(lerRetryAfter(null)).toBeUndefined();
            expect(lerRetryAfter('')).toBeUndefined();
            expect(lerRetryAfter('daqui a pouco')).toBeUndefined();

            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
            expect(lerRetryAfter('Wed, 11 Nov 2026 12:00:05 GMT')).toBe(5_000);
            expect(lerRetryAfter('Wed, 11 Nov 2026 11:59:00 GMT')).toBe(0);
            vi.useRealTimers();
        });
    });

    it('abaA1 escapa aspas simples', () => {
        expect(abaA1("Aba d'água")).toBe("'Aba d''água'");
    });
});
