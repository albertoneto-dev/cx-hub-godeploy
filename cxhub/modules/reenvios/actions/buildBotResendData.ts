import type { NormalizedOrder } from '../../../shared/types/index';
import type { MarcaCxHub, ResendSubmissionData } from '../types/sheets';
import type { Step1FormData, Step2Data } from '../types/resend';
import { BRAND_API_TO_DISPLAY } from '../../../shared/lib/constants';
import { adaptBotPayload, type BotResendPayload } from './adaptBotPayload';
import { buildSubmissionData, type BuildSubmissionDataResult } from './buildSubmissionData';
import { resolveCarrierLoose } from './carrierMap';

/**
 * Monta o reenvio COMPLETO a partir do pedido real, para o caminho do bot — o que a UI monta com um
 * agente clicando, aqui é derivado do pedido.
 *
 * O caso de uso é o **extravio**: não há escolha de itens, o reenvio é o pedido inteiro. Por isso todos
 * os produtos de topo entram como problema E como reenvio, sem quantidade escolhida a mão (cai na
 * quantidade do ERP).
 *
 * Ele NÃO reimplementa a linha nem o `apiData`: sintetiza o `Step1FormData`/`Step2Data` que a UI
 * produziria e delega ao `buildSubmissionData` canônico. Reimplementar divergiria da UI justamente nos
 * campos que disparam a automação.
 *
 * Onde o bot também tem o dado (responsável, motivo, ID do atendimento, observações, lote e
 * transportadora), o valor do BOT prevalece (RF-11b): quem conversou com a cliente apurou o caso; o
 * pedido só descreve o que foi vendido.
 */

export interface BuildBotResendDataInput {
    /**
     * Marca sem Cosmos (ADR-015): o pedido veio da Shopify, o mapa de transportadoras não tem a marca e o
     * `buildSubmissionData` não monta `apiData` — a linha sai só para registro.
     */
    brand: MarcaCxHub;
    orderData: NormalizedOrder;
    /** Corpo cru do bot (mesmo shape de `BotResendPayload`) */
    botPayload: unknown;
    /**
     * Reenvio parcial: a seleção já validada contra o pedido (`resolvePartialReshipment`). Ausente ⇒ o
     * reenvio é o pedido inteiro, que é o caso de extravio.
     */
    selecaoParcial?: { produtosReenviar: string[]; quantidadesReenviar: Record<string, number> };
}

/** Colunas que ligam a automação a jusante — o nó de decisão do n8n só desvia com `automacao` cheia. */
const CAMPOS_DE_AUTOMACAO = ['valorReenvio', 'status', 'codNfd', 'automacao', 'erp'] as const;

export function buildBotResendData(input: BuildBotResendDataInput): BuildSubmissionDataResult {
    const { brand, orderData, selecaoParcial } = input;
    const payload = (input.botPayload ?? {}) as BotResendPayload;

    // Reuso do tradutor do bot: ele já normaliza enum, booleano e nulo→'' (RF-14/RF-15). Aqui ele
    // serve como a FONTE DO LADO DO BOT, não mais como o caminho inteiro.
    const { data: botData } = adaptBotPayload(payload);

    const produtosDoPedido = orderData.produtos.map(p => p.id);

    // A transportadora do bot tem precedência; sem ela, a do pedido. Em ambos os casos o nome passa
    // pelo casamento tolerante, porque nem o bot nem o Cosmos falam o vocabulário do dropdown.
    const nomeTransportadora = botData.transportadoraReenvio || orderData.transportadora || '';
    const carrierMatch = resolveCarrierLoose(brand, nomeTransportadora);

    // Nome fora do mapa não é motivo suficiente para desistir: o pedido real traz o id que o **próprio
    // Cosmos** atribuiu à transportadora daquela remessa (`adapter.ts` ← `order.carrier.id`). Usar esse id
    // não é chutar — é reenviar pela mesma transportadora que já levou o pedido, que é exatamente o que o
    // caso de extravio quer. O mapa nome→id é vocabulário da UI; o ERP fala o dele ('Anjun Express').
    //
    // Exige o PAR completo (id + service_name), e a razão é assimetria de estrago: quando o Cosmos recusa
    // o reenvio, o nó do n8n desvia pela saída de erro e a linha NÃO é gravada — a solicitação se perde,
    // que é o único desfecho que esta rota não pode ter (INV-05). Degradar com o par incompleto custa uma
    // fila humana; tentar e ser recusado custa a solicitação inteira.
    const carrierFallback = !carrierMatch && orderData.carrierId && orderData.carrierServiceName
        ? { serviceName: orderData.carrierServiceName, carrierId: orderData.carrierId }
        : undefined;

    const trocaEndereco = payload.addressChange?.enabled === true;
    const enderecoBot = payload.addressChange?.address ?? {};

    const formData: Step1FormData = {
        responsavel: botData.responsavel,
        tipoSolicitacao: 'reenvio',
        origemReclamacao: botData.origemReclamacao,
        idAtendimento: botData.idAtendimento,
        marca: BRAND_API_TO_DISPLAY[brand] || brand,
        numeroPedido: botData.numeroPedido,
    };

    const step2Data: Step2Data = {
        solicitarCancelamento: false,
        alterarEndereco: trocaEndereco,
        // Reenvio completo: todos os produtos de topo, sem quantidade escolhida a mão. Parcial: só o que o
        // portal mandou, com a quantidade dele.
        produtosComProblema: selecaoParcial?.produtosReenviar ?? produtosDoPedido,
        produtosReenviar: selecaoParcial?.produtosReenviar ?? produtosDoPedido,
        quantidadesReenviar: selecaoParcial?.quantidadesReenviar ?? {},
        itemDiferente: false,
        itensAdicionais: [],
        substituicoes: {},
        loteProduto: botData.loteProduto,
        problemaProduto: botData.problemaProduto,
        devolucao: botData.devolucao === 'Sim' ? 'sim' : 'nao',
        novoEndereco: {
            logradouro: str(enderecoBot.street),
            numero: str(enderecoBot.number),
            complemento: str(enderecoBot.complement),
            bairro: str(enderecoBot.district),
            cidade: str(enderecoBot.city),
            estado: str(enderecoBot.state),
            // Uma linha, dois destinos: o `buildSubmissionData` leva este valor para a coluna `cep` da
            // planilha E para `apiData.shippingAddress.postal_code`. Vai **como o bot mandou** — o Cosmos
            // normaliza removendo não-dígitos (Confluence §3.2), então não há nada a converter aqui.
            // Formato ilegível ou ausente não é decidido aqui: quem reprova é a guarda da rota.
            cep: str(enderecoBot.postalCode),
        },
        statusPedido: botData.statusPedido,
        ticketTransportadora: botData.ticketTransportadora,
        // A coluna recebe a chave canônica quando o nome foi reconhecido; senão o nome cru, para a
        // linha ainda dizer a um humano o que o bot/pedido informou.
        transportadoraReenvio: carrierMatch ? carrierMatch.carrierName : nomeTransportadora,
        observacoes: botData.comentarios,
        ReenvioCompleto: selecaoParcial ? 'nao' : 'sim',
        numeroNFManual: botData.numeroNF,
        chaveNFManual: botData.chaveNF,
    };

    const result = buildSubmissionData({ formData, step2Data, orderData, carrierFallback });

    // A regra de elegibilidade do reenvio (`shouldSendToAPI`) não olha transportadora — na UI o
    // agente escolhe de um dropdown, então ela sempre resolve. No caminho do bot o nome vem do ERP e
    // pode não casar; sem esta barra, a linha sairia com automação cheia e SEM `apiData`.
    //
    // Só degrada quando não sobrou id em lugar nenhum — nem no mapa, nem no pedido. Aí a dúvida é real
    // (INV-05): transportadora é para onde a caixa vai fisicamente, e não há agente conferindo.
    if (!carrierMatch && !carrierFallback && result.shouldSend) {
        return {
            ...result,
            submissionData: stripAutomation(result.submissionData),
            shouldSend: false,
            motivo: `Transportadora "${nomeTransportadora || '(ausente)'}" não foi reconhecida no mapa da marca ${brand} e o pedido não trouxe ID de transportadora`,
            reason: 'CARRIER_UNRESOLVED',
        };
    }

    return result;
}

/**
 * Devolve uma cópia da linha SEM automação — é o "degrada para só registro" das guardas: a
 * solicitação continua existindo na planilha para um humano, e o desvio para o ERP fica inalcançável.
 */
export function stripAutomation(data: ResendSubmissionData): ResendSubmissionData {
    const copia: ResendSubmissionData = { ...data };
    CAMPOS_DE_AUTOMACAO.forEach(campo => { copia[campo] = ''; });
    delete copia.apiData;
    return copia;
}

function str(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
}
