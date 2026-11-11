import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/lib/formDataApi', () => ({ buscarDadosDoFormulario: vi.fn() }));

import { buscarDadosDoFormulario } from '@shared/lib/formDataApi';
import { JANELA_ROTA_DADOS_MS, marcasDoBot } from '@modules/reenvios/actions/marcasDoBot';
import { VALID_RESEND_BRANDS } from '@modules/reenvios/actions/postResendWebhook';

/**
 * As marcas do bot (ADR-015): as que a rota dados lista para o reenvio, só entre as que o código sabe registrar; com a
 * rota dados fora, as do código.
 */

const buscar = vi.mocked(buscarDadosDoFormulario);

const respostaDaRotaDados = (marcas: string[]) => ({
    status: 200,
    body: { marcas, 'responsáveis': ['Ana'], motivos: [], transportadoras_reenvio: [] },
});

beforeEach(() => {
    buscar.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('marcasDoBot', () => {
    it('pergunta à rota dados pela origem reenvio, com a janela do bot', async () => {
        buscar.mockResolvedValue(respostaDaRotaDados(['lescent']));

        await marcasDoBot();

        expect(buscar).toHaveBeenCalledWith('reenvio', JANELA_ROTA_DADOS_MS);
    });

    it('a lista da rota dados manda: só as marcas que ela lista, na ordem do código', async () => {
        buscar.mockResolvedValue(respostaDaRotaDados(['apice', 'lescent', 'gobeaute']));

        expect(await marcasDoBot()).toEqual({ marcas: ['lescent', 'apice', 'gobeaute'], fonte: 'rota-dados' });
    });

    it('marca que o código não conhece fica de fora, e a grafia é normalizada (espaço, maiúscula)', async () => {
        buscar.mockResolvedValue(respostaDaRotaDados(['gocase', ' Yenzah ', 'BARBOURS']));

        expect(await marcasDoBot()).toEqual({ marcas: ['barbours', 'yenzah'], fonte: 'rota-dados' });
    });

    it.each([
        ['sem configuração', { status: 500, body: { error: 'App de configuração do formulário não configurado' } }],
        ['timeout', { status: 504, body: { error: 'O app de configuração do formulário não respondeu a tempo' } }],
        ['credencial recusada', { status: 502, body: { error: 'Credencial do app de configuração do formulário recusada' } }],
        ['app sem banco', { status: 503, body: { error: 'App de configuração do formulário: DB_UNAVAILABLE', code: 'DB_UNAVAILABLE' } }],
    ])('rota dados fora (%s) ⇒ todas as marcas do código, inclusive as sem Cosmos', async (_caso, resposta) => {
        buscar.mockResolvedValue(resposta);

        const resultado = await marcasDoBot();

        expect(resultado).toEqual({ marcas: VALID_RESEND_BRANDS, fonte: 'codigo' });
        expect(resultado.marcas).toEqual(expect.arrayContaining(['apice', 'yenzah', 'denavita', 'gobeaute']));
        expect(console.warn).toHaveBeenCalled();
    });

    it('a lista devolvida é uma cópia: quem a altera não muda a VALID_RESEND_BRANDS', async () => {
        buscar.mockResolvedValue({ status: 504, body: {} });

        const { marcas } = await marcasDoBot();
        marcas.pop();

        expect(VALID_RESEND_BRANDS).toHaveLength(10);
    });
});
