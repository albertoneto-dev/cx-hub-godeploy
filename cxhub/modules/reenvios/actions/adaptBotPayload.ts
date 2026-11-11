import type { ResendSubmissionData } from '../types/sheets';

/**
 * Tradutor do payload do bot de atendimento (Typebot) para o formato de registro de reenvio.
 *
 * Duas garantias estruturais moram aqui:
 * - **Sheets-only (INV-03):** nunca preenche `automacao`/`status`/`codNfd`/`erp`/`valorReenvio` nem monta
 *   `apiData`. É isso que torna o desvio para o Cosmos INALCANÇÁVEL a jusante — o nó de decisão do n8n só
 *   desvia com `automacao` não-vazia. A garantia não depende de o bot mandar marcação alguma.
 * - **Toda chave sempre presente (RF-14):** o nó `Data` do n8n faz `.replace()` cru em `timestamp` e
 *   `numeroPedido`; campo ausente derrubaria a execução e NENHUMA linha seria gravada. Campo opcional para
 *   o bot ⇒ string vazia aqui, nunca `undefined`.
 */

/** Payload aninhado em inglês que o bot monta. Todo campo é opcional exceto `brand`. */
export interface BotResendPayload {
    brand?: string;
    testMode?: boolean;
    /** ID da solicitação no Portal de Cancelamento — vai para as observações da linha (rastreio) */
    externalRequestId?: string | null;
    handledBy?: string;
    sourceChannel?: string;
    supportTicketId?: string;
    notes?: string | null;
    customer?: { name?: string | null } | null;
    order?: {
        ecommerceOrderId?: string | null;
        invoiceNumber?: string | null;
        invoiceKey?: string | null;
        batchNumber?: string | null;
        originWarehouse?: string | null;
        orderStatus?: string | null;
    } | null;
    reshipment?: {
        isFullReshipment?: boolean | null;
        requiresReturn?: boolean | null;
        reason?: string | null;
        problemItems?: Array<{ sku?: string | null; quantity?: number | null }> | null;
        reshipmentItems?: Array<{ sku?: string | null; quantity?: number | null }> | null;
        /** Reenvio parcial (`isFullReshipment: false`): os itens que vão. Validados contra o pedido na rota. */
        items?: Array<{ sku?: string | null; quantity?: number | null; lineItemId?: number | null }> | null;
        /** Reenvio parcial: os itens que saem — só histórico, vão para as observações */
        removedItems?: Array<{ sku?: string | null; quantity?: number | null; lineItemId?: number | null }> | null;
        carrier?: { name?: string | null } | null;
    } | null;
    addressChange?: {
        enabled?: boolean | null;
        address?: {
            street?: string | null;
            number?: string | null;
            complement?: string | null;
            district?: string | null;
            city?: string | null;
            state?: string | null;
            postalCode?: string | null;
        } | null;
    } | null;
    return?: { carrierName?: string | null; carrierTicketId?: string | null } | null;
}

export interface AdaptBotPayloadResult {
    brand: string;
    data: ResendSubmissionData;
}

/**
 * Aliases dos enums do Typebot → valores canônicos de `shared/lib/constants`.
 *
 * Só os aliases CONFIRMADOS entram aqui (OQ-01 em docs/open-questions.md: a lista completa do Typebot
 * ainda não foi fornecida). Valor não reconhecido faz **passthrough** do valor cru (RF-15) — a linha
 * ainda serve e o dado não se perde. Completar o mapa quando a QA confirmar os nomes.
 */
const SOURCE_CHANNEL_ALIASES: Record<string, string> = {
    CHAT_ATENDIMENTO: 'Chat Atendimento',
};

const ORDER_STATUS_ALIASES: Record<string, string> = {
    NOT_SHIPPED: 'Pedido não foi enviado',
};

/** Texto: nulo/ausente ⇒ '' (RF-14). Nunca devolve `undefined`. */
function text(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
}

/** Booleano do bot → 'Sim'/'Não' da planilha. Ausente ⇒ ''. */
function simNao(value: unknown): string {
    if (value === true) return 'Sim';
    if (value === false) return 'Não';
    return '';
}

/** Traduz um enum conhecido; passthrough do valor cru quando não reconhecido (RF-15). */
function translateEnum(value: unknown, aliases: Record<string, string>): string {
    const raw = text(value);
    return aliases[raw] ?? raw;
}

/** SKUs unidos por `;` — o formato que o builder de linha do n8n já espera. */
function joinSkus(items: Array<{ sku?: string | null }> | null | undefined): string {
    if (!Array.isArray(items)) return '';
    return items.map((item) => text(item?.sku)).filter(Boolean).join(';');
}

/** `"<sku> - <quantity>"` unidos por `;` — mesmo formato do fluxo da UI. */
function joinSkusComQuantidade(
    items: Array<{ sku?: string | null; quantity?: number | null }> | null | undefined
): string {
    if (!Array.isArray(items)) return '';
    return items
        .map((item) => {
            const sku = text(item?.sku);
            if (!sku) return '';
            const quantidade = text(item?.quantity);
            return quantidade ? `${sku} - ${quantidade}` : sku;
        })
        .filter(Boolean)
        .join(';');
}

/**
 * Endereço de troca → uma linha só. Só vale quando `addressChange.enabled` é true: endereço desligado
 * não deve vazar para a célula. Segmentos vazios são descartados para não sobrar vírgula solta.
 */
function formatAddressChange(
    addressChange: BotResendPayload['addressChange']
): { endereco: string; estado: string; cep: string } {
    if (addressChange?.enabled !== true) {
        return { endereco: '', estado: '', cep: '' };
    }

    const address = addressChange.address ?? {};
    const cidade = text(address.city);
    const estado = text(address.state);
    const cidadeEstado = cidade && estado ? `${cidade}/${estado}` : cidade || estado;

    const endereco = [
        text(address.street),
        text(address.number),
        text(address.complement),
        text(address.district),
        cidadeEstado,
    ]
        .filter(Boolean)
        .join(', ');

    return { endereco, estado, cep: text(address.postalCode) };
}

/**
 * Traduz o payload do bot em `{ brand, data }` com o `ResendSubmissionData` COMPLETO — toda chave
 * presente e string. Função pura: sem I/O, sem consulta ao Cosmos/Shopify.
 */
export function adaptBotPayload(body: unknown): AdaptBotPayloadResult {
    const payload = (body ?? {}) as BotResendPayload;

    const order = payload.order ?? {};
    const reshipment = payload.reshipment ?? {};
    const devolucaoInfo = payload.return ?? {};
    const { endereco, estado, cep } = formatAddressChange(payload.addressChange);

    // RF-16 — o carimbo é a 1ª coluna e o campo que o dedup usa para decidir se a linha é recente;
    // o bot não o manda, então é gerado aqui, na mesma convenção do fluxo da UI.
    const now = new Date();
    const timestamp = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const dataSolicitacao = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const data: ResendSubmissionData = {
        timestamp,
        dataSolicitacao,

        // O payload do bot não carrega estes dados (OQ-02) — célula vazia é comportamento válido (RF-14)
        data_criacao: '',
        tipoSolicitacao: '',
        telefoneCliente: '',
        cosmosId: '',

        // O CEP existe só quando há troca de endereço — no caminho sem troca quem tem o CEP é o pedido,
        // e é o `buildSubmissionData` que o preenche. Endereço desligado não vaza para a célula.
        cep,

        responsavel: text(payload.handledBy),
        origemReclamacao: translateEnum(payload.sourceChannel, SOURCE_CHANNEL_ALIASES),
        idAtendimento: text(payload.supportTicketId),
        cdOrigem: text(order.originWarehouse),

        nomeCliente: text(payload.customer?.name),
        enderecoCliente: endereco,
        estado,

        numeroPedido: text(order.ecommerceOrderId),
        numeroNF: text(order.invoiceNumber),
        chaveNF: text(order.invoiceKey),

        produtoComProblema: joinSkus(reshipment.problemItems),
        // Reenvio parcial manda `items`; o bot de extravio manda `reshipmentItems`. Mesmo papel na linha.
        produtoReenviar: joinSkusComQuantidade(reshipment.items ?? reshipment.reshipmentItems),
        loteProduto: text(order.batchNumber),
        problemaProduto: text(reshipment.reason),

        transportadoraOriginal: text(devolucaoInfo.carrierName),
        transportadoraReenvio: text(reshipment.carrier?.name),
        devolucao: simNao(reshipment.requiresReturn),
        ticketTransportadora: text(devolucaoInfo.carrierTicketId),

        statusPedido: translateEnum(order.orderStatus, ORDER_STATUS_ALIASES),
        ReenvioCompleto: simNao(reshipment.isFullReshipment),

        // Sheets-only (INV-03/RF-11): campos de automação SEMPRE vazios, e nenhum `apiData`.
        // É o que torna o nó do Cosmos inalcançável a jusante — não mexer sem um plano próprio.
        valorReenvio: '',
        status: '',
        codNfd: '',
        automacao: '',
        erp: '',

        comentarios: [
            text(payload.notes),
            Array.isArray(reshipment.removedItems) && reshipment.removedItems.length > 0
                ? `Itens removidos: ${joinSkusComQuantidade(reshipment.removedItems)}`
                : '',
            text(payload.externalRequestId) ? `Portal: ${text(payload.externalRequestId)}` : '',
        ].filter(Boolean).join(' | '),
    };

    return { brand: text(payload.brand), data };
}
