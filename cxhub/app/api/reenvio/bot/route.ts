import { NextRequest, NextResponse } from '../../../../../api/next-server';
import type { MarcaCxHub, ResendSubmissionData, SheetsAppendResponse, SupportedBrand } from '../../../../modules/reenvios/types/index';
import type { MarcaSemCosmos } from '../../../../shared/lib/constants';
import { ehMarcaSemCosmos } from '../../../../shared/lib/constants';
import { adaptBotPayload, type BotResendPayload } from '../../../../modules/reenvios/actions/adaptBotPayload';
import { isCepValido } from '../../../../shared/lib/format';
import { postResendWebhook } from '../../../../modules/reenvios/actions/postResendWebhook';
import { JANELA_ROTA_DADOS_MS, marcasDoBot } from '../../../../modules/reenvios/actions/marcasDoBot';
import { buildBotResendData, stripAutomation } from '../../../../modules/reenvios/actions/buildBotResendData';
import { resolvePartialReshipment } from '../../../../modules/reenvios/actions/resolvePartialReshipment';
import { JANELA_FILA_MS, prazoDaFila } from '../../../../shared/lib/fila/index';
import { FOLGA_HANDLER_MS } from '../../../../shared/lib/backendDireto';
import { JANELA_PLANILHA_MS } from '../../../../shared/lib/sheets/gravarLinha';
import { getCosmosServiceToken, fetchNormalizedCosmosOrder } from '../../../../shared/lib/cosmos/server';
import { adaptShopifyOrder } from '../../../../shared/lib/shopify/index';
import { buscarPedidoNoGatewayOuNoDataMart } from '../../../../shared/lib/shopify/buscarPedidoNoGatewayOuNoDataMart';
import { sendAlert, deveAvisar, ALERT_TIMEOUT_MS, type AlertContext, type AlertReason } from '../../../../shared/lib/alerts/index';

/**
 * Endpoint de reenvio para o bot de atendimento (Typebot).
 *
 * Aceita o payload aninhado em inglês que o bot já monta, **busca o pedido real no Cosmos pelo
 * servidor**, monta o reenvio completo (`buildBotResendData`) e delega ao MESMO transporte do submit da
 * UI (`postResendWebhook`). Quando tudo confere, a linha sai com os campos de automação preenchidos e o
 * `processResend` executa o reenvio no ERP — o INV-03 (que proibia isso por construção) foi **revogado**
 * explicitamente nesta fatia, e no lugar dele ficaram as guardas abaixo.
 *
 * As marcas aceitas são as que a rota dados lista para o reenvio (ADR-015, `marcasDoBot`). As marcas sem Cosmos
 * (Ápice, Yenzah, Denavita, Gobeaute) seguem outro caminho, sem nenhuma chamada ao Cosmos (INV-07): o pedido vem da
 * Shopify pelo integrations-gateway e a solicitação só é registrada (`registrarMarcaSemCosmos`).
 *
 * **Régua única das guardas (INV-05): toda dúvida degrada para REGISTRO** — a linha é gravada sem
 * automação, com o motivo na resposta. Nunca "executa mesmo assim", e nunca perde a solicitação num
 * 500: quem chama é um bot, e para ele a solicitação sumir é indistinguível de nunca ter existido.
 *
 * Modo de teste (`"testMode": true`) percorre o caminho INTEIRO (RF-29) — um ensaio mais curto que a
 * produção não testaria o que importa. Quem impede o Cosmos ali é o `processResend` (`testMode` não chama o
 * ERP), com a guarda do INV-02 por cima. Ver docs/qa-reenvio-bot.md.
 */
const BOT_SECRET_HEADER = 'x-bot-secret';

/**
 * Uma reprovação de guarda, agora com classificação legível por máquina (ADR-005).
 *
 * O `motivo` continua sendo a frase em português que a resposta sempre teve; o `reason` é o que o bot
 * ramifica e o que decide se o caso chega ao canal do Slack. Os dois juntos porque servem
 * públicos diferentes — pessoa e máquina — e separá-los em dois caminhos os faria divergir.
 */
interface Reprovacao {
    reason: AlertReason;
    motivo: string;
    /** Detalhe técnico que torna o aviso acionável (erro do ERP, nome da transportadora, SKU). */
    detalhe?: string;
    /** O que o código tentou antes de desistir — só existe onde houve contorno (ADR-005 §1). */
    tentativas?: string;
}

/**
 * Envia o aviso **sem jamais** deixar o desfecho da solicitação depender dele (ADR-005 §4).
 *
 * O `sendAlert` já promete não lançar; este `catch` é redundante de propósito e tem teste próprio. A
 * redundância é barata e o que ela protege não é: um `throw` vazando daqui cairia no catch geral da
 * rota e transformaria "avisamos que degradou" em "perdemos a solicitação num 500".
 */
async function avisar(ctx: AlertContext): Promise<void> {
    try {
        // Consulta o predicado CANÔNICO (não uma segunda régua): falha de dado da cliente volta ao bot
        // pelo `reason` e não chega ao grupo. Sair aqui, e não só dentro do transporte, é o que garante
        // que nenhum trabalho — nem uma chamada de rede — é gasto com o que não deve ser avisado.
        //
        // DENTRO do `try` de propósito: era o único ponto do caminho do aviso que podia lançar para fora
        // do guarda-chuva do INV-06 (um `reason` fora do mapa faria o acesso à política explodir).
        if (!deveAvisar(ctx.reason)) {
            return;
        }

        await sendAlert(ctx);
    } catch (error) {
        console.error('[Reenvio Bot API] Falha ao avisar (ignorada de propósito):', error);
    }
}

/**
 * Teto de execução do handler. Existe junto do orçamento agregado do `cosmos/server.ts`: aquele garante
 * que a busca no ERP termina com tempo de sobra para GRAVAR a linha; este limita o pior caso total. A
 * ordem importa — se a plataforma matar o processo, nenhum `catch` roda e a solicitação se perde em
 * silêncio, que é o único desfecho que esta rota não pode ter.
 *
 * A postagem entrega o caso à fila do Metabase (até `JANELA_FILA_MS`, ADR-012) e depois grava a linha na planilha
 * (ADR-010); o orçamento abaixo desconta as duas janelas, e a consulta à rota dados que vem antes de tudo
 * (`JANELA_ROTA_DADOS_MS`, ADR-015).
 */
export const maxDuration = 150;

/** Piso do orçamento da fase Cosmos: abaixo disso a busca não tem chance e degradar já é o certo. */
const MIN_ORCAMENTO_COSMOS_MS = 8_000;

/** Quanto o handler pode gastar: o `maxDuration` inteiro. */
const ORCAMENTO_DO_HANDLER_MS = maxDuration * 1_000;

/**
 * Orçamento da fase Cosmos (signin + busca do pedido), **derivado do que precisa sobrar depois dela**.
 *
 * Número solto aqui não serve: o custo do que vem depois é governado pela env `TIMEOUT`, então um teto fixo
 * seria invalidado em silêncio pelo primeiro ambiente que a mudasse. O que tem que caber depois do Cosmos é
 * **duas** postagens — a segunda é a repostagem que garante a linha quando o ERP recusa (T6, ADR-005
 * §2) — mais as janelas da fila e da planilha (ADR-012 e ADR-010), o aviso e a folga. Essa segunda postagem
 * é justamente o que era cortado quando a plataforma matava o handler, e ela é a garantia inteira desta rota.
 */
function orcamentoFaseCosmos(): number {
    const timeoutWebhook = parseInt(process.env.TIMEOUT || '', 10) || 10_000;
    const reserva = 2 * timeoutWebhook + JANELA_ROTA_DADOS_MS + JANELA_FILA_MS + JANELA_PLANILHA_MS + ALERT_TIMEOUT_MS + FOLGA_HANDLER_MS;
    const disponivel = ORCAMENTO_DO_HANDLER_MS - reserva;
    if (disponivel < MIN_ORCAMENTO_COSMOS_MS) {
        // O `Math.max` abaixo é **piso, não teto**: sozinho ele absorveria este estouro em silêncio, e o
        // pior caso voltaria a passar do `maxDuration` — que é como a plataforma mata o handler antes da
        // repostagem que garante a linha. Encurtar de verdade exigiria mexer no `TIMEOUT`, que é
        // compartilhado com o fluxo da tela; o que cabe aqui é **não deixar passar calado**.
        const tetoTimeout = Math.floor(
            (ORCAMENTO_DO_HANDLER_MS - JANELA_ROTA_DADOS_MS - JANELA_FILA_MS - JANELA_PLANILHA_MS - ALERT_TIMEOUT_MS - FOLGA_HANDLER_MS - MIN_ORCAMENTO_COSMOS_MS) / 2
        );
        console.warn(
            `[Reenvio Bot API] Orçamento insuficiente: a reserva de ${reserva}ms (2× TIMEOUT=${timeoutWebhook}ms `
            + `+ rota dados + fila + planilha + aviso + folga) não cabe no maxDuration de ${ORCAMENTO_DO_HANDLER_MS / 1_000}s. A fase Cosmos cai no piso de `
            + `${MIN_ORCAMENTO_COSMOS_MS}ms e o pior caso pode estourar a execução, perdendo a solicitação. `
            + `Reduza TIMEOUT para ${tetoTimeout}ms ou menos.`
        );
    }
    return Math.max(MIN_ORCAMENTO_COSMOS_MS, disponivel);
}

/**
 * Janela que ESTA rota concede a cada postagem — o outro lado da mesma conta do
 * `orcamentoFaseCosmos`.
 *
 * O `postResendWebhook` lê a env `TIMEOUT` por conta própria, e essa env é **compartilhada com o fluxo da
 * tela**: subi-la para o agente esperar mais empurrava o pior caso do bot para além do `maxDuration`, e o
 * que a plataforma cortava era justamente a repostagem que garante a linha. Enquanto o teto era só um
 * `console.warn`, a proteção dependia de alguém ler o log (OQ-12).
 *
 * Aqui o bot passa a declarar o **seu** teto: o menor entre a env e o que cabe em duas postagens dentro do
 * `maxDuration`. A tela não passa nada e segue com a env — cada porta com a restrição que é a dela.
 */
function tetoWebhookBot(): number {
    const timeoutEnv = parseInt(process.env.TIMEOUT || '', 10) || 10_000;
    const cabeNoHandler = Math.floor(
        (ORCAMENTO_DO_HANDLER_MS - JANELA_ROTA_DADOS_MS - JANELA_FILA_MS - JANELA_PLANILHA_MS - ALERT_TIMEOUT_MS - FOLGA_HANDLER_MS - MIN_ORCAMENTO_COSMOS_MS) / 2
    );
    return Math.min(timeoutEnv, cabeNoHandler);
}

/**
 * Interruptores de emergência (G8) — avaliados ANTES de qualquer I/O no ERP, de propósito: quando se
 * desliga a automação porque o Cosmos está em sofrimento, um interruptor que ainda martela o Cosmos não
 * alivia nada. `null` = pode seguir.
 */
function interruptorDesligado(body: unknown): Reprovacao | null {
    if ((process.env.BOT_RESEND_EXECUTE || '').trim().toLowerCase() === 'off') {
        return {
            reason: 'AUTOMATION_OFF',
            motivo: 'Automação de reenvio desligada no ambiente (BOT_RESEND_EXECUTE=off)',
        };
    }
    if ((body as { executeResend?: unknown } | null)?.executeResend === false) {
        return {
            reason: 'AUTOMATION_OFF',
            motivo: 'Automação desligada nesta requisição ("executeResend": false)',
        };
    }
    return null;
}

/**
 * Compara o segredo em tempo constante *para segredos do mesmo tamanho* — é o que impede descobrir
 * o valor byte a byte. Tamanhos diferentes saem antes, e o custo do ramo depende do tamanho RECEBIDO,
 * não do esperado: não vira oráculo do tamanho do segredo. Só com APIs da web (o Worker não tem o
 * `timingSafeEqual` do `node:crypto` nem `Buffer`).
 */
function secretMatches(received: string, expected: string): boolean {
    const a = new TextEncoder().encode(received);
    const b = new TextEncoder().encode(expected);
    if (a.length !== b.length) {
        bytesIguais(a, a);
        return false;
    }
    return bytesIguais(a, b);
}

/** Percorre todos os bytes, sem sair no primeiro diferente. */
function bytesIguais(a: Uint8Array, b: Uint8Array): boolean {
    let diferenca = 0;
    for (let i = 0; i < a.length; i++) diferenca |= a[i] ^ b[i];
    return diferenca === 0;
}

/**
 * Os campos que a tela exige do agente ao trocar endereço (`validateSteps.ts:66-85`) — complemento é o
 * único opcional. A porta do bot usa a MESMA régua de propósito: validar só o CEP a deixaria mais
 * permissiva que a do humano, e o endereço novo é a única parte do reenvio que ninguém confere depois.
 */
const CAMPOS_ENDERECO_NOVO = [
    { key: 'street', rotulo: 'logradouro' },
    { key: 'number', rotulo: 'número' },
    { key: 'district', rotulo: 'bairro' },
    { key: 'city', rotulo: 'cidade' },
    { key: 'state', rotulo: 'estado' },
    { key: 'postalCode', rotulo: 'CEP' },
] as const;

/**
 * G5b — endereço novo (RF-32). `null` = pode seguir.
 *
 * Campo ausente e CEP ilegível têm motivos **distintos** de propósito: a operação precisa separar "o bot
 * não coletou o dado" de "coletou e está ilegível" — são conversas diferentes com a cliente. Só age
 * quando o bot pediu troca de endereço; sem troca, o endereço é o do pedido e já foi validado pelo ERP.
 */
function avaliarEnderecoNovo(botPayload: unknown): Reprovacao | null {
    const addressChange = (botPayload as BotResendPayload | null)?.addressChange;
    if (addressChange?.enabled !== true) return null;

    const address = addressChange.address ?? {};
    const ausentes = CAMPOS_ENDERECO_NOVO
        .filter(({ key }) => !String(address[key] ?? '').trim())
        .map(({ rotulo }) => rotulo);

    if (ausentes.length > 0) {
        return {
            reason: 'NEW_ADDRESS_INCOMPLETE',
            motivo: `Endereço novo incompleto — campo(s) ausente(s): ${ausentes.join(', ')} — registrado sem automação`,
        };
    }

    // Bem-formado ≠ correto: 8 dígitos que não casam com faixa de roteamento fazem o Cosmos salvar o
    // reenvio sem CD e sem ERP, em silêncio (Confluence §13.7). Descartar isso exigiria consulta externa,
    // recusada por decisão de escopo — o que dá para barrar aqui é o ilegível.
    if (!isCepValido(address.postalCode)) {
        return {
            reason: 'NEW_ADDRESS_CEP_INVALID',
            motivo: `CEP do endereço novo malformado ("${String(address.postalCode ?? '')}") — registrado sem automação`,
        };
    }

    return null;
}

/**
 * As guardas que substituem o olho humano — o que antes era a revisão de um agente de CX antes de
 * clicar. Devolve o **motivo da reprovação** (string) ou `null` quando o reenvio pode executar.
 *
 * A ordem é do mais barato e mais explícito para o mais derivado: interruptor → elegibilidade →
 * integridade do que iria ao ERP. Nenhuma delas prova que o pedido *merece* reenvio — isso quem apura é
 * o fluxo do bot, antes de chamar.
 *
 * **Não há guarda de VALOR** (o antigo G6 / RF-25 e RF-26, revogadas): quem decide o mérito é o Typebot,
 * e esta rota é executora — a mesma régua do fluxo manual, que nunca teve teto. Ver OQ-05.
 */
function avaliarGuardas(input: {
    submissionData: ResendSubmissionData;
    shouldSend: boolean;
    motivo?: string;
    reason?: AlertReason;
    botPayload: unknown;
}): Reprovacao | null {
    const { submissionData, shouldSend, motivo, reason, botPayload } = input;

    // G3/G4 — elegibilidade (`shouldSendToAPI`) e transportadora resolvida (mapa da marca ou o id que o
    // pedido trouxe do Cosmos). O `reason` vem do builder quando ele sabe classificar (transportadora);
    // as demais reprovações do `shouldSendToAPI` são todas de elegibilidade.
    if (!shouldSend) {
        return {
            reason: reason || 'NOT_ELIGIBLE',
            motivo: motivo || 'Pedido não elegível à automação de reenvio',
        };
    }

    // G5b antes da integridade genérica: um CEP ausente também tropeçaria no `!postal_code` abaixo, e o
    // motivo genérico ("Endereço de entrega sem CEP") esconderia QUAL campo o bot deixou de coletar.
    const problemaEndereco = avaliarEnderecoNovo(botPayload);
    if (problemaEndereco) {
        return problemaEndereco;
    }

    // G5 — integridade do corpo que iria ao Cosmos. `carrierId` ausente ou `product_id: 0` fariam o ERP
    // receber uma remessa inválida; CEP vazio faria despachar sem endereço de entrega (é o caso da troca
    // de endereço pelo bot, cujo payload não carrega CEP).
    const apiData = submissionData.apiData;
    if (!apiData) {
        return {
            reason: 'AUTOMATION_DATA_MISSING',
            motivo: 'Dados de automação não foram montados a partir do pedido — registrado sem automação',
        };
    }
    if (!apiData.carrierId) {
        return {
            reason: 'CARRIER_ID_MISSING',
            motivo: 'Transportadora sem ID no Cosmos (carrierId ausente) — registrado sem automação',
            detalhe: apiData.carrierServiceName || undefined,
        };
    }
    if (!apiData.resendProducts || apiData.resendProducts.length === 0) {
        return {
            reason: 'NO_RESEND_ITEMS',
            motivo: 'Nenhum item para reenviar foi resolvido no pedido — registrado sem automação',
        };
    }
    if (apiData.resendProducts.some((item) => !item.product_id)) {
        return {
            reason: 'PRODUCT_ID_MISSING',
            motivo: 'Item do reenvio sem ID de produto no Cosmos (product_id 0) — registrado sem automação',
            detalhe: submissionData.produtoReenviar || undefined,
        };
    }
    if (!apiData.shippingAddress?.postal_code) {
        return {
            reason: 'ORDER_ADDRESS_NO_CEP',
            motivo: 'Endereço de entrega sem CEP — registrado sem automação',
        };
    }

    return null;
}

/**
 * Carimba na linha o PORQUÊ da degradação (ADR-005 §2 · RF-38).
 *
 * Sem isto a linha chega à planilha **muda**: sem automação e sem pista nenhuma da causa. E a outra metade
 * — o aviso no Slack — é falha **aberta** por desenho (INV-06: sem `SLACK_ALERT_WEBHOOK_URL` nenhum aviso
 * sai). Quem trata a fila à mão precisa da causa **na linha**, que é o artefato que sempre existe.
 *
 * O comentário que o bot mandou é **preservado**: a causa é anexada, nunca sobrescreve — ele é o relato da
 * cliente, e trocá-lo por texto de máquina perderia o que a atendente escreveu.
 */
function anotarCausa(data: ResendSubmissionData, reprovacao: Reprovacao): ResendSubmissionData {
    const causa = [reprovacao.motivo, reprovacao.detalhe].filter(Boolean).join(' — ');
    return {
        ...data,
        comentarios: [data.comentarios, `[CXHub] ${causa}`].filter(Boolean).join(' | '),
    };
}

/**
 * O desfecho de toda guarda reprovada: a linha É gravada, sem automação e sem `apiData`, com o motivo
 * na resposta E na própria linha. Nenhum token de ERP acompanha o envelope — no caminho de registro não há
 * o que autenticar.
 */
async function postarSemAutomacao(input: {
    brand: MarcaCxHub;
    data: ResendSubmissionData;
    testMode?: boolean;
    reprovacao: Reprovacao;
    requestId: string;
}): Promise<NextResponse<SheetsAppendResponse>> {
    const { brand, data, testMode, reprovacao, requestId } = input;
    console.warn('[Reenvio Bot API] Degradando para registro sem automação:', reprovacao.motivo);

    const enviado = stripAutomation(anotarCausa(data, reprovacao));
    const { body: result, status } = await postResendWebhook({
        brand,
        data: enviado,
        testMode,
        timeoutMs: tetoWebhookBot(),
        // O `requestId` é o id do caso: casa o caso da fila com o card do Chat e o log da Vercel.
        idSolicitacao: requestId,
        prazoFila: prazoDaFila(),
    });
    // Precedência do transporte: se a linha ficou INCERTA, isso importa mais do que a guarda que
    // degradou — "não sabemos se registrou" pede outra ação que "registrou sem automação".
    const reason = result.reason ?? reprovacao.reason;

    // O aviso vem DEPOIS da gravação, sempre. Ordem, não estilo: a linha é a garantia; o aviso é
    // observabilidade. Invertê-los faria um Chat lento atrasar o que protege a solicitação.
    await avisar({
        // A planilha que falhou já foi avisada por quem a gravou (com o id do caso): aqui avisa-se a guarda.
        reason: result.reason === 'SHEET_WRITE_FAILED' ? reprovacao.reason : reason,
        motivo: reprovacao.motivo,
        requestId,
        brand,
        numeroPedido: data.numeroPedido || undefined,
        cosmosId: data.cosmosId || undefined,
        idAtendimento: data.idAtendimento || undefined,
        testMode: testMode === true,
        detalhe: reprovacao.detalhe,
        tentativas: reprovacao.tentativas,
    });

    return NextResponse.json(
        { ...result, message: [reprovacao.motivo, result.message].filter(Boolean).join(' — '), reason },
        { status }
    );
}

/**
 * Recusa por payload inválido — o único desfecho da rota que **descarta** a solicitação de propósito
 * (RF-08/RF-17: coagir `"true"` em `true` gravaria na aba errada, então recusar é mais seguro que
 * adivinhar). Justamente por descartar, avisa: um bot mal configurado perdendo solicitação em silêncio
 * é indistinguível de um bot que nunca chamou.
 */
async function recusarPayload(mensagem: string, requestId: string): Promise<NextResponse<SheetsAppendResponse>> {
    console.warn('[Reenvio Bot API] Payload recusado:', mensagem);
    await avisar({
        reason: 'INVALID_PAYLOAD',
        motivo: `${mensagem} — a solicitação foi DESCARTADA (nenhuma linha gravada)`,
        requestId,
    });
    return NextResponse.json(
        { code: 'UNKNOWN_ERROR', message: mensagem, sentToAPI: false, reason: 'INVALID_PAYLOAD' },
        { status: 400 }
    );
}

/**
 * Recusa do reenvio PARCIAL (Portal de Cancelamento) quando os itens não conferem com o pedido.
 *
 * Exceção deliberada ao INV-05 ("toda dúvida degrada para registro"): degradar gravaria uma linha com uma
 * caixa diferente da que o portal combinou com a cliente, e quem chama tem uma pessoa na frente para
 * corrigir e reenviar. Pedido do portal: "recusar com erro claro em vez de mandar o pedido inteiro".
 */
async function recusarItens(motivo: string, requestId: string): Promise<NextResponse<SheetsAppendResponse>> {
    console.warn('[Reenvio Bot API] Reenvio parcial recusado:', motivo);
    await avisar({ reason: 'INVALID_ITEMS', motivo, requestId });
    return NextResponse.json(
        { code: 'INVALID_ITEMS', message: motivo, sentToAPI: false, reason: 'INVALID_ITEMS' },
        { status: 422 }
    );
}

/**
 * Marca sem Cosmos no bot (ADR-015): o desfecho é o mesmo da tela para essas marcas — o pedido vem da Shopify pelo
 * integrations-gateway (ou, fora dos 60 dias dele, do Data Mart: decisão deste app) e a solicitação é **só
 * registrada** (fila e planilha; a Gobeaute, só na fila). Nenhuma chamada
 * ao Cosmos (INV-07), nenhuma guarda de automação (não há o que executar) e nenhum aviso quando tudo dá certo:
 * registrar é o caminho normal dessas marcas, não uma degradação.
 *
 * A régua do bot vale igual: pedido não achado ou gateway fora ⇒ a linha é gravada com o que o bot mandou (INV-05), e
 * o reenvio parcial com item que não confere é recusado, como nas marcas do Cosmos.
 */
async function registrarMarcaSemCosmos(input: {
    marca: MarcaSemCosmos;
    data: ResendSubmissionData;
    body: unknown;
    testMode?: boolean;
    parcial: boolean;
    requestId: string;
}): Promise<NextResponse<SheetsAppendResponse>> {
    const { marca, data, body, testMode, parcial, requestId } = input;

    // A busca (no gateway e, sem o pedido, no Data Mart) ocupa o lugar da fase Cosmos no orçamento do handler: o mesmo
    // prazo, o mesmo teto.
    const prazo = Date.now() + orcamentoFaseCosmos();
    const timeoutPorConsulta = parseInt(process.env.TIMEOUT || '', 10) || 10_000;
    const busca = data.numeroPedido
        ? await buscarPedidoNoGatewayOuNoDataMart(marca, data.numeroPedido, timeoutPorConsulta, prazo)
        : { tipo: 'nao_encontrado' as const };

    if (busca.tipo === 'falha') {
        return await postarSemAutomacao({
            brand: marca,
            data,
            testMode,
            requestId,
            reprovacao: {
                reason: 'SHOPIFY_UNAVAILABLE',
                motivo: 'Não foi possível consultar o pedido na Shopify (integrations-gateway indisponível ou mal configurado) — registrado com o que o bot informou',
                detalhe: busca.erro,
            },
        });
    }
    if (busca.tipo === 'nao_encontrado') {
        return await postarSemAutomacao({
            brand: marca,
            data,
            testMode,
            requestId,
            reprovacao: {
                reason: 'ORDER_NOT_FOUND',
                motivo: `Pedido ${data.numeroPedido || '(sem número)'} não foi encontrado na Shopify nem no Data Mart — registrado para tratativa manual`,
            },
        });
    }

    const orderData = adaptShopifyOrder(busca.pedido, marca);

    const reshipment = (body as BotResendPayload | null)?.reshipment;
    const resolucaoParcial = parcial ? resolvePartialReshipment(orderData.produtos, reshipment?.items) : null;
    if (resolucaoParcial && !resolucaoParcial.ok) {
        return await recusarItens(resolucaoParcial.motivo, requestId);
    }
    const selecaoParcial = resolucaoParcial?.ok ? resolucaoParcial : undefined;

    // O pedido da Shopify não foi validado por ninguém: uma exceção na montagem degrada para o que o bot mandou, como
    // no caminho do Cosmos (OQ-06), em vez de descartar a solicitação num 500.
    let submissionData: ResendSubmissionData;
    try {
        submissionData = buildBotResendData({ brand: marca, orderData, botPayload: body, selecaoParcial }).submissionData;
    } catch (erroDeMontagem) {
        console.error('[Reenvio Bot API] Falha ao montar o reenvio (marca sem Cosmos) — registrando com o que o bot informou:', erroDeMontagem);
        return await postarSemAutomacao({
            brand: marca,
            data,
            testMode,
            requestId,
            reprovacao: {
                reason: 'INTERNAL_ERROR',
                motivo: 'Falha inesperada ao montar o reenvio — registrado com o que o bot informou',
                detalhe: erroDeMontagem instanceof Error ? erroDeMontagem.message : 'erro desconhecido',
            },
        });
    }

    // `stripAutomation` por garantia: o `processResend` já não executa marca sem Cosmos (INV-07).
    const { body: result, status } = await postResendWebhook({
        brand: marca,
        data: stripAutomation(submissionData),
        testMode,
        timeoutMs: tetoWebhookBot(),
        idSolicitacao: requestId,
        prazoFila: prazoDaFila(),
    });

    // Fila incerta ou modo de teste violado: o transporte mandou o `reason`. A planilha que falhou já foi avisada por
    // quem a gravou.
    if (result.reason && result.reason !== 'SHEET_WRITE_FAILED') {
        await avisar({
            reason: result.reason,
            motivo: result.message || 'Resposta do fluxo não confirmou o registro',
            requestId,
            brand: marca,
            numeroPedido: submissionData.numeroPedido || undefined,
            idAtendimento: submissionData.idAtendimento || undefined,
            testMode: testMode === true,
        });
    }

    return NextResponse.json({ ...result, ...(selecaoParcial ? { items: selecaoParcial.itens } : {}) }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse<SheetsAppendResponse>> {
    // Casa o aviso no grupo com o log da Vercel e o registro da solicitação. Gerado antes de tudo porque a
    // recusa mais precoce (503) também precisa de rastro.
    const requestId = crypto.randomUUID();

    // RF-18/RF-19 · INV-04 — a credencial é conferida ANTES de ler o corpo e antes de qualquer fetch:
    // a porta do bot grava numa planilha que a operação trata como fila de trabalho, então uma
    // requisição bem-formada é trabalho real. Falha fechada: sem env var configurada, ninguém entra
    // (em NENHUM ambiente) — um caminho que abre a porta quando a config falta transforma erro de
    // deploy em endpoint aberto.
    const expectedSecret = process.env.BOT_RESEND_SECRET;
    if (!expectedSecret) {
        console.error('[Reenvio Bot API] Missing BOT_RESEND_SECRET env variable — recusando requisição');
        // O pior modo de falha desta rota: sem a env var, TODA solicitação do bot é recusada e nada
        // registra em lugar nenhum. Um deploy incompleto ficaria assim indefinidamente, com o bot
        // dizendo à cliente que houve erro e ninguém sabendo por quê.
        await avisar({
            reason: 'GATE_CLOSED',
            motivo: 'BOT_RESEND_SECRET ausente do ambiente — o endpoint recusa toda solicitação com 503',
            requestId,
        });
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Endpoint não configurado.', sentToAPI: false },
            { status: 503 }
        );
    }

    const receivedSecret = request.headers.get(BOT_SECRET_HEADER);
    // Mensagem única e opaca de propósito: ausente e errado respondem igual, para a resposta não
    // servir de oráculo de adivinhação (RF-18).
    if (!receivedSecret || !secretMatches(receivedSecret, expectedSecret)) {
        // **Não avisa no Chat de propósito** (ADR-005): quem dispara um 401 é quem está do lado de fora
        // — bot mal configurado ou varredura. Avisar daqui deixaria qualquer um encher o grupo da
        // operação batendo na porta, e o discriminante abaixo já serve à triagem pelo log.
        //
        // Discriminante não sensível de propósito: sem ele, um pico de 401 não distingue "bot mal
        // configurado" de varredura. NUNCA o valor do header.
        console.warn(
            '[Reenvio Bot API] Credencial inválida ou ausente — requisição recusada',
            { header: receivedSecret ? 'presente' : 'ausente', origem: request.headers.get('x-forwarded-for') || 'desconhecida' }
        );
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Não autorizado.', sentToAPI: false },
            { status: 401 }
        );
    }

    // Payload torto é erro DO CLIENTE (400), não falha nossa (500). Separado do catch geral de
    // propósito: um 500 aqui mentiria na mensagem e poluiria a fila de erros de runtime que o time
    // usa para triagem.
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return await recusarPayload('Invalid JSON payload', requestId);
    }

    try {
        const { brand, data } = adaptBotPayload(body);
        const testMode = (body as { testMode?: unknown } | null)?.testMode;

        // RF-12 — a marca é o que determina em qual planilha a linha é gravada; sem ela não há destino.
        if (!brand) {
            return await recusarPayload('Invalid brand: (ausente)', requestId);
        }
        // ADR-015 — as marcas do bot são as que a rota dados lista para o reenvio; fora do ar, as do código.
        const { marcas, fonte } = await marcasDoBot();
        if (!marcas.includes(brand as MarcaCxHub)) {
            const porque = fonte === 'rota-dados' ? 'não está entre as marcas de reenvio da rota dados' : 'marca desconhecida';
            return await recusarPayload(`Invalid brand: ${brand} (${porque})`, requestId);
        }

        // RF-08/RF-17 — se a marcação de teste vier, tem que ser boolean: a string "true" não vira true
        // por acidente (um falso positivo aqui gravaria na aba de produção pensando estar em teste).
        if (testMode !== undefined && typeof testMode !== 'boolean') {
            return await recusarPayload('Invalid testMode: expected boolean', requestId);
        }

        // RF-13 — fora do modo de teste, o número do pedido é obrigatório: o dedup a jusante procura o
        // número na aba de produção e filtra por 24h, então duas solicitações sem número na mesma janela
        // fariam a 2ª voltar DUPLICATE_RESEND em vez de ser registrada. Em modo de teste não há colisão
        // (as linhas vão para a aba de teste, que o dedup não lê).
        if (testMode !== true && !data.numeroPedido) {
            return await recusarPayload(
                'Missing order.ecommerceOrderId: obrigatório fora do modo de teste',
                requestId
            );
        }

        // Reenvio parcial (Portal de Cancelamento): `isFullReshipment: false` exige a lista de itens. A lista
        // vazia é recusada aqui, antes de qualquer chamada ao ERP; o resto da validação precisa do pedido.
        const reshipment = (body as BotResendPayload | null)?.reshipment;
        const parcial = reshipment?.isFullReshipment === false;
        if (parcial && (!Array.isArray(reshipment?.items) || reshipment.items.length === 0)) {
            return await recusarItens(
                'Reenvio parcial sem itens: reshipment.items é obrigatório e não pode ser vazio quando isFullReshipment é false',
                requestId
            );
        }

        // Marca sem Cosmos (ADR-015): só registro, com o pedido da Shopify. Antes do interruptor G8, que existe para
        // poupar o Cosmos — aqui não há Cosmos nem automação a desligar.
        if (ehMarcaSemCosmos(brand)) {
            return await registrarMarcaSemCosmos({ marca: brand, data, body, testMode, parcial, requestId });
        }
        const marca = brand as SupportedBrand;

        // G8 primeiro — desligar a automação tem de custar zero chamada ao ERP.
        const desligado = interruptorDesligado(body);
        if (desligado) {
            return await postarSemAutomacao({ brand: marca, data, testMode, reprovacao: desligado, requestId });
        }

        // ─── Cosmos: token de serviço + pedido real ──────────────────────────────────────────
        // RF-21 — nenhuma credencial de ERP vem do corpo: o `token` é mintado AQUI. Um token vindo do
        // bot seria um segredo do ERP trafegando por um canal que não controlamos.
        let serviceToken: string | undefined;
        let orderData = null;
        // Discrimina as duas causas de propósito: o token só falha por CONFIGURAÇÃO ou ERP fora do ar,
        // e chamar isso de "pedido não encontrado" esconderia o pior modo de falha desta rota — um
        // deploy sem `COSMOS_EMAIL` responderia "pedido não encontrado" para sempre, sem alarme.
        //
        // A distinção também governa o AVISO: pedido não achado é conversa com a cliente (não avisa);
        // ERP inacessível é problema nosso, e já passou pela retentativa automática (avisa).
        let reprovacaoCosmos: Reprovacao = {
            reason: 'ORDER_NOT_FOUND',
            motivo: `Pedido ${data.numeroPedido || '(sem número)'} não foi encontrado no Cosmos — registrado para tratativa manual`,
        };
        // UM prazo para a fase inteira, não um por chamada: o signin e a busca compartilham o mesmo
        // relógio, senão os orçamentos somam e estouram o `maxDuration` (ver `orcamentoFaseCosmos`).
        const deadlineCosmos = Date.now() + orcamentoFaseCosmos();
        try {
            serviceToken = await getCosmosServiceToken(deadlineCosmos);
            orderData = await fetchNormalizedCosmosOrder(marca, data.numeroPedido, serviceToken, deadlineCosmos);
        } catch (cosmosError) {
            console.error(
                '[Reenvio Bot API] Cosmos inacessível (configuração ausente ou ERP fora do ar) — degradando para registro:',
                cosmosError
            );
            serviceToken = undefined;
            orderData = null;
            const causa = cosmosError instanceof Error ? cosmosError.message : 'erro desconhecido';
            reprovacaoCosmos = {
                reason: 'COSMOS_UNAVAILABLE',
                motivo: 'Não foi possível consultar o Cosmos (indisponível ou mal configurado) — registrado para tratativa manual',
                // O que separa "o código desistiu" de "o código nem tentou" — o contorno do ADR-005 §1
                // já rodou aqui, e o card precisa dizer isso para ninguém pedir "tenta de novo".
                tentativas: `retentativa automática esgotada; última falha: ${causa}`,
            };
        }

        // G2 — sem o pedido não há como montar automação alguma: registra o que o bot informou.
        if (!orderData) {
            return await postarSemAutomacao({ brand: marca, data, testMode, reprovacao: reprovacaoCosmos, requestId });
        }

        // Reenvio parcial: cada item tem de existir no pedido, com quantidade até a original. Não conferiu ⇒
        // recusa a lista inteira (ver `recusarItens`), nunca o pedido inteiro no lugar.
        const resolucaoParcial = parcial ? resolvePartialReshipment(orderData.produtos, reshipment?.items) : null;
        if (resolucaoParcial && !resolucaoParcial.ok) {
            return await recusarItens(resolucaoParcial.motivo, requestId);
        }
        const selecaoParcial = resolucaoParcial?.ok ? resolucaoParcial : undefined;
        const itensParciais = selecaoParcial ? { items: selecaoParcial.itens } : {};

        // OQ-06 — o build e as guardas operam sobre dados do **ERP**, que ninguém validou. Uma exceção
        // aqui respondia 500 e **descartava** a solicitação, exatamente o desfecho que o INV-05 proíbe.
        // Degradar é a mesma régua que o caminho do Cosmos já seguia, aplicada ao trecho vizinho.
        let submissionData: ResendSubmissionData;
        let reprovacao: Reprovacao | null;
        try {
            const construido = buildBotResendData({ brand: marca, orderData, botPayload: body, selecaoParcial });
            submissionData = construido.submissionData;
            reprovacao = avaliarGuardas({
                submissionData: construido.submissionData,
                shouldSend: construido.shouldSend,
                motivo: construido.motivo,
                reason: construido.reason,
                botPayload: body,
            });
        } catch (erroDeMontagem) {
            console.error('[Reenvio Bot API] Falha ao montar o reenvio — degradando para registro:', erroDeMontagem);
            const causa = erroDeMontagem instanceof Error ? erroDeMontagem.message : 'erro desconhecido';
            return await postarSemAutomacao({
                brand: marca,
                data,
                testMode,
                reprovacao: {
                    reason: 'INTERNAL_ERROR',
                    motivo: 'Falha inesperada ao montar o reenvio — registrado sem automação',
                    detalhe: causa,
                },
                requestId,
            });
        }

        if (reprovacao) {
            return await postarSemAutomacao({ brand: marca, data: submissionData, testMode, reprovacao, requestId });
        }

        // ─── Caminho executando ──────────────────────────────────────────────────────────────
        const { body: result, status } = await postResendWebhook({
            brand: marca,
            data: submissionData,
            token: serviceToken,
            testMode,
            timeoutMs: tetoWebhookBot(),
            idSolicitacao: requestId,
            prazoFila: prazoDaFila(),
        });
        // ADR-005 §2 — o ERP recusou (SKU sem saldo, transportadora inválida, payload que ele não
        // aceita). A recusa volta sem gravar (OQ-08: no antigo n8n a solicitação evaporava). Reposta sem
        // automação para GARANTIR a linha — a segunda chamada não reexecuta nada, porque é `stripAutomation`
        // que decide o desvio ao ERP.
        if (result.code === 'API_ERROR' && !result.sentToAPI) {
            console.warn('[Reenvio Bot API] ERP recusou o reenvio — garantindo a linha sem automação');
            return await postarSemAutomacao({
                brand: marca,
                data: submissionData,
                testMode,
                reprovacao: {
                    reason: 'ERP_REFUSED',
                    // Sem "nenhuma remessa saiu": o mesmo `API_ERROR` vem quando o Cosmos não responde, e aí a
                    // remessa pode ter saído. O `detalhe` diz qual dos dois foi.
                    motivo: 'O ERP não confirmou o reenvio — registro garantido sem automação',
                    detalhe: result.message || undefined,
                },
                requestId,
            });
        }

        // Linha incerta ou modo de teste violado: o transporte é quem sabe distinguir isso, e mandou o
        // `reason`. Aqui só se avisa — não há o que contornar sem risco de duplicar solicitação (o T4,
        // que faria isso, depende de medir o dedup do n8n). A planilha que falhou já foi avisada por quem a
        // gravou (ADR-010): avisar de novo aqui seria um card repetido.
        if (result.reason && result.reason !== 'SHEET_WRITE_FAILED') {
            await avisar({
                reason: result.reason,
                motivo: result.message || 'Resposta do fluxo não confirmou o registro',
                requestId,
                brand: marca,
                numeroPedido: submissionData.numeroPedido || undefined,
                cosmosId: submissionData.cosmosId || undefined,
                idAtendimento: submissionData.idAtendimento || undefined,
                testMode: testMode === true,
            });
        }

        // T8/RF-30 — o eco do ensaio. O `apiData` nunca chega à planilha, então sem isto o ensaio prova
        // que o caminho roda, mas não que o CONTEÚDO está certo — que é o que se confere a olho antes da
        // primeira remessa real. Só em modo de teste, e só quando havia automação a prever.
        if (testMode === true && submissionData.apiData) {
            return NextResponse.json(
                { ...result, ...itensParciais, apiPreview: { ...submissionData.apiData, valorReenvio: submissionData.valorReenvio } },
                { status }
            );
        }

        return NextResponse.json({ ...result, ...itensParciais }, { status });
    } catch (error) {
        // Rede de segurança final. Depois da degradação da OQ-06 acima, chegar aqui significa falha
        // ANTES de haver marca/pedido para registrar (ex.: `adaptBotPayload` explodindo) — não há linha
        // a gravar, então o que resta é não deixar passar em silêncio.
        console.error('[Reenvio Bot API] Error:', error);
        await avisar({
            reason: 'INTERNAL_ERROR',
            motivo: 'Falha inesperada antes de conseguir registrar a solicitação — nenhuma linha gravada',
            requestId,
            detalhe: error instanceof Error ? error.message : undefined,
        });
        return NextResponse.json(
            { code: 'UNKNOWN_ERROR', message: 'Não foi possível se conectar ao sistema.', sentToAPI: false, reason: 'INTERNAL_ERROR' },
            { status: 500 }
        );
    }
}
