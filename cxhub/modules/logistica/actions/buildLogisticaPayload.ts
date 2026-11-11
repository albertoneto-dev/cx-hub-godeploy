import type { LogisticaFormData, LogisticaAddressData } from '../types/index';
import { UF_TO_STATE_NAME, BRAND_DISPLAY_MAP, ISSUE_MAP } from '../types/index';
import type { NormalizedOrder } from '../../../shared/types/index';

// ─── Webhook Payload Types ──────────────────────────────────────────

export interface CorrectAddress {
    firstname: string;
    lastname: string;
    address1: string;
    address2: string;
    address3: string;
    address4: string;
    phone: string;
    city: string;
    zipcode: string;
    country_code: string;
    state: string;
    fullAddress: string;
}

/**
 * Corpo de `POST /gogroup-tickets-clind` do worker `cx-ticketcreator`.
 * `issue` é o vocabulário do worker (ver `ISSUE_MAP`), não o rótulo da UI.
 */
export interface LogisticaPayload {
    orderId: string;
    issue: string;
    brand: string;
    /** Quem abriu o ticket. Pela tela do CXHub é sempre um agente de CX. */
    callerType: 'agent';
    variables: {
        executed_by: string;
        correct_address?: CorrectAddress;
    };
}

// ─── Input ──────────────────────────────────────────────────────────

export interface BuildLogisticaPayloadInput {
    formData: LogisticaFormData;
    orderData: NormalizedOrder;
    addressData?: LogisticaAddressData;
}

// ─── Builder ────────────────────────────────────────────────────────

function splitName(fullName: string): { firstname: string; lastname: string } {
    const trimmed = fullName.trim();
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) {
        return { firstname: trimmed, lastname: '' };
    }
    return {
        firstname: trimmed.slice(0, firstSpace),
        lastname: trimmed.slice(firstSpace + 1).trim(),
    };
}

export function buildLogisticaPayload({ formData, orderData, addressData }: BuildLogisticaPayloadInput): LogisticaPayload {
    const brand = BRAND_DISPLAY_MAP[formData.marca] || formData.marca.toLowerCase();

    const payload: LogisticaPayload = {
        orderId: orderData.order_name,
        // O worker rejeita o rótulo acentuado da UI — traduz sempre.
        issue: formData.problema ? ISSUE_MAP[formData.problema] : '',
        brand,
        callerType: 'agent',
        variables: {
            executed_by: `${formData.responsavel} — CXHub`,
        },
    };

    if (formData.problema === 'Endereço Errado' && addressData) {
        const { firstname, lastname } = splitName(orderData.nomeCliente);
        const state = UF_TO_STATE_NAME[addressData.estado] || addressData.estado;
        const zipcode = addressData.cep.replace(/\D/g, '');

        const correct_address: CorrectAddress = {
            firstname,
            lastname,
            address1: addressData.logradouro,
            address2: addressData.numero,
            address3: addressData.complemento,
            address4: addressData.bairro,
            phone: orderData.telefoneCliente,
            city: addressData.cidade,
            zipcode,
            country_code: '31',
            state,
            // `fullAddress` é lido por uma PESSOA na transportadora — é o corpo do e-mail que o
            // worker monta ("altere o endereço de entrega para: <fullAddress>"). Por isso ele leva
            // só o que faz sentido num endereço escrito: nada de `country_code` (o '31' aparecia
            // no meio da linha, entre o estado e o CEP, e não significa nada pra quem lê), e
            // campo vazio sai fora em vez de virar placeholder.
            fullAddress: [
                addressData.logradouro,
                addressData.numero,
                addressData.complemento,
                addressData.bairro,
                addressData.cidade,
                state,
                zipcode,
            ].filter(Boolean).join(', '),
        };

        payload.variables.correct_address = correct_address;
    }

    return payload;
}
