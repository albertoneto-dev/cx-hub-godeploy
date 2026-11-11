import type { MarcaCxHub } from '../../../shared/lib/constants';
import { buscarDadosDoFormulario } from '../../../shared/lib/formDataApi';
import { VALID_RESEND_BRANDS } from './postResendWebhook';

/**
 * Quanto a rota do bot espera pela rota dados. Entra na conta do `maxDuration` da rota (a busca vem antes do pedido).
 */
export const JANELA_ROTA_DADOS_MS = 5_000;

export interface MarcasDoBot {
    marcas: MarcaCxHub[];
    /** De onde a lista veio: `rota-dados` (o que a operação ligou) ou `codigo` (a rota dados não respondeu). */
    fonte: 'rota-dados' | 'codigo';
}

/**
 * As marcas que o bot aceita no reenvio (ADR-015): as `marcas` que a rota dados (`rota-dados-cxhub`, origem
 * `reenvio`) lista, as mesmas do formulário da tela. Ligar ou desligar uma marca no bot é mexer na rota dados, sem
 * deploy.
 *
 * Só passa marca que o código sabe registrar (`VALID_RESEND_BRANDS`): uma marca que a rota dados lista e o CX Hub não
 * conhece não tem planilha nem sigla na gold, e o bot a recusa como sempre.
 *
 * Rota dados fora (sem configuração, timeout, credencial, resposta fora do contrato) ⇒ a `VALID_RESEND_BRANDS` inteira,
 * para nenhuma solicitação do bot se perder por causa dela. Nunca lança.
 *
 * ⚠️ Server-only (lê os segredos da rota dados), fora do barrel.
 */
export async function marcasDoBot(timeoutMs: number = JANELA_ROTA_DADOS_MS): Promise<MarcasDoBot> {
    const resposta = await buscarDadosDoFormulario('reenvio', timeoutMs);
    if (resposta.status !== 200) {
        console.warn(
            `[Reenvio Bot API] A rota dados não respondeu (HTTP ${resposta.status}): usando as marcas do código`,
            resposta.body,
        );
        return { marcas: [...VALID_RESEND_BRANDS], fonte: 'codigo' };
    }

    // O corpo já passou pelo `validateFormDataShape` (INV-01): `marcas` é uma lista não vazia.
    const daRotaDados = (resposta.body as { marcas: unknown[] }).marcas.map((m) => String(m).trim().toLowerCase());
    return {
        marcas: VALID_RESEND_BRANDS.filter((marca) => daRotaDados.includes(marca)),
        fonte: 'rota-dados',
    };
}
