// Google Sheets related types

// `import type` de propósito: `@shared/lib/alerts` é server-only (lê env var, faz fetch), e este
// arquivo de tipos é importado pelo cliente via `submitResend`. Tipo é apagado na compilação.
import type { AlertReason } from '../../../shared/lib/alerts/types';
import type { ItemReenviado } from '../../../shared/lib/datamart/pedidoTipos';

/**
 * Dados de submissão de reenvio para a planilha do Google Sheets
 * Campos extraídos dos nodes n8n de cada marca
 */
export interface ResendSubmissionData {
    // Timestamps
    timestamp: string;               // Carimbo de data/hora
    dataSolicitacao: string;         // Data solicitação

    // Data de criação do pedido
    data_criacao: string;            // Data de criação do pedido (dd/mm/aaaa)

    // Dados do formulário
    tipoSolicitacao: string;         // Tipo de solicitação
    responsavel: string;             // Responsável
    origemReclamacao: string;        // Origem da Reclamação
    idAtendimento: string;           // ID do atendimento
    cdOrigem: string;                // CD de Origem

    // Dados do cliente
    nomeCliente: string;             // Nome do(a) cliente
    telefoneCliente: string;         // Número de telefone da cliente
    enderecoCliente: string;         // Endereço do cliente
    cep: string;                     // CEP
    estado: string;                  // Estado

    // Dados do pedido
    numeroPedido: string;            // Número do pedido (Shopify)
    numeroNF: string;                // Número da NF
    chaveNF: string;                 // Chave da NF
    cosmosId: string;                // ID do pedido no Cosmos

    // Produtos
    produtoComProblema: string;      // Qual produto apresentou problema?
    produtoReenviar: string;         // Qual produto deve ser reenviado?
    loteProduto: string;             // Lote do Produto
    problemaProduto: string;         // Qual foi o problema do produto?

    // Transportadora e reenvio
    transportadoraOriginal: string;  // Transportadora do pedido original
    transportadoraReenvio: string;   // Qual deve ser a transportadora do reenvio?
    devolucao: string;               // Pedido será devolvido para a operação?
    ticketTransportadora: string;    // ID do Ticket com a transportadora

    // Status
    statusPedido: string;            // Status do Pedido
    ReenvioCompleto: string;         // Reenvio Completo
    valorReenvio: string;            // Valor de Reenvio (valor ou '' se shouldSendToAPI=false)

    // Campos calculados baseados em shouldSendToAPI
    // Preenchidos apenas quando shouldSendToAPI=true
    status: string;                  // 'Realizado' ou ''
    codNfd: string;                  // 'Pendente' ou ''
    automacao: string;               // 'Automação' ou ''
    erp: string;                     // 'Protheus' ou '' (usado apenas para Barbours)

    // Observações
    comentarios: string;             // COMENTÁRIOS GERAIS

    /**
     * Só nas marcas sem Cosmos com planilha (ADR-018): os itens do pedido que vão no reenvio, como foram marcados (o kit
     * ou o componente), **antes** da troca e sem os mimos. É a base do "Valor da NF de reenvio (R$)" que o servidor
     * calcula: o `produtoReenviar` já chega com o substituto e o mimo somados por SKU, e dele não dá para separar o
     * original. Opcional: sem a lista (a Central de Tickets, por enquanto), o servidor lê o `produtoReenviar` quando os
     * comentários não têm mimo nem troca, e deixa o valor em branco quando têm.
     */
    itensOriginaisReenviados?: ItemReenviado[];

    // === Dados estruturados para a API Cosmos (usados pelo n8n no nó de resend) ===
    // Preenchidos apenas quando shouldSendToAPI=true
    apiData?: {
        carrierId: number;              // ID da transportadora no Cosmos
        carrierServiceName: string;     // Nome do serviço da transportadora
        shippingCost: string;           // Custo de frete do pedido original
        discountAmount: string;         // Valor de desconto do pedido original
        resendProducts: Array<{         // Produtos a serem reenviados
            product_id: number;
            quantity: number;
            unit_price: string;
        }>;
        shippingAddress: {              // Endereço de entrega (campos separados)
            street: string;
            number: string;
            complement: string;
            neighborhood: string;
            city: string;
            state: string;
            postal_code: string;
        };
    };
}

/**
 * Códigos padronizados retornados pelo webhook n8n
 */
export type WebhookResponseCode =
    | 'SUCCESS'
    | 'SUCCESS_SHEETS_ONLY'
    /** Modo de teste: a linha foi para a aba TESTE e NENHUM reenvio foi executado no Cosmos (INV-02) */
    | 'SUCCESS_TEST_MODE'
    | 'SHEETS_ERROR'
    | 'API_ERROR'
    | 'API_TIMEOUT'
    | 'DUPLICATE_RESEND'
    | 'OUT_OF_STOCK'
    /** Reenvio parcial recusado pela rota do bot: itens não conferem com o pedido (nada foi gravado) */
    | 'INVALID_ITEMS'
    | 'UNKNOWN_ERROR';

/**
 * Eco do que iria ao Cosmos — devolvido APENAS em modo de teste (RF-30).
 *
 * O `apiData` nunca chega à planilha: a linha mostra que a automação seria acionada, não o que seria
 * despachado. Sem este eco o ensaio prova que o caminho roda, mas não que o conteúdo está certo — que é
 * justamente o que se confere antes da primeira remessa real.
 */
export interface ResendApiPreview {
    carrierId: number;
    carrierServiceName: string;
    shippingCost: string;
    discountAmount: string;
    /** Valor calculado do reenvio (mesmo valor que vai para a coluna da planilha) */
    valorReenvio: string;
    resendProducts: Array<{
        product_id: number;
        quantity: number;
        unit_price: string;
    }>;
    shippingAddress: {
        street: string;
        number: string;
        complement: string;
        neighborhood: string;
        city: string;
        state: string;
        postal_code: string;
    };
}

/**
 * Resposta padronizada do webhook n8n (via API route /api/sheets/append)
 */
export interface SheetsAppendResponse {
    code: WebhookResponseCode;
    message: string;
    sentToAPI: boolean;
    /** Só em modo de teste, e só quando a automação foi preenchida (RF-30) */
    apiPreview?: ResendApiPreview;
    /** Reenvio parcial (rota do bot): os itens que foram no reenvio, para o portal conferir */
    items?: Array<{ sku: string; quantity: number }>;
    /**
     * Por que não executou, em forma que **máquina** consegue ramificar (ADR-005).
     *
     * O `message` continua sendo a mesma frase em português de sempre — este campo é **aditivo**, e
     * existe porque o bot não pode decidir com base em prosa: "endereço novo incompleto" pede que ele
     * volte e pergunte à cliente, "pedido não encontrado" pede escalada. Antes disso, as duas chegavam
     * como texto no mesmo `SUCCESS_SHEETS_ONLY`.
     *
     * Ausente no caminho de sucesso e no fluxo da tela (lá quem lê é um agente).
     */
    reason?: AlertReason;
    /**
     * O caso que foi à fila do Metabase (ADR-012): a lista acompanha por ele quando a raw o recebe ("Gravado no
     * Metabase"). Vem sempre que a planilha foi tentada (sucesso, `SHEET_WRITE_FAILED` e `ROW_UNCERTAIN`).
     */
    idSolicitacao?: string;
}

/**
 * Marcas suportadas para o builder de rows
 * Re-exported from shared — canonical definition in @shared/lib/constants
 */
export type { MarcaCxHub, SupportedBrand } from '../../../shared/lib/constants';

/**
 * Produto selecionado para reenvio (item adicional)
 */
export interface SelectedProduct {
    id: number;
    sku: string;
    name: string;
    price: string;
    is_kit: boolean;
    isGift: boolean;
    quantidade: number;
}
