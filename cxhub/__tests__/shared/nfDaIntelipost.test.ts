import { describe, expect, it, vi } from 'vitest';
import {
    BRAND_CODE_NA_INTELIPOST,
    nfAusente,
    nfDaIntelipost,
    sqlDaNfNaIntelipost,
} from '@shared/lib/datamart/nfDaIntelipostServer';

// A NF das marcas do Cosmos pela Intelipost (2026-11-17): o pedido do Cosmos V3 chega sem invoice_number, e a planilha
// e a gold ficavam com "-". O SH52988BS (BySamia) tem a NF 001834451 na Intelipost.

const AGORA = 1_000_000;
const PRAZO = AGORA + 10_000;
const deps = (consultar: (sql: string, opcoes?: { timeoutMs?: number }) => Promise<unknown[][]>) =>
    ({ consultar: vi.fn(consultar), agora: () => AGORA });

describe('nfAusente', () => {
    it.each([['-'], [''], ['  '], [null], [undefined], ['na'], ['NA'], ['n/a'], ['0'], ['000']])('"%s" é NF ausente', (nf) => {
        expect(nfAusente(nf as string | null | undefined)).toBe(true);
    });

    it.each([['1834451'], ['001834451'], ['104929']])('"%s" é NF', (nf) => {
        expect(nfAusente(nf)).toBe(false);
    });
});

describe('sqlDaNfNaIntelipost', () => {
    it('lê pelo índice (shopify_order_number, brand_code), da primeira remessa à última', () => {
        expect(sqlDaNfNaIntelipost('by_samia', '52988')).toBe(
            "select invoice_number from gold.fct_intelipost_orders\nwhere shopify_order_number = '52988' and brand_code = 'by_samia'\norder by created_iso limit 10",
        );
    });

    it('a BySamia é a única marca do Cosmos com brand_code diferente do id', () => {
        expect(BRAND_CODE_NA_INTELIPOST).toEqual({
            lescent: 'lescent', kokeshi: 'kokeshi', bysamia: 'by_samia', aua: 'aua', barbours: 'barbours', rituaria: 'rituaria',
        });
    });
});

describe('nfDaIntelipost', () => {
    it('a NF da primeira remessa, sem os zeros à esquerda', async () => {
        const d = deps(async () => [['001834451'], ['001899999']]);
        expect(await nfDaIntelipost('bysamia', 'SH52988BS', PRAZO, d)).toBe('1834451');
        expect(d.consultar).toHaveBeenCalledWith(sqlDaNfNaIntelipost('by_samia', '52988'), { timeoutMs: 5_000 });
    });

    it('o teto da consulta é o que sobra do prazo, se for menos de 5 s', async () => {
        const d = deps(async () => [['001834451']]);
        await nfDaIntelipost('lescent', 'SH52988LC', AGORA + 2_000, d);
        expect(d.consultar.mock.calls[0][1]).toEqual({ timeoutMs: 2_000 });
    });

    it.each([
        ['sem remessa', [] as unknown[][]],
        ['remessa ainda sem NF', [[null]]],
        ['NF em branco', [['  ']]],
        ['NF fora do formato', [['NF-123']]],
    ])('%s: null (fica a NF que veio)', async (_caso, linhas) => {
        expect(await nfDaIntelipost('barbours', 'SH2813130BB', PRAZO, deps(async () => linhas))).toBeNull();
    });

    it('Data Mart fora: null, sem lançar', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = deps(async () => { throw new Error('Metabase 502'); });
        await expect(nfDaIntelipost('rituaria', 'SH1398512RT', PRAZO, d)).resolves.toBeNull();
        vi.restoreAllMocks();
    });

    it('sem prazo ou com o número fora do formato, nem consulta', async () => {
        const d = deps(async () => [['001834451']]);
        expect(await nfDaIntelipost('kokeshi', 'SH1595343KS', AGORA + 100, d)).toBeNull();
        expect(await nfDaIntelipost('kokeshi', 'sem número', PRAZO, d)).toBeNull();
        expect(d.consultar).not.toHaveBeenCalled();
    });
});
