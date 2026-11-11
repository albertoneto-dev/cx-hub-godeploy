import { describe, it, expect, afterEach, vi } from 'vitest';
import { ambienteDasPlanilhas, resolverPlanilha } from '@shared/lib/sheets';
import type { AmbientePlanilha, FluxoPlanilha } from '@shared/lib/sheets';
import type { SupportedBrand } from '@shared/lib/constants';

const MARCAS: SupportedBrand[] = ['lescent', 'kokeshi', 'bysamia', 'aua', 'barbours', 'rituaria'];
const FLUXOS: FluxoPlanilha[] = ['reenvio', 'reembolso', 'cancelamento'];
const AMBIENTES: AmbientePlanilha[] = ['prod', 'staging'];

describe('resolverPlanilha', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('toda combinação ambiente × fluxo × marca tem destino completo', () => {
        for (const ambiente of AMBIENTES) {
            for (const fluxo of FLUXOS) {
                for (const marca of MARCAS) {
                    const destino = resolverPlanilha(fluxo, marca, ambiente);
                    expect(destino.spreadsheetId, `${ambiente}/${fluxo}/${marca}`).toMatch(/^[\w-]{40,}$/);
                    expect(destino.aba).toMatch(/^Respostas ao formulário/);
                    expect(destino.intervalo).toMatch(/^A1:[A-Z]+1$/);
                }
            }
        }
    });

    it('staging nunca aponta para uma planilha de produção', () => {
        const prod = new Set(FLUXOS.flatMap((f) => MARCAS.map((m) => resolverPlanilha(f, m, 'prod').spreadsheetId)));
        for (const fluxo of FLUXOS) {
            for (const marca of MARCAS) {
                expect(prod.has(resolverPlanilha(fluxo, marca, 'staging').spreadsheetId), `${fluxo}/${marca}`).toBe(false);
            }
        }
    });

    it('cada marca × fluxo tem planilha própria (nenhum ID repetido dentro do ambiente)', () => {
        for (const ambiente of AMBIENTES) {
            const ids = FLUXOS.flatMap((f) => MARCAS.map((m) => resolverPlanilha(f, m, ambiente).spreadsheetId));
            expect(new Set(ids).size, ambiente).toBe(ids.length);
        }
    });

    it('confere os destinos de produção da Rituária com o docs/PLANILHAS-N8N.md', () => {
        expect(resolverPlanilha('reenvio', 'rituaria', 'prod')).toEqual({
            spreadsheetId: '1LndlqC401QU0QO1xyoAqtgpH4L5kMbtdK-aO4bBCVqk',
            aba: 'Respostas ao formulário',
            intervalo: 'A1:AN1',
            inserirLinhas: true,
        });
        expect(resolverPlanilha('reembolso', 'rituaria', 'prod').spreadsheetId).toBe('1L5piyJ0mVLSB2H2UNf-tUdqM3Wm__SR2i4MVY4w01Dg');
        expect(resolverPlanilha('cancelamento', 'rituaria', 'prod').spreadsheetId).toBe('1QdUnQMHwlSiXczmJqKhiRdh4LHiWXeFQhH1vO06PEBM');
    });

    it('ID e aba das 18 planilhas de produção ficam fixados (já conferidos com a lista da operação): mexer aqui é decisão, não acidente', () => {
        const prod = Object.fromEntries(
            FLUXOS.flatMap((f) => MARCAS.map((m) => {
                const { spreadsheetId, aba } = resolverPlanilha(f, m, 'prod');
                return [`${f}/${m}`, `${spreadsheetId} · ${aba}`];
            }))
        );
        expect(prod).toEqual({
            'reenvio/lescent': '18St20WjvNGgLyyl05zIg7Z8U7A6hoyguHIfBpp2N8Bk · Respostas ao formulário',
            'reenvio/kokeshi': '1fW3mDgAyG6lmgcR9T4Kz03gWnmakpLCL9nqOe59Q1cU · Respostas ao formulário',
            'reenvio/bysamia': '1K1Ba634eA-Ewrm_UoPYk1V7GTi0ZM3n9jCdIRXry5tc · Respostas ao formulário',
            'reenvio/aua': '191azVcoGfOY7UX0g--zim6W9mMrciO7WPx__6-MCeyk · Respostas ao formulário 1',
            'reenvio/barbours': '15XKeR-m2X_anXTANqk45xa0BfDh1GhEWLyIyjdnxuwc · Respostas ao formulário',
            'reenvio/rituaria': '1LndlqC401QU0QO1xyoAqtgpH4L5kMbtdK-aO4bBCVqk · Respostas ao formulário',
            'reembolso/lescent': '1xk1Dtb_n_nl0xsVSDc8rWpDzQ8H_dQ4iKQmmE8bpSEM · Respostas ao formulário',
            'reembolso/kokeshi': '1JObnj5bF9bxD-ZawsiCVfkoxRK4Ch8_xheoD-deOSF8 · Respostas ao formulário',
            'reembolso/bysamia': '1zmTPFWXrLAFeOi9oIibx5nPIqzElU93NkczI-cowvyo · Respostas ao formulário 1',
            'reembolso/aua': '1x1hNL-jFqrIimjvqYRTEKT2n2s30ndj7tFJ3zBlunXw · Respostas ao formulário 1',
            'reembolso/barbours': '1SUwnIMyuWsA7vgvIaeOLOmkHoMfa47Ayy_7kgkiA3VM · Respostas ao formulário',
            'reembolso/rituaria': '1L5piyJ0mVLSB2H2UNf-tUdqM3Wm__SR2i4MVY4w01Dg · Respostas ao formulário 1',
            'cancelamento/lescent': '1XScJUs0sX5cD6EQ4kkARg-5Euf_L_VPXMa8UEt07Myw · Respostas ao formulário 1',
            'cancelamento/kokeshi': '1-LPBV8mjSMbu_pkWdydwRySuGZpVSosEoLi1E_cBMDM · Respostas ao formulário 1',
            'cancelamento/bysamia': '146aTwxUsKze0PwUrnEt6ht9QbPl2Sya_x902v2-OMXI · Respostas ao formulário 1',
            'cancelamento/aua': '1BDOYDbJGya-SueCTrcqvryR9h-23ULPBX27d_-qYgYg · Respostas ao formulário 1',
            'cancelamento/barbours': '11OA0VbDTOhGM5vQkYCB9dfZAWUNeF_s76n23ZcxNxWk · Respostas ao formulário 1',
            'cancelamento/rituaria': '1QdUnQMHwlSiXczmJqKhiRdh4LHiWXeFQhH1vO06PEBM · Respostas ao formulário 1',
        });
    });

    it('sem ambiente explícito, usa o SHEETS_ENV', () => {
        vi.stubEnv('SHEETS_ENV', 'staging');
        expect(resolverPlanilha('reenvio', 'lescent').spreadsheetId).toBe('1KBDSEHAko9rnyps-omztQ91-uRt94UEDb6X-NR98fkM');
        vi.stubEnv('SHEETS_ENV', 'prod');
        expect(resolverPlanilha('reenvio', 'lescent').spreadsheetId).toBe('18St20WjvNGgLyyl05zIg7Z8U7A6hoyguHIfBpp2N8Bk');
    });

    it('sem SHEETS_ENV válida lança, em vez de escolher uma planilha', () => {
        vi.stubEnv('SHEETS_ENV', '');
        expect(() => resolverPlanilha('reenvio', 'lescent')).toThrow(/SHEETS_ENV/);
    });
});

describe('ambienteDasPlanilhas', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each(['prod', 'staging'])('aceita %s', (valor) => {
        vi.stubEnv('SHEETS_ENV', valor);
        expect(ambienteDasPlanilhas()).toBe(valor);
    });

    it.each(['', 'production', 'PROD', 'sandbox'])('falha fechada com "%s" — sem default', (valor) => {
        vi.stubEnv('SHEETS_ENV', valor);
        expect(() => ambienteDasPlanilhas()).toThrow(/SHEETS_ENV/);
    });
});
