/**
 * Tipos do aviso de erro acionável (ADR-005).
 *
 * O `AlertReason` tem **dois consumidores de propósito**: é o que classifica o aviso no grupo do Google
 * Chat **e** o que a resposta da rota do bot devolve no campo `reason`. Um enum só, porque as duas
 * perguntas são a mesma — *"por que isto não executou?"* — e duas listas divergiriam na primeira causa
 * nova que alguém acrescentasse só de um lado.
 */

/**
 * Por que a solicitação não executou. Nomes estáveis: o Typebot ramifica em cima deles, então mudar
 * um valor é mudança de contrato (ver `docs/qa-reenvio-bot.md`).
 */
export type AlertReason =
    /** A porta está fechada: `BOT_RESEND_SECRET` ausente do ambiente ⇒ 503 para tudo */
    | 'GATE_CLOSED'
    /** Corpo torto (marca inválida, `testMode` não-boolean, sem número do pedido) — a solicitação é descartada */
    | 'INVALID_PAYLOAD'
    /** Reenvio parcial com itens que não conferem com o pedido (ou lista vazia) — recusado, nenhuma linha gravada */
    | 'INVALID_ITEMS'
    /** ERP inacessível ou mal configurado, **depois** de esgotadas as retentativas */
    | 'COSMOS_UNAVAILABLE'
    /**
     * Marca sem Cosmos (ADR-015): o integrations-gateway não respondeu ou está mal configurado — a solicitação foi
     * registrada com o que o bot informou, sem os dados do pedido
     */
    | 'SHOPIFY_UNAVAILABLE'
    /** O pedido não foi achado no Cosmos, ou na Shopify nas marcas sem Cosmos (número errado, pedido de outra marca) */
    | 'ORDER_NOT_FOUND'
    /** `shouldSendToAPI` reprovou (pedido Shopify, só brindes) */
    | 'NOT_ELIGIBLE'
    /** Nome de transportadora fora do `CARRIER_MAP` **e** pedido sem identificador do Cosmos */
    | 'CARRIER_UNRESOLVED'
    /** O `apiData` não foi montado a partir do pedido */
    | 'AUTOMATION_DATA_MISSING'
    /** `carrierId` ausente no corpo que iria ao ERP */
    | 'CARRIER_ID_MISSING'
    /** Nenhum item de reenvio resolvido */
    | 'NO_RESEND_ITEMS'
    /** Item com `product_id: 0` — SKU sem cadastro no Cosmos */
    | 'PRODUCT_ID_MISSING'
    /** O endereço do próprio pedido está sem CEP */
    | 'ORDER_ADDRESS_NO_CEP'
    /** Troca de endereço pedida com campo(s) faltando (G5b) */
    | 'NEW_ADDRESS_INCOMPLETE'
    /** Troca de endereço com CEP que não tem 8 dígitos (G5b) */
    | 'NEW_ADDRESS_CEP_INVALID'
    /** Interruptor de emergência: `BOT_RESEND_EXECUTE=off` ou `"executeResend": false` */
    | 'AUTOMATION_OFF'
    /** Exceção inesperada no nosso código (OQ-06) — degradada para registro em vez de 500 */
    | 'INTERNAL_ERROR'
    /**
     * O ERP recusou o reenvio, ou o Cosmos não respondeu (aí a remessa PODE ter saído); o registro foi garantido
     * pelo CXHub sem automação (ADR-005 §2)
     */
    | 'ERP_REFUSED'
    /** Resposta do n8n ilegível ou estourada, ou run do Airflow sem desfecho: **o registro pode não existir** */
    | 'ROW_UNCERTAIN'
    /**
     * Backend direto (ADR-008): a raw de eventos não pôde ser lida para o dedup, ou o Airflow recusou o registro
     * (DAG pausada ou fora do ar, contrato). O registro **com certeza não** foi feito — o `sentToAPI` diz se a
     * remessa saiu.
     */
    | 'RECORD_UNAVAILABLE'
    /** Pedido em modo de teste recebeu resposta de fluxo real — INV-02 violado */
    | 'TEST_MODE_VIOLATION'
    /**
     * Um cancelamento ou edição foi feito, mas a atualização da gold falhou de vez (Metabase ou Airflow).
     * Só existe no aviso: roda depois da resposta.
     */
    | 'GOLD_UPDATE_FAILED'
    /** A alteração foi feita, mas nenhum caso do CX Hub na gold casou com o pedido. Só no aviso. */
    | 'GOLD_UPDATE_NO_CASE'
    /**
     * ADR-010: a solicitação ficou registrada na gold (Metabase), mas a linha não chegou à planilha da marca. O
     * agente **não deve repetir** — a linha completa está no log da Vercel, para repor à mão.
     */
    | 'SHEET_WRITE_FAILED'
    /**
     * Gestão do reembolso (ADR-010): a linha do caso não está na planilha da marca (nenhuma linha com o pedido e um
     * carimbo a até 2 min do `criado_em`: solicitação aberta antes de o CX Hub gravar a linha, ou carimbo mexido), então
     * cancelar, editar, concluir ou sincronizar não tem onde escrever ou ler. A gold, quando já mudou, não volta atrás.
     * Só no aviso, agrupado por marca.
     */
    | 'SHEET_ROW_NOT_FOUND';

/**
 * `nenhuma` não é "erro sem gravidade" — é **erro que não é do time**. Falha de dado da cliente volta
 * ao bot pelo `reason` para ele perguntar de novo; mandá-la ao grupo trocaria uma correção automática
 * por trabalho humano, e o ruído dessensibilizaria quem lê (ADR-005 §3).
 */
export type AlertSeverity = 'critica' | 'alta' | 'media' | 'nenhuma';

export interface AlertPolicy {
    severidade: AlertSeverity;
    /** Uma linha que diz o que aconteceu, sem jargão — é o título do card */
    titulo: string;
    /** O que a pessoa que lê no grupo deve FAZER. É isto que impede o card de ser genérico. */
    acao: string;
    /**
     * `true` = causa **sistêmica**: um card por janela basta (100 pedidos degradando pela mesma
     * transportadora fora do mapa é **um** problema, não 100).
     * `false` = cada pedido é individualmente acionável, então a janela agrupa só a repetição do
     * **mesmo** pedido.
     */
    agrupar: boolean;
}

/**
 * O que o card pode carregar. **Deliberadamente sem PII**: nome, telefone e endereço da cliente não
 * têm campo aqui, porque o espaço do Chat tem membros fora do time do CXHub e o número do pedido já
 * basta para achar a linha (ADR-005 §5).
 */
export interface AlertContext {
    reason: AlertReason;
    /** O motivo em português que a rota já produz — vai ao card como veio */
    motivo: string;
    /** Casa o card com o log da Vercel e o registro (a linha da planilha, ou o run `cxhub__<id>` no Airflow) */
    requestId: string;
    brand?: string;
    numeroPedido?: string;
    cosmosId?: string;
    idAtendimento?: string;
    /** Ensaio não pode parecer incidente real */
    testMode?: boolean;
    /** O que o código já tentou antes de desistir (ADR-005 §1) */
    tentativas?: string;
    /** Detalhe técnico: nome da transportadora, erro do ERP, SKU sem cadastro */
    detalhe?: string;
    /**
     * Complemento da chave de agrupamento de uma causa **sistêmica** (`agrupar: true`): a causa continua agrupada
     * por janela, mas um card por valor distinto — por exemplo, uma marca por vez. Sem ele, a 1ª marca com o
     * problema calaria o aviso de todas as outras. Valor de cardinalidade pequena e fixa (nunca um id de pedido).
     */
    agruparPor?: string;
}
