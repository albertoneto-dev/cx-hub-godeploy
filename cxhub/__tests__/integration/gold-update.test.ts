import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('next/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: vi.fn(),
}));

import { after } from 'next/server';
import { POST as cancelResendRoute } from '../../app/api/cosmos/resends/[id]/cancel/route';
import { PATCH as updateResendRoute } from '../../app/api/cosmos/resends/[id]/route';
import { createRequest } from '../helpers/api-test-utils';

/**
 * Cancelar e editar reenvio levam a alteração à gold DEPOIS da resposta (`after`), e só quando o Cosmos
 * confirmou: o id do caso é lido da gold pelo Metabase, e a alteração vai à fila do Metabase (ADR-012), que o lote
 * leva à DAG. O `fetch` falso responde Cosmos, Metabase e a fila; o `after` é capturado e executado à mão.
 */

const AUTH = 'Bearer test-token';
const COSMOS = 'https://api.cosmos.test';
const FILA = 'https://cx-hub.test';
const METABASE = 'https://metabase.test';
const ID = '6f1c0e2a-1111-2222-3333-444455556666';

const ENDERECO = {
    street: 'Rua Antiga', number: '10', complement: 'Ap 1', neighborhood: 'Centro',
    city: 'São Paulo', state: 'SP', postal_code: '01000-000',
};

const REENVIO = {
    id: 42,
    external_id: 'SH12345LC-R-1',
    origin: 'resend',
    status: 'pending',
    erp_status: 'waiting',
    created_at: '2026-10-20T14:05:03-03:00',
    customer: { name: 'Cliente Teste', email: 'cliente@example.com', phone: '11900000000', document: '00000000000', type: 'cpf' },
    shipping: { name: 'Cliente Teste', phone: '11900000000', address: ENDERECO, service_name: 'NORMAL_J&T', cost: '12.5' },
};

let pedidoCosmos: Record<string, unknown>;
let depoisDaAlteracao: Record<string, unknown>;
let linhasMetabase: unknown[][];
let consultas: string[];
interface AtualizacaoNaFila {
    id_atualizacao: string;
    id_solicitacao: string;
    atualizado_em: string;
    campos: Record<string, unknown>;
}
let enfileiradas: AtualizacaoNaFila[];

function instalarFetch() {
    consultas = [];
    enfileiradas = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const metodo = init?.method ?? 'GET';
        if (url === `${METABASE}/api/dataset`) {
            consultas.push(JSON.parse(String(init?.body)).native.query);
            return new Response(JSON.stringify({ status: 'completed', data: { rows: linhasMetabase } }), { status: 202 });
        }
        if (url === `${FILA}/api/v1/atualizacoes` && metodo === 'POST') {
            enfileiradas.push(...(JSON.parse(String(init?.body)).atualizacoes as AtualizacaoNaFila[]));
            return new Response(JSON.stringify({ code: 'ENFILEIRADO' }), { status: 200 });
        }
        if (url.startsWith(`${COSMOS}/organizations/3/carriers`)) {
            return new Response(JSON.stringify(url.includes('?') ? [] : { id: 161, shopify_name: 'Loggi', active: true }), { status: 200 });
        }
        if (url.startsWith(`${COSMOS}/organizations/3/orders/42`)) {
            return new Response(JSON.stringify(metodo === 'GET' ? pedidoCosmos : depoisDaAlteracao), { status: 200 });
        }
        throw new Error(`fetch inesperado: ${metodo} ${url}`);
    });
}

/** Roda o que a rota agendou com `after`, como a plataforma faria depois da resposta. */
async function rodarAgendados() {
    for (const [fn] of vi.mocked(after).mock.calls) {
        await (fn as () => Promise<unknown>)();
    }
}

function rota(caminho: string, method: string, body: unknown) {
    return createRequest(`http://localhost${caminho}`, { method, headers: { Authorization: AUTH }, body });
}

const params = { params: Promise.resolve({ id: '42' }) };

beforeEach(() => {
    vi.mocked(after).mockReset();
    vi.stubEnv('COSMOS_API_URL', COSMOS);
    vi.stubEnv('TIMEOUT', '10000');
    vi.stubEnv('CXHUB_FILA_URL', FILA);
    vi.stubEnv('CXHUB_FILA_TOKEN', 'token-da-fila');
    vi.stubEnv('METABASE_URL', METABASE);
    vi.stubEnv('METABASE_API_KEY', 'chave');
    vi.stubEnv('METABASE_DATABASE_ID', '43');
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    pedidoCosmos = REENVIO;
    depoisDaAlteracao = { ...REENVIO, status: 'cancelled' };
    linhasMetabase = [[`cxhub|${ID}`]];
    instalarFetch();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('reenvio: cancelar e editar levam a alteração à gold', () => {
    it('cancelar acha o caso pelo -R-n e marca Cancelado, depois da resposta', async () => {
        const res = await cancelResendRoute(
            rota('/api/cosmos/resends/42/cancel?brand=lescent', 'POST', { handledBy: 'Ana', reason: 'Cliente desistiu' }),
            params,
        );

        expect(res.status).toBe(200);
        expect(enfileiradas).toHaveLength(0);

        await rodarAgendados();

        expect(consultas).toHaveLength(1);
        expect(consultas[0]).toContain("tipo = 'REENVIO'");
        expect(consultas[0]).toContain("sigla = 'LE'");
        expect(consultas[0]).toContain("= '12345'");
        expect(enfileiradas).toEqual([{
            id_atualizacao: expect.stringMatching(/^[0-9a-f-]{36}$/),
            id_solicitacao: ID,
            atualizado_em: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
            campos: { status_execucao: 'Cancelado', responsavel_execucao: 'Ana' },
        }]);
    });

    it('editar o endereço leva só a UF como o Cosmos devolveu (cidade e CEP são dado pessoal)', async () => {
        depoisDaAlteracao = { ...REENVIO, shipping: { ...REENVIO.shipping, address: { ...ENDERECO, city: 'Campinas', postal_code: '13000-000' } } };

        const res = await updateResendRoute(
            rota('/api/cosmos/resends/42?brand=lescent', 'PATCH', {
                handledBy: 'Ana', shippingAddress: { city: 'Campinas', postalCode: '13000-000' },
            }),
            params,
        );
        expect(res.status).toBe(200);

        await rodarAgendados();

        expect(enfileiradas).toHaveLength(1);
        expect(enfileiradas[0]).toMatchObject({ id_solicitacao: ID, campos: { uf: 'SP' } });
        expect(enfileiradas[0].campos).toEqual({ uf: 'SP' });
        expect(JSON.stringify(enfileiradas)).not.toMatch(/Campinas|13000-000/);
    });

    it('trocar só a transportadora não mexe na gold', async () => {
        depoisDaAlteracao = REENVIO;

        const res = await updateResendRoute(rota('/api/cosmos/resends/42?brand=lescent', 'PATCH', { handledBy: 'Ana', carrierId: 161 }), params);

        expect(res.status).toBe(200);
        expect(after).not.toHaveBeenCalled();
    });

    it('fora da janela de gestão (faturamento começou) nada vai à gold', async () => {
        pedidoCosmos = { ...REENVIO, erp_status: 'invoiced' };

        const res = await cancelResendRoute(
            rota('/api/cosmos/resends/42/cancel?brand=lescent', 'POST', { handledBy: 'Ana', reason: 'x' }),
            params,
        );

        expect(res.status).toBe(422);
        expect(after).not.toHaveBeenCalled();
    });

    it('sem METABASE_* o cancelamento acontece e a gold fica de fora, sem erro', async () => {
        vi.stubEnv('METABASE_URL', '');

        const res = await cancelResendRoute(
            rota('/api/cosmos/resends/42/cancel?brand=lescent', 'POST', { handledBy: 'Ana', reason: 'x' }),
            params,
        );

        expect(res.status).toBe(200);
        expect(after).not.toHaveBeenCalled();
    });
});
