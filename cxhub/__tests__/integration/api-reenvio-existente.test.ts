import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as consultarRota } from '../../app/api/reenvio/existente/route';
import { createRequest } from '../helpers/api-test-utils';

/**
 * `GET /api/reenvio/existente`: a rota inteira, com a fila e o Metabase falsos no `fetch`. As três leituras são as de
 * verdade (o dedup, a lista do registro e o histórico da gold), cada uma reconhecida pelo SQL que manda. Sem header da
 * rota: o gateway confere a `gdk_` antes. Pedidos e nomes fictícios.
 */

const METABASE = 'https://metabase.test';
const FILA = 'https://cx-hub.test';
const INVALIDO = 'Informe o número do pedido: letras, dígitos, # e -, com ao menos um dígito (o da Gocreators, como GC107465BB).';

type Consulta = 'dedup' | 'lista' | 'historico';

let linhasDe: Record<Consulta, unknown[][] | Error>;
let casosNaFila: unknown[];
let filaFora: boolean;
let consultas: Array<{ tipo: Consulta; sql: string }>;

function tipoDaConsulta(sql: string): Consulta {
    if (sql.includes('gold.fct_reenvio_reembolso_gobeaute')) return 'historico';
    if (sql.includes('count(*) as total')) return 'lista';
    return 'dedup';
}

function json(corpo: unknown, status = 200) {
    return new Response(JSON.stringify(corpo), { status });
}

function instalarFetch() {
    consultas = [];
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === `${METABASE}/api/dataset`) {
            const sql = JSON.parse(String(init?.body)).native.query as string;
            const tipo = tipoDaConsulta(sql);
            consultas.push({ tipo, sql });
            const linhas = linhasDe[tipo];
            if (linhas instanceof Error) throw linhas;
            return json({ status: 'completed', data: { rows: linhas } }, 202);
        }
        if (url.startsWith(`${FILA}/api/v1/`)) {
            if (filaFora) return json({ code: 'UNAVAILABLE' }, 503);
            if (url.startsWith(`${FILA}/api/v1/atualizacoes`)) return json({ atualizacoes: [] });
            return json({ casos: casosNaFila });
        }
        throw new Error(`fetch inesperado: ${url}`);
    });
}

function consultar(query: string) {
    return consultarRota(createRequest(`http://localhost/api/reenvio/existente?${query}`));
}

beforeEach(() => {
    vi.stubEnv('METABASE_URL', METABASE);
    vi.stubEnv('METABASE_API_KEY', 'chave');
    vi.stubEnv('METABASE_DATABASE_ID', '43');
    vi.stubEnv('CXHUB_FILA_URL', FILA);
    vi.stubEnv('CXHUB_FILA_TOKEN', 'token-da-fila');
    linhasDe = { dedup: [], lista: [], historico: [] };
    casosNaFila = [];
    filaFora = false;
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('GET /api/reenvio/existente', () => {
    it('marca sem Cosmos com um reenvio de hoje: bloqueiaNovo, o caso no registro e o histórico lido', async () => {
        const fetchSpy = instalarFetch();
        const agora = new Date().toISOString();
        linhasDe.dedup = [['SH1607929AP', 'Ana', agora, 'caso-1']];
        linhasDe.lista = [[1, 'caso-1', 'apice', 'SH1607929AP', agora, false, true, null, 'Extravio', null, 'Ana', agora]];

        const res = await consultar('marca=Apice&pedido=SH1607929AP');

        expect(res.status).toBe(200);
        const corpo = await res.json();
        expect(corpo).toMatchObject({
            code: 'SUCCESS',
            marca: 'apice',
            pedido: '1607929',
            bloqueiaNovo: true,
            bloqueadoPor: { idSolicitacao: 'caso-1', responsavel: 'Ana', solicitadoEm: agora },
            historicoLido: true,
        });
        expect(corpo.message).toMatch(/^Um reenvio novo seria barrado: já existe um reenvio para o pedido feito por Ana em /);
        expect(corpo.reenvios).toEqual([expect.objectContaining({ fonte: 'cxhub', id: 'caso-1', motivo: 'Extravio', situacaoNaFila: null })]);

        expect(consultas.map((c) => c.tipo).sort()).toEqual(['dedup', 'historico', 'lista']);
        const historico = consultas.find((c) => c.tipo === 'historico')!.sql;
        expect(historico).toContain("sigla = 'AP'");
        expect(historico).toContain("= '1607929'");
        // Nem Cosmos nem Shopify: a rota só lê a fila e o Metabase.
        expect(fetchSpy.mock.calls.map(([url]) => String(url)).filter((u) => !u.startsWith(METABASE) && !u.startsWith(FILA))).toEqual([]);
    });

    it('sem reenvio nas 24 h: o histórico da gold aparece, e nada barra um novo', async () => {
        instalarFetch();
        linhasDe.historico = [['fonte_kokeshi_reenvio|1', '716185', '2026-03-02T09:15:00', 'Avaria', 'Realizado', 'Carla']];

        const corpo = await (await consultar('marca=kokeshi&pedido=%23716185')).json();

        expect(corpo).toMatchObject({ code: 'SUCCESS', marca: 'kokeshi', pedido: '716185', bloqueiaNovo: false, bloqueadoPor: null });
        expect(corpo.reenvios).toEqual([{
            fonte: 'historico', id: 'fonte_kokeshi_reenvio|1', numeroPedido: '716185', dataSolicitacao: '2026-03-02T09:15:00',
            motivo: 'Avaria', statusExecucao: 'Realizado', responsavel: 'Carla', situacaoNaFila: null,
        }]);
        expect(corpo.message).toBe('O pedido tem 1 reenvio registrado, e nenhum barra um novo: só barra o reenvio das últimas 24 h que não foi cancelado.');
    });

    it('o caso que ainda está na fila conta: barra e aparece como pendente', async () => {
        instalarFetch();
        const agora = new Date().toISOString();
        casosNaFila = [{
            id_solicitacao: 'caso-fila', tipo: 'REENVIO', marca: 'yenzah', numero_pedido: 'SH555YE', criado_em: agora,
            responsavel: 'Bia', situacao: 'pendente', motivo: 'Extravio',
        }];
        // A lista junta a fila à raw dentro do SQL (`values`): a linha volta do Metabase marcada como da fila.
        linhasDe.lista = [[1, 'caso-fila', 'yenzah', 'SH555YE', agora, true, true, null, null, null, null, null]];

        const corpo = await (await consultar('marca=yenzah&pedido=SH555YE')).json();

        expect(corpo.bloqueiaNovo).toBe(true);
        expect(corpo.bloqueadoPor).toMatchObject({ idSolicitacao: 'caso-fila', responsavel: 'Bia' });
        expect(corpo.reenvios).toEqual([expect.objectContaining({ fonte: 'cxhub', id: 'caso-fila', situacaoNaFila: 'pendente' })]);
    });

    describe('pedido da Gocreators (decisão de 2026-11-27)', () => {
        const hoje = () => new Date().toISOString();
        const casoNaFila = (id: string, numero: string) => ({
            id_solicitacao: id, tipo: 'REENVIO', marca: 'barbours', numero_pedido: numero, criado_em: hoje(),
            responsavel: 'Bia', situacao: 'pendente', motivo: 'Extravio',
        });

        it('o GC responde com o nome inteiro, e o caso do #n de mesmos dígitos não barra nem aparece', async () => {
            instalarFetch();
            casosNaFila = [casoNaFila('caso-sh', '#107465')];

            const corpo = await (await consultar('marca=barbours&pedido=gc107465bb')).json();

            expect(corpo).toMatchObject({ code: 'SUCCESS', marca: 'barbours', pedido: 'GC107465BB', bloqueiaNovo: false, reenvios: [] });
            // A lista junta à raw só os casos da fila do mesmo pedido: o do #107465 nem entra no SQL.
            expect(consultas.find((c) => c.tipo === 'lista')!.sql).not.toContain('caso-sh');
            for (const c of consultas) expect(c.sql, c.tipo).toContain("= '107465' and coalesce(");
            expect(consultas.find((c) => c.tipo === 'historico')!.sql).toContain("= '107465' and coalesce(numero_pedido, '') ~* 'GC[0-9]')");
        });

        it('o GC na fila barra o GC, e não o SH de mesmos dígitos', async () => {
            instalarFetch();
            casosNaFila = [casoNaFila('caso-gc', 'GC107465BB')];

            const doGc = await (await consultar('marca=barbours&pedido=GC107465BB')).json();
            expect(doGc).toMatchObject({ pedido: 'GC107465BB', bloqueiaNovo: true, bloqueadoPor: { idSolicitacao: 'caso-gc' } });

            const doSh = await (await consultar('marca=barbours&pedido=107465')).json();
            expect(doSh).toMatchObject({ pedido: '107465', bloqueiaNovo: false, bloqueadoPor: null });
        });
    });

    it('a gold que falha deixa a resposta de pé, com historicoLido false', async () => {
        instalarFetch();
        linhasDe.historico = new Error('rede');

        const res = await consultar('marca=lescent&pedido=SH716185LC');

        expect(res.status).toBe(200);
        const corpo = await res.json();
        expect(corpo).toMatchObject({ code: 'SUCCESS', historicoLido: false, reenvios: [] });
        expect(corpo.message).toContain('não respondeu');
    });

    it('parâmetro inválido ⇒ 400, sem chamar nada', async () => {
        const fetchSpy = instalarFetch();
        for (const [query, mensagem] of [
            ['pedido=123', 'Informe a marca.'],
            ['marca=gocase&pedido=123', 'Marca inválida: gocase.'],
            ['marca=apice', INVALIDO],
            ['marca=apice&pedido=abc', INVALIDO],
            ["marca=apice&pedido=1'2", INVALIDO],
            // O reenvio GC não é um pedido, e cair nos dígitos acharia o #n de mesmo número (decisão de 2026-11-27).
            ['marca=barbours&pedido=GC107465BB-R-1', INVALIDO],
        ]) {
            const res = await consultar(query);
            expect(res.status, query).toBe(400);
            expect(await res.json(), query).toEqual({ code: 'INVALID_REQUEST', message: mensagem });
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sem o Metabase configurado ⇒ 503, antes de ler qualquer coisa', async () => {
        const fetchSpy = instalarFetch();
        vi.stubEnv('METABASE_API_KEY', '');

        const res = await consultar('marca=apice&pedido=1607929');

        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe('UNAVAILABLE');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a raw que não responde ⇒ 504; a fila fora ⇒ 502', async () => {
        instalarFetch();
        linhasDe.dedup = new Error('rede');
        linhasDe.lista = new Error('rede');
        const semRaw = await consultar('marca=apice&pedido=1607929');
        expect(semRaw.status).toBe(504);
        expect(await semRaw.json()).toEqual({ code: 'API_TIMEOUT', message: 'O Metabase não respondeu.' });

        linhasDe = { dedup: [], lista: [], historico: [] };
        filaFora = true;
        const semFila = await consultar('marca=apice&pedido=1607929');
        expect(semFila.status).toBe(502);
        expect(await semFila.json()).toEqual({ code: 'UNKNOWN_ERROR', message: 'Não foi possível ler a fila do registro.' });
    });
});
