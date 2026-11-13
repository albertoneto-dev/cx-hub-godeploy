import {
    ehMarcaSemCosmos,
    ehMarcaSemCosmosComPlanilha,
    pedeChavePixNoReembolso,
    registraNaPlanilha,
    temOrganizacaoNoCosmos,
    type MarcaCxHub,
} from '../../../shared/lib/constants';
import type { CasoCxhub } from '../../../shared/lib/airflow/types';
import { configuracaoQueFalta } from '../../../shared/lib/backendDireto';
import { buildCancellationRow, prepararCancelamento } from '../../../shared/lib/cancellation/buildCancellationRow';
import { casoDoCancelamento } from '../../../shared/lib/cancellation/casoDoCancelamento';
import type { CancellationPayload } from '../../../shared/lib/cancellation/types';
import { conferirPedidoNoDataMart, prazoDaConferencia } from '../../../shared/lib/datamart/conferenciaServer';
import { enfileirarCasos, prazoDaFila, solicitacaoRecenteNoRegistro } from '../../../shared/lib/fila/index';
import { formatarCarimboSP } from '../../../shared/lib/format';
import { planilhaQueFalta } from '../../../shared/lib/sheets/index';
import { gravarNasPlanilhas, type LinhaDaSolicitacao } from '../../../shared/lib/sheets/gravarLinha';
import type { RefundSubmissionData, RefundSubmitResponse } from '../types/index';
import { buildRefundRow, COLUNA_DA_CHAVE_PIX, prepararReembolso } from './buildRefundRow';
import { casoDoReembolso } from './casoDoReembolso';
import { aplicarConferenciaAoReembolso, chavePixDoReembolso } from './conferenciaDoReembolso';
import { camposFaltandoNoReembolso } from './validateRefundBody';

const LOG = '[Refund Direct]';

export interface ProcessRefundOptions {
    /** Instante-limite da entrega à fila do Metabase; ausente ⇒ `prazoDaFila()`, contado de quando ela começa */
    prazoFila?: number;
    agora?: Date;
}

type Resultado = { body: RefundSubmitResponse; status: number };

/**
 * O que o workflow `[PROD] - Webhook Refund CXHub` fazia, dentro do CXHub, com o registro na fila do Metabase e
 * **junto dele** na planilha da marca (ADR-007, ADR-010, ADR-012): valida o corpo → configuração (fila e planilha) →
 * dedup de 24h (fila e raw) → fila → planilha; se foi o Bot, o cancelamento dele vai junto (um caso na mesma entrega
 * à fila e uma segunda linha, na planilha de cancelamento — só nas marcas do Cosmos: as sem Cosmos não têm essa
 * planilha, e o caso do cancelamento delas fica só na fila, ADR-015).
 *
 * A planilha só é gravada depois da fila, e só se a fila não recusou (o dedup lê a fila: uma linha sem ela deixaria o
 * agente repetir e duplicá-la). Com a fila `incerto` a linha vai também, e a resposta diz para NÃO repetir. Planilha
 * que falha depois da fila não desfaz nada: responde `SHEETS_ERROR` dizendo para NÃO repetir, deixa a linha no log e
 * avisa no Chat.
 *
 * A marca **sem planilha** (a Gobeaute, ADR-014) termina na fila: a configuração confere só a fila, e as respostas são
 * as mesmas (`API_TIMEOUT` com o id quando a fila fica incerta).
 *
 * Os códigos e mensagens são os do n8n, para a tela não perceber a troca. As diferenças são onde o n8n não
 * respondia nada útil: campo faltando (o node de resposta quebrava lendo `extraFields`) e falha ao consultar as
 * solicitações recentes (o workflow inteiro caía).
 *
 * ⚠️ Server-only — fora do barrel de `modules/reembolsos/actions`. Importe pelo caminho completo.
 */
export async function processRefund(
    brand: MarcaCxHub,
    data: RefundSubmissionData,
    opcoes: ProcessRefundOptions = {}
): Promise<Resultado> {
    const agora = opcoes.agora ?? new Date();

    const faltando = camposFaltandoNoReembolso(data as unknown as Record<string, unknown>);
    if (faltando.length > 0) {
        return {
            body: { code: 'UNKNOWN_ERROR', message: `missing field(s): ${faltando.join(', ')}` },
            status: 400,
        };
    }

    // ─── Chave Pix (Ápice, Yenzah e Denavita, ADR-018): validada pelo tipo e gravada normalizada ──
    // Antes de qualquer leitura: é o corpo. A chave nunca vai ao log (LGPD); o erro não a repete.
    let dados = data;
    if (pedeChavePixNoReembolso(brand)) {
        const pix = chavePixDoReembolso(data, chavePixObrigatoria());
        if (!pix.ok) return { body: { code: 'UNKNOWN_ERROR', message: `${pix.erro} Nada foi registrado.` }, status: 422 };
        dados = { ...data, pixKey: pix.chave };
    }

    // ─── Configuração: fila e planilha andam juntas ───────────────────────────────────────────────
    // A planilha da marca também tem de existir no ambiente (as marcas sem Cosmos ainda não têm cópia de staging). A
    // marca sem planilha (ADR-014) só precisa da fila.
    const comPlanilha = registraNaPlanilha(brand);
    const faltaConfiguracao = comPlanilha
        ? (configuracaoQueFalta() ?? planilhaQueFalta('reembolso', brand))
        : configuracaoQueFalta({ comPlanilha: false });
    if (faltaConfiguracao) {
        console.error(`${LOG} ${faltaConfiguracao} (${brand}) — recusando antes do dedup`);
        return {
            body: {
                code: 'UNKNOWN_ERROR',
                message: `Não foi possível registrar o reembolso (${faltaConfiguracao}) — nada foi registrado. Tente novamente.`,
            },
            status: 503,
        };
    }

    // ─── Dedup de 24h (era o `[PROD] [AUX] Consulta Reembolsos CXHub`, lendo a planilha) ──────────
    // Junto dele, a conferência do pedido no Data Mart (ADR-018): as duas só leem, e ela tem teto próprio
    // (`JANELA_CONFERENCIA_MS`, menor que o pior caso do dedup), então não alonga a rota. Nunca lança.
    const conferencia = ehMarcaSemCosmosComPlanilha(brand)
        ? conferirPedidoNoDataMart(brand, String(data.ecommerceOrderId), prazoDaConferencia())
        : null;
    try {
        const existente = await solicitacaoRecenteNoRegistro('REEMBOLSO', brand, String(data.ecommerceOrderId));
        if (existente) {
            console.log(`${LOG} Reembolso duplicado barrado (${brand}, pedido ${existente.pedido})`);
            return {
                body: {
                    code: 'DUPLICATE_REFUND',
                    message: `Já existe um reembolso para o pedido ${existente.pedido} feito por ${existente.responsavel} em ${formatarCarimboSP(new Date(existente.solicitadoEm))}`,
                },
                status: 200,
            };
        }
    } catch (erro) {
        console.error(`${LOG} Falha ao consultar as solicitações recentes (${brand}):`, erro);
        return {
            body: {
                code: 'UNKNOWN_ERROR',
                message: 'Não foi possível consultar as solicitações recentes — nada foi registrado. Tente novamente.',
            },
            status: 503,
        };
    }

    // ─── O que a conferência muda: NF e CD (ADR-018) ─────────────────────────────────────────────
    if (conferencia && ehMarcaSemCosmosComPlanilha(brand)) {
        const conferido = aplicarConferenciaAoReembolso(brand, dados, await conferencia);
        if (conferido.tipo === 'recusado') {
            console.log(`${LOG} Recusado (${brand}): o pedido ${data.ecommerceOrderId} não tem NF de venda no Data Mart`);
            return { body: { code: 'UNKNOWN_ERROR', message: conferido.mensagem }, status: 422 };
        }
        if (conferido.nfDivergente) {
            console.warn(`${LOG} A NF que veio (${conferido.nfDivergente.digitada}) difere da do Data Mart `
                + `(${conferido.nfDivergente.doDataMart}) no pedido ${data.ecommerceOrderId} (${brand}) — vale a do Data Mart`);
        }
        if (conferido.naoConferidos.length > 0) {
            console.warn(`${LOG} Sem conferência no Data Mart (${conferido.naoConferidos.join(', ')}) no pedido `
                + `${data.ecommerceOrderId} (${brand}) — vale o que veio, com a nota nas observações`);
        }
        dados = conferido.data;
    }

    // ─── Fila do Metabase ─────────────────────────────────────────────────────────────────────────
    const idReembolso = crypto.randomUUID();
    const casos: CasoCxhub[] = [casoDoReembolso({ brand, data: dados, idSolicitacao: idReembolso, criadoEm: agora })];
    // O reembolso do Bot vem com cancelamento (era o "If" → "HTTP Request - Cancelamento"): um caso CANCELAMENTO
    // próprio, entregue à fila junto com o reembolso. Nas marcas sem Cosmos também (ADR-015), mas só na fila: elas
    // não têm planilha de cancelamento (o cancelamento delas é no Portal de Reembolso).
    const cancelamentoDoBot = data.handledBy === 'Bot'
        ? { marca: brand, payload: payloadDoCancelamentoDoBot(brand, dados), idSolicitacao: crypto.randomUUID() }
        : null;
    if (cancelamentoDoBot) {
        casos.push(casoDoCancelamento({
            brand: cancelamentoDoBot.marca,
            data: cancelamentoDoBot.payload,
            idSolicitacao: cancelamentoDoBot.idSolicitacao,
            criadoEm: agora,
        }));
    }

    const fila = await enfileirarCasos(casos, opcoes.prazoFila ?? prazoDaFila());
    // Fila recusou: com certeza nada foi guardado, e a planilha também fica de fora (o agente pode repetir).
    if (fila.status === 'recusado') {
        console.error(`${LOG} Fila recusou (${brand}): ${fila.motivo}`);
        return { body: { code: 'SHEETS_ERROR', message: `Erro ao registrar o reembolso (${fila.motivo}).` }, status: 200 };
    }

    // Marca sem planilha (ADR-014): o registro termina na fila, com o cancelamento do Bot quando ele veio (ADR-015).
    if (!comPlanilha) {
        if (fila.status === 'incerto') {
            console.error(`${LOG} Fila incerta, marca sem planilha (${brand}): ${fila.motivo}`);
            return {
                body: {
                    code: 'API_TIMEOUT',
                    message: `Não deu para confirmar a entrada do reembolso na fila do Metabase (${fila.motivo}). NÃO repita a solicitação: confira na lista de reembolsos em alguns minutos ou avise o suporte.`,
                    idSolicitacao: idReembolso,
                },
                status: 504,
            };
        }
        console.log(`${LOG} Reembolso registrado (${brand}, sem planilha${cancelamentoDoBot ? ', com o cancelamento do Bot' : ''})`);
        return {
            body: {
                code: 'SUCCESS',
                message: 'Reembolso registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).',
                idSolicitacao: idReembolso,
            },
            status: 200,
        };
    }

    // ─── Registro na planilha (depois da fila) ────────────────────────────────────────────────────
    // O carimbo da linha é o `criado_em` dos casos, o mesmo instante que foi para a fila (ADR-010).
    const carimbo = formatarCarimboSP(agora);
    const pedido = String(dados.ecommerceOrderId);
    const linhas: LinhaDaSolicitacao[] = [
        {
            fluxo: 'reembolso',
            marca: brand,
            linha: buildRefundRow(brand, prepararReembolso(dados, carimbo)),
            idSolicitacao: idReembolso,
            pedido,
            criadoEm: agora,
            // A chave Pix (marcas sem Cosmos) não vai ao log da linha que falhou (LGPD).
            ...(ehMarcaSemCosmos(brand) ? { colunasSensiveis: [COLUNA_DA_CHAVE_PIX[brand]] } : {}),
        },
    ];
    // A linha do cancelamento só existe nas marcas do Cosmos: as sem Cosmos não têm planilha de cancelamento (ADR-015).
    if (cancelamentoDoBot && temOrganizacaoNoCosmos(brand)) {
        linhas.push({
            fluxo: 'cancelamento',
            marca: brand,
            linha: buildCancellationRow(brand, prepararCancelamento(cancelamentoDoBot.payload, carimbo)),
            idSolicitacao: cancelamentoDoBot.idSolicitacao,
            pedido,
            criadoEm: agora,
        });
    }
    const planilha = await gravarNasPlanilhas(linhas, {
        numeroPedido: pedido,
        idAtendimento: dados.supportTicketId,
        statusDaFila: fila.status,
    });

    if (!planilha.ok) {
        console.error(`${LOG} Fila ${fila.status}, planilha não (${brand}): ${planilha.motivo}`);
        const naFila = fila.status === 'enfileirado' ? 'entrou na fila do Metabase' : `pode ter entrado na fila do Metabase (${fila.motivo})`;
        // A linha entrou e só as fórmulas da operação faltaram (ADR-013): o suporte completa, e repetir duplicaria a linha.
        const naPlanilha = planilha.linhasGravadas
            ? 'a linha entrou na planilha sem as fórmulas de prazo e SLA (o suporte foi avisado para completar)'
            : 'a planilha não foi atualizada';
        return {
            body: {
                code: 'SHEETS_ERROR',
                message: `O reembolso ${naFila}, mas ${naPlanilha}. NÃO repita a solicitação.`,
                // É o que a tela lê para dizer "registrada, não repita" em vez do "nada foi gravado" do recusado.
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao: idReembolso,
            },
            status: 200,
        };
    }

    // Fila incerta: a linha está na planilha, então repetir a duplicaria; quem confere a fila é o suporte (o caso
    // inteiro está no log).
    if (fila.status === 'incerto') {
        console.error(`${LOG} Planilha gravada, fila incerta (${brand}): ${fila.motivo}`);
        return {
            body: {
                code: 'API_TIMEOUT',
                message: `O reembolso foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (${fila.motivo}). NÃO repita a solicitação: avise o suporte.`,
                idSolicitacao: idReembolso,
            },
            status: 504,
        };
    }

    console.log(`${LOG} Reembolso registrado (${brand}${cancelamentoDoBot ? ', com o cancelamento do Bot' : ''})`);
    return {
        body: {
            code: 'SUCCESS',
            message: 'Reembolso registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).',
            idSolicitacao: idReembolso,
        },
        status: 200,
    };
}

/**
 * A chave Pix é obrigatória no reembolso de Ápice, Yenzah e Denavita (a regra do app antigo, ADR-018)? Só com
 * `CHAVE_PIX_OBRIGATORIA=on`: a Central de Tickets ainda manda o reembolso sem a chave, e exigi-la antes de a Central
 * mudar quebraria o envio dela. Lida a cada chamada, para valer sem deploy onde o ambiente é lido na hora (GoDeploy).
 */
function chavePixObrigatoria(): boolean {
    return (process.env.CHAVE_PIX_OBRIGATORIA ?? '').trim().toLowerCase() === 'on';
}

/**
 * O cancelamento que acompanha o reembolso do Bot. `Status` e `Local da Tratativa` ficam vazios (o n8n também não
 * os mandava); a tratativa é sempre `Reembolso`.
 */
function payloadDoCancelamentoDoBot(brand: MarcaCxHub, data: RefundSubmissionData): CancellationPayload {
    return {
        brand,
        'Responsável': data.handledBy,
        'Nome do(a) cliente': data.customerName,
        'Número do pedido (Shopify)': data.ecommerceOrderId,
        'Observações': data.notes ?? '',
        'Número da NF': data.invoiceNumber,
        'CD de origem': data.originWarehouse,
        'Status': '',
        'Local da Tratativa': '',
        'Tratativa': 'Reembolso',
    };
}
