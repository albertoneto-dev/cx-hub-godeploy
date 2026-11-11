import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    atualizacoesNaFila,
    casosAbertosNaFila,
    casoNaFila,
    casosDoPedidoNaFila,
    enfileirarAtualizacao,
    enfileirarCasos,
    filaConfigurada,
    FilaError,
} from '@shared/lib/fila';
import type { CasoCxhub } from '@shared/lib/airflow/types';

/**
 * Cliente da fila do app GoDeploy `cx-hub` (`docs/fila-cxhub.md`). O que importa: as duas credenciais, o 302 do
 * gateway como credencial errada, os três desfechos da escrita (só o transitório é repetido, e com o mesmo corpo,
 * porque a fila é idempotente) e a leitura que confere o contrato da resposta.
 */

const URL_FILA = 'https://cx-hub.test';

interface Chamada { url: string; init: RequestInit }

function fetchFalso(respostas: Array<[number, unknown] | Error>) {
    const chamadas: Chamada[] = [];
    const fila = [...respostas];
    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        chamadas.push({ url: String(input), init: init ?? {} });
        const proxima = fila.shift() ?? [500, { code: 'SEM_RESPOSTA' }];
        if (proxima instanceof Error) throw proxima;
        const [status, corpo] = proxima;
        return new Response(JSON.stringify(corpo), { status });
    });
    return chamadas;
}

const caso = (sobre: Partial<CasoCxhub> = {}): CasoCxhub => ({
    id_solicitacao: 'id-1',
    tipo: 'REEMBOLSO',
    marca: 'lescent',
    criado_em: '2026-11-04T10:00:00-03:00',
    numero_pedido: 'SH9000105LC',
    ...sobre,
});

const daqui = (ms: number) => Date.now() + ms;

beforeEach(() => {
    vi.stubEnv('CXHUB_FILA_URL', `${URL_FILA}/`);
    vi.stubEnv('CXHUB_FILA_TOKEN', 'token-da-fila');
    vi.stubEnv('CXHUB_FILA_GODEPLOY_KEY', 'gdk_chave');
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('filaConfigurada', () => {
    it('exige a URL e o token; a chave do gateway é opcional (app local)', () => {
        expect(filaConfigurada()).toBe(true);
        vi.stubEnv('CXHUB_FILA_GODEPLOY_KEY', '');
        expect(filaConfigurada()).toBe(true);
        vi.stubEnv('CXHUB_FILA_TOKEN', '');
        expect(filaConfigurada()).toBe(false);
    });
});

describe('enfileirarCasos', () => {
    it('manda os casos com as duas credenciais e sem seguir redirecionamento', async () => {
        const chamadas = fetchFalso([[200, { code: 'ENFILEIRADO', ids: ['id-1'] }]]);
        await expect(enfileirarCasos([caso()], daqui(10_000))).resolves.toEqual({ status: 'enfileirado' });

        expect(chamadas).toHaveLength(1);
        expect(chamadas[0].url).toBe(`${URL_FILA}/api/v1/casos`);
        const headers = chamadas[0].init.headers as Record<string, string>;
        expect(headers['x-cxhub-fila-token']).toBe('token-da-fila');
        expect(headers.Authorization).toBe('Bearer gdk_chave');
        expect(chamadas[0].init.redirect).toBe('manual');
        expect(JSON.parse(String(chamadas[0].init.body))).toEqual({ casos: [caso()] });
    });

    it('sem a chave do gateway, não manda Authorization', async () => {
        vi.stubEnv('CXHUB_FILA_GODEPLOY_KEY', '');
        const chamadas = fetchFalso([[200, { code: 'ENFILEIRADO' }]]);
        await enfileirarCasos([caso()], daqui(10_000));
        expect((chamadas[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it('caso fora do contrato da DAG é recusado sem chamar a fila', async () => {
        const chamadas = fetchFalso([]);
        const resultado = await enfileirarCasos([caso({ marca: 'gocase' as CasoCxhub['marca'] })], daqui(10_000));
        expect(resultado).toEqual({ status: 'recusado', motivo: expect.stringContaining('marca desconhecida') });
        expect(chamadas).toHaveLength(0);
    });

    it('sem configuração, recusa sem chamar a fila', async () => {
        vi.stubEnv('CXHUB_FILA_URL', '');
        const chamadas = fetchFalso([]);
        expect((await enfileirarCasos([caso()], daqui(10_000))).status).toBe('recusado');
        expect(chamadas).toHaveLength(0);
    });

    it.each([
        [302, 'credencial'],
        [401, 'credencial'],
        [400, 'HTTP 400 INVALID_REQUEST'],
    ])('HTTP %i é recusa certa, sem retentativa', async (status, trecho) => {
        const chamadas = fetchFalso([[status, { code: 'INVALID_REQUEST' }]]);
        const resultado = await enfileirarCasos([caso()], daqui(10_000));
        expect(resultado).toEqual({ status: 'recusado', motivo: expect.stringContaining(trecho) });
        expect(chamadas).toHaveLength(1);
    });

    it('5xx ou rede repete uma vez com o mesmo corpo (a fila é idempotente)', async () => {
        const chamadas = fetchFalso([[503, { code: 'UNAVAILABLE' }], [200, { code: 'ENFILEIRADO' }]]);
        await expect(enfileirarCasos([caso()], daqui(10_000))).resolves.toEqual({ status: 'enfileirado' });
        expect(chamadas).toHaveLength(2);
        expect(chamadas[1].init.body).toBe(chamadas[0].init.body);
    });

    it('duas falhas transitórias dão incerto: pode ter chegado', async () => {
        fetchFalso([new TypeError('fetch failed'), [502, {}]]);
        await expect(enfileirarCasos([caso()], daqui(10_000))).resolves.toEqual({
            status: 'incerto', motivo: 'a fila respondeu HTTP 502',
        });
    });

    it('sem tempo para nenhuma tentativa é recusa certa', async () => {
        const chamadas = fetchFalso([]);
        await expect(enfileirarCasos([caso()], daqui(500))).resolves.toEqual({
            status: 'recusado', motivo: 'sem tempo para entregar à fila',
        });
        expect(chamadas).toHaveLength(0);
    });
});

describe('enfileirarAtualizacao', () => {
    it('leva id e instante próprios: no lote é o atualizado_em que ordena', async () => {
        const chamadas = fetchFalso([[200, { code: 'ENFILEIRADO' }]]);
        const agora = new Date('2026-11-04T13:05:00.000Z');
        await expect(
            enfileirarAtualizacao('id-1', { status_execucao: 'Cancelado', responsavel_execucao: 'Ana' }, daqui(10_000), agora),
        ).resolves.toEqual({ status: 'enfileirado' });

        expect(chamadas[0].url).toBe(`${URL_FILA}/api/v1/atualizacoes`);
        const [item] = JSON.parse(String(chamadas[0].init.body)).atualizacoes;
        expect(item).toEqual({
            id_atualizacao: expect.stringMatching(/^[0-9a-f-]{36}$/),
            id_solicitacao: 'id-1',
            atualizado_em: '2026-11-04T13:05:00.000Z',
            campos: { status_execucao: 'Cancelado', responsavel_execucao: 'Ana' },
        });
    });

    it('a retentativa repete o mesmo id_atualizacao', async () => {
        const chamadas = fetchFalso([[500, {}], [200, { code: 'ENFILEIRADO' }]]);
        await enfileirarAtualizacao('id-1', { valor: 10 }, daqui(10_000));
        expect(chamadas[1].init.body).toBe(chamadas[0].init.body);
    });

    it('atualização fora do contrato é recusada sem chamar a fila', async () => {
        const chamadas = fetchFalso([]);
        const resultado = await enfileirarAtualizacao('id-1', { status_execucao: 'Feito' as never }, daqui(10_000));
        expect(resultado.status).toBe('recusado');
        expect(chamadas).toHaveLength(0);
    });
});

describe('leituras', () => {
    const naFila = {
        id_solicitacao: 'id-1', tipo: 'REEMBOLSO', marca: 'lescent', numero_pedido: 'SH9000105LC',
        criado_em: '2026-11-04T10:00:00-03:00', responsavel: 'Ana', situacao: 'pendente',
    };

    it('casos do pedido: só os dígitos vão na query, o mais novo primeiro', async () => {
        const chamadas = fetchFalso([[200, { casos: [naFila, { ...naFila, id_solicitacao: 'id-2', criado_em: '2026-11-04T11:00:00-03:00' }] }]]);
        const casos = await casosDoPedidoNaFila('REEMBOLSO', 'lescent', '#SH9000105LC');
        expect(new URL(chamadas[0].url).searchParams.get('pedido')).toBe('9000105');
        expect(casos.map((c) => c.idSolicitacao)).toEqual(['id-2', 'id-1']);
        expect(casos[1]).toEqual({
            idSolicitacao: 'id-1', tipo: 'REEMBOLSO', marca: 'lescent', numeroPedido: 'SH9000105LC',
            criadoEm: '2026-11-04T10:00:00-03:00', responsavel: 'Ana', situacao: 'pendente',
        });
    });

    it('pedido sem dígito não consulta', async () => {
        const chamadas = fetchFalso([]);
        await expect(casosDoPedidoNaFila('REEMBOLSO', 'lescent', 'SH')).resolves.toEqual([]);
        expect(chamadas).toHaveLength(0);
    });

    it('caso por id: null quando a fila não tem', async () => {
        fetchFalso([[200, { caso: null }], [200, { caso: naFila }]]);
        await expect(casoNaFila('nao-tem')).resolves.toBeNull();
        await expect(casoNaFila('id-1')).resolves.toMatchObject({ idSolicitacao: 'id-1', situacao: 'pendente' });
    });

    it('atualizações em ordem de atualizado_em', async () => {
        const a = { id_atualizacao: 'a', id_solicitacao: 'id-1', campos: { valor: 1 }, situacao: 'pendente' };
        const chamadas = fetchFalso([[200, { atualizacoes: [
            { ...a, id_atualizacao: 'depois', atualizado_em: '2026-11-04T13:10:00Z' },
            { ...a, id_atualizacao: 'antes', atualizado_em: '2026-11-04T13:05:00Z' },
        ] }]]);
        const lidas = await atualizacoesNaFila(['id-1', 'id-2']);
        expect(new URL(chamadas[0].url).searchParams.get('ids')).toBe('id-1,id-2');
        expect(lidas.map((x) => x.idAtualizacao)).toEqual(['antes', 'depois']);
    });

    it('a leitura repete o transitório uma vez e depois lança FilaError', async () => {
        fetchFalso([[503, {}], [200, { caso: null }]]);
        await expect(casoNaFila('id-1')).resolves.toBeNull();

        fetchFalso([[503, {}], [503, {}]]);
        await expect(casoNaFila('id-1')).rejects.toBeInstanceOf(FilaError);
    });

    it('resposta fora do contrato lança, em vez de virar "não tem"', async () => {
        fetchFalso([[200, { casos: [{ ...naFila, situacao: 'perdido' }] }]]);
        await expect(casosDoPedidoNaFila('REEMBOLSO', 'lescent', '123')).rejects.toThrow('situação desconhecida');
        fetchFalso([[200, {}]]);
        await expect(casoNaFila('id-1')).rejects.toThrow('sem o campo "caso"');
    });

    it('sem configuração, a leitura lança', async () => {
        vi.stubEnv('CXHUB_FILA_TOKEN', '');
        await expect(casoNaFila('id-1')).rejects.toBeInstanceOf(FilaError);
    });
});

describe('casosAbertosNaFila', () => {
    const aberto = {
        id_solicitacao: 'id-1', tipo: 'REEMBOLSO', marca: 'lescent', numero_pedido: 'SH1', criado_em: '2026-11-04T10:00:00-03:00',
        responsavel: 'Ana', situacao: 'pendente', valor: 'R$ 1.234,56', motivo: 'Extravio',
    };

    it('manda o tipo e, quando há, a marca e os dígitos do pedido; lê valor e motivo', async () => {
        const chamadas = fetchFalso([[200, { casos: [aberto] }]]);
        const casos = await casosAbertosNaFila({ tipo: 'REEMBOLSO', marca: 'lescent', pedido: '#SH1' });
        const url = new URL(chamadas[0].url);
        expect(url.pathname).toBe('/api/v1/casos/abertos');
        expect(Object.fromEntries(url.searchParams)).toEqual({ tipo: 'REEMBOLSO', marca: 'lescent', pedido: '1' });
        expect(casos).toEqual([expect.objectContaining({ idSolicitacao: 'id-1', situacao: 'pendente', valor: 1234.56, motivo: 'Extravio' })]);
    });

    it('sem marca nem pedido, só o tipo vai', async () => {
        const chamadas = fetchFalso([[200, { casos: [] }]]);
        await casosAbertosNaFila({ tipo: 'REENVIO' });
        expect(Object.fromEntries(new URL(chamadas[0].url).searchParams)).toEqual({ tipo: 'REENVIO' });
    });

    it('404 (o app ainda sem a rota) é fila vazia; outro erro sobe', async () => {
        fetchFalso([[404, {}]]);
        await expect(casosAbertosNaFila({ tipo: 'REENVIO' })).resolves.toEqual([]);
        fetchFalso([[400, {}]]);
        await expect(casosAbertosNaFila({ tipo: 'REENVIO' })).rejects.toBeInstanceOf(FilaError);
    });
});
