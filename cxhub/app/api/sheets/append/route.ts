import { NextRequest, NextResponse } from '../../../../../api/next-server';
import { MarcaCxHub, ResendSubmissionData, SheetsAppendResponse } from '../../../../modules/reenvios/types/index';
import { VALID_RESEND_BRANDS, postResendWebhook } from '../../../../modules/reenvios/actions/postResendWebhook';
import { registrarFalhaDaTela } from '../../../../shared/lib/fila/semExecucao';

/**
 * O dedup, o Cosmos, a fila do Metabase (até 16 s, ADR-012) e a linha na planilha (até 15 s, ADR-010), com folga.
 * Literal porque o Next só lê configuração de rota estática.
 */
export const maxDuration = 120;

interface AppendRequestBody {
    brand: MarcaCxHub;
    data: ResendSubmissionData;
    token?: string;
    /**
     * Modo de teste (QA/homologação). Opcional e opt-in: ausente ⇒ false ⇒ fluxo de produção.
     * Quando true, o Cosmos NÃO é chamado e nada é gravado, nem na fila nem na planilha (INV-02). O app nunca envia
     * este campo — só chamadas diretas à rota (curl da QA). Ver docs/qa-modo-teste.md.
     */
    testMode?: boolean;
    /**
     * A nova tentativa de uma solicitação registrada sem execução (`reason: REGISTRADO_SEM_EXECUCAO`): o `idSolicitacao`
     * que a resposta dela trouxe. Reescreve o mesmo caso e a mesma linha. Só com `REGISTRAR_FALHA_DA_TELA=on`; um id
     * que não é de uma tentativa sem execução deste pedido é ignorado (vale o dedup de sempre).
     */
    idSolicitacao?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse<SheetsAppendResponse>> {
    try {
        const body: AppendRequestBody = await request.json();
        const { brand, data, token, testMode, idSolicitacao } = body;

        if (!brand || !data) {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Missing brand or data', sentToAPI: false },
                { status: 400 }
            );
        }

        // Valida a marca: a tela registra também as marcas sem Cosmos (ADR-013, ADR-014).
        if (!VALID_RESEND_BRANDS.includes(brand)) {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: `Invalid brand: ${brand}`, sentToAPI: false },
                { status: 400 }
            );
        }

        // testMode é opcional, mas se vier tem que ser boolean — string "true" não vira true por acidente
        if (testMode !== undefined && typeof testMode !== 'boolean') {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Invalid testMode: expected boolean', sentToAPI: false },
                { status: 400 }
            );
        }

        if (idSolicitacao !== undefined && typeof idSolicitacao !== 'string') {
            return NextResponse.json(
                { code: 'UNKNOWN_ERROR', message: 'Invalid idSolicitacao: expected string', sentToAPI: false },
                { status: 400 }
            );
        }

        // A trava é lida a cada chamada (liga e desliga sem deploy). Desligada, o id da tentativa anterior nem é lido.
        const registrarFalha = registrarFalhaDaTela();
        const { body: result, status } = await postResendWebhook({
            brand, data, token, testMode,
            registrarFalha,
            tentativaAnterior: registrarFalha ? idSolicitacao : undefined,
        });
        return NextResponse.json(result, { status });
    } catch (error) {
        console.error('[Sheets Append API] Error:', error);
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Não foi possível se conectar ao sistema.', sentToAPI: false },
            { status: 500 }
        );
    }
}
