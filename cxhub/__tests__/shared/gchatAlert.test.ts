import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendAlert, __resetAlertThrottle } from '@shared/lib/alerts';
import type { AlertContext } from '@shared/lib/alerts';

/**
 * O transporte do aviso. A propriedade que mais importa aqui não é "consegue enviar" — é
 * **nunca lançar e nunca travar** (candidato a INV-06 no ADR-005): perder a solicitação por
 * causa do mecanismo que existe para avisar que ela se perdeu seria absurdo.
 */

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/segredo-de-teste';

const ctx: AlertContext = {
    reason: 'COSMOS_UNAVAILABLE',
    motivo: 'Cosmos indisponível',
    requestId: 'req_1',
    brand: 'lescent',
    numeroPedido: '123',
};

describe('sendAlert', () => {
    beforeEach(() => {
        __resetAlertThrottle();
        process.env.SLACK_ALERT_WEBHOOK_URL = WEBHOOK;
        vi.restoreAllMocks();
    });

    afterEach(() => {
        delete process.env.SLACK_ALERT_WEBHOOK_URL;
        vi.restoreAllMocks();
    });

    it('posta no webhook configurado, com o texto no corpo', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        const enviado = await sendAlert(ctx);

        expect(enviado).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(WEBHOOK);
        expect(init.method).toBe('POST');
        const corpo = JSON.parse(init.body);
        expect(corpo.text).toContain('123');
    });

    // No app GoDeploy cx-hub o aviso vai ao Slack, que lê <...> como link ou menção e & como entidade.
    it('escapa & < > do texto: uma mensagem do ERP com <!channel> não chama o canal inteiro', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await sendAlert({ ...ctx, reason: 'ERP_REFUSED', detalhe: 'recusado <!channel> & <https://x.y|clique>' });

        const corpo = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(corpo.text).toContain('recusado &lt;!channel&gt; &amp; &lt;https://x.y|clique&gt;');
        expect(corpo.text).not.toContain('<!channel>');
    });

    it('Slack recusou: devolve false e loga o status e o erro curto do Slack, nunca a URL', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no_service', { status: 404 })));
        const erro = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(await sendAlert(ctx)).toBe(false);
        const logado = erro.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logado).toContain('HTTP 404 (no_service)');
        expect(logado).not.toContain('segredo-de-teste');
    });

    it('não faz chamada nenhuma quando a env var não está configurada', async () => {
        delete process.env.SLACK_ALERT_WEBHOOK_URL;
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const enviado = await sendAlert(ctx);

        expect(enviado).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('não avisa causa de severidade nenhuma (dado da cliente volta pro bot, não pro grupo)', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        const enviado = await sendAlert({
            ...ctx,
            reason: 'NEW_ADDRESS_INCOMPLETE',
            motivo: 'Endereço novo incompleto — campo(s) ausente(s): bairro',
        });

        expect(enviado).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // ─── O que de fato protege a solicitação ──────────────────────────

    it('NÃO lança quando o webhook do Chat está fora do ar', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

        await expect(sendAlert(ctx)).resolves.toBe(false);
    });

    it('NÃO lança quando o Chat responde erro', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

        await expect(sendAlert(ctx)).resolves.toBe(false);
    });

    it('NÃO lança quando o envio estoura o timeout', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
            Object.assign(new Error('aborted'), { name: 'AbortError' })
        ));

        await expect(sendAlert(ctx)).resolves.toBe(false);
    });

    it('aborta o envio por timeout próprio, sem herdar o do fluxo', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await sendAlert(ctx);

        expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
    });

    // ─── Anti-ruído (T8) ──────────────────────────────────────────────

    it('agrupa causa sistêmica repetida na mesma janela (o grupo não pode virar ruído)', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await sendAlert({ ...ctx, reason: 'CARRIER_UNRESOLVED', numeroPedido: '1' });
        await sendAlert({ ...ctx, reason: 'CARRIER_UNRESOLVED', numeroPedido: '2' });
        await sendAlert({ ...ctx, reason: 'CARRIER_UNRESOLVED', numeroPedido: '3' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('agruparPor abre a causa sistêmica em sub-grupos: um card por marca, e a mesma marca repetida continua agrupada', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);
        const semLinha: AlertContext = { ...ctx, reason: 'SHEET_ROW_NOT_FOUND', numeroPedido: undefined };

        await sendAlert({ ...semLinha, agruparPor: 'reembolso/kokeshi' });
        await sendAlert({ ...semLinha, agruparPor: 'reembolso/lescent' });
        await sendAlert({ ...semLinha, agruparPor: 'reembolso/barbours' });
        await sendAlert({ ...semLinha, agruparPor: 'reembolso/kokeshi' }); // repetição da 1ª marca

        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('sem agruparPor a causa sistêmica segue agrupada pelo reason (o comportamento de antes)', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await sendAlert({ ...ctx, reason: 'SHEET_ROW_NOT_FOUND', numeroPedido: undefined });
        await sendAlert({ ...ctx, reason: 'SHEET_ROW_NOT_FOUND', numeroPedido: undefined });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('SHEET_WRITE_FAILED agrupa por PEDIDO (não por causa): pedidos distintos são cards distintos', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await sendAlert({ ...ctx, reason: 'SHEET_WRITE_FAILED', numeroPedido: '1' });
        await sendAlert({ ...ctx, reason: 'SHEET_WRITE_FAILED', numeroPedido: '2' });
        await sendAlert({ ...ctx, reason: 'SHEET_WRITE_FAILED', numeroPedido: '1' });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('nunca agrupa o crítico — cada violação do modo de teste é um card', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await sendAlert({ ...ctx, reason: 'TEST_MODE_VIOLATION' });
        await sendAlert({ ...ctx, reason: 'TEST_MODE_VIOLATION' });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('não deixa o segredo do webhook vazar para o log de erro', async () => {
        const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('falhou')));

        await sendAlert(ctx);

        for (const call of erro.mock.calls) {
            expect(JSON.stringify(call)).not.toContain('token=t');
            expect(JSON.stringify(call)).not.toContain('key=k');
        }
    });

    // ─── Agrupamento da falha SISTÊMICA sem pedido (RF-42) ────────────
    //
    // Causa `agrupar: false` existe para não fundir dois pedidos diferentes num card só. Mas quando
    // NÃO há pedido no contexto, não há o que distinguir: a falha é do sistema, e cair no `requestId`
    // (único por requisição) é o mesmo que não agrupar — uma rajada vira uma enxurrada de cards
    // idênticos no grupo, que é exatamente o ruído que o mecanismo existe para evitar.

    it('agrupa causa não-agrupável QUANDO não há pedido no contexto (a chave cai no reason)', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        const semPedido = {
            reason: 'INTERNAL_ERROR' as const,
            motivo: 'Falha inesperada do CXHub',
            brand: 'lescent',
        };

        await sendAlert({ ...semPedido, requestId: 'req_a' });
        await sendAlert({ ...semPedido, requestId: 'req_b' });
        await sendAlert({ ...semPedido, requestId: 'req_c' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('NÃO agrupa causa não-agrupável quando HÁ pedido: cada pedido continua sendo um card', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        const base = {
            reason: 'INTERNAL_ERROR' as const,
            motivo: 'Falha inesperada do CXHub',
            requestId: 'req_x',
            brand: 'lescent',
        };

        await sendAlert({ ...base, numeroPedido: '#1' });
        await sendAlert({ ...base, numeroPedido: '#2' });
        await sendAlert({ ...base, numeroPedido: '#3' });

        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    // ─── Teto do Map do throttle: eviction de verdade ─────────────────
    //
    // A poda por expiração só libera espaço quando a janela passou. Com o teto batido e TODAS as chaves
    // dentro da janela, não há nada a expirar — e o Map cresce indefinidamente num processo de vida
    // longa. Bater o teto tem que descartar a chave MAIS ANTIGA (FIFO de inserção).

    /** Constante privada do módulo (não exportada) — dimensionamos o caso pelo número. */
    const MAX_CHAVES_THROTTLE = 500;

    it('ao bater o teto de chaves dentro da janela, descarta a mais antiga (FIFO) em vez de crescer sem limite', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        const base = {
            reason: 'INTERNAL_ERROR' as const,
            motivo: 'Falha inesperada do CXHub',
            requestId: 'req_teto',
            brand: 'lescent',
        };

        const PRIMEIRO = 'pedido-0';

        // Uma chave por pedido: todas distintas, todas dentro da janela.
        await sendAlert({ ...base, numeroPedido: PRIMEIRO });
        for (let i = 1; i <= MAX_CHAVES_THROTTLE; i++) {
            await sendAlert({ ...base, numeroPedido: `pedido-${i}` });
        }

        const antes = fetchMock.mock.calls.length;
        expect(antes).toBe(MAX_CHAVES_THROTTLE + 1);

        // O primeiro pedido é o mais antigo: ao estourar o teto ele deveria ter sido descartado,
        // então reavisar sobre ele volta a disparar (o "custo" do descarte é um card repetido, não
        // memória crescendo para sempre).
        await sendAlert({ ...base, numeroPedido: PRIMEIRO });

        expect(fetchMock.mock.calls.length).toBe(antes + 1);
    });

    it('o descarte por teto é do MAIS ANTIGO — a chave recém-inserida continua agrupando', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        const base = {
            reason: 'INTERNAL_ERROR' as const,
            motivo: 'Falha inesperada do CXHub',
            requestId: 'req_teto_2',
            brand: 'lescent',
        };

        for (let i = 0; i <= MAX_CHAVES_THROTTLE; i++) {
            await sendAlert({ ...base, numeroPedido: `pedido-${i}` });
        }

        const antes = fetchMock.mock.calls.length;

        // A última inserida está dentro da janela e não é a mais antiga: tem que continuar agrupada.
        await sendAlert({ ...base, numeroPedido: `pedido-${MAX_CHAVES_THROTTLE}` });

        expect(fetchMock.mock.calls.length).toBe(antes);
    });

    // ─── A chave que MAIS importa é a que o teto derruba primeiro ─────
    //
    // Quando o Cosmos cai, a rajada é composta: um card sistêmico (`COSMOS_UNAVAILABLE`, agrupável) e
    // uma chave por pedido afetado. As chaves por pedido são descartáveis — cada uma serve a um card
    // só. A sistêmica é o oposto: é ela que segura a enxurrada. Deixar o volume de pedidos empurrar a
    // sistêmica para fora do Map inverte o mecanismo — o throttle passa a agrupar o que não repete e
    // a soltar o que repete, e o grupo vira exatamente o ruído que ele existe para evitar, no pior
    // momento possível.

    it('a chave sistêmica rearmada SOBREVIVE a uma rajada de 500 chaves novas — continua agrupando', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        // Causa sistêmica (`agrupar: true`): a mesma chave para toda a rajada.
        const sistemico: AlertContext = {
            reason: 'COSMOS_UNAVAILABLE',
            motivo: 'Cosmos indisponível',
            requestId: 'req_sistemico',
            brand: 'lescent',
            numeroPedido: '#1',
        };

        await sendAlert(sistemico);                       // 1 card
        await sendAlert({ ...sistemico, numeroPedido: '#2' }); // agrupado — rearma a janela
        expect(fetchMock.mock.calls.length).toBe(1);

        // A rajada de pedidos afetados: uma chave nova por pedido, todas dentro da janela.
        const porPedido = {
            reason: 'INTERNAL_ERROR' as const,
            motivo: 'Falha inesperada do CXHub',
            requestId: 'req_rajada',
            brand: 'lescent',
        };
        for (let i = 0; i < MAX_CHAVES_THROTTLE; i++) {
            await sendAlert({ ...porPedido, numeroPedido: `rajada-${i}` });
        }

        const antes = fetchMock.mock.calls.length;

        // Mesma causa sistêmica, mesma janela: tem que seguir agrupada.
        await sendAlert({ ...sistemico, numeroPedido: '#3' });

        expect(
            fetchMock.mock.calls.length,
            'a rajada de chaves por pedido derrubou a chave sistêmica do throttle'
        ).toBe(antes);
    });
});
