/** Complaint origin options shared across modules */
export const ORIGENS = [
    'Chat Atendimento',
    'Reclame Aqui',
    'Instagram',
    'Tratativas de Logística',
    'Troquecommerce',
    'Vendah',
    'Vendah e Troquecommerce'
];

/** Order status options shared across modules */
export const STATUS_OPTIONS = [
    'Cliente ficou com o pedido',
    'Reversa solicitada (pedido em trânsito)',
    'Pedido não entregue (em trânsito)',
    'Produto avariado/extraviado',
    'Pedido não foi enviado',
];

/**
 * As marcas **com organização no Cosmos** — o pedido, o reenvio automático e as rotas `app/api/cosmos/*` valem só para
 * elas. O nome ficou do tempo em que toda marca do CX Hub estava no Cosmos; a marca que o CX Hub registra é a
 * `MarcaCxHub`, que soma as sem Cosmos (ADR-013).
 */
export type SupportedBrand = 'lescent' | 'kokeshi' | 'bysamia' | 'aua' | 'barbours' | 'rituaria';

/**
 * As marcas **sem organização no Cosmos** (ADR-013, ADR-014): o pedido vem só da Shopify e o CX Hub só **registra** o
 * reenvio e o reembolso, sem executar nada. Nenhuma rota do Cosmos pode ser chamada com elas: as cópias locais do mapa
 * de organizações usam o valor cru quando não acham a marca, e o 401 do Cosmos desloga a agente.
 *
 * A `gobeaute` é o site multimarca (www.gobeaute.com.br): uma loja Shopify com produtos de várias marcas, registrada
 * como marca própria, **sem planilha** (ADR-014) — ver `MarcaComPlanilha`.
 */
export type MarcaSemCosmos = 'apice' | 'yenzah' | 'denavita' | 'gobeaute';

/** Toda marca que o CX Hub registra: as do Cosmos e as sem Cosmos. */
export type MarcaCxHub = SupportedBrand | MarcaSemCosmos;

export const MARCAS_SEM_COSMOS: readonly MarcaSemCosmos[] = ['apice', 'yenzah', 'denavita', 'gobeaute'];

/**
 * As marcas **sem planilha** (ADR-014): o registro é só a fila do Metabase, e o acompanhamento é pela lista do CX Hub
 * e pelo Metabase. Exceção deliberada à regra de que a fila e a planilha andam juntas (ADR-010).
 */
export type MarcaSemPlanilha = 'gobeaute';

/** As marcas cuja solicitação também vai para a planilha da marca (ADR-010): todas, menos as sem planilha. */
export type MarcaComPlanilha = Exclude<MarcaCxHub, MarcaSemPlanilha>;

/** As marcas sem Cosmos que têm planilha (ADR-013): Ápice, Yenzah e Denavita, com layout, Pix e prazo próprios. */
export type MarcaSemCosmosComPlanilha = Exclude<MarcaSemCosmos, MarcaSemPlanilha>;

const MARCAS_SEM_PLANILHA: readonly MarcaSemPlanilha[] = ['gobeaute'];

/** Ápice, Yenzah e Denavita: as sem Cosmos com planilha, layout e chave Pix próprios (ADR-013). */
export const MARCAS_SEM_COSMOS_COM_PLANILHA: readonly MarcaSemCosmosComPlanilha[] = ['apice', 'yenzah', 'denavita'];

/**
 * O reembolso pede a chave Pix da cliente: só nas sem Cosmos com planilha (ADR-013), porque a chave vai **só** para a
 * planilha (nunca para a fila, a gold ou o log). A Gobeaute não tem planilha e não pede (ADR-014).
 */
export function pedeChavePixNoReembolso(marca: string): marca is MarcaSemCosmosComPlanilha {
    return ehMarcaSemCosmosComPlanilha(marca);
}

/**
 * Ápice, Yenzah e Denavita: as sem Cosmos com planilha. São as marcas cujo pedido o servidor confere no Data Mart
 * (NF, CD e valor da NF de reenvio, ADR-018). A Gobeaute, sem Cosmos e sem planilha, fica de fora.
 */
export function ehMarcaSemCosmosComPlanilha(marca: string): marca is MarcaSemCosmosComPlanilha {
    return (MARCAS_SEM_COSMOS_COM_PLANILHA as readonly string[]).includes(marca);
}

/** A solicitação da marca vai também para a planilha (ADR-010). Falso só nas marcas sem planilha (ADR-014). */
export function registraNaPlanilha(marca: string): marca is MarcaComPlanilha {
    return ehMarcaCxHub(marca) && !(MARCAS_SEM_PLANILHA as readonly string[]).includes(marca);
}

/**
 * O sufixo do número do pedido na Shopify (`SH{n}{sufixo}`). A Ápice usa `SH{n}AP` desde 16/09/2026 e `#n` antes
 * disso; a Denavita tem histórico com `#n`. A Denavita é `DN` no pedido, mas `DV` na base consolidada (a sigla da
 * gold fica em `SIGLA_DA_MARCA`). A Gobeaute é `SH{n}GB` desde o primeiro pedido (`SH1001GB`, 2026-11).
 */
export const SUFIXO_DO_PEDIDO: Record<MarcaSemCosmos, string> = {
    apice: 'AP',
    yenzah: 'YE',
    denavita: 'DN',
    gobeaute: 'GB',
};

/**
 * Marca → ID da organização no Cosmos.
 *
 * Canônico: é este o mapa que o código novo consome. As cópias locais que existem nas rotas de
 * `app/api/cosmos/*` e em `postResendWebhook` são anteriores a ele e seguem valendo — trocá-las é
 * refatoração própria, fora da fatia que criou este export.
 */
export const BRAND_TO_ORG_ID: Record<SupportedBrand, string> = {
    lescent: '3',
    kokeshi: '4',
    bysamia: '5',
    aua: '6',
    barbours: '8',
    rituaria: '9',
};

/** A marca tem organização no Cosmos (e, portanto, pedido, reenvio automático e cancelamento por lá). */
export function temOrganizacaoNoCosmos(marca: string): marca is SupportedBrand {
    return Object.prototype.hasOwnProperty.call(BRAND_TO_ORG_ID, marca);
}

/** A marca é do CX Hub, mas não está no Cosmos: o pedido vem só da Shopify (ADR-013). */
export function ehMarcaSemCosmos(marca: string): marca is MarcaSemCosmos {
    return (MARCAS_SEM_COSMOS as readonly string[]).includes(marca);
}

/** Qualquer marca que o CX Hub registra. */
export function ehMarcaCxHub(marca: string): marca is MarcaCxHub {
    return temOrganizacaoNoCosmos(marca) || ehMarcaSemCosmos(marca);
}

/** Display name → API brand mapping */
export const BRAND_DISPLAY_MAP: Record<string, MarcaCxHub> = {
    'Lescent': 'lescent',
    'Kokeshi': 'kokeshi',
    'BySamia': 'bysamia',
    'Auá': 'aua',
    'Barbours': 'barbours',
    'Rituária': 'rituaria',
    'Ápice': 'apice',
    'Yenzah': 'yenzah',
    'Denavita': 'denavita',
    'Gobeaute': 'gobeaute',
};

/** UF abbreviation → full state name (payload da logística; o "Rio de Janeiro (RJ)" das planilhas das marcas sem Cosmos) */
export const UF_TO_STATE_NAME: Record<string, string> = {
    AC: 'Acre',
    AL: 'Alagoas',
    AP: 'Amapá',
    AM: 'Amazonas',
    BA: 'Bahia',
    CE: 'Ceará',
    DF: 'Distrito Federal',
    ES: 'Espírito Santo',
    GO: 'Goiás',
    MA: 'Maranhão',
    MT: 'Mato Grosso',
    MS: 'Mato Grosso do Sul',
    MG: 'Minas Gerais',
    PA: 'Pará',
    PB: 'Paraíba',
    PR: 'Paraná',
    PE: 'Pernambuco',
    PI: 'Piauí',
    RJ: 'Rio de Janeiro',
    RN: 'Rio Grande do Norte',
    RS: 'Rio Grande do Sul',
    RO: 'Rondônia',
    RR: 'Roraima',
    SC: 'Santa Catarina',
    SP: 'São Paulo',
    SE: 'Sergipe',
    TO: 'Tocantins',
};

/** API brand → display name mapping */
export const BRAND_API_TO_DISPLAY: Record<string, string> = {
    'lescent': 'Lescent',
    'kokeshi': 'Kokeshi',
    'bysamia': 'BySamia',
    'aua': 'Auá',
    'barbours': 'Barbours',
    'rituaria': 'Rituária',
    'apice': 'Ápice',
    'yenzah': 'Yenzah',
    'denavita': 'Denavita',
    'gobeaute': 'Gobeaute',
};
