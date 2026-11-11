/**
 * Mapa de transportadoras por marca.
 * Para cada marca, mapeia o nome da transportadora de reenvio
 * para [service_name, carrier_id] usados na API Cosmos.
 */

type CarrierInfo = [serviceName: string, carrierId: number];

const CARRIER_MAP: Record<string, Record<string, CarrierInfo>> = {
    lescent: {
        'PAC': ['EXPRESSO_CORREIOS_PAC', 23],
        'Sedex': ['EXPRESSO_CORREIOS_SEDEX', 27],
        'Logan': ['EXPRESSO_LOGAN_EXPRESS', 33],
        'Loggi': ['EXPRESSO_LOGGI_STANDARD', 21],
        'Dialogo': ['EXPRESSO_DIALOGO_STANDARD', 25],
        'Diaslog': ['EXPRESSO_DIASLOG_SP', 31],
        'Clique Retire': ['EXPRESSO_CLIQUE_E_RETIRE', 139],
        'J&T Express': ['EXPRESSO_J&T', 29],
        'Dissudes': ['EXPRESSO_DISSUDES_STANDARD', 131],
        'Magalog': ['EXPRESSO_MAGALOG', 141],
    },
    bysamia: {
        'PAC': ['EXPRESSO_CORREIOS_PAC', 53],
        'Sedex': ['EXPRESSO_CORREIOS_SEDEX', 57],
        'Logan': ['EXPRESSO_LOGAN_EXPRESS', 63],
        'Loggi': ['EXPRESSO_LOGGI_STANDARD', 49],
        'Dialogo': ['EXPRESSO_DIALOGO_STANDARD', 73],
        'Diaslog': ['EXPRESSO_DIASLOG_SP', 69],
        'Clique Retire': ['EXPRESSO_CLIQUE_E_RETIRE', 135],
        'J&T Express': ['EXPRESSO_J&T', 59],
        'Dissudes': ['EXPRESSO_DISSUDES_STANDARD', 125],
        'Magalog': ['EXPRESSO_MAGALOG', 145],
    },
    kokeshi: {
        'PAC': ['EXPRESSO_CORREIOS_PAC', 52],
        'Sedex': ['EXPRESSO_CORREIOS_SEDEX', 56],
        'Logan': ['EXPRESSO_LOGAN_EXPRESS', 62],
        'Loggi': ['EXPRESSO_LOGGI_STANDARD', 48],
        'Dialogo': ['EXPRESSO_DIALOGO_STANDARD', 72],
        'Diaslog': ['EXPRESSO_DIASLOG_SP', 68],
        'Clique Retire': ['EXPRESSO_CLIQUE_E_RETIRE', 137],
        'J&T Express': ['EXPRESSO_J&T', 58],
        'Dissudes': ['EXPRESSO_DISSUDES_STANDARD', 129],
        'Magalog': ['EXPRESSO_MAGALOG', 143],
    },
    aua: {
        'PAC': ['EXPRESSO_CORREIOS_PAC', 114],
        'Sedex': ['EXPRESSO_CORREIOS_SEDEX', 113],
        'Logan': ['EXPRESSO_LOGAN_EXPRESS', 111],
        'Loggi': ['EXPRESSO_LOGGI_STANDARD', 115],
        'Dialogo': ['EXPRESSO_DIALOGO_STANDARD', 109],
        'Diaslog': ['EXPRESSO_DIASLOG_SP', 110],
        'Clique Retire': ['EXPRESSO_CLIQUE_E_RETIRE', 133],
        'J&T Express': ['EXPRESSO_J&T', 112],
        'Dissudes': ['EXPRESSO_DISSUDES_STANDARD', 127],
        'Magalog': ['EXPRESSO_MAGALOG', 147],
    },
    barbours: {
        'PAC': ['EXPRESSO_CORREIOS_PAC', 166],
        'Sedex': ['EXPRESSO_CORREIOS_SEDEX', 165],
        'Logan': ['EXPRESSO_LOGAN_EXPRESS', 163],
        'Loggi': ['EXPRESSO_LOGGI_STANDARD', 167],
        'Dialogo': ['EXPRESSO_DIALOGO_STANDARD', 161],
        'Diaslog': ['EXPRESSO_DIASLOG_SP', 162],
        'Clique Retire': ['EXPRESSO_CLIQUE_E_RETIRE', 183],
        'J&T Express': ['EXPRESSO_J&T', 164],
        'Dissudes': ['EXPRESSO_DISSUDES_STANDARD', 179],
        'Magalog': ['EXPRESSO_MAGALOG', 182],
    },
    rituaria: {
        'PAC': ['EXPRESSO_CORREIOS_PAC', 166],
        'Sedex': ['EXPRESSO_CORREIOS_SEDEX', 165],
        'Logan': ['EXPRESSO_LOGAN_EXPRESS', 163],
        'Loggi': ['EXPRESSO_LOGGI_STANDARD', 167],
        'Dialogo': ['EXPRESSO_DIALOGO_STANDARD', 161],
        'Diaslog': ['EXPRESSO_DIASLOG_SP', 162],
        'Clique Retire': ['EXPRESSO_CLIQUE_E_RETIRE', 183],
        'J&T Express': ['EXPRESSO_J&T', 164],
        'Dissudes': ['EXPRESSO_DISSUDES_STANDARD', 179],
        'Magalog': ['EXPRESSO_MAGALOG', 182],
    },
};

/**
 * Resolve carrierId e carrierServiceName a partir da marca e nome da transportadora de reenvio.
 * @returns [serviceName, carrierId] ou null se não encontrar.
 */
export function resolveCarrier(brand: string, carrierName: string): CarrierInfo | null {
    const brandMap = CARRIER_MAP[brand.toLowerCase()];
    if (!brandMap) return null;
    return brandMap[carrierName] || null;
}

/** Resultado do casamento tolerante: a chave canônica do mapa + o par que a API do Cosmos espera. */
export interface CarrierLooseMatch {
    /** Chave canônica do mapa (ex.: 'PAC', 'Clique Retire') — serve à planilha e ao resolveCarrier estrito */
    carrierName: string;
    serviceName: string;
    carrierId: number;
}

/**
 * Normaliza para comparação: sem acento, sem caixa, pontuação virando espaço e espaços colapsados.
 * Ex.: 'CORREIOS - PAC' → 'correios pac'; 'Diálogo' → 'dialogo'; 'J&T Express' → 'j t express'.
 */
function normalizeCarrierName(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Casa a chave como SEQUÊNCIA DE PALAVRAS INTEIRAS dentro do nome — 'Pacote' nunca vira 'PAC'. */
function containsAsWords(haystack: string, needle: string): boolean {
    const words = haystack.split(' ');
    const target = needle.split(' ');
    for (let i = 0; i + target.length <= words.length; i++) {
        if (target.every((word, j) => words[i + j] === word)) return true;
    }
    return false;
}

/**
 * Casa o nome de transportadora que o ERP devolve (`order.carrier.name`) com a chave canônica do mapa
 * da marca. Existe porque o Cosmos não fala o mesmo vocabulário do dropdown da UI: de lá vem
 * 'Correios PAC', 'Loggi Standard', 'Diálogo'.
 *
 * SEM MATCH ⇒ `null`, sempre. Nunca devolve um palpite: transportadora é para onde a caixa vai
 * fisicamente, e no caminho automático não há agente conferindo. Nome ambíguo (duas chaves distintas
 * no mesmo texto) também é `null` — escolher uma seria chutar.
 */
export function resolveCarrierLoose(brand: string, carrierName: string): CarrierLooseMatch | null {
    const brandMap = CARRIER_MAP[brand.toLowerCase()];
    if (!brandMap) return null;

    const normalized = normalizeCarrierName(carrierName || '');
    if (!normalized) return null;

    const keys = Object.keys(brandMap);

    // 1. Igualdade normalizada — o caso simples ('pac', 'Diálogo', 'CLIQUE-RETIRE')
    const exact = keys.find(key => normalizeCarrierName(key) === normalized);
    if (exact) return toMatch(exact, brandMap[exact]);

    // 2. Palavra inteira, chaves da mais longa para a mais curta (uma chave de duas palavras ganha
    //    de uma de uma palavra contida nela)
    const matches = keys
        .filter(key => containsAsWords(normalized, normalizeCarrierName(key)))
        .sort((a, b) => normalizeCarrierName(b).length - normalizeCarrierName(a).length);

    if (matches.length === 0) return null;

    // Descarta a chave que é sub-sequência de outra já casada (não é ambiguidade, é especificidade)
    const distintas = matches.filter(
        key => !matches.some(
            outra => outra !== key && containsAsWords(normalizeCarrierName(outra), normalizeCarrierName(key))
        )
    );

    // Duas chaves distintas no mesmo nome ⇒ ambíguo ⇒ null (ver doc acima)
    if (distintas.length !== 1) return null;

    return toMatch(distintas[0], brandMap[distintas[0]]);
}

function toMatch(key: string, info: CarrierInfo): CarrierLooseMatch {
    const [serviceName, carrierId] = info;
    return { carrierName: key, serviceName, carrierId };
}
