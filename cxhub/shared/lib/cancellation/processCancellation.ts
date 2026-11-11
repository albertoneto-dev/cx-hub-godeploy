import type { SupportedBrand } from '../constants';
import { configuracaoQueFalta } from '../backendDireto';
import { enfileirarCasos, prazoDaFila } from '../fila/index';
import { formatarCarimboSP } from '../format';
import { gravarNasPlanilhas } from '../sheets/gravarLinha';
import { buildCancellationRow, prepararCancelamento } from './buildCancellationRow';
import { casoDoCancelamento } from './casoDoCancelamento';
import type { CancellationPayload, CancellationResponse } from './types';

const LOG = '[Cancellation Direct]';

export interface ProcessCancellationOptions {
    /** Instante-limite da entrega à fila do Metabase; ausente ⇒ `prazoDaFila()`, contado de quando ela começa */
    prazoFila?: number;
    agora?: Date;
}

/**
 * O que o workflow `[PROD] [AUX] - Cancelamento CXHub` fazia, dentro do CXHub, com o registro na fila do Metabase e
 * **junto dele** na planilha da marca (ADR-007, ADR-010, ADR-012): configuração (fila e planilha) → entrega o caso
 * CANCELAMENTO à fila → registra a linha na planilha. Sem dedup — o workflow também não tinha.
 *
 * A planilha só é gravada depois da fila, e só se a fila não recusou. Com a fila `incerto` a linha vai também, e a
 * resposta diz para NÃO repetir. Planilha que falha depois da fila não desfaz nada: responde dizendo para NÃO
 * repetir, deixa a linha no log e avisa no Chat.
 *
 * ⚠️ Server-only (fala com a fila e com o Google) — fora do barrel de `shared/lib/cancellation`, que é importado pelas
 * páginas. Importe por `@shared/lib/cancellation/processCancellation`.
 *
 * Nunca lança: toda falha vira um corpo com `code` que o `submitCancellation` já sabe ler.
 */
export async function processCancellation(
    brand: SupportedBrand,
    payload: CancellationPayload,
    opcoes: ProcessCancellationOptions = {}
): Promise<{ body: CancellationResponse; status: number }> {
    const agora = opcoes.agora ?? new Date();

    // ─── Configuração: fila e planilha andam juntas ───────────────────────────────────────────────
    const faltaConfiguracao = configuracaoQueFalta();
    if (faltaConfiguracao) {
        console.error(`${LOG} ${faltaConfiguracao} (${brand}) — recusando o registro`);
        return {
            body: { code: 'UNKNOWN_ERROR', message: `Erro ao registrar o cancelamento (${faltaConfiguracao}).` },
            status: 500,
        };
    }

    const idSolicitacao = crypto.randomUUID();
    const caso = casoDoCancelamento({ brand, data: payload, idSolicitacao, criadoEm: agora });
    const fila = await enfileirarCasos([caso], opcoes.prazoFila ?? prazoDaFila());

    // Fila recusou: com certeza nada foi guardado, e a planilha também fica de fora (o agente pode repetir).
    if (fila.status === 'recusado') {
        console.error(`${LOG} Fila recusou (${brand}): ${fila.motivo}`);
        return { body: { code: 'UNKNOWN_ERROR', message: `Erro ao registrar o cancelamento (${fila.motivo}).` }, status: 500 };
    }

    const planilha = await gravarNasPlanilhas(
        [{
            fluxo: 'cancelamento',
            marca: brand,
            linha: buildCancellationRow(brand, prepararCancelamento(payload, formatarCarimboSP(agora))),
            idSolicitacao,
            pedido: payload['Número do pedido (Shopify)'],
            criadoEm: agora,
        }],
        { numeroPedido: payload['Número do pedido (Shopify)'], statusDaFila: fila.status },
    );

    if (!planilha.ok) {
        console.error(`${LOG} Fila ${fila.status}, planilha não (${brand}): ${planilha.motivo}`);
        const naFila = fila.status === 'enfileirado' ? 'entrou na fila do Metabase' : `pode ter entrado na fila do Metabase (${fila.motivo})`;
        return {
            body: {
                code: 'UNKNOWN_ERROR',
                message: `O cancelamento ${naFila}, mas a planilha não foi atualizada. NÃO repita a solicitação.`,
                reason: 'SHEET_WRITE_FAILED',
                idSolicitacao,
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
                message: `O cancelamento foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (${fila.motivo}). NÃO repita a solicitação: avise o suporte.`,
                idSolicitacao,
            },
            status: 504,
        };
    }

    console.log(`${LOG} Cancelamento registrado (${brand})`);
    return {
        body: { code: 'SUCCESS', message: 'Cancelamento registrado com sucesso', idSolicitacao },
        status: 200,
    };
}
