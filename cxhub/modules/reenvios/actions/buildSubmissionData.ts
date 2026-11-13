import type { NormalizedOrder } from '../../../shared/types/index';
// `import type` de propósito: o módulo de alertas é server-only (lê env var e faz fetch), e um import
// de runtime aqui o arrastaria para o bundle do cliente pelo caminho do builder da UI.
import type { AlertReason } from '@shared/lib/alerts/types';
import type { MarcaCxHub, ResendSubmissionData, SupportedBrand } from '../types/sheets';
import type { Step1FormData, Step2Data } from '../types/resend';
import { BRAND_DISPLAY_MAP } from '../types/resend';
import { ehMarcaSemCosmos, ehMarcaSemCosmosComPlanilha, temOrganizacaoNoCosmos } from '../../../shared/lib/constants';
import type { ItemReenviado } from '../../../shared/lib/datamart/pedidoTipos';
import { shouldSendToAPI } from './shouldSendToAPI';
import { calculateResendValue, getSkusToResend } from './calculateResendValue';
import { resolveCarrier } from './carrierMap';
import { formatCdOrigem } from '../../../shared/lib/shopify/index';

export interface BuildSubmissionDataInput {
    formData: Step1FormData;
    step2Data: Step2Data;
    orderData: NormalizedOrder;
    /**
     * Par transportadora↔serviço a usar **quando o nome não casa no `CARRIER_MAP`**.
     *
     * Existe para o caminho do bot, e a razão é que o mapa é um artefato da UI: lá o agente escolhe de um
     * dropdown, então o nome sempre resolve. No caminho do bot o nome vem do ERP (`order.carrier.name`),
     * num vocabulário que o mapa não cobre — foi assim que `'Anjun Express'` degradou 5 de 5 reenvios do
     * Typebot em produção. Quem passa isto passa o id que o **próprio Cosmos** deu àquele pedido, então
     * não há palpite: é a transportadora que já levou a remessa original.
     *
     * Ausente ⇒ comportamento inalterado (nome fora do mapa ⇒ sem `apiData`), que é o da UI.
     */
    carrierFallback?: { serviceName: string; carrierId: number };
}

export interface BuildSubmissionDataResult {
    brand: MarcaCxHub;
    submissionData: ResendSubmissionData;
    shouldSend: boolean;
    motivo?: string;
    /**
     * Classificação legível por máquina do `motivo` (ADR-005). Nasce **aqui**, na origem, de propósito:
     * quem decide já sabe por quê, e deixar a rota adivinhar por trecho de texto criaria um acoplamento
     * que se rompe em silêncio na primeira vez que alguém reescrever a mensagem.
     *
     * Opcional porque o caminho da UI não consome — lá o motivo é lido por um humano na tela.
     */
    reason?: AlertReason;
}

// ─── Helpers ────────────────────────────────────────────────────────

function resolveErp(brand: MarcaCxHub, source: NormalizedOrder['source']): string {
    if (brand === 'rituaria') {
        return source === 'shopify' ? 'Bling' : 'Protheus';
    }
    return 'Protheus';
}

function formatPhoneNumber(phone: string): string {
    let cleaned = phone.replace(/\D/g, '');

    if (cleaned.startsWith('55') && cleaned.length > 11) {
        cleaned = cleaned.substring(2);
    }

    if (cleaned.length === 11) {
        return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 7)}-${cleaned.slice(7)}`;
    } else if (cleaned.length === 10) {
        return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 6)}-${cleaned.slice(6)}`;
    }
    return phone;
}

function buildShippingAddress(step2Data: Step2Data, orderData: NormalizedOrder) {
    const useNew = step2Data.alterarEndereco;
    const addr = useNew ? step2Data.novoEndereco : orderData.endereco;

    const enderecoEnvio = useNew
        ? `${addr.logradouro}, ${addr.numero}${addr.complemento ? ', ' + addr.complemento : ''}, ${addr.bairro}, ${addr.cidade}/${addr.estado}`
        : orderData.enderecoCliente;

    return {
        enderecoEnvio,
        cepEnvio: addr.cep,
        estadoEnvio: addr.estado,
        addr,
    };
}

function buildProdutosComProblema(selectedIds: string[], orderData: NormalizedOrder): string {
    return selectedIds
        .map(id => {
            const produto = orderData.produtos.find(p => p.id === id);
            return produto ? produto.sku : null;
        })
        .filter(Boolean)
        .join(';');
}

/** Um item do pedido que vai no reenvio: a chave dele (produto ou componente de kit), o SKU original e a quantidade. */
interface ItemDoPedidoParaReenviar {
    id: string;
    sku: string;
    quantidade: number;
}

/**
 * Os itens do pedido marcados para reenviar, na ordem de `produtosReenviar`. O componente de um kit que também foi
 * marcado não entra (vai o kit inteiro).
 */
function itensDoPedidoParaReenviar(
    step2Data: Step2Data,
    orderData: NormalizedOrder,
): ItemDoPedidoParaReenviar[] {
    const produtosReenviarSet = new Set(step2Data.produtosReenviar);
    const itens: ItemDoPedidoParaReenviar[] = [];

    step2Data.produtosReenviar.forEach(id => {
        const mainProduct = orderData.produtos.find(p => p.id === id);

        if (mainProduct) {
            const qtdMain = step2Data.quantidadesReenviar[id] || mainProduct.quantidade;
            itens.push({ id, sku: mainProduct.sku, quantidade: qtdMain });
            return;
        }

        let foundComponent = null;
        let parentKit = null;

        for (const p of orderData.produtos) {
            if (p.kitComponents) {
                const comp = p.kitComponents.find(c => c.id === id);
                if (comp) {
                    foundComponent = comp;
                    parentKit = p;
                    break;
                }
            }
        }

        if (foundComponent && parentKit) {
            if (produtosReenviarSet.has(parentKit.id)) {
                return;
            }
            const qtdComp = step2Data.quantidadesReenviar[id] || foundComponent.quantidade;
            itens.push({ id, sku: foundComponent.sku, quantidade: qtdComp });
        }
    });

    return itens;
}

function buildProdutosReenviar(
    step2Data: Step2Data,
    orderData: NormalizedOrder,
): string {
    const produtosPedidoOriginal = itensDoPedidoParaReenviar(step2Data, orderData)
        .map(item => `${item.sku} - ${item.quantidade}`);

    const produtosAdicionais = step2Data.itensAdicionais.map(item => {
        const sku = item.sku || item.name;
        return `${sku} - ${item.quantidade}`;
    });

    return [...produtosPedidoOriginal, ...produtosAdicionais].join(';');
}

/**
 * Marcas sem Cosmos (ADR-016): o que vai no lugar do `produtoReenviar` e do `comentarios` de sempre.
 * - `produtoReenviar`: cada item marcado com o SKU do substituto, quando há troca (`substituicoes[id]`); depois os
 *   mimos; as quantidades do mesmo SKU somadas (na ordem em que o SKU aparece primeiro), `SKU - qtd` separados por `;`.
 * - `notas`: cada troca (na ordem de `produtosReenviar`) e depois cada mimo, no vocabulário que a operação já lê nas
 *   planilhas dessas marcas. Vão na frente das observações.
 * - `itensOriginais`: os itens do pedido marcados, com o SKU **original** e sem os mimos (ADR-018). É por eles que o
 *   servidor calcula o valor da NF de reenvio: o substituto herda o preço do item que substitui, e o mimo não entra.
 */
function reenvioDaMarcaSemCosmos(
    step2Data: Step2Data,
    orderData: NormalizedOrder,
): { produtoReenviar: string; notas: string[]; itensOriginais: ItemReenviado[] } {
    const quantidadePorSku = new Map<string, number>();
    const somar = (sku: string, quantidade: number) => quantidadePorSku.set(sku, (quantidadePorSku.get(sku) ?? 0) + quantidade);
    const notas: string[] = [];
    const itensOriginais: ItemReenviado[] = [];

    for (const item of itensDoPedidoParaReenviar(step2Data, orderData)) {
        const troca = step2Data.substituicoes[item.id];
        somar(troca?.sku ?? item.sku, item.quantidade);
        itensOriginais.push({ sku: item.sku, quantidade: item.quantidade });
        if (troca) notas.push(`SKU ${item.sku} sem estoque substituído pelo SKU ${troca.sku}`);
    }
    for (const mimo of step2Data.itensAdicionais) {
        somar(mimo.sku, mimo.quantidade);
        notas.push(`SKU ${mimo.sku} incluído como mimo`);
    }

    return {
        produtoReenviar: [...quantidadePorSku].map(([sku, quantidade]) => `${sku} - ${quantidade}`).join(';'),
        notas,
        itensOriginais,
    };
}

function computeShouldSendToAPI(
    formData: Step1FormData,
    step2Data: Step2Data,
    orderData: NormalizedOrder,
) {
    const orderProducts = step2Data.produtosReenviar.map(id => {
        const produto = orderData.produtos.find(p => p.id === id);

        if (!produto) {
            for (const p of orderData.produtos) {
                if (p.kitComponents) {
                    const component = p.kitComponents.find(c => c.id === id);
                    if (component) {
                        return {
                            is_gift: component.isGift || component.nome.toLowerCase().includes('brinde'),
                        };
                    }
                }
            }
            return null;
        }

        return {
            is_gift: produto.isGift || produto.nome.toLowerCase().includes('brinde'),
        };
    }).filter((item): item is { is_gift: boolean } => item !== null);

    const extraProducts = step2Data.itensAdicionais.map(item => ({
        is_gift: item.isGift,
    }));

    return shouldSendToAPI({
        tipoSolicitacao: formData.tipoSolicitacao,
        isShopify: orderData.source === 'shopify',
        orderProducts,
        extraProducts,
    });
}

function buildApiData(
    brand: SupportedBrand,
    step2Data: Step2Data,
    orderData: NormalizedOrder,
    addr: { logradouro: string; numero: string; complemento: string; bairro: string; cidade: string; estado: string; cep: string },
    carrierFallback?: { serviceName: string; carrierId: number },
): ResendSubmissionData['apiData'] {
    const carrierLookup = resolveCarrier(brand, step2Data.transportadoraReenvio);
    // O mapa tem precedência: quando o nome casa, é uma escolha explícita (dropdown do agente ou nome que
    // o bot informou) e vale mais que a transportadora que por acaso levou a remessa original.
    const carrier = carrierLookup
        ? { serviceName: carrierLookup[0], carrierId: carrierLookup[1] }
        : carrierFallback;

    if (!carrier) {
        console.warn('[buildSubmissionData] Carrier not found in map:', { brand, carrier: step2Data.transportadoraReenvio });
        return undefined;
    }
    const { serviceName: carrierServiceName, carrierId } = carrier;

    const skusToResend = getSkusToResend(step2Data.produtosReenviar, orderData.produtos);
    const erpItemsBySku = new Map(
        (orderData.erpPayloadItems || []).map(item => [item.sku, item])
    );

    let totalDiscount = 0;

    const resendProducts = skusToResend.map(item => {
        const produto = orderData.produtos.find(p => p.sku === item.sku);
        let productId = produto?.product_id || 0;
        if (!productId) {
            for (const p of orderData.produtos) {
                const comp = p.kitComponents?.find(c => c.sku === item.sku);
                if (comp) { productId = comp.product_id; break; }
            }
        }

        let unitPrice = '0';
        let quantity = 1;

        const erpItem = erpItemsBySku.get(item.sku);
        if (erpItem) {
            quantity = erpItem.quantity;
        } else if (produto) {
            quantity = produto.quantidade;
        }

        // Use user-selected quantity
        const produtoById = orderData.produtos.find(p => p.sku === item.sku);
        if (produtoById && step2Data.quantidadesReenviar[produtoById.id] !== undefined) {
            quantity = step2Data.quantidadesReenviar[produtoById.id];
        } else {
            for (const p of orderData.produtos) {
                if (p.kitComponents) {
                    const comp = p.kitComponents.find(c => c.sku === item.sku);
                    if (comp && step2Data.quantidadesReenviar[comp.id] !== undefined) {
                        quantity = step2Data.quantidadesReenviar[comp.id];
                        break;
                    }
                }
            }
        }

        if (erpItem) {
            unitPrice = erpItem.unit_price.toString();
            if (!item.isGift) {
                const unitDiscount = erpItem.quantity > 0 ? erpItem.discount_value / erpItem.quantity : 0;
                totalDiscount += unitDiscount * quantity;
            }
        } else if (item.kitComponentSkus && item.kitComponentSkus.length > 0) {
            let calculatedPrice = 0;
            for (const kitComp of item.kitComponentSkus) {
                const compErp = erpItemsBySku.get(kitComp.sku);
                if (compErp) {
                    calculatedPrice += compErp.unit_price;
                    if (!item.isGift) {
                        const unitCompDiscount = compErp.quantity > 0 ? compErp.discount_value / compErp.quantity : 0;
                        const totalCompQty = step2Data.quantidadesReenviar[kitComp.id] || quantity;
                        totalDiscount += unitCompDiscount * totalCompQty;
                    }
                }
            }
            unitPrice = calculatedPrice.toString();
        }

        return {
            product_id: productId,
            quantity,
            unit_price: unitPrice,
        };
    });

    const additionalProducts = step2Data.itensAdicionais.map(item => ({
        product_id: item.id,
        quantity: item.quantidade,
        unit_price: item.isGift ? '0.02' : item.price,
    }));

    return {
        carrierId,
        carrierServiceName,
        shippingCost: orderData.shippingCost || '0',
        discountAmount: totalDiscount.toFixed(2),
        resendProducts: [...resendProducts, ...additionalProducts],
        shippingAddress: {
            street: addr.logradouro,
            number: addr.numero,
            complement: addr.complemento,
            neighborhood: addr.bairro,
            city: addr.cidade,
            state: addr.estado,
            postal_code: addr.cep,
        },
    };
}

// ─── Main Function ──────────────────────────────────────────────────

export function buildSubmissionData(input: BuildSubmissionDataInput): BuildSubmissionDataResult {
    const { formData, step2Data, orderData, carrierFallback } = input;

    const brand = BRAND_DISPLAY_MAP[formData.marca] || formData.marca.toLowerCase() as MarcaCxHub;

    const { enderecoEnvio, cepEnvio, estadoEnvio, addr } = buildShippingAddress(step2Data, orderData);
    const produtosComProblema = buildProdutosComProblema(step2Data.produtosComProblema, orderData);
    // Marca sem Cosmos (ADR-016): os itens adicionais são os mimos, e um item sem estoque pode ir trocado. As marcas do
    // Cosmos seguem como sempre (as `substituicoes` não valem para elas).
    const semCosmos = ehMarcaSemCosmos(brand);
    const reenvioSemCosmos = semCosmos ? reenvioDaMarcaSemCosmos(step2Data, orderData) : null;
    const produtosReenviar = reenvioSemCosmos ? reenvioSemCosmos.produtoReenviar : buildProdutosReenviar(step2Data, orderData);
    const comentarios = reenvioSemCosmos
        ? [reenvioSemCosmos.notas.join('; '), step2Data.observacoes.trim()].filter(Boolean).join(' | ')
        : step2Data.observacoes;

    const now = new Date();
    const timestamp = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const dataSolicitacao = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const apiResult = computeShouldSendToAPI(formData, step2Data, orderData);
    const { shouldSendToAPI: shouldSend, motivo } = apiResult;
    // As marcas sem Cosmos nunca automatizam, mas a planilha da Denavita guarda o valor do reenvio no próprio
    // formulário (ADR-013): o valor é calculado para elas também, pelo mesmo cálculo de pedido da Shopify.
    const calcularValor = shouldSend || semCosmos;

    const dataCriacao = orderData.createdAt
        ? new Date(orderData.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        : '';

    const submissionData: ResendSubmissionData = {
        timestamp,
        dataSolicitacao,
        data_criacao: dataCriacao,
        tipoSolicitacao: formData.tipoSolicitacao.charAt(0).toUpperCase() + formData.tipoSolicitacao.slice(1).toLowerCase(),
        responsavel: formData.responsavel,
        origemReclamacao: formData.origemReclamacao,
        idAtendimento: formData.idAtendimento,
        cdOrigem: formatCdOrigem(orderData.cdOrigem || ''),

        nomeCliente: orderData.nomeCliente,
        telefoneCliente: formatPhoneNumber(orderData.telefoneCliente),
        enderecoCliente: enderecoEnvio,
        cep: cepEnvio,
        estado: estadoEnvio,

        numeroPedido: orderData.numeroPedido,
        numeroNF: orderData.source === 'shopify'
            ? step2Data.numeroNFManual
            : (orderData.numeroNF || ''),
        chaveNF: orderData.source === 'shopify'
            ? step2Data.chaveNFManual
            : (orderData.invoiceAccessKey || ''),
        cosmosId: orderData.cosmos_id ? String(orderData.cosmos_id) : '',

        produtoComProblema: produtosComProblema,
        produtoReenviar: produtosReenviar,
        loteProduto: step2Data.loteProduto,
        problemaProduto: step2Data.problemaProduto,

        transportadoraOriginal: orderData.transportadora || '',
        transportadoraReenvio: step2Data.transportadoraReenvio,
        devolucao: step2Data.devolucao === 'sim' ? 'Sim' : 'Não',
        ticketTransportadora: step2Data.ticketTransportadora,

        statusPedido: step2Data.statusPedido,
        ReenvioCompleto: step2Data.ReenvioCompleto === 'sim' ? 'Sim' : 'Não',

        // Pelos itens ORIGINAIS: o substituto herda o preço do item que substitui. Nas marcas sem Cosmos o mimo não entra.
        valorReenvio: calcularValor ? calculateResendValue({
            selectedProducts: getSkusToResend(step2Data.produtosReenviar, orderData.produtos),
            quantidadesReenviar: step2Data.quantidadesReenviar,
            extraGiftsCount: semCosmos ? 0 : step2Data.itensAdicionais.filter(item => item.isGift).length,
            erpPayloadItems: orderData.erpPayloadItems || [],
            shippingCost: orderData.shippingCost || '0',
            produtos: orderData.produtos,
        }) : '',
        status: shouldSend ? 'Realizado' : '',
        codNfd: shouldSend ? 'Pendente' : '',
        automacao: shouldSend ? 'Automação' : '',
        erp: shouldSend ? resolveErp(brand, orderData.source) : '',

        comentarios,

        // Só onde o servidor confere o pedido no Data Mart (ADR-018): a Gobeaute também é sem Cosmos, mas não tem a regra.
        ...(reenvioSemCosmos && ehMarcaSemCosmosComPlanilha(brand) ? { itensOriginaisReenviados: reenvioSemCosmos.itensOriginais } : {}),

        ...(shouldSend && temOrganizacaoNoCosmos(brand) ? { apiData: buildApiData(brand, step2Data, orderData, addr, carrierFallback) } : {}),
    };

    return { brand, submissionData, shouldSend, motivo };
}
