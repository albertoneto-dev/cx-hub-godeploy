import { BRAND_API_TO_DISPLAY } from '../constants';
import { ALERT_POLICY } from './policy';
import type { AlertContext } from './types';

/**
 * Monta o texto do aviso (no Slack; era o card do Google Chat no CX Hub da Vercel).
 *
 * A função lê **campo por campo, nominalmente** — nunca faz spread do contexto no texto. É o que
 * garante que PII não vaze mesmo se um chamador futuro enfiar `nomeCliente` no objeto (há teste para
 * isso): o que não está escrito aqui não sai daqui.
 *
 * Ordem das seções escolhida para quem lê no celular, de cima para baixo: **o que houve** → **qual
 * pedido** → **o que já tentamos** → **o que fazer**. O plano de ação é o último porque é o que a
 * pessoa vai executar depois de entender o caso — e o primeiro que ela procura ao reler.
 */
/** Teto do texto livre no card — mensagem de ERP pode vir com stack trace ou dump inteiro. */
const MAX_TEXTO_LIVRE = 200;

/**
 * Higieniza texto que veio de **fora deste repo** (mensagem do ERP, erro do n8n) antes de entrar no card.
 *
 * A leitura nominal do `formatAlert` protege contra um **campo novo** carregando PII; não protege contra
 * PII passando por um campo que já existe. `result.message` é texto livre de sistema externo, e uma recusa
 * do ERP pode ecoar CEP, telefone ou documento — dentro de um espaço do Chat que, por decisão registrada
 * (ADR-005 §5), tem membros fora do time do CXHub.
 *
 * Mascara sequências de 8+ dígitos (CEP, telefone, CPF, cartão) e trunca. Não tenta ser um detector de PII
 * completo: o que sobra é o suficiente para agir e barato de garantir.
 */
function higienizar(texto: string): string {
    const mascarado = texto.replace(/\d[\d.\-/\s]{6,}\d/g, '[número omitido]');
    return mascarado.length > MAX_TEXTO_LIVRE
        ? `${mascarado.slice(0, MAX_TEXTO_LIVRE)}…`
        : mascarado;
}

export function formatAlert(ctx: AlertContext): string {
    const politica = ALERT_POLICY[ctx.reason];
    const linhas: string[] = [];

    const prefixoEnsaio = ctx.testMode === true ? '[TESTE] ' : '';
    linhas.push(`${prefixoEnsaio}*${politica.titulo}*`);
    linhas.push('');
    linhas.push(`*Motivo:* ${ctx.motivo}`);

    // Identificação — só o que serve para achar o registro e a execução.
    const identificacao: string[] = [];
    if (ctx.brand) {
        identificacao.push(`*Marca:* ${BRAND_API_TO_DISPLAY[ctx.brand.toLowerCase()] || ctx.brand}`);
    }
    if (ctx.numeroPedido) identificacao.push(`*Pedido:* ${ctx.numeroPedido}`);
    if (ctx.cosmosId) identificacao.push(`*Cosmos:* ${ctx.cosmosId}`);
    if (ctx.idAtendimento) identificacao.push(`*Atendimento:* ${ctx.idAtendimento}`);
    if (identificacao.length > 0) {
        linhas.push(identificacao.join(' · '));
    }

    // `detalhe` e `tentativas` são os dois campos que carregam texto de sistema externo — os únicos que
    // passam pelo higienizador. `motivo` é frase nossa, escrita neste repo.
    if (ctx.detalhe) {
        linhas.push(`*Detalhe:* ${higienizar(ctx.detalhe)}`);
    }

    // O que separa "o código desistiu" de "o código nem tentou" — ADR-005 §1.
    if (ctx.tentativas) {
        linhas.push(`*Já tentamos:* ${higienizar(ctx.tentativas)}`);
    }

    linhas.push('');
    linhas.push(`*O que fazer:* ${politica.acao}`);

    if (politica.agrupar && politica.severidade !== 'critica') {
        linhas.push('_Avisos repetidos desta mesma causa ficam agrupados por alguns minutos._');
    }

    linhas.push(`_requestId: ${ctx.requestId}_`);

    return linhas.join('\n');
}
