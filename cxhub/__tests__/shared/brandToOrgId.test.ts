import { describe, it, expect } from 'vitest';
import {
    BRAND_TO_ORG_ID,
    BRAND_API_TO_DISPLAY,
    BRAND_DISPLAY_MAP,
    MARCAS_SEM_COSMOS,
    SUFIXO_DO_PEDIDO,
    ehMarcaCxHub,
    ehMarcaSemCosmos,
    temOrganizacaoNoCosmos,
} from '@shared/lib/constants';

/**
 * BRAND_TO_ORG_ID canônico: mapa marca → orgId do Cosmos. Cobre EXATAMENTE as marcas do Cosmos (`SupportedBrand`),
 * porque é ele que as rotas usam para escolher a organização no Cosmos. As marcas sem Cosmos (ADR-013) têm nome de
 * exibição, mas nunca orgId: com um orgId inventado, as rotas chamariam o Cosmos e o 401 deslogaria a agente.
 */
describe('BRAND_TO_ORG_ID', () => {
    it('mapeia cada marca para o orgId correto', () => {
        expect(BRAND_TO_ORG_ID).toEqual({
            lescent: '3',
            kokeshi: '4',
            bysamia: '5',
            aua: '6',
            barbours: '8',
            rituaria: '9',
        });
    });

    it('toda marca do CX Hub (as do Cosmos e as sem Cosmos) tem nome de exibição, nos dois sentidos', () => {
        const marcasDoCxHub = [...Object.keys(BRAND_TO_ORG_ID), ...MARCAS_SEM_COSMOS].sort();
        expect(Object.keys(BRAND_API_TO_DISPLAY).sort()).toEqual(marcasDoCxHub);
        expect([...new Set(Object.values(BRAND_DISPLAY_MAP))].sort()).toEqual(marcasDoCxHub);
    });

    it('nenhuma marca sem Cosmos tem orgId', () => {
        for (const marca of MARCAS_SEM_COSMOS) {
            expect(Object.prototype.hasOwnProperty.call(BRAND_TO_ORG_ID, marca), marca).toBe(false);
        }
    });

    it('todos os orgIds são strings numéricas não-vazias e distintas', () => {
        const valores = Object.values(BRAND_TO_ORG_ID);
        valores.forEach(v => {
            expect(typeof v).toBe('string');
            expect(v).toMatch(/^\d+$/);
        });
        expect(new Set(valores).size).toBe(valores.length);
    });
});

describe('marca do CX Hub × marca do Cosmos (ADR-013)', () => {
    it('as 4 marcas sem Cosmos (a Gobeaute é o site multimarca, ADR-014), com o nome que a tela mostra', () => {
        expect(MARCAS_SEM_COSMOS).toEqual(['apice', 'yenzah', 'denavita', 'gobeaute']);
        expect(MARCAS_SEM_COSMOS.map((marca) => BRAND_API_TO_DISPLAY[marca])).toEqual(['Ápice', 'Yenzah', 'Denavita', 'Gobeaute']);
        expect(BRAND_DISPLAY_MAP['Ápice']).toBe('apice');
    });

    it('o sufixo do pedido é o da Shopify — DN na Denavita, embora a sigla da base seja DV', () => {
        expect(SUFIXO_DO_PEDIDO).toEqual({ apice: 'AP', yenzah: 'YE', denavita: 'DN', gobeaute: 'GB' });
    });

    it.each([
        ['lescent', true, false, true],
        ['rituaria', true, false, true],
        ['apice', false, true, true],
        ['yenzah', false, true, true],
        ['denavita', false, true, true],
        ['gocase', false, false, false],
        ['Apice', false, false, false],
        ['', false, false, false],
        ['__proto__', false, false, false],
        ['toString', false, false, false],
    ])('%s: Cosmos=%s, sem Cosmos=%s, do CX Hub=%s', (marca, cosmos, semCosmos, cxHub) => {
        expect(temOrganizacaoNoCosmos(marca)).toBe(cosmos);
        expect(ehMarcaSemCosmos(marca)).toBe(semCosmos);
        expect(ehMarcaCxHub(marca)).toBe(cxHub);
    });
});
