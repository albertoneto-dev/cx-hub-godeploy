import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A leitura tem testes próprios (`pedidoNoDataMart.test.ts`): aqui importa a costura com as regras.
vi.mock('@shared/lib/datamart/pedidoServer', () => ({ lerPedidoNoDataMart: vi.fn() }));

import { conferirPedidoNoDataMart, JANELA_CONFERENCIA_MS, prazoDaConferencia } from '@shared/lib/datamart/conferenciaServer';
import { lerPedidoNoDataMart } from '@shared/lib/datamart/pedidoServer';
import type { LeiturasDoPedido } from '@shared/lib/datamart/pedidoTipos';

const ler = vi.mocked(lerPedidoNoDataMart);
const FALHA = { ok: false, motivo: 'Metabase fora' } as const;

beforeEach(() => {
    ler.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('prazoDaConferencia', () => {
    it('a janela de 12 s, ou o prazo de quem chama se acabar antes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        expect(prazoDaConferencia()).toBe(1_000_000 + JANELA_CONFERENCIA_MS);
        expect(prazoDaConferencia(1_005_000)).toBe(1_005_000);
        expect(prazoDaConferencia(1_060_000)).toBe(1_000_000 + JANELA_CONFERENCIA_MS);
    });
});

describe('conferirPedidoNoDataMart', () => {
    it('só Ápice, Yenzah e Denavita: as marcas do Cosmos e a Gobeaute não têm a conferência', async () => {
        for (const marca of ['lescent', 'gobeaute', 'xyz']) {
            expect(await conferirPedidoNoDataMart(marca, 'SH1001GB', Date.now() + 1000)).toEqual({ tipo: 'nao_se_aplica' });
        }
        expect(ler).not.toHaveBeenCalled();
    });

    it('número que não é de pedido não é consultado', async () => {
        for (const numero of [null, '', 'SH', '1184356468908164']) {
            expect(await conferirPedidoNoDataMart('apice', numero, Date.now() + 1000)).toEqual({
                tipo: 'nao_conferido', motivo: 'o número do pedido não dá para consultar no Data Mart',
            });
        }
        expect(ler).not.toHaveBeenCalled();
    });

    it('lê pelos dígitos e deriva o contexto (mesmo com tudo falhando, o CD da Denavita é MG)', async () => {
        const leituras: LeiturasDoPedido = { marca: 'denavita', numero: '423209', intelipost: FALHA, shopify: FALHA, explodidas: FALHA };
        ler.mockResolvedValue(leituras);
        const prazo = Date.now() + 5000;

        const r = await conferirPedidoNoDataMart('denavita', 'SH423209DN', prazo);

        expect(ler).toHaveBeenCalledWith('denavita', '423209', prazo);
        expect(r).toMatchObject({
            tipo: 'lido',
            contexto: { pedido: 'SH423209DN', nf: { estado: 'desconhecida' }, cd: { valor: 'CD MG', conferido: true }, baseConferida: false },
        });
    });

    it('uma falha inesperada nunca derruba o registro: volta "não conferido"', async () => {
        ler.mockRejectedValue(new Error('bug'));

        expect(await conferirPedidoNoDataMart('yenzah', 'SH5478YE', Date.now() + 1000)).toEqual({
            tipo: 'nao_conferido', motivo: 'falha inesperada na conferência',
        });
    });
});
