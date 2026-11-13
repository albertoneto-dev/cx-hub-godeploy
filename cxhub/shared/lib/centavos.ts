/**
 * Reparte `total` (centavos) proporcionalmente aos `pesos` (centavos) pelo método do maior resto: cada parte é o piso
 * da cota, e os centavos que sobram vão, um a um, às linhas de maior resto (empate: a linha que vem antes). A soma das
 * partes fecha exatamente em `total`. Tudo em inteiros, para o resultado não depender de arredondamento.
 */
export function repartirPeloMaiorResto(total: number, pesos: number[]): number[] {
    const somaDosPesos = pesos.reduce((s, p) => s + p, 0);
    if (somaDosPesos <= 0) return pesos.map(() => 0);
    const partes = pesos.map((p) => Math.floor((total * p) / somaDosPesos));
    const restos = pesos.map((p, i) => total * p - partes[i] * somaDosPesos);
    let faltam = total - partes.reduce((s, p) => s + p, 0);
    const ordem = pesos.map((_, i) => i).sort((a, b) => restos[b] - restos[a] || a - b);
    for (const i of ordem) {
        if (faltam <= 0) break;
        partes[i] += 1;
        faltam -= 1;
    }
    return partes;
}
