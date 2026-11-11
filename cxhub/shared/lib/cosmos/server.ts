import type { CosmosOrder, CosmosDetailedOrder, CosmosProduct, NormalizedOrder } from '../../types/index';
import { BRAND_TO_ORG_ID, type SupportedBrand } from '../constants';
import { KOKESHI_GIFT_SKUS } from '../productSelectionLogic';
import { readJwtExpiry } from '../jwt';
import { adaptCosmosOrder } from './adapter';
import { sanitizeOrderId, enrichOrderWithProductDetails, type EnrichDeps } from './client';

/**
 * Acesso ao Cosmos a partir do SERVIDOR.
 *
 * Por que existe um módulo separado do `client.ts`: aquele é código de navegador — monta URL
 * **relativa** (`/api/cosmos/...`) e trata 401 mexendo em `localStorage`/`window`. Nada disso roda
 * dentro de um route handler. Aqui as URLs são **absolutas** (`COSMOS_API_URL`) e o token é **mintado
 * no servidor**, porque a porta do bot não tem sessão de agente para carregar credencial.
 *
 * ⚠️ **Server-only.** NÃO é exportado pelo barrel `shared/lib/cosmos/index.ts` de propósito: o barrel é
 * importado por componentes de página, e arrastar para o bundle do cliente um módulo que lê
 * `COSMOS_EMAIL`/`COSMOS_PASSWORD` seria criar o risco que o módulo existe para evitar. Importe pelo
 * caminho completo (`@shared/lib/cosmos/server`).
 *
 * A régua das falhas é assimétrica de propósito:
 * - **configuração faltando ⇒ lança** (falha fechada — um caminho que segue sem credencial mentiria);
 * - **qualquer dúvida na busca do pedido ⇒ `null`**, nunca exceção. Quem chama degrada para registro
 *   sem automação (INV-05); um throw aqui derrubaria a solicitação inteira, que é o pior desfecho.
 */

const LOG = '[Cosmos Server]';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Orçamento AGREGADO de uma busca de pedido (signin + lista + detalhe + catálogo + kits).
 *
 * Timeout por chamada não basta: o caminho tem várias chamadas em série, então o pior caso somado
 * passava de minutos e o route handler seria **morto pela plataforma** antes de gravar a linha — um
 * desfecho que nenhum `catch` vê, e que quebraria justamente a garantia de "nunca perde a
 * solicitação". Com deadline único, estourar o orçamento vira degradação registrada e logada.
 *
 * Lido a cada busca, não na carga do módulo: no Worker o `process.env` só é preenchido quando a requisição chega.
 */
const orderFetchBudgetMs = (): number => parseInt(process.env.COSMOS_FETCH_BUDGET_MS || '', 10) || 25_000;

/**
 * TTL do catálogo por organização. O catálogo é o mesmo para toda requisição da marca e custa até 10
 * páginas de 100 produtos; reler isso a cada reenvio castiga o ERP exatamente quando ele está em
 * sofrimento. Curto de propósito: `id`/`is_kit`/composição de kit praticamente não mudam, e **preço de
 * item vendido vem do `erp_payload`**, não daqui (o do catálogo é só fallback de componente de kit).
 */
const CATALOG_TTL_MS = 5 * 60_000;

/**
 * Margem sobre o `exp` do JWT. Um token que expira "já" é tratado como expirado: a requisição leva
 * tempo, e um 401 no meio do caminho custa a automação do reenvio.
 */
const TOKEN_MARGIN_MS = 60_000;

/** Fallback quando o `exp` do JWT não é legível — curto de propósito, para não cachear lixo. */
const TOKEN_FALLBACK_TTL_MS = 5 * 60_000;

/**
 * Tentativas por chamada ao Cosmos (**total**, não retentativas extra). Duas, não cinco: o objetivo é
 * absorver o blip transitório, não insistir com um ERP fora do ar — e cada tentativa come do
 * `ORDER_FETCH_BUDGET_MS`, que a gravação da linha precisa que sobre.
 */
const MAX_TENTATIVAS_COSMOS = 2;

/** Espera entre tentativas. Curta: é blip de rede, não fila. */
const BACKOFF_COSMOS_MS = 300;

/** Janela mínima que precisa restar do orçamento para valer a pena tentar de novo. */
const MIN_JANELA_RETENTATIVA_MS = 1_500;

interface CachedToken {
    token: string;
    expiresAt: number;
}

/** Cache de módulo: uma instância de servidor reusa o token entre requisições. */
let cachedToken: CachedToken | null = null;

/** Cache do catálogo por `orgId` (ver CATALOG_TTL_MS). */
const catalogCache = new Map<string, { products: CosmosProduct[]; expiresAt: number }>();

/** Só para teste — os caches são estado de módulo e vazariam entre casos. */
export function __resetCosmosTokenCache(): void {
    cachedToken = null;
    catalogCache.clear();
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${LOG} Missing ${name} env variable`);
    }
    return value;
}

/**
 * Token de serviço do Cosmos, mintado com as credenciais do AMBIENTE — as mesmas que o
 * `/api/auth/login` já usa (o login do agente nunca foi a credencial do ERP).
 *
 * Lança quando a configuração falta ou o signin não devolve token: sem token não há automação, e
 * seguir com token vazio produziria um 401 no n8n, longe daqui e difícil de ler.
 */
export async function getCosmosServiceToken(deadline?: number): Promise<string> {
    // Antes de qualquer rede: sem config, não há o que tentar.
    const baseUrl = requireEnv('COSMOS_API_URL');
    const email = requireEnv('COSMOS_EMAIL');
    const password = requireEnv('COSMOS_PASSWORD');

    if (cachedToken && cachedToken.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
        return cachedToken.token;
    }

    const url = `${baseUrl}/auth/signin`;
    console.log(`${LOG} Minting service token:`, url);

    const body = await fetchWithTimeout<{ credentials?: { token?: unknown } } | null>(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    }, deadline, async (res) => {
        if (!res.ok) {
            throw new Error(`${LOG} Cosmos signin failed: HTTP ${res.status}`);
        }
        // Lido aqui dentro de propósito: com o timer ainda armado (ver `fetchWithTimeout`).
        return res.json().catch(() => null);
    });

    const token: unknown = body?.credentials?.token;
    if (!token || typeof token !== 'string') {
        throw new Error(`${LOG} Cosmos signin response without credentials.token`);
    }

    const exp = readJwtExpiry(token);
    cachedToken = {
        token,
        expiresAt: exp !== null ? exp * 1000 : Date.now() + TOKEN_FALLBACK_TTL_MS,
    };

    return token;
}

/**
 * Busca o pedido no Cosmos e devolve-o **normalizado e enriquecido** (kits expandidos, preços do ERP),
 * pronto para o builder da linha de reenvio.
 *
 * Usa a MESMA régua de casamento do `getCosmosOrder` do cliente (regex `^SH<id>[a-zA-Z]{2}\d*$` ou
 * `#SHOPIFY<id>`) — divergir aqui faria o bot achar um pedido que a UI não acharia, ou o contrário.
 *
 * **Sem fallback Shopify**, e isso é decisão, não esquecimento: pedido Shopify não é elegível a
 * automação (`shouldSendToAPI` barra), então buscá-lo só produziria uma linha pior, com dados de outra
 * fonte, para o mesmo desfecho.
 *
 * @param token Token já disponível (evita um signin). Ausente ⇒ minta um.
 * @param deadlineDaRequisicao Instante-limite **da requisição inteira**, para quando quem chama já gastou
 * tempo antes (tipicamente no signin). Ausente ⇒ esta busca abre o próprio orçamento. Recebê-lo é o que
 * impede o relógio de **reiniciar** no meio do handler: sem ele, signin e busca somam dois orçamentos
 * independentes e o pior caso estoura o `maxDuration` da rota — matando a função **antes de gravar a
 * linha**, que é o único desfecho que o caminho do bot não pode ter.
 */
export async function fetchNormalizedCosmosOrder(
    brand: string,
    orderId: string,
    token?: string,
    deadlineDaRequisicao?: number
): Promise<NormalizedOrder | null> {
    // Deadline único de toda a busca — ver ORDER_FETCH_BUDGET_MS. O prazo de fora **encurta**, nunca
    // estende: quem chama conhece o teto do handler; esta função conhece só o custo do ERP.
    const proprio = Date.now() + orderFetchBudgetMs();
    const deadline = deadlineDaRequisicao !== undefined
        ? Math.min(deadlineDaRequisicao, proprio)
        : proprio;

    try {
        const baseUrl = requireEnv('COSMOS_API_URL');
        const orgId = BRAND_TO_ORG_ID[brand.toLowerCase() as SupportedBrand] || brand;
        const authToken = token || await getCosmosServiceToken(deadline);

        const sanitizedId = sanitizeOrderId(orderId);
        const listUrl = `${baseUrl}/organizations/${orgId}/orders?external_id=${encodeURIComponent(sanitizedId)}`;
        console.log(`${LOG} Fetching orders:`, listUrl);

        const orders = await getJson<CosmosOrder[]>(listUrl, authToken, deadline);
        if (!Array.isArray(orders) || orders.length === 0) {
            console.warn(`${LOG} No orders returned for external_id=${sanitizedId}`);
            return null;
        }

        const regexPattern = new RegExp(`^SH${sanitizedId}[a-zA-Z]{2}\\d*$`);
        const exactMatch = `#SHOPIFY${sanitizedId}`;
        const matched = orders.find(
            (order) => regexPattern.test(order.external_id) || order.external_id === exactMatch
        );

        if (!matched) {
            console.warn(
                `${LOG} No external_id matched the rule for ${sanitizedId}:`,
                orders.map((o) => o.external_id)
            );
            return null;
        }

        const detailUrl = `${baseUrl}/organizations/${orgId}/orders/${matched.id}`;
        const detail = await getJson<CosmosDetailedOrder>(detailUrl, authToken, deadline);
        if (!detail) return null;

        const normalized = adaptCosmosOrder(detail);

        // T2 — o enriquecimento é o canônico; só as dependências de catálogo são as do servidor.
        return await enrichOrderWithProductDetails(
            normalized,
            orgId,
            authToken,
            undefined,
            createServerEnrichDeps(baseUrl, deadline)
        );
    } catch (error) {
        // Degradação, não propagação: quem chama transforma `null` em "registra sem automação".
        console.error(`${LOG} Failed to fetch order ${orderId} for brand ${brand}:`, error);
        return null;
    }
}

/**
 * As três leituras de catálogo de que o enriquecimento depende, faladas direto com o Cosmos.
 * Mesmos endpoints (e mesma paginação) das rotas-proxy `/api/cosmos/products*`.
 */
function createServerEnrichDeps(baseUrl: string, deadline: number): EnrichDeps {
    return {
        getProducts: async (orgId, token) => {
            const cached = catalogCache.get(orgId);
            if (cached && cached.expiresAt > Date.now()) {
                return cached.products;
            }

            try {
                const perPage = 100;
                const maxPages = 10;
                const all: CosmosProduct[] = [];

                for (let page = 1; page <= maxPages; page++) {
                    const url = `${baseUrl}/organizations/${orgId}/products?per_page=${perPage}&page=${page}`;
                    const data = await getJson<CosmosProduct[]>(url, token, deadline);
                    if (!Array.isArray(data) || data.length === 0) break;
                    all.push(...data);
                    if (data.length < perPage) break;
                }

                // Mesma régua do cliente: só produto ativo, com `isGift` computado.
                const products = all
                    .filter((p) => p.active)
                    .map((p) => ({
                        ...p,
                        isGift:
                            p.name.toLowerCase().includes('brinde') ||
                            KOKESHI_GIFT_SKUS.includes(p.sku.toUpperCase()),
                    }));

                catalogCache.set(orgId, { products, expiresAt: Date.now() + CATALOG_TTL_MS });
                return products;
            } catch (error) {
                // Catálogo incompleto NÃO é cacheado: um erro no meio da paginação viraria um mapa
                // furado servido por 5 minutos, e SKU ausente do mapa vira `product_id: 0` — que a
                // guarda G5 barra. Melhor pagar a releitura na próxima requisição.
                console.error(`${LOG} Failed to fetch products for org ${orgId}:`, error);
                return [];
            }
        },

        getProductDetails: async (orgId, productId, token) => {
            try {
                return await getJson<unknown>(
                    `${baseUrl}/organizations/${orgId}/products/${productId}`,
                    token,
                    deadline
                );
            } catch (error) {
                console.error(`${LOG} Failed to fetch product ${productId}:`, error);
                return null;
            }
        },

        getProductBySku: async (orgId, sku, token) => {
            try {
                const data = await getJson<CosmosProduct[]>(
                    `${baseUrl}/organizations/${orgId}/products?sku=${encodeURIComponent(sku)}`,
                    token,
                    deadline
                );
                return Array.isArray(data) ? data : [];
            } catch (error) {
                console.error(`${LOG} Failed to fetch product by sku ${sku}:`, error);
                return [];
            }
        },
    };
}

/**
 * GET autenticado que lança em resposta não-ok — o `catch` de quem chama decide o que fazer.
 *
 * O corpo é lido **dentro** do `fetchWithTimeout` (parâmetro `consumir`), com o relógio ainda armado:
 * ler depois deixaria a leitura fora de qualquer timeout. Ver a nota no `fetchWithTimeout`.
 */
async function getJson<T>(url: string, token: string, deadline?: number): Promise<T> {
    return fetchWithTimeout<T>(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
    }, deadline, async (res) => {
        if (!res.ok) {
            // Token rejeitado ⇒ o que está em cache não serve mais. Sem isto, um token revogado antes do
            // `exp` deixaria TODA solicitação degradando para manual pelo resto do TTL, e nada aqui ficaria
            // sabendo: a próxima requisição re-minta.
            if (res.status === 401 || res.status === 403) {
                console.warn(`${LOG} Token rejeitado (HTTP ${res.status}) — invalidando o cache do token`);
                cachedToken = null;
            }
            throw new Error(`${LOG} Cosmos API error ${res.status} on ${url}`);
        }

        return (await res.json()) as T;
    });
}

/**
 * Timeout por chamada **e** respeito ao deadline agregado: a janela efetiva é a MENOR entre o timeout
 * padrão e o que resta do orçamento. Orçamento já estourado nem abre conexão.
 *
 * **Retenta o transitório (ADR-005 §1).** Até esta fatia não havia uma única retentativa no caminho do
 * bot: um blip de rede no ERP custava uma tratativa **manual** — trabalho humano para um problema que a
 * máquina resolve sozinha na segunda tentativa. Como o aviso no Chat só dispara depois de o contorno
 * esgotar, é aqui que se decide quanto barulho o time vai ouvir.
 *
 * O que **não** se retenta: `4xx`. Credencial recusada, pedido inexistente e payload rejeitado não
 * melhoram tentando de novo — insistir só queima o orçamento que a gravação da linha vai precisar.
 *
 * **O relógio cobre até o CORPO, não até os headers** (ADR-005 §1). Por isso o corpo é lido aqui dentro,
 * pelo `consumir`, e o `clearTimeout` só roda depois: a versão anterior devolvia a `Response` crua e
 * desarmava o timer, deixando `res.json()` acontecer fora de qualquer relógio. Uma resposta que entrega
 * `200` + headers e depois estola no corpo consumia o orçamento inteiro **sem nada disparar** — medido,
 * 8s pendurado numa janela de 2s. Como quem chama pendura dentro do próprio `try` da rota, nem o `catch`
 * rodava: o `maxDuration` matava o handler e a solicitação sumia sem linha, sem aviso e sem log.
 */
async function fetchWithTimeout<T>(
    url: string,
    init: RequestInit,
    deadline: number | undefined,
    consumir: (res: Response) => Promise<T>,
): Promise<T> {
    const timeoutMs = parseInt(process.env.TIMEOUT || '', 10) || DEFAULT_TIMEOUT_MS;

    let ultimoErro: unknown;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_COSMOS; tentativa++) {
        let janela = timeoutMs;
        if (deadline !== undefined) {
            const restante = deadline - Date.now();
            if (restante <= 0) {
                throw new Error(`${LOG} Orçamento da busca no Cosmos esgotado antes de ${url}`);
            }
            janela = Math.min(timeoutMs, restante);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), janela);
        // Marca a fronteira entre "falha ao obter a resposta" (transitória, retentável) e "falha ao
        // interpretá-la" (4xx, JSON inválido — resposta do servidor, que NÃO se retenta). Sem ela, o
        // `catch` abaixo reabriria a retentativa de 4xx que o `getJson` acabou de fechar.
        let consumindo = false;
        try {
            const res = await fetch(url, { ...init, signal: controller.signal });

            // 5xx é o ERP em sofrimento, não uma resposta sobre o pedido — vale outra tentativa.
            if (res.status >= 500 && podeRetentar(tentativa, deadline)) {
                console.warn(`${LOG} HTTP ${res.status} em ${url} — retentando (${tentativa}/${MAX_TENTATIVAS_COSMOS})`);
                // Corpo descartado precisa ser cancelado: sem isto o undici segura a conexão até o GC.
                await res.body?.cancel().catch(() => { });
                await espera(BACKOFF_COSMOS_MS);
                continue;
            }

            consumindo = true;
            return await consumir(res);
        } catch (error) {
            ultimoErro = error;
            if (consumindo || !podeRetentar(tentativa, deadline)) {
                throw error;
            }
            const causa = error instanceof Error ? error.message : 'erro desconhecido';
            console.warn(`${LOG} Falha de rede em ${url} (${causa}) — retentando (${tentativa}/${MAX_TENTATIVAS_COSMOS})`);
            await espera(BACKOFF_COSMOS_MS);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // Só se chega aqui com o laço esgotado por falha de rede na última volta.
    throw ultimoErro ?? new Error(`${LOG} Falha ao chamar ${url} após ${MAX_TENTATIVAS_COSMOS} tentativas`);
}

/**
 * Retentar só faz sentido se ainda **sobra orçamento para gravar a linha depois**. Sem esta checagem, a
 * retentativa competiria com a garantia que ela deveria proteger: uma segunda tentativa que estoura o
 * `maxDuration` faz a plataforma matar o handler, e aí nenhum `catch` roda — a solicitação se perde em
 * silêncio, que é o único desfecho que esta rota não pode ter.
 */
function podeRetentar(tentativa: number, deadline?: number): boolean {
    if (tentativa >= MAX_TENTATIVAS_COSMOS) return false;
    // Sem orçamento não se retenta — falha **fechada**. Devolver `true` aqui era o furo: o signin do route
    // era chamado sem deadline, então a retentativa rodava sem teto e o pior caso do handler passava do
    // `maxDuration`. Uma retentativa que não sabe quanto tempo resta compete com a gravação da linha que
    // ela deveria proteger.
    if (deadline === undefined) return false;
    return deadline - Date.now() > BACKOFF_COSMOS_MS + MIN_JANELA_RETENTATIVA_MS;
}

function espera(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
