import {
    BRAND_TO_ORG_ID,
    ehMarcaSemCosmosComPlanilha,
    registraNaPlanilha,
    temOrganizacaoNoCosmos,
    type MarcaCxHub,
    type SupportedBrand,
} from '../../../shared/lib/constants';
import { configuracaoQueFalta, prazoDaRequisicao } from '../../../shared/lib/backendDireto';
import { conferirPedidoNoDataMart, prazoDaConferencia } from '../../../shared/lib/datamart/conferenciaServer';
import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro, type ResultadoFila } from '../../../shared/lib/fila/index';
import { formatarCarimboSP } from '../../../shared/lib/format';
import { planilhaQueFalta } from '../../../shared/lib/sheets/index';
import { colunaDoCabecalho } from '../../../shared/lib/sheets/cabecalhos';
import { gravarNasPlanilhas } from '../../../shared/lib/sheets/gravarLinha';
import type { ResendSubmissionData, SheetsAppendResponse } from '../types/index';
import { buildResendRow } from './buildResendRow';
import { casoDoReenvio } from './casoDoReenvio';
import { aplicarConferenciaAoReenvio, type ConferenciaDoReenvio } from './conferenciaDoReenvio';
import { buildCosmosResendBody, interpretarErroCosmos, type FalhaCosmos } from './cosmosResend';

const LOG = '[Resend Direct]';

export interface ProcessResendInput {
    /** As marcas sem Cosmos (ADR-013) só registram: o Cosmos nunca é chamado para elas, nem com automação no corpo. */
    brand: MarcaCxHub;
    data: ResendSubmissionData;
    /** Token do Cosmos: o do agente (tela) ou o de serviço (bot) — o mesmo que ia no envelope do n8n */
    token?: string;
    testMode?: boolean;
    /** Teto do dedup e do Cosmos; ausente ⇒ env `TIMEOUT`. A fila tem prazo próprio (`prazoFila`). */
    timeoutMs?: number;
    /** Instante-limite da entrega à fila do Metabase; ausente ⇒ `prazoDaFila()`, contado de quando ela começa */
    prazoFila?: number;
    /** O id do caso: o `requestId` do bot, que casa com o card do Chat e o log; ausente ⇒ gerado */
    idSolicitacao?: string;
    agora?: Date;
}

/**
 * O que o workflow `[PROD] - Webhook CXHub` (`/cxhub/resend`) fazia, dentro do CXHub, com o registro na fila do
 * Metabase e **junto dele** na planilha da marca (ADR-007, ADR-010, ADR-012):
 *
 * 0. **configuração** — fila e planilha, antes de tudo: sem uma das duas nada é registrado nem reenviado;
 * 1. **dedup de 24h** — na fila e na raw de eventos (era a aba da marca, pelo `[AUX] Consulta Pedidos`). Na Ápice, na
 *    Yenzah e na Denavita, junto dele, a **conferência do pedido no Data Mart** (ADR-018): pedido sem NF de venda é
 *    recusado aqui, e a NF, o CD e o valor da NF de reenvio do Data Mart entram no lugar dos que vieram;
 * 2. **reenvio no Cosmos**, só com automação e fora do modo de teste (era o IF "Order should be sent to API2" —
 *    é aqui que mora o INV-02);
 * 3. **fila do Metabase** — o caso vai à fila do app `cx-hub`, e o lote o leva à gold em até 20 min (ADR-012);
 * 4. **linha na planilha** (era o append do n8n) — só depois da fila, e só se a fila não recusou: o dedup lê a fila,
 *    e uma linha na planilha sem ela deixaria o agente repetir e duplicá-la. Com a fila `incerto` a linha vai também
 *    (`ROW_UNCERTAIN`: o agente NÃO repete). Planilha que falha depois da fila não desfaz nada: responde
 *    `SHEET_WRITE_FAILED` (o agente NÃO repete), deixa a linha no log e avisa no Chat.
 *
 * A marca **sem planilha** (a Gobeaute, ADR-014) não tem os passos da planilha: a configuração confere só a fila, e o
 * registro termina na fila, com as mesmas respostas (`ROW_UNCERTAIN` quando a fila fica incerta).
 *
 * Devolve os mesmos códigos do n8n, para a tela, o bot e o Portal não perceberem a troca. Quem chama é o
 * `postResendWebhook`, que continua aplicando a guarda do INV-02 por cima. Como no n8n, a recusa do ERP volta
 * sem registro (OQ-08): quem garante o registro nesse caso é a rota do bot, repostando sem automação.
 *
 * O `POST /resend` **não é retentado** (o node tinha `retryOnFail`: uma 1ª tentativa que estourou depois de o
 * Cosmos criar o pedido virava um 2º reenvio).
 *
 * ⚠️ Server-only — fora do barrel de `modules/reenvios/actions`. Importe pelo caminho completo.
 */
export async function processResend(input: ProcessResendInput): Promise<{ body: SheetsAppendResponse; status: number }> {
    const { brand, data, token } = input;
    const testMode = input.testMode === true;
    const prazo = prazoDaRequisicao(input.timeoutMs);
    const agora = input.agora ?? new Date();
    const idSolicitacao = input.idSolicitacao ?? crypto.randomUUID();
    // Marca sem organização no Cosmos nunca executa (ADR-013): a tela nem manda automação para pedido da Shopify, e um
    // corpo que mandasse não pode virar `POST /organizations/undefined/...`.
    const executar = Boolean(data.automacao) && !testMode && temOrganizacaoNoCosmos(brand);

    console.log(`${LOG} ${idSolicitacao}: ${brand}, testMode=${testMode}, automação=${data.automacao ? 'sim' : 'não'}`);

    // ─── 0. Configuração: fila e planilha andam juntas ───────────────────────────────────────────
    // O ensaio não grava em nenhum dos dois, então não precisa de nenhum. A planilha da marca também tem de existir no
    // ambiente (as marcas sem Cosmos ainda não têm cópia de staging). A marca sem planilha (ADR-014) só precisa da fila.
    const comPlanilha = registraNaPlanilha(brand);
    const faltaConfiguracao = testMode
        ? null
        : comPlanilha
            ? (configuracaoQueFalta() ?? planilhaQueFalta('reenvio', brand))
            : configuracaoQueFalta({ comPlanilha: false });
    if (faltaConfiguracao) {
        console.error(`${LOG} ${idSolicitacao}: ${faltaConfiguracao} — recusando antes do dedup e do Cosmos`);
        return {
            body: {
                code: 'UNKNOWN_ERROR',
                message: `Não foi possível registrar a solicitação (${faltaConfiguracao}) — nada foi registrado nem reenviado.`,
                sentToAPI: false,
                reason: 'RECORD_UNAVAILABLE',
            },
            status: 503,
        };
    }

    // ─── 1. Dedup de 24h, com a conferência no Data Mart junto ───────────────────────────────────
    // A conferência (ADR-018) começa antes do dedup e corre junto dele: as duas só leem. Ela fica no prazo do Cosmos, que
    // essas marcas nunca chamam, então não alonga o pior caso da rota; e nunca lança (o que não leu volta "não conferido").
    const conferencia = ehMarcaSemCosmosComPlanilha(brand)
        ? conferirPedidoNoDataMart(brand, data.numeroPedido, prazoDaConferencia(prazo))
        : null;
    try {
        const existente = await solicitacaoRecenteNoRegistro('REENVIO', brand, data.numeroPedido);
        if (existente) {
            console.log(`${LOG} ${idSolicitacao}: reenvio duplicado barrado (pedido ${existente.pedido})`);
            return {
                body: {
                    code: 'DUPLICATE_RESEND',
                    message: `Já existe um reenvio para o pedido ${existente.pedido} feito por ${existente.responsavel} em ${formatarCarimboSP(new Date(existente.solicitadoEm))}`,
                    sentToAPI: false,
                },
                status: 200,
            };
        }
    } catch (erro) {
        console.error(`${LOG} ${idSolicitacao}: falha ao consultar as solicitações recentes:`, erro);
        return {
            body: {
                code: 'UNKNOWN_ERROR',
                message: 'Não foi possível consultar as solicitações recentes — nada foi registrado nem reenviado. Tente novamente.',
                sentToAPI: false,
                reason: 'RECORD_UNAVAILABLE',
            },
            status: 503,
        };
    }

    // ─── 1b. O que a conferência muda: NF, CD e o valor da NF de reenvio (ADR-018) ───────────────
    let dados = data;
    let valorNaOperacao: number | null = null;
    if (conferencia && ehMarcaSemCosmosComPlanilha(brand)) {
        const conferido = aplicarConferenciaAoReenvio(brand, data, await conferencia);
        if (conferido.tipo === 'recusado') {
            console.log(`${LOG} ${idSolicitacao}: recusado — o pedido ${data.numeroPedido} não tem NF de venda no Data Mart`);
            return {
                body: { code: 'UNKNOWN_ERROR', message: conferido.mensagem, sentToAPI: false, reason: 'ORDER_NOT_INVOICED' },
                status: 422,
            };
        }
        logarConferencia(idSolicitacao, data.numeroPedido, conferido);
        dados = conferido.data;
        valorNaOperacao = conferido.valorNaOperacao;
    }

    // ─── 2. Reenvio no Cosmos ─────────────────────────────────────────────────────────────────────
    if (executar && temOrganizacaoNoCosmos(brand)) {
        const falha = await executarNoCosmos(brand, dados, token, prazo, idSolicitacao);
        if (falha) return { body: { ...falha, sentToAPI: false }, status: 200 };
    }

    // Ensaio: o Cosmos não foi chamado, e nada é registrado — a DAG não tem modo de teste e a fila leva à gold real.
    if (testMode) {
        return {
            body: {
                code: 'SUCCESS_TEST_MODE',
                message: 'Solicitação de TESTE: nada foi registrado e nenhum reenvio foi executado.',
                sentToAPI: false,
            },
            status: 200,
        };
    }

    // ─── 3. Fila do Metabase ──────────────────────────────────────────────────────────────────────
    const caso = casoDoReenvio({ brand, data: dados, automacao: executar, idSolicitacao, criadoEm: agora });
    const fila = await enfileirarCasos([caso], input.prazoFila ?? prazoDaFila());

    // Fila recusou: com certeza nada foi guardado, e a planilha também fica de fora (o agente pode repetir).
    if (fila.status === 'recusado') {
        console.error(`${LOG} ${idSolicitacao}: fila recusou (sentToAPI=${executar}) — ${fila.motivo}`);
        return {
            body: {
                code: 'SHEETS_ERROR',
                message: executar
                    ? `O reenvio foi processado com sucesso no Cosmos, porém houve um erro ao registrar a solicitação (${fila.motivo}).`
                    : `Houve um erro ao registrar o reenvio (${fila.motivo}). Tente novamente.`,
                sentToAPI: executar,
                reason: 'RECORD_UNAVAILABLE',
            },
            status: 200,
        };
    }

    // Marca sem planilha (ADR-014): o registro termina na fila.
    if (!comPlanilha) return respostaSemPlanilha(fila, idSolicitacao);

    // ─── 4. Linha na planilha ─────────────────────────────────────────────────────────────────────
    // Na Ápice e na Yenzah o valor da NF de reenvio é coluna da operação: vai na linha nova junto com as fórmulas (ADR-018).
    const colunaDoValor = valorNaOperacao === null ? null : colunaDoCabecalho('reenvio', brand, 'Valor da NF de reenvio (R$)');
    const planilha = await gravarNasPlanilhas(
        [{
            fluxo: 'reenvio',
            marca: brand,
            // O carimbo da linha é o `criado_em` do caso, o mesmo instante que foi para a fila (ADR-010).
            linha: buildResendRow(brand, dados, formatarCarimboSP(agora)),
            idSolicitacao,
            pedido: dados.numeroPedido,
            criadoEm: agora,
            ...(colunaDoValor ? { valoresDaOperacao: { [colunaDoValor]: valorNaOperacao } } : {}),
        }],
        { numeroPedido: dados.numeroPedido, idAtendimento: dados.idAtendimento, statusDaFila: fila.status },
    );

    const feito = executar ? 'O reenvio foi processado com sucesso no Cosmos e a' : 'A';

    if (!planilha.ok) {
        console.error(`${LOG} ${idSolicitacao}: fila ${fila.status}, planilha não (sentToAPI=${executar}) — ${planilha.motivo}`);
        const naFila = fila.status === 'enfileirado'
            ? 'entrou na fila do Metabase'
            : `pode ter entrado na fila do Metabase (${fila.motivo})`;
        // A linha entrou e só as fórmulas da operação faltaram (ADR-013): o suporte completa, e repetir duplicaria a linha.
        const naPlanilha = planilha.linhasGravadas
            ? 'a linha entrou na planilha sem as fórmulas de prazo e SLA (o suporte foi avisado para completar)'
            : 'a planilha não foi atualizada';
        return {
            body: {
                code: 'SHEETS_ERROR',
                message: `${feito} solicitação ${naFila}, mas ${naPlanilha}. NÃO repita a solicitação.`,
                sentToAPI: executar,
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao,
            },
            status: 200,
        };
    }

    // Fila incerta: a linha está na planilha, então repetir a duplicaria; quem confere a fila é o suporte (o caso
    // inteiro está no log).
    if (fila.status === 'incerto') {
        console.error(`${LOG} ${idSolicitacao}: planilha gravada, fila incerta (sentToAPI=${executar}) — ${fila.motivo}`);
        return {
            body: {
                code: 'SHEETS_ERROR',
                message: `${feito} solicitação foi registrada na planilha, mas não deu para confirmar a entrada na fila do `
                    + `Metabase (${fila.motivo}). NÃO repita a solicitação: avise o suporte.`,
                sentToAPI: executar,
                reason: 'ROW_UNCERTAIN',
                idSolicitacao,
            },
            status: 200,
        };
    }

    return {
        body: {
            code: executar ? 'SUCCESS' : 'SUCCESS_SHEETS_ONLY',
            message: 'Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).',
            sentToAPI: executar,
            idSolicitacao,
        },
        status: 200,
    };
}

/**
 * O fim do registro da marca sem planilha (ADR-014), que nunca executa no Cosmos: a fila aceitou ⇒ registrado; ficou
 * incerta ⇒ `ROW_UNCERTAIN`, como nas outras marcas — a tela trata como enviado e acompanha pela tag do Metabase, e o
 * caso inteiro está no log da fila para o suporte repor.
 */
function respostaSemPlanilha(
    fila: Exclude<ResultadoFila, { status: 'recusado' }>,
    idSolicitacao: string,
): { body: SheetsAppendResponse; status: number } {
    if (fila.status === 'incerto') {
        console.error(`${LOG} ${idSolicitacao}: fila incerta, marca sem planilha — ${fila.motivo}`);
        return {
            body: {
                code: 'SHEETS_ERROR',
                message: `Não deu para confirmar a entrada da solicitação na fila do Metabase (${fila.motivo}). `
                    + 'NÃO repita a solicitação: confira na lista de reenvios em alguns minutos ou avise o suporte.',
                sentToAPI: false,
                reason: 'ROW_UNCERTAIN',
                idSolicitacao,
            },
            status: 200,
        };
    }
    return {
        body: {
            code: 'SUCCESS_SHEETS_ONLY',
            message: 'Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).',
            sentToAPI: false,
            idSolicitacao,
        },
        status: 200,
    };
}

/**
 * O que a conferência fez, para o log (ADR-018): a NF que veio e difere da do Data Mart (números de NF não são dado
 * pessoal), o motivo do valor em branco e o que ficou sem conferir.
 */
function logarConferencia(
    idSolicitacao: string,
    pedido: string,
    conferido: Extract<ConferenciaDoReenvio, { tipo: 'aplicado' }>,
): void {
    if (conferido.nfDivergente) {
        console.warn(`${LOG} ${idSolicitacao}: a NF que veio (${conferido.nfDivergente.digitada}) difere da do Data Mart `
            + `(${conferido.nfDivergente.doDataMart}) no pedido ${pedido} — vale a do Data Mart`);
    }
    if (conferido.valorEmBranco) {
        console.log(`${LOG} ${idSolicitacao}: valor da NF de reenvio em branco (${pedido}) — ${conferido.valorEmBranco}`);
    }
    if (conferido.naoConferidos.length > 0) {
        console.warn(`${LOG} ${idSolicitacao}: sem conferência no Data Mart (${conferido.naoConferidos.join(', ')}) no pedido `
            + `${pedido} — vale o que veio, com a nota nas observações`);
    }
}

/**
 * Teste local: com `COSMOS_RESEND_SIMULADO=true` o `POST /resend` nunca sai. Ignorado na produção da Vercel,
 * onde simular seria afirmar uma remessa que não existe.
 */
function cosmosSimulado(): boolean {
    if (process.env.COSMOS_RESEND_SIMULADO !== 'true') return false;
    if (process.env.VERCEL_ENV === 'production') {
        console.warn(`${LOG} COSMOS_RESEND_SIMULADO ignorado na produção`);
        return false;
    }
    return true;
}

/** `null` = o Cosmos criou o reenvio. Qualquer outra coisa = não criou, ou não dá para saber. */
async function executarNoCosmos(
    brand: SupportedBrand,
    data: ResendSubmissionData,
    token: string | undefined,
    prazo: number,
    idSolicitacao: string,
): Promise<FalhaCosmos | null> {
    const corpo = buildCosmosResendBody(data);
    const baseUrl = process.env.COSMOS_API_URL;
    if (!corpo || !data.cosmosId || !token || !baseUrl) {
        // O n8n chamava assim mesmo (`Bearer undefined`, `/orders//resend`) e recebia um 4xx. Aqui nem sai.
        console.error(`${LOG} ${idSolicitacao}: automação pedida sem o necessário`, {
            apiData: Boolean(corpo), cosmosId: Boolean(data.cosmosId), token: Boolean(token), COSMOS_API_URL: Boolean(baseUrl),
        });
        return { code: 'API_ERROR', message: 'Os dados da automação estão incompletos — o reenvio não foi enviado ao Cosmos.' };
    }

    const janela = prazo - Date.now();
    if (janela <= 0) {
        return { code: 'API_ERROR', message: 'O tempo acabou antes de chamar o Cosmos — o reenvio não foi enviado.' };
    }

    const url = `${baseUrl}/organizations/${BRAND_TO_ORG_ID[brand]}/orders/${encodeURIComponent(data.cosmosId)}/resend`;
    if (cosmosSimulado()) {
        // Só o que confere a remessa (transportadora, itens, valores). Nome, telefone e endereço ficam fora do log.
        console.warn(`${LOG} ${idSolicitacao}: SIMULADO — POST ${url} NÃO enviado (tratado como aceito)`, {
            carrier_id: corpo.order.carrier_id,
            service_name: corpo.order.shipping_address.service_name,
            products: corpo.order.products,
            shipping_cost: corpo.order.shipping_cost,
            discount_amount: corpo.order.discount_amount,
        });
        return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), janela);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(corpo),
            signal: controller.signal,
        });

        if (res.ok) {
            // 2xx basta: o corpo não é usado, e lê-lo só abriria espaço para um timeout DEPOIS do sucesso.
            await res.body?.cancel().catch(() => { });
            console.log(`${LOG} ${idSolicitacao}: reenvio criado no Cosmos (pedido ${data.cosmosId})`);
            return null;
        }

        const falha = interpretarErroCosmos(res.status, await res.json().catch(() => null));
        console.warn(`${LOG} ${idSolicitacao}: Cosmos recusou (HTTP ${res.status}) — ${falha.message}`);
        return falha;
    } catch (erro) {
        // Sem resposta: a requisição pode ter chegado. Não retenta (duplicaria a remessa) e avisa no texto.
        console.error(`${LOG} ${idSolicitacao}: Cosmos sem resposta:`, erro);
        return {
            code: 'API_ERROR',
            message: 'O Cosmos não respondeu — o reenvio PODE ter sido criado. Confira no Cosmos antes de repetir.',
        };
    } finally {
        clearTimeout(timer);
    }
}
