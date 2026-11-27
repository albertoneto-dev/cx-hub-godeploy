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
import { nfAusente, nfDoPedidoDoCosmos } from '../../../shared/lib/datamart/nfDaIntelipostServer';
import {
    atualizacaoDoCaso,
    enfileirarAtualizacao,
    enfileirarCasos,
    execucaoDoSemExecucao,
    notaDoSemExecucao,
    prazoDaFila,
    solicitacaoRecenteNoRegistro,
    tentativaSemExecucao,
    type ResultadoFila,
    type SemExecucao,
    type TentativaAnterior,
} from '../../../shared/lib/fila/index';
import { formatarCarimboSP } from '../../../shared/lib/format';
import { planilhaQueFalta } from '../../../shared/lib/sheets/index';
import { colunaDoCabecalho } from '../../../shared/lib/sheets/cabecalhos';
import { gravarNasPlanilhas } from '../../../shared/lib/sheets/gravarLinha';
import type { AtualizacaoCxhub, CasoCxhub } from '../../../shared/lib/airflow/types';
import type { ResendSubmissionData, SheetsAppendResponse } from '../types/index';
import { stripAutomation } from './buildBotResendData';
import { buildResendRow } from './buildResendRow';
import { casoDoReenvio } from './casoDoReenvio';
import { aplicarConferenciaAoReenvio, type ConferenciaDoReenvio } from './conferenciaDoReenvio';
import { buildCosmosResendBody, interpretarErroCosmos, type FalhaCosmos } from './cosmosResend';
import { notaDoReenvioExistente, reenvioRecenteNoCosmos, type ReenvioNoCosmos } from './reenvioRecenteNoCosmos';

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
    /**
     * Só a tela, com `REGISTRAR_FALHA_DA_TELA=on` (2026-11-27): a solicitação que não deu certo também é registrada, sem
     * execução, com o status na linha (`registrarSemExecucao`), e a fila que recusa não tira a linha da planilha. O bot
     * não manda: ele já reposta sem automação.
     */
    registrarFalha?: boolean;
    /** O `idSolicitacao` da tentativa sem execução que esta refaz: o mesmo caso e a mesma linha. Só com `registrarFalha`. */
    tentativaAnterior?: string;
}

type Resultado = { body: SheetsAppendResponse; status: number };

const ENVIE_DE_NOVO = 'nenhum reenvio foi criado. Envie de novo pela Central.';

/**
 * O que o workflow `[PROD] - Webhook CXHub` (`/cxhub/resend`) fazia, dentro do CXHub, com o registro na fila do
 * Metabase e **junto dele** na planilha da marca (ADR-007, ADR-010, ADR-012):
 *
 * 0. **configuração** — fila e planilha, antes de tudo: sem uma das duas nada é registrado nem reenviado;
 * 1. **dedup de 24h** — na fila e na raw de eventos (era a aba da marca, pelo `[AUX] Consulta Pedidos`). Na Ápice, na
 *    Yenzah e na Denavita, junto dele, a **conferência do pedido no Data Mart** (ADR-018): pedido sem NF de venda é
 *    recusado aqui, e a NF, o CD e o valor da NF de reenvio do Data Mart entram no lugar dos que vieram;
 * 2. **reenvio no Cosmos**, só com automação e fora do modo de teste (era o IF "Order should be sent to API2" —
 *    é aqui que mora o INV-02). Antes do `POST /resend`, o Cosmos é perguntado se o pedido já tem reenvio das últimas
 *    24 h (`reenvioRecenteNoCosmos`, 2026-11-22, decisão deste app): com um, a solicitação é registrada com ele, sem
 *    criar outro; sem dar para saber, nada é criado nem registrado (`API_ERROR`, e repetir é seguro);
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
 * sem registro (OQ-08): quem garante o registro nesse caso é a rota do bot, repostando sem automação. Na tela, com
 * `registrarFalha` (`REGISTRAR_FALHA_DA_TELA`, 2026-11-27), toda saída sem sucesso depois da configuração é registrada
 * sem execução (`registrarSemExecucao`), e a fila que recusa não tira a linha da planilha.
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
    const registrarFalha = input.registrarFalha === true && !testMode;
    let anterior: TentativaAnterior | null = null;
    // Toda saída sem sucesso depois da configuração passa por aqui: sem a trava, responde como sempre.
    const semExecucao = (resposta: Resultado, sem: SemExecucao, dadosDaLinha: ResendSubmissionData): Promise<Resultado> =>
        registrarFalha
            ? registrarSemExecucao({ brand, dados: dadosDaLinha, sem, resposta, anterior, idSolicitacao, agora, prazoFila: input.prazoFila })
            : Promise.resolve(resposta);

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
    // Nas marcas do Cosmos, a NF que não veio (o pedido do Cosmos V3 chega sem ela) sai da Intelipost do Data Mart (2026-11-17)
    // e, sem ela, do metacampo da Shopify ou da Intelipost ao vivo (2026-11-19), também junto do dedup e no mesmo teto da
    // conferência. Nunca lança; sem resposta, fica a que veio.
    const nfIntelipost = temOrganizacaoNoCosmos(brand) && nfAusente(data.numeroNF)
        ? nfDoPedidoDoCosmos(brand, data.numeroPedido, prazoDaConferencia(prazo))
        : null;
    // O reenvio que o pedido já tem no Cosmos (2026-11-22), também junto do dedup: as duas só leem, e o tempo dela sai do
    // mesmo prazo do `POST /resend`. Nunca lança.
    const reenvioAnterior = executar && temOrganizacaoNoCosmos(brand)
        ? reenvioRecenteNoCosmos(brand, data.numeroPedido, token, prazo, agora)
        : null;
    try {
        const [existente, tentativa] = await Promise.all([
            solicitacaoRecenteNoRegistro('REENVIO', brand, data.numeroPedido),
            registrarFalha ? tentativaSemExecucao(input.tentativaAnterior, 'REENVIO', brand, data.numeroPedido) : null,
        ]);
        anterior = tentativa;
        // A tentativa anterior "a conferir" está aberta e o dedup a acha: é ela que esta solicitação refaz.
        if (existente && existente.idSolicitacao !== anterior?.idSolicitacao) {
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
        return semExecucao({
            body: {
                code: 'UNKNOWN_ERROR',
                message: 'Não foi possível consultar as solicitações recentes — nada foi registrado nem reenviado. Tente novamente.',
                sentToAPI: false,
                reason: 'RECORD_UNAVAILABLE',
            },
            status: 503,
        }, {
            desfecho: 'nao_realizado',
            status: 'Reenvio não realizado (erro de comunicação com o registro)',
            proximoPasso: ENVIE_DE_NOVO,
        }, data);
    }

    // ─── 1b. O que a conferência muda: NF, CD e o valor da NF de reenvio (ADR-018) ───────────────
    let dados = data;
    let valorNaOperacao: number | null = null;
    if (conferencia && ehMarcaSemCosmosComPlanilha(brand)) {
        const conferido = aplicarConferenciaAoReenvio(brand, data, await conferencia);
        if (conferido.tipo === 'recusado') {
            console.log(`${LOG} ${idSolicitacao}: recusado — o pedido ${data.numeroPedido} não tem NF de venda no Data Mart`);
            return semExecucao({
                body: { code: 'UNKNOWN_ERROR', message: conferido.mensagem, sentToAPI: false, reason: 'ORDER_NOT_INVOICED' },
                status: 422,
            }, {
                desfecho: 'nao_realizado',
                status: 'Reenvio não realizado (pedido sem NF)',
                proximoPasso: `${conferido.mensagem} Nenhum reenvio foi criado.`,
            }, data);
        }
        logarConferencia(idSolicitacao, data.numeroPedido, conferido);
        dados = conferido.data;
        valorNaOperacao = conferido.valorNaOperacao;
    }
    if (nfIntelipost) {
        const achada = await nfIntelipost;
        if (achada) {
            console.log(`${LOG} ${idSolicitacao}: NF ${achada.nf} (${achada.origem}) no pedido ${data.numeroPedido} (veio "${data.numeroNF ?? ''}")`);
            dados = { ...dados, numeroNF: achada.nf };
        }
    }

    // ─── 2. Reenvio no Cosmos ─────────────────────────────────────────────────────────────────────
    // O reenvio que já estava no Cosmos: a solicitação é registrada como automação (o reenvio existe e sai), sem um 2º.
    let jaNoCosmos: ReenvioNoCosmos | null = null;
    if (executar && temOrganizacaoNoCosmos(brand)) {
        const noCosmosAntes = reenvioAnterior ? await reenvioAnterior : ({ tipo: 'nenhum' } as const);
        if (noCosmosAntes.tipo === 'indefinido') {
            // Sem saber se o pedido já tem reenvio, criar outro arriscaria a 2ª caixa de 19/11. Nada sai, então repetir é seguro.
            console.error(`${LOG} ${idSolicitacao}: sem conferir se o pedido ${data.numeroPedido} já tem reenvio (${noCosmosAntes.motivo}) — nada criado`);
            // O texto continua o mesmo com a trava: é por ele que a Central oferece "Enviar de novo com os mesmos dados".
            return semExecucao({
                body: {
                    code: 'API_ERROR',
                    message: `Não deu para conferir no Cosmos se o pedido já tem reenvio (${noCosmosAntes.motivo}). `
                        + 'Nenhum reenvio foi criado e nada foi registrado: tente de novo em alguns instantes.',
                    sentToAPI: false,
                },
                status: 200,
            }, {
                desfecho: 'nao_realizado',
                status: 'Reenvio não realizado (erro de comunicação com o Cosmos)',
                proximoPasso: `não deu para conferir no Cosmos se o pedido já tinha reenvio (${noCosmosAntes.motivo}), e ${ENVIE_DE_NOVO}`,
            }, dados);
        }
        if (noCosmosAntes.tipo === 'existe') {
            const reenvio: ReenvioNoCosmos = { externalId: noCosmosAntes.externalId, criadoEm: noCosmosAntes.criadoEm, fonte: noCosmosAntes.fonte };
            jaNoCosmos = reenvio;
            console.log(`${LOG} ${idSolicitacao}: o pedido ${data.numeroPedido} já tem o reenvio ${reenvio.externalId} `
                + `(criado ${reenvio.criadoEm}, visto no ${reenvio.fonte === 'cosmos' ? 'Cosmos' : 'Data Mart'}) — registrando sem criar outro`);
            dados = { ...dados, comentarios: [notaDoReenvioExistente(reenvio.externalId), dados.comentarios].filter(Boolean).join(' | ') };
        } else {
            const falha = await executarNoCosmos(brand, dados, token, prazo, idSolicitacao);
            if (falha) return semExecucao({ body: { ...falha.resposta, sentToAPI: false }, status: 200 }, falha.sem, dados);
        }
    }
    const noCosmos = jaNoCosmos
        ? `O reenvio ${jaNoCosmos.externalId} já estava no Cosmos (nenhum outro foi criado)`
        : 'O reenvio foi processado com sucesso no Cosmos';

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
    // A nova tentativa de uma solicitação sem execução reescreve o caso dela: o mesmo id e o mesmo `criado_em` (o carimbo
    // da linha). O caso sai da marca de sem execução: Pendente, com "Automação" de responsável quando o Cosmos tem o
    // reenvio, como o dbt faz com o caso que nasce com automação (o `automacao` do caso não muda numa atualização).
    const id = anterior?.idSolicitacao ?? idSolicitacao;
    const criadoEm = anterior?.criadoEm ?? agora;
    const caso = casoDoReenvio({ brand, data: dados, automacao: executar, idSolicitacao: id, criadoEm });
    const fila = await entregarAFila(
        caso,
        anterior ? { status_execucao: 'Pendente', responsavel_execucao: executar ? 'Automação' : '' } : null,
        anterior,
        input.prazoFila ?? prazoDaFila(),
    );

    // Fila recusou: com certeza nada foi guardado, e a planilha também fica de fora (o agente pode repetir). Com a trava,
    // a linha vai assim mesmo e é o único registro (a resposta diz para não repetir, como na fila incerta).
    if (fila.status === 'recusado' && (!registrarFalha || !comPlanilha)) return respostaDaFilaRecusada(executar, noCosmos, fila.motivo);

    // Marca sem planilha (ADR-014): o registro termina na fila.
    if (!comPlanilha) return respostaSemPlanilha(fila as Exclude<ResultadoFila, { status: 'recusado' }>, id);

    // ─── 4. Linha na planilha ─────────────────────────────────────────────────────────────────────
    // Na Ápice e na Yenzah o valor da NF de reenvio é coluna da operação: vai na linha nova junto com as fórmulas (ADR-018).
    const colunaDoValor = valorNaOperacao === null ? null : colunaDoCabecalho('reenvio', brand, 'Valor da NF de reenvio (R$)');
    const planilha = await gravarNasPlanilhas(
        [{
            fluxo: 'reenvio',
            marca: brand,
            // O carimbo da linha é o `criado_em` do caso, o mesmo instante que foi para a fila (ADR-010).
            linha: buildResendRow(brand, dados, formatarCarimboSP(criadoEm)),
            idSolicitacao: id,
            pedido: dados.numeroPedido,
            criadoEm,
            ...(colunaDoValor ? { valoresDaOperacao: { [colunaDoValor]: valorNaOperacao } } : {}),
            // A nova tentativa reescreve a linha da anterior e limpa o status de sem execução (nas 6 do Cosmos ele é célula da linha).
            ...(anterior ? { sobrescrever: true, valoresPorCabecalho: statusNaOperacao(brand, '') } : {}),
        }],
        { numeroPedido: dados.numeroPedido, idAtendimento: dados.idAtendimento, statusDaFila: fila.status },
    );

    const feito = executar ? `${noCosmos} e a` : 'A';

    if (!planilha.ok) {
        if (fila.status === 'recusado' && !planilha.linhasGravadas) return respostaDaFilaRecusada(executar, noCosmos, fila.motivo);
        console.error(`${LOG} ${id}: fila ${fila.status}, planilha não (sentToAPI=${executar}) — ${planilha.motivo}`);
        const naFila = fila.status === 'enfileirado'
            ? 'entrou na fila do Metabase'
            : fila.status === 'recusado'
                ? `não entrou na fila do Metabase (${fila.motivo})`
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
                idSolicitacao: id,
            },
            status: 200,
        };
    }

    // Fila incerta (ou recusada, com a trava): a linha está na planilha, então repetir a duplicaria; quem confere a fila é
    // o suporte (o caso inteiro está no log).
    if (fila.status !== 'enfileirado') {
        console.error(`${LOG} ${id}: planilha gravada, fila ${fila.status} (sentToAPI=${executar}) — ${fila.motivo}`);
        const naFila = fila.status === 'recusado'
            ? `a fila do Metabase a recusou (${fila.motivo})`
            : `não deu para confirmar a entrada na fila do Metabase (${fila.motivo})`;
        return {
            body: {
                code: 'SHEETS_ERROR',
                message: `${feito} solicitação foi registrada na planilha, mas ${naFila}. NÃO repita a solicitação: avise o suporte.`,
                sentToAPI: executar,
                reason: 'ROW_UNCERTAIN',
                idSolicitacao: id,
            },
            status: 200,
        };
    }

    return {
        body: {
            code: executar ? 'SUCCESS' : 'SUCCESS_SHEETS_ONLY',
            message: (jaNoCosmos ? `${noCosmos}. ` : '') + 'Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).',
            sentToAPI: executar,
            idSolicitacao: id,
        },
        status: 200,
    };
}

/**
 * Entrega à fila o caso da solicitação. Com a tentativa anterior, é uma atualização do caso dela (`atualizacaoDoCaso`).
 * Sem ela, a criação e, logo depois, a `execucao`, quando houver: o lote leva a criação antes da atualização. Nunca lança.
 */
async function entregarAFila(
    caso: CasoCxhub,
    execucao: AtualizacaoCxhub | null,
    anterior: TentativaAnterior | null,
    prazo: number,
): Promise<ResultadoFila> {
    if (anterior) return enfileirarAtualizacao(anterior.idSolicitacao, atualizacaoDoCaso(caso, execucao), prazo);
    const fila = await enfileirarCasos([caso], prazo);
    if (fila.status === 'enfileirado' && execucao) {
        const marcado = await enfileirarAtualizacao(caso.id_solicitacao, execucao, prazo);
        // O caso entrou sem a marca e parece um caso comum sem automação: a linha leva o status, e o log da fila, a atualização.
        if (marcado.status !== 'enfileirado') console.error(`${LOG} ${caso.id_solicitacao}: o caso entrou na fila sem a marca de sem execução`);
    }
    return fila;
}

/** A fila recusou e nada foi gravado: o agente pode repetir. */
function respostaDaFilaRecusada(executar: boolean, noCosmos: string, motivo: string): Resultado {
    console.error(`${LOG} fila recusou (sentToAPI=${executar}) — ${motivo}`);
    return {
        body: {
            code: 'SHEETS_ERROR',
            message: executar
                ? `${noCosmos}, porém houve um erro ao registrar a solicitação (${motivo}).`
                : `Houve um erro ao registrar o reenvio (${motivo}). Tente novamente.`,
            sentToAPI: executar,
            reason: 'RECORD_UNAVAILABLE',
        },
        status: 200,
    };
}

/**
 * O status da solicitação sem execução nas marcas sem Cosmos: lá ele é coluna da operação ("Status do Reenvio"), e não
 * célula da linha do formulário como nas 6 do Cosmos. Texto vazio limpa (a nova tentativa que deu certo).
 */
function statusNaOperacao(brand: MarcaCxHub, status: string): Record<string, string> | undefined {
    return ehMarcaSemCosmosComPlanilha(brand) ? { 'Status do Reenvio': status } : undefined;
}

/**
 * A solicitação da tela que não deu certo, registrada mesmo assim (`REGISTRAR_FALHA_DA_TELA`, 2026-11-27): o caso vai à
 * fila sem automação e com a marca de sem execução (`execucaoDoSemExecucao`: Cancelado ou, no "a conferir", Pendente), e
 * a linha vai à planilha sem os campos da automação, com o status na coluna de status e a nota nos comentários. A
 * tentativa anterior, quando a tela a mandou, é reescrita (o mesmo caso e a mesma linha).
 *
 * A resposta é a de antes (o `code`, o texto e o status HTTP, que a Central conhece), mais o `idSolicitacao` para a
 * nova tentativa, o `reason: REGISTRADO_SEM_EXECUCAO` e o `statusRegistrado`. Se a fila recusou, não há caso para a nova
 * tentativa refazer: a linha fica como rastro, e a resposta é a de antes, sem os campos novos.
 */
async function registrarSemExecucao(p: {
    brand: MarcaCxHub;
    dados: ResendSubmissionData;
    sem: SemExecucao;
    resposta: Resultado;
    anterior: TentativaAnterior | null;
    idSolicitacao: string;
    agora: Date;
    prazoFila?: number;
}): Promise<Resultado> {
    const { brand, sem, resposta, anterior } = p;
    const id = anterior?.idSolicitacao ?? p.idSolicitacao;
    const criadoEm = anterior?.criadoEm ?? p.agora;
    const dados: ResendSubmissionData = {
        ...stripAutomation(p.dados),
        status: sem.status,
        comentarios: [p.dados.comentarios, notaDoSemExecucao(sem)].filter(Boolean).join(' | '),
    };
    const caso = casoDoReenvio({ brand, data: dados, automacao: false, idSolicitacao: id, criadoEm });
    const fila = await entregarAFila(caso, execucaoDoSemExecucao(sem.desfecho), anterior, p.prazoFila ?? prazoDaFila());
    console.warn(`${LOG} ${id}: registrado sem execução (${sem.status}), fila ${fila.status}${anterior ? ', por cima da tentativa anterior' : ''}`);

    if (registraNaPlanilha(brand)) {
        await gravarNasPlanilhas(
            [{
                fluxo: 'reenvio',
                marca: brand,
                linha: buildResendRow(brand, dados, formatarCarimboSP(criadoEm)),
                idSolicitacao: id,
                pedido: dados.numeroPedido,
                criadoEm,
                sobrescrever: anterior !== null,
                valoresPorCabecalho: statusNaOperacao(brand, sem.status),
            }],
            { numeroPedido: dados.numeroPedido, idAtendimento: dados.idAtendimento, statusDaFila: fila.status },
        );
    }

    if (fila.status === 'recusado') return resposta;
    return {
        body: { ...resposta.body, idSolicitacao: id, reason: 'REGISTRADO_SEM_EXECUCAO', statusRegistrado: sem.status },
        status: resposta.status,
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

/**
 * `null` = o Cosmos criou o reenvio. Qualquer outra coisa = não criou, ou não dá para saber: a `resposta` de sempre e o
 * `sem`, o que a linha diz quando a solicitação é registrada sem execução.
 */
async function executarNoCosmos(
    brand: SupportedBrand,
    data: ResendSubmissionData,
    token: string | undefined,
    prazo: number,
    idSolicitacao: string,
): Promise<{ resposta: FalhaCosmos; sem: SemExecucao } | null> {
    const corpo = buildCosmosResendBody(data);
    const baseUrl = process.env.COSMOS_API_URL;
    if (!corpo || !data.cosmosId || !token || !baseUrl) {
        // O n8n chamava assim mesmo (`Bearer undefined`, `/orders//resend`) e recebia um 4xx. Aqui nem sai.
        console.error(`${LOG} ${idSolicitacao}: automação pedida sem o necessário`, {
            apiData: Boolean(corpo), cosmosId: Boolean(data.cosmosId), token: Boolean(token), COSMOS_API_URL: Boolean(baseUrl),
        });
        return {
            resposta: { code: 'API_ERROR', message: 'Os dados da automação estão incompletos — o reenvio não foi enviado ao Cosmos.' },
            sem: { desfecho: 'nao_realizado', status: 'Reenvio não realizado (dados da automação incompletos)', proximoPasso: ENVIE_DE_NOVO },
        };
    }

    const janela = prazo - Date.now();
    if (janela <= 0) {
        return {
            resposta: { code: 'API_ERROR', message: 'O tempo acabou antes de chamar o Cosmos — o reenvio não foi enviado.' },
            sem: { desfecho: 'nao_realizado', status: 'Reenvio não realizado (erro de comunicação com o Cosmos)', proximoPasso: ENVIE_DE_NOVO },
        };
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
        // O motivo curto vai no status; o texto do Cosmos, nos comentários.
        const motivo = falha.code === 'OUT_OF_STOCK' ? 'sem saldo' : `HTTP ${res.status}`;
        return {
            resposta: falha,
            sem: { desfecho: 'nao_realizado', status: `Reenvio não realizado (Cosmos recusou: ${motivo})`, proximoPasso: `${falha.message} Nenhum reenvio foi criado.` },
        };
    } catch (erro) {
        // Sem resposta: a requisição pode ter chegado. Não retenta (duplicaria a remessa) e avisa no texto.
        console.error(`${LOG} ${idSolicitacao}: Cosmos sem resposta:`, erro);
        return {
            resposta: {
                code: 'API_ERROR',
                message: 'O Cosmos não respondeu — o reenvio PODE ter sido criado. Confira no Cosmos antes de repetir.',
            },
            sem: {
                desfecho: 'a_conferir',
                status: 'Reenvio a conferir no Cosmos (sem resposta depois do envio)',
                proximoPasso: 'o reenvio PODE ter sido criado. Confira no Cosmos; enviar de novo pela Central confere antes de criar outro.',
            },
        };
    } finally {
        clearTimeout(timer);
    }
}
