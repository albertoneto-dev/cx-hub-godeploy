import {
    ehMarcaSemCosmosComPlanilha,
    pedeChavePixNoReembolso,
    registraNaPlanilha,
    temOrganizacaoNoCosmos,
    type MarcaComPlanilha,
    type MarcaCxHub,
} from '../../../shared/lib/constants';
import type { AtualizacaoCxhub, CasoCxhub } from '../../../shared/lib/airflow/types';
import { configuracaoQueFalta } from '../../../shared/lib/backendDireto';
import { buildCancellationRow, prepararCancelamento } from '../../../shared/lib/cancellation/buildCancellationRow';
import { casoDoCancelamento } from '../../../shared/lib/cancellation/casoDoCancelamento';
import type { CancellationPayload } from '../../../shared/lib/cancellation/types';
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
import { gravarNasPlanilhas, type LinhaDaSolicitacao } from '../../../shared/lib/sheets/gravarLinha';
import type { RefundSubmissionData, RefundSubmitResponse } from '../types/index';
import { buildRefundRow, COLUNA_DA_CHAVE_PIX, prepararReembolso } from './buildRefundRow';
import { casoDoReembolso } from './casoDoReembolso';
import { aplicarConferenciaAoReembolso, chavePixDoReembolso, recusaDoReembolsoGcSemNf } from './conferenciaDoReembolso';
import { COLUNAS_DO_REEMBOLSO } from './refundSheetColumns';
import { camposFaltandoNoReembolso } from './validateRefundBody';

const LOG = '[Refund Direct]';

export interface ProcessRefundOptions {
    /** Instante-limite da entrega à fila do Metabase; ausente ⇒ `prazoDaFila()`, contado de quando ela começa */
    prazoFila?: number;
    agora?: Date;
    /**
     * Só a tela, com `REGISTRAR_FALHA_DA_TELA=on` (2026-11-27): o reembolso que não deu certo também é registrado, sem
     * execução, com o status na linha (`registrarSemExecucao`), e a fila que recusa não tira a linha da planilha. O
     * reembolso do Bot fica de fora, mesmo com ele.
     */
    registrarFalha?: boolean;
    /** O `idSolicitacao` da tentativa sem execução que esta refaz: o mesmo caso e a mesma linha. Só com `registrarFalha`. */
    tentativaAnterior?: string;
}

type Resultado = { body: RefundSubmitResponse; status: number };

const ENVIE_DE_NOVO = 'nenhum reembolso foi registrado para pagar. Envie de novo pela Central.';

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
    const registrarFalha = opcoes.registrarFalha === true && data.handledBy !== 'Bot';
    let anterior: TentativaAnterior | null = null;
    // Toda saída sem sucesso depois do corpo validado passa por aqui: sem a trava (ou sem a configuração), responde como sempre.
    const semExecucao = (resposta: Resultado, sem: SemExecucao, dadosDaLinha: RefundSubmissionData): Promise<Resultado> =>
        registrarFalha && !configuracaoDoRegistroQueFalta(brand)
            ? registrarSemExecucao({ brand, dados: dadosDaLinha, sem, resposta, anterior, agora, prazoFila: opcoes.prazoFila })
            : Promise.resolve(resposta);

    const faltando = camposFaltandoNoReembolso(data as unknown as Record<string, unknown>);
    if (faltando.length > 0) {
        return {
            body: { code: 'UNKNOWN_ERROR', message: `missing field(s): ${faltando.join(', ')}` },
            status: 400,
        };
    }

    // ─── Chave Pix (toda marca com planilha): gravada como veio, normalizada só se vier o tipo e bater ──
    // Antes de qualquer leitura: é o corpo. A chave nunca vai ao log (LGPD); o erro não a repete. Só Ápice, Yenzah e
    // Denavita a exigem (com `CHAVE_PIX_OBRIGATORIA=on`); nas 6 do Cosmos é sempre opcional. A Gobeaute não a lê.
    let dados = data;
    if (registraNaPlanilha(brand)) {
        const pix = chavePixDoReembolso(data, pedeChavePixNoReembolso(brand) && chavePixObrigatoria());
        if (!pix.ok) {
            // A chave que não vale não vai para a linha (a agente a digita de novo).
            return semExecucao({ body: { code: 'UNKNOWN_ERROR', message: `${pix.erro} Nada foi registrado.` }, status: 422 }, {
                desfecho: 'nao_realizado',
                status: 'Reembolso não realizado (chave Pix inválida)',
                proximoPasso: `${pix.erro} Corrija a chave e ${ENVIE_DE_NOVO.charAt(0).toLowerCase()}${ENVIE_DE_NOVO.slice(1)}`,
            }, { ...data, pixKey: '' });
        }
        dados = { ...data, pixKey: pix.chave };
    }

    // ─── Configuração: fila e planilha andam juntas ───────────────────────────────────────────────
    // A planilha da marca também tem de existir no ambiente (as marcas sem Cosmos ainda não têm cópia de staging). A
    // marca sem planilha (ADR-014) só precisa da fila.
    const comPlanilha = registraNaPlanilha(brand);
    const faltaConfiguracao = configuracaoDoRegistroQueFalta(brand);
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
    // Nas marcas do Cosmos, a NF que não veio (o pedido do Cosmos V3 chega sem ela) sai da Intelipost do Data Mart (2026-11-17)
    // e, sem ela, do metacampo da Shopify ou da Intelipost ao vivo (2026-11-19), também junto do dedup e no mesmo teto da
    // conferência. Nunca lança; sem resposta, fica a que veio.
    const nfIntelipost = temOrganizacaoNoCosmos(brand) && nfAusente(data.invoiceNumber)
        ? nfDoPedidoDoCosmos(brand, String(data.ecommerceOrderId), prazoDaConferencia())
        : null;
    try {
        const [existente, tentativa] = await Promise.all([
            solicitacaoRecenteNoRegistro('REEMBOLSO', brand, String(data.ecommerceOrderId)),
            registrarFalha ? tentativaSemExecucao(opcoes.tentativaAnterior, 'REEMBOLSO', brand, String(data.ecommerceOrderId)) : null,
        ]);
        anterior = tentativa;
        if (existente && existente.idSolicitacao !== anterior?.idSolicitacao) {
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
        return semExecucao({
            body: {
                code: 'UNKNOWN_ERROR',
                message: 'Não foi possível consultar as solicitações recentes — nada foi registrado. Tente novamente.',
            },
            status: 503,
        }, { desfecho: 'nao_realizado', status: 'Reembolso não realizado (erro de comunicação com o registro)', proximoPasso: ENVIE_DE_NOVO }, dados);
    }

    // ─── O que a conferência muda: NF e CD (ADR-018) ─────────────────────────────────────────────
    if (conferencia && ehMarcaSemCosmosComPlanilha(brand)) {
        const conferido = aplicarConferenciaAoReembolso(brand, dados, await conferencia);
        if (conferido.tipo === 'recusado') {
            console.log(`${LOG} Recusado (${brand}): o pedido ${data.ecommerceOrderId} não tem NF de venda no Data Mart`);
            return semExecucao({ body: { code: 'UNKNOWN_ERROR', message: conferido.mensagem }, status: 422 }, {
                desfecho: 'nao_realizado',
                status: 'Reembolso não realizado (pedido sem NF)',
                proximoPasso: `${conferido.mensagem} Nenhum reembolso foi registrado para pagar.`,
            }, dados);
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
    if (nfIntelipost) {
        const achada = await nfIntelipost;
        if (achada) {
            console.log(`${LOG} NF ${achada.nf} (${achada.origem}) no pedido ${data.ecommerceOrderId} (${brand}; veio "${data.invoiceNumber ?? ''}")`);
            dados = { ...dados, invoiceNumber: achada.nf };
        }
    }

    // ─── Pedido da Gocreators: o reembolso só com NF (decisão do usuário em 2026-11-27) ──────────
    const recusaDoGc = recusaDoReembolsoGcSemNf(String(data.ecommerceOrderId), brand, !nfAusente(dados.invoiceNumber));
    if (recusaDoGc) {
        console.log(`${LOG} Recusado (${brand}): o pedido ${data.ecommerceOrderId} é da Gocreators e está sem NF de venda`);
        return semExecucao({ body: { code: 'UNKNOWN_ERROR', message: recusaDoGc }, status: 422 }, {
            desfecho: 'nao_realizado',
            status: 'Reembolso não realizado (pedido sem NF)',
            proximoPasso: `${recusaDoGc} Nenhum reembolso foi registrado para pagar.`,
        }, dados);
    }

    // ─── Fila do Metabase ─────────────────────────────────────────────────────────────────────────
    // A nova tentativa de um reembolso sem execução reescreve o caso dele: o mesmo id e o mesmo `criado_em` (o carimbo da
    // linha), de volta a Pendente.
    const idReembolso = anterior?.idSolicitacao ?? crypto.randomUUID();
    const criadoEm = anterior?.criadoEm ?? agora;
    const casos: CasoCxhub[] = [casoDoReembolso({ brand, data: dados, idSolicitacao: idReembolso, criadoEm })];
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

    const prazoFila = opcoes.prazoFila ?? prazoDaFila();
    const fila = anterior
        ? await enfileirarAtualizacao(anterior.idSolicitacao, atualizacaoDoCaso(casos[0], { status_execucao: 'Pendente', responsavel_execucao: '' }), prazoFila)
        : await enfileirarCasos(casos, prazoFila);
    // Fila recusou: com certeza nada foi guardado, e a planilha também fica de fora (o agente pode repetir). Com a trava,
    // a linha vai assim mesmo e é o único registro (a resposta diz para não repetir, como na fila incerta).
    if (fila.status === 'recusado' && (!registrarFalha || !comPlanilha)) {
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
    const pedido = String(dados.ecommerceOrderId);
    const linhas: LinhaDaSolicitacao[] = [
        {
            ...linhaDoReembolso(brand, dados, idReembolso, criadoEm),
            // A nova tentativa reescreve a linha da anterior e limpa o status de sem execução.
            ...(anterior ? { sobrescrever: true, valoresPorCabecalho: statusNaPlanilha(brand, '') } : {}),
        },
    ];
    const carimbo = formatarCarimboSP(agora);
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
        if (fila.status === 'recusado' && !planilha.linhasGravadas) {
            return { body: { code: 'SHEETS_ERROR', message: `Erro ao registrar o reembolso (${fila.motivo}).` }, status: 200 };
        }
        console.error(`${LOG} Fila ${fila.status}, planilha não (${brand}): ${planilha.motivo}`);
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
    if (fila.status !== 'enfileirado') {
        console.error(`${LOG} Planilha gravada, fila ${fila.status} (${brand}): ${fila.motivo}`);
        const naFila = fila.status === 'recusado'
            ? `a fila do Metabase o recusou (${fila.motivo})`
            : `não deu para confirmar a entrada na fila do Metabase (${fila.motivo})`;
        return {
            body: {
                code: 'API_TIMEOUT',
                message: `O reembolso foi registrado na planilha, mas ${naFila}. NÃO repita a solicitação: avise o suporte.`,
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

/** O que falta para registrar (fila e planilha andam juntas; a marca sem planilha, ADR-014, só precisa da fila), ou `null`. */
function configuracaoDoRegistroQueFalta(brand: MarcaCxHub): string | null {
    return registraNaPlanilha(brand)
        ? (configuracaoQueFalta() ?? planilhaQueFalta('reembolso', brand))
        : configuracaoQueFalta({ comPlanilha: false });
}

/** A linha do reembolso. O carimbo é o `criado_em` do caso, o mesmo instante que foi para a fila (ADR-010). */
function linhaDoReembolso(brand: MarcaComPlanilha, dados: RefundSubmissionData, idSolicitacao: string, criadoEm: Date): LinhaDaSolicitacao {
    return {
        fluxo: 'reembolso',
        marca: brand,
        linha: buildRefundRow(brand, prepararReembolso(dados, formatarCarimboSP(criadoEm))),
        idSolicitacao,
        pedido: String(dados.ecommerceOrderId),
        criadoEm,
        // A chave Pix não vai ao log da linha que falhou (LGPD). Na Kokeshi ela está na célula de Observações.
        colunasSensiveis: [COLUNA_DA_CHAVE_PIX[brand]],
    };
}

/**
 * O status do reembolso sem execução vai na coluna de status da planilha, a de onde o financeiro decide o que pagar
 * (a mesma que a gestão do reembolso escreve nas 6 do Cosmos). Na Ápice não se sabe qual é ("Reembolso" ou "Reembolso
 * Feito"): lá ele fica só nas observações. Texto vazio limpa (a nova tentativa que deu certo).
 */
function statusNaPlanilha(brand: MarcaCxHub, status: string): Record<string, string> | undefined {
    const coluna = temOrganizacaoNoCosmos(brand)
        ? COLUNAS_DO_REEMBOLSO[brand].status
        : brand === 'yenzah' || brand === 'denavita' ? 'Status Reembolso' : null;
    return coluna ? { [coluna]: status } : undefined;
}

/**
 * O reembolso da tela que não deu certo, registrado mesmo assim (`REGISTRAR_FALHA_DA_TELA`, 2026-11-27): o caso vai à
 * fila com a marca de sem execução (Cancelado, responsável "CX Hub"), e a linha vai à planilha com o status na coluna de
 * status e a nota nas observações. A tentativa anterior, quando a tela a mandou, é reescrita (o mesmo caso e a mesma
 * linha).
 *
 * A resposta é a de antes (o `code`, o texto e o status HTTP), mais o `idSolicitacao` para a nova tentativa, o
 * `reason: REGISTRADO_SEM_EXECUCAO` e o `statusRegistrado`. Se a fila recusou, não há caso para a nova tentativa
 * refazer: a linha fica como rastro, e a resposta é a de antes.
 */
async function registrarSemExecucao(p: {
    brand: MarcaCxHub;
    dados: RefundSubmissionData;
    sem: SemExecucao;
    resposta: Resultado;
    anterior: TentativaAnterior | null;
    agora: Date;
    prazoFila?: number;
}): Promise<Resultado> {
    const { brand, sem, resposta, anterior } = p;
    const id = anterior?.idSolicitacao ?? crypto.randomUUID();
    const criadoEm = anterior?.criadoEm ?? p.agora;
    const dados: RefundSubmissionData = { ...p.dados, notes: [p.dados.notes, notaDoSemExecucao(sem)].filter(Boolean).join(' | ') };
    const caso = casoDoReembolso({ brand, data: dados, idSolicitacao: id, criadoEm });
    const execucao = execucaoDoSemExecucao(sem.desfecho);
    const prazo = p.prazoFila ?? prazoDaFila();
    const fila = await entregarAFila(caso, execucao, anterior, prazo);
    console.warn(`${LOG} ${id}: registrado sem execução (${sem.status}), fila ${fila.status}${anterior ? ', por cima da tentativa anterior' : ''}`);

    if (registraNaPlanilha(brand)) {
        await gravarNasPlanilhas(
            [{ ...linhaDoReembolso(brand, dados, id, criadoEm), sobrescrever: anterior !== null, valoresPorCabecalho: statusNaPlanilha(brand, sem.status) }],
            { numeroPedido: String(dados.ecommerceOrderId), idAtendimento: dados.supportTicketId, statusDaFila: fila.status },
        );
    }

    if (fila.status === 'recusado') return resposta;
    return {
        body: { ...resposta.body, idSolicitacao: id, reason: 'REGISTRADO_SEM_EXECUCAO', statusRegistrado: sem.status },
        status: resposta.status,
    };
}

/**
 * Entrega à fila o caso sem execução: por cima da tentativa anterior (uma atualização) ou novo, com a marca logo depois
 * (o lote leva a criação antes da atualização). Nunca lança.
 */
async function entregarAFila(
    caso: CasoCxhub,
    execucao: AtualizacaoCxhub,
    anterior: TentativaAnterior | null,
    prazo: number,
): Promise<ResultadoFila> {
    if (anterior) return enfileirarAtualizacao(anterior.idSolicitacao, atualizacaoDoCaso(caso, execucao), prazo);
    const fila = await enfileirarCasos([caso], prazo);
    if (fila.status === 'enfileirado') {
        const marcado = await enfileirarAtualizacao(caso.id_solicitacao, execucao, prazo);
        // O caso entrou sem a marca e parece um reembolso comum: a linha leva o status, e o log da fila, a atualização.
        if (marcado.status !== 'enfileirado') console.error(`${LOG} ${caso.id_solicitacao}: o caso entrou na fila sem a marca de sem execução`);
    }
    return fila;
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
