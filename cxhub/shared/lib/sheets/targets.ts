import type { MarcaComPlanilha, MarcaCxHub, MarcaSemCosmosComPlanilha, SupportedBrand } from '../constants';
import type { AmbientePlanilha, FluxoPlanilha, PlanilhaDestino } from './types';

/**
 * Onde cada fluxo grava, por marca e por ambiente.
 *
 * Os valores das 6 marcas do Cosmos foram copiados dos workflows `[PROD] - Webhook CXHub`, `[PROD] - Webhook Refund
 * CXHub` e `[PROD] [AUX] - Cancelamento CXHub` (exportados em 2026-10-27) e do mapa de staging em
 * `docs/PLANILHAS-N8N.md`. As da Ápice, da Yenzah e da Denavita (ADR-013) são as planilhas que o app "Reenvio e
 * Reembolso" grava hoje, com o cabeçalho conferido em 2026-11-05 — **mudou uma planilha, mude aqui e lá**.
 *
 * ⚠️ Só `import type` aqui, de propósito: o arquivo é só dado e não deve puxar nada de runtime.
 */

type Ancora = Pick<PlanilhaDestino, 'intervalo' | 'inserirLinhas'>;
type Planilha = Pick<PlanilhaDestino, 'spreadsheetId' | 'aba'>;

/**
 * Reenvio e reembolso valem para toda marca com planilha (a Gobeaute não tem — ADR-014); o cancelamento, só para as do
 * Cosmos (as sem Cosmos cancelam no Portal de Reembolso, fora do CX Hub — ADR-013).
 */
interface PorFluxo<T> {
    reenvio: Record<MarcaComPlanilha, T>;
    reembolso: Record<MarcaComPlanilha, T>;
    cancelamento: Record<SupportedBrand, T>;
}

/** Num ambiente, as marcas sem Cosmos podem ainda não ter planilha (staging, até existirem as cópias). */
type DaMarcaSemCosmosOpcional<T> = Record<SupportedBrand, T> & Partial<Record<MarcaSemCosmosComPlanilha, T>>;
interface PlanilhasDoAmbiente {
    reenvio: DaMarcaSemCosmosOpcional<Planilha>;
    reembolso: DaMarcaSemCosmosOpcional<Planilha>;
    cancelamento: Record<SupportedBrand, Planilha>;
}

/**
 * Âncora e modo de inserção, copiados node a node. São iguais em staging e prod: o workflow de staging é cópia
 * do de prod, e o intervalo só ancora a tabela (não muda o que é gravado). Nas marcas sem Cosmos a âncora é o
 * cabeçalho inteiro, e a linha é **inserida** (a grade das 6 planilhas termina na última linha com dado).
 */
const ANCORAS: PorFluxo<Ancora> = {
    reenvio: {
        lescent: { intervalo: 'A1:AQ1', inserirLinhas: false },
        kokeshi: { intervalo: 'A1:AO1', inserirLinhas: true },
        bysamia: { intervalo: 'A1:AO1', inserirLinhas: false },
        aua: { intervalo: 'A1:AO1', inserirLinhas: true },
        barbours: { intervalo: 'A1:AG1', inserirLinhas: true },
        rituaria: { intervalo: 'A1:AN1', inserirLinhas: true },
        apice: { intervalo: 'A1:AN1', inserirLinhas: true },
        yenzah: { intervalo: 'A1:AQ1', inserirLinhas: true },
        denavita: { intervalo: 'A1:AR1', inserirLinhas: true },
    },
    reembolso: {
        lescent: { intervalo: 'A1:AG1', inserirLinhas: false },
        kokeshi: { intervalo: 'A1:V1', inserirLinhas: false },
        bysamia: { intervalo: 'A1:AI1', inserirLinhas: false },
        aua: { intervalo: 'A1:V1', inserirLinhas: false },
        barbours: { intervalo: 'A1:AK1', inserirLinhas: false },
        rituaria: { intervalo: 'A1:Z1', inserirLinhas: false },
        apice: { intervalo: 'A1:AK1', inserirLinhas: true },
        yenzah: { intervalo: 'A1:AJ1', inserirLinhas: true },
        denavita: { intervalo: 'A1:AJ1', inserirLinhas: true },
    },
    cancelamento: {
        lescent: { intervalo: 'A1:N1', inserirLinhas: false },
        kokeshi: { intervalo: 'A1:I1', inserirLinhas: false },
        bysamia: { intervalo: 'A1:H1', inserirLinhas: false },
        aua: { intervalo: 'A1:H1', inserirLinhas: false },
        barbours: { intervalo: 'A1:H1', inserirLinhas: false },
        rituaria: { intervalo: 'A1:H1', inserirLinhas: false },
    },
};

const PLANILHAS: Record<AmbientePlanilha, PlanilhasDoAmbiente> = {
    prod: {
        reenvio: {
            lescent: { spreadsheetId: '18St20WjvNGgLyyl05zIg7Z8U7A6hoyguHIfBpp2N8Bk', aba: 'Respostas ao formulário' },
            kokeshi: { spreadsheetId: '1fW3mDgAyG6lmgcR9T4Kz03gWnmakpLCL9nqOe59Q1cU', aba: 'Respostas ao formulário' },
            bysamia: { spreadsheetId: '1K1Ba634eA-Ewrm_UoPYk1V7GTi0ZM3n9jCdIRXry5tc', aba: 'Respostas ao formulário' },
            aua: { spreadsheetId: '191azVcoGfOY7UX0g--zim6W9mMrciO7WPx__6-MCeyk', aba: 'Respostas ao formulário 1' },
            barbours: { spreadsheetId: '15XKeR-m2X_anXTANqk45xa0BfDh1GhEWLyIyjdnxuwc', aba: 'Respostas ao formulário' },
            rituaria: { spreadsheetId: '1LndlqC401QU0QO1xyoAqtgpH4L5kMbtdK-aO4bBCVqk', aba: 'Respostas ao formulário' },
            apice: { spreadsheetId: '1Zc2EAu94ul9qXvjWV7ogSRcHSmpqbBHi-E1MovAHOg8', aba: 'Respostas ao formulário' },
            yenzah: { spreadsheetId: '1alur0W_rS2Q4b7pTnGupHAW4xmtWkof6_pNrz3bIqSQ', aba: 'Respostas ao formulário 1' },
            denavita: { spreadsheetId: '1eCZ-joIpcPkUNdVJizdDbDdfM8T0TANEw7VBY7OhDE0', aba: 'Respostas ao formulário 1' },
        },
        reembolso: {
            lescent: { spreadsheetId: '1xk1Dtb_n_nl0xsVSDc8rWpDzQ8H_dQ4iKQmmE8bpSEM', aba: 'Respostas ao formulário' },
            kokeshi: { spreadsheetId: '1JObnj5bF9bxD-ZawsiCVfkoxRK4Ch8_xheoD-deOSF8', aba: 'Respostas ao formulário' },
            bysamia: { spreadsheetId: '1zmTPFWXrLAFeOi9oIibx5nPIqzElU93NkczI-cowvyo', aba: 'Respostas ao formulário 1' },
            aua: { spreadsheetId: '1x1hNL-jFqrIimjvqYRTEKT2n2s30ndj7tFJ3zBlunXw', aba: 'Respostas ao formulário 1' },
            barbours: { spreadsheetId: '1SUwnIMyuWsA7vgvIaeOLOmkHoMfa47Ayy_7kgkiA3VM', aba: 'Respostas ao formulário' },
            rituaria: { spreadsheetId: '1L5piyJ0mVLSB2H2UNf-tUdqM3Wm__SR2i4MVY4w01Dg', aba: 'Respostas ao formulário 1' },
            // A aba da Ápice tem um espaço no fim do nome — é assim mesmo na planilha.
            apice: { spreadsheetId: '1vwOdSLz0yOlZsGbYtO5hGfJ3F9F--FE9yxFmdiYtVSE', aba: 'Respostas ao formulário ' },
            yenzah: { spreadsheetId: '1rp-pFOtgpy7RHGTS92DexHQgVT6NvvoBuu2ArpjQwaw', aba: 'Respostas ao formulário 1' },
            denavita: { spreadsheetId: '1P5ZQcX3ckkgydOXjDB8EfGP8RPcOiNPJkEf3xRyF8NU', aba: 'Respostas ao formulário 1' },
        },
        cancelamento: {
            lescent: { spreadsheetId: '1XScJUs0sX5cD6EQ4kkARg-5Euf_L_VPXMa8UEt07Myw', aba: 'Respostas ao formulário 1' },
            kokeshi: { spreadsheetId: '1-LPBV8mjSMbu_pkWdydwRySuGZpVSosEoLi1E_cBMDM', aba: 'Respostas ao formulário 1' },
            bysamia: { spreadsheetId: '146aTwxUsKze0PwUrnEt6ht9QbPl2Sya_x902v2-OMXI', aba: 'Respostas ao formulário 1' },
            aua: { spreadsheetId: '1BDOYDbJGya-SueCTrcqvryR9h-23ULPBX27d_-qYgYg', aba: 'Respostas ao formulário 1' },
            barbours: { spreadsheetId: '11OA0VbDTOhGM5vQkYCB9dfZAWUNeF_s76n23ZcxNxWk', aba: 'Respostas ao formulário 1' },
            rituaria: { spreadsheetId: '1QdUnQMHwlSiXczmJqKhiRdh4LHiWXeFQhH1vO06PEBM', aba: 'Respostas ao formulário 1' },
        },
    },
    staging: {
        reenvio: {
            lescent: { spreadsheetId: '1KBDSEHAko9rnyps-omztQ91-uRt94UEDb6X-NR98fkM', aba: 'Respostas ao formulário' },
            kokeshi: { spreadsheetId: '1-0_cDAaoAVUWXTLnN1nC3uxDxhNwrun6r9zPA45YEVs', aba: 'Respostas ao formulário' },
            bysamia: { spreadsheetId: '1z1OabAN8z6RP78p8dhsBBKi6TJX2Ek2pEYspx5s3NoE', aba: 'Respostas ao formulário' },
            aua: { spreadsheetId: '1ULWNE_DITYPAmBGG4OVXwuyFbae1uvscj6ION-0LtH4', aba: 'Respostas ao formulário 1' },
            barbours: { spreadsheetId: '17Cwkrcu9dPiyn1oRBLS4fn9v_eyqswBxDEuvAdBEQj8', aba: 'Respostas ao formulário teste' },
            rituaria: { spreadsheetId: '1U3GlpmbMgtjC0wxaNTvKmvRPX5BuNoCoVc9g_6chAj0', aba: 'Respostas ao formulário teste' },
        },
        reembolso: {
            lescent: { spreadsheetId: '1VntzggmwTnR2ajaUdjWVyKsKjtm70a4_s_TshIwMKo8', aba: 'Respostas ao formulário' },
            kokeshi: { spreadsheetId: '17KUPzjTipn2_5aMFVsSyvYN-94Zw0ZrK4zwSS_5ORwo', aba: 'Respostas ao formulário' },
            bysamia: { spreadsheetId: '1Aq6evn_xdXD4mD_SeXADHUiPyd5FxJDnJH0jR_sUpKg', aba: 'Respostas ao formulário' },
            aua: { spreadsheetId: '1wQ8jkgY1hKTmP-lYDJdu4pQz7m5NbXsAUM9K_yQhOrQ', aba: 'Respostas ao formulário 1' },
            barbours: { spreadsheetId: '15JtHOctVfz4R1_X9TgwH6XkjjV9v8QE2va2GR_v4f38', aba: 'Respostas ao formulário' },
            rituaria: { spreadsheetId: '1vbK01C8FbCPmvfxL_NdjwFqDIlA6hFQ07bwkyrvCrpI', aba: 'Respostas ao formulário 1 teste' },
        },
        cancelamento: {
            lescent: { spreadsheetId: '1dtsUpvY8AHkhySUnDpnqEH7UupM167KHL5Q_Wu-6fDk', aba: 'Respostas ao formulário 1' },
            kokeshi: { spreadsheetId: '1flny_dck0Tw2YmghNlyWakcNBZjCC6Te58IXfO14MKU', aba: 'Respostas ao formulário 1' },
            bysamia: { spreadsheetId: '1kkiwA6HI6Mbww2Y0ey2JU9nUzsSllFizWkI-EIQ_gIo', aba: 'Respostas ao formulário 1' },
            aua: { spreadsheetId: '12BaKSnugv1hglX7K89pWkaRPwVnGnLhiqx9ZMZiiv_Y', aba: 'Respostas ao formulário 1' },
            barbours: { spreadsheetId: '1ObF-doTABE8JNM2-kIk4KTg-Q2ZAwhjwdd2xz8-RIbo', aba: 'Respostas ao formulário 1' },
            rituaria: { spreadsheetId: '1U8Zly5NtJsb2U5wZzVI-gCh8s3Cf_oympcOfwkNISSA', aba: 'Respostas ao formulário 1' },
        },
    },
};

/** Lança se `SHEETS_ENV` não for `prod` ou `staging` — falha fechada (ver `AmbientePlanilha`). */
export function ambienteDasPlanilhas(): AmbientePlanilha {
    const valor = process.env.SHEETS_ENV;
    if (valor === 'prod' || valor === 'staging') return valor;
    throw new Error(
        `[Sheets] SHEETS_ENV inválida (${valor === undefined ? 'ausente' : `"${valor}"`}): use "prod" ou "staging"`
    );
}

/**
 * A planilha de um fluxo e marca no ambiente. **Lança** quando não há (o cancelamento das marcas sem Cosmos, ou a
 * cópia de staging que ainda não existe): nunca cai numa planilha de outra marca ou de outro ambiente.
 */
export function resolverPlanilha(
    fluxo: FluxoPlanilha,
    brand: MarcaCxHub,
    ambiente: AmbientePlanilha = ambienteDasPlanilhas()
): PlanilhaDestino {
    const planilha = (PLANILHAS[ambiente][fluxo] as Partial<Record<MarcaCxHub, Planilha>>)[brand];
    const ancora = (ANCORAS[fluxo] as Partial<Record<MarcaCxHub, Ancora>>)[brand];
    if (!planilha || !ancora) {
        throw new Error(`[Sheets] não há planilha de ${fluxo} da marca ${brand} em ${ambiente}`);
    }
    return { ...planilha, ...ancora };
}

/**
 * `null` quando o fluxo da marca tem planilha no ambiente; senão, o porquê. É o que os `process*` conferem na
 * configuração, antes do dedup e da fila: sem planilha, nada é registrado (ADR-010 — a fila e a planilha andam juntas).
 */
export function planilhaQueFalta(fluxo: FluxoPlanilha, brand: MarcaCxHub): string | null {
    try {
        resolverPlanilha(fluxo, brand);
        return null;
    } catch (erro) {
        return erro instanceof Error ? erro.message : String(erro);
    }
}
