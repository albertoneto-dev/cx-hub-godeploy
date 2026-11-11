/**
 * Parseia endereço concatenado para extrair número e complemento separadamente
 * A API Cosmos e Shopify às vezes retornam tudo junto no campo street/address1
 * Ex: "Rua Faria Lemos, 65, Casa" -> { logradouro: "Rua Faria Lemos", numero: "65", complemento: "Casa" }
 */
export function parseAddressStringExtended(street: string, number: string, complement: string): { logradouro: string; numero: string; complemento: string; bairro: string } {
    // Inicializa retorno padrão
    const result = {
        logradouro: street || '',
        numero: number || '',
        complemento: complement || '',
        bairro: '',
    };

    // Se number já veio separado, confiamos nele, mas ainda processamos o logradouro se tiver vírgulas para extrair bairro/complemento extra
    // Mas a prioridade é o numero passado como argumento se existir.

    // Se street contém vírgulas, tenta parsear estrutura
    if (street && street.includes(',')) {
        const parts = street.split(',').map(p => p.trim()).filter(Boolean);

        // Tenta achar índice do número
        // Procura da esquerda para direita, o primeiro token que parece número isolado ou número+letra
        // Ex: "Rua A, 12, ..." -> índice 1
        let numberIndex = -1;

        // Se o argumento 'number' foi passado, tenta achá-lo nas partes para sincronizar
        if (number) {
            numberIndex = parts.findIndex(p => p === number);
        }

        // HEURÍSTICA DE CONTAGEM DE VÍRGULAS (Solicitada para Shopify)
        // Padrão: Logradouro, Número, [Complemento], Bairro, Cidade, CEP

        // Caso: >= 5 vírgulas (>= 6 partes) -> Pela regra do usuário, 3º item é Complemento, 4º é Bairro
        // Ex: Rua Mário Maia, 95, Casa, Conjunto Laélia Alcântara, Rio Branco, 69914-480...
        if (parts.length >= 6) {
            result.logradouro = parts[0];
            result.numero = parts[1];
            result.complemento = parts[2];
            result.bairro = parts[3];
            return result;
        }

        // Caso: 4 vírgulas (5 partes) -> Pela regra do usuário, NÃO tem complemento. 3º item é Bairro.
        // Ex: Rua Adílio Ramos, 1482, Bairro Alto, Curitiba, 82820-100
        else if (parts.length === 5) {
            result.logradouro = parts[0];
            result.numero = parts[1];
            result.bairro = parts[2];
            result.complemento = '';
            return result;
        }

        // Caso: 3 vírgulas (4 partes) -> Logradouro, Número, Complemento, Bairro
        // Ex: Rua Bahia, 255, Apartamento 113, Canto do Forte (Shopify address1 sem cidade/CEP)
        else if (parts.length === 4) {
            result.logradouro = parts[0];
            result.numero = parts[1];
            result.complemento = parts[2];
            result.bairro = parts[3];
            return result;
        }

        // Caso: 2 vírgulas (3 partes) -> Logradouro, Número, Bairro (sem complemento)
        // Ex: Rua Bahia, 255, Canto do Forte
        else if (parts.length === 3) {
            result.logradouro = parts[0];
            result.numero = parts[1];
            // Verifica se a 3ª parte parece ser complemento ou bairro
            const item = parts[2];
            const complRegex = /^(ap|apt|apto|bloco|bl|c\/|cs|casa|cj|conj|loja|sl|sala|fd|fundos|lot|lote|qd|quadra|térreo|cob|cobertura)/i;
            if (complRegex.test(item)) {
                result.complemento = item;
                result.bairro = '';
            } else {
                result.bairro = item;
                result.complemento = '';
            }
            return result;
        }

        // Se não achou ou não foi passado, tenta inferir (Fallback anterior)
        if (numberIndex === -1 && parts.length >= 2) {
            // Assume que a segunda parte pode ser o número (padrão mais comum)
            // Verifica se parace número
            const candidate = parts[1];
            if (/^\d+[A-Za-z]?$/.test(candidate) || /^s\/n$/i.test(candidate) || /^km\s?\d+$/i.test(candidate)) {
                numberIndex = 1;
            }
        }

        if (numberIndex !== -1) {
            result.logradouro = parts.slice(0, numberIndex).join(', ');
            result.numero = parts[numberIndex];

            // O que sobra depois do número
            const leftovers = parts.slice(numberIndex + 1);

            // Lógica para extrair Bairro vs Complemento dos leftovers
            // Heurística:
            // - Se houver 2+ itens: Último é Bairro, anteriores são Complemento.
            // - Se houver 1 item: Verifica palavras-chave de complemento (apto, bloco, casa...). Se não tiver, assume Bairro.

            if (leftovers.length > 0) {
                let extractedBairro = '';
                let extractedComp = '';

                if (leftovers.length >= 2) {
                    // "Casa 79, Vila Carrão" -> Comp: Casa 79, Bairro: Vila Carrão
                    extractedBairro = leftovers[leftovers.length - 1];
                    extractedComp = leftovers.slice(0, leftovers.length - 1).join(', ');
                } else {
                    // leftovers.length === 1
                    const item = leftovers[0];
                    // Lista de prefixos comuns de complemento
                    const complRegex = /^(ap|apt|apto|bloco|bl|c\/|cs|casa|cj|conj|loja|sl|sala|fd|fundos|lot|lote|qd|quadra|térreo|cob|cobertura)/i;

                    if (complRegex.test(item)) {
                        extractedComp = item;
                    } else {
                        // Assume bairro (ex: "Centro", "Vila Mariana")
                        extractedBairro = item;
                    }
                }

                result.bairro = extractedBairro;

                // Merge com o complemento já passado por argumento
                if (complement && extractedComp) {
                    result.complemento = `${extractedComp}, ${complement}`;
                } else {
                    result.complemento = extractedComp || complement || '';
                }
            }
        }
    }

    // Se nada foi parseado (ou falhou), mantém defaults (mas garante que bairro esteja na string de retorno)
    // Se o numberArgument não existia e parse achou, ótimo.
    // Se parse falhou:
    if (result.logradouro === street) {
        // Não houve split bem sucedido ou não achou número.
        // Mantém logradouro original.
        // Bairro continua vazio.
    }

    return result;
}

/**
 * Normaliza uma string para comparação (busca)
 * Remove acentos e converte para minúsculas
 * Ex: "Miréia" -> "mireia"
 */
export function normalizeString(str: string | undefined | null): string {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}
