import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// O gateway e o Data Mart têm testes próprios: aqui importa a ordem entre os dois (decisão deste app, `cxhub/ORIGEM.md`).
vi.mock('@shared/lib/shopify/buscarPedidoNoGateway', () => ({ buscarPedidoNoGateway: vi.fn() }));
vi.mock('@shared/lib/datamart/pedidoDaShopifyServer', () => ({ buscarPedidoDaShopifyNoDataMart: vi.fn() }));

import { buscarPedidoDaShopifyNoDataMart } from '@shared/lib/datamart/pedidoDaShopifyServer';
import { buscarPedidoNoGateway } from '@shared/lib/shopify/buscarPedidoNoGateway';
import { buscarPedidoNoGatewayOuNoDataMart } from '@shared/lib/shopify/buscarPedidoNoGatewayOuNoDataMart';
import type { ShopifyOrder } from '@shared/types/index';

const noGateway = vi.mocked(buscarPedidoNoGateway);
const noDataMart = vi.mocked(buscarPedidoDaShopifyNoDataMart);

const DO_GATEWAY = { name: 'SH1724179AP' } as unknown as ShopifyOrder;
const DO_DATA_MART = { name: '#1607929' } as unknown as ShopifyOrder;

beforeEach(() => {
    noGateway.mockReset();
    noDataMart.mockReset().mockResolvedValue({ tipo: 'achado', pedido: DO_DATA_MART });
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('buscarPedidoNoGatewayOuNoDataMart', () => {
    it('o gateway achou: vale ele, e o Data Mart nem é lido', async () => {
        noGateway.mockResolvedValue({ tipo: 'achado', pedido: DO_GATEWAY });

        expect(await buscarPedidoNoGatewayOuNoDataMart('apice', '1724179', 10_000)).toEqual({ tipo: 'achado', pedido: DO_GATEWAY });
        expect(noDataMart).not.toHaveBeenCalled();
    });

    it('fora dos 60 dias do gateway (não encontrado), o pedido vem do Data Mart', async () => {
        noGateway.mockResolvedValue({ tipo: 'nao_encontrado' });

        expect(await buscarPedidoNoGatewayOuNoDataMart('apice', '1607929', 10_000)).toEqual({ tipo: 'achado', pedido: DO_DATA_MART });
        expect(noGateway).toHaveBeenCalledWith('apice', '1607929', 10_000, undefined);
        expect(noDataMart).toHaveBeenCalledWith('apice', '1607929');
    });

    it('o gateway com falha também cai no Data Mart, e a Rituária também', async () => {
        noGateway.mockResolvedValue({ tipo: 'falha', status: 502, erro: 'Shopify gateway error: 401' });

        expect(await buscarPedidoNoGatewayOuNoDataMart('rituaria', '123456', 10_000)).toEqual({ tipo: 'achado', pedido: DO_DATA_MART });
        expect(noDataMart).toHaveBeenCalledWith('rituaria', '123456');
    });

    it('sem o pedido nos dois, vale o desfecho do gateway (o não encontrado, ou a falha com o status)', async () => {
        noDataMart.mockResolvedValue({ tipo: 'nao_encontrado' });
        noGateway.mockResolvedValueOnce({ tipo: 'nao_encontrado' });
        expect(await buscarPedidoNoGatewayOuNoDataMart('apice', '999', 10_000)).toEqual({ tipo: 'nao_encontrado' });

        noDataMart.mockResolvedValue({ tipo: 'falha', erro: 'Metabase fora' });
        noGateway.mockResolvedValueOnce({ tipo: 'falha', status: 504, erro: 'Request timeout' });
        expect(await buscarPedidoNoGatewayOuNoDataMart('apice', '999', 10_000)).toEqual({ tipo: 'falha', status: 504, erro: 'Request timeout' });
    });

    it('com prazo (o bot), o Data Mart só é lido se a consulta dele ainda cabe', async () => {
        noGateway.mockResolvedValue({ tipo: 'nao_encontrado' });

        expect(await buscarPedidoNoGatewayOuNoDataMart('apice', '1607929', 10_000, Date.now() + 2_000)).toEqual({ tipo: 'nao_encontrado' });
        expect(noDataMart).not.toHaveBeenCalled();

        expect(await buscarPedidoNoGatewayOuNoDataMart('apice', '1607929', 10_000, Date.now() + 30_000)).toEqual({ tipo: 'achado', pedido: DO_DATA_MART });
    });
});
