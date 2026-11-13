import { describe, expect, it } from 'vitest';
import { repartirPeloMaiorResto } from '@shared/lib/centavos';

const soma = (v: number[]) => v.reduce((s, p) => s + p, 0);

describe('repartirPeloMaiorResto', () => {
    it('a soma das partes fecha exatamente no total', () => {
        const partes = repartirPeloMaiorResto(10000, [3333, 3333, 3334]);
        expect(soma(partes)).toBe(10000);
        expect(soma(repartirPeloMaiorResto(1001, [7, 11, 13, 17]))).toBe(1001);
    });

    it('os centavos que sobram vão às linhas de maior resto', () => {
        // cotas 33,33 e 66,66: os pisos somam 99, e o centavo que falta vai à linha de maior resto (a segunda)
        expect(repartirPeloMaiorResto(100, [1, 2])).toEqual([33, 67]);
    });

    it('no empate de resto, o centavo vai à linha que vem antes', () => {
        expect(repartirPeloMaiorResto(1, [1, 1])).toEqual([1, 0]);
        expect(repartirPeloMaiorResto(2, [1, 1, 1])).toEqual([1, 1, 0]);
    });

    it('pesos zerados dão zeros, e peso zero não recebe nada', () => {
        expect(repartirPeloMaiorResto(500, [0, 0])).toEqual([0, 0]);
        expect(repartirPeloMaiorResto(500, [])).toEqual([]);
        expect(repartirPeloMaiorResto(500, [0, 100])).toEqual([0, 500]);
    });
});
