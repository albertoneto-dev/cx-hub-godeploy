/** Índice 0-based da coluna → letra do A1: 0 → `A`, 25 → `Z`, 26 → `AA`. */
export function letraDaColuna(indice: number): string {
    let letra = '';
    for (let n = indice + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        letra = String.fromCharCode(65 + ((n - 1) % 26)) + letra;
    }
    return letra;
}

/**
 * O número da linha (1 = cabeçalho) de um intervalo A1 de uma linha só, como o `updates.updatedRange` que o
 * `values:append` devolve (`'Respostas ao formulário 1'!A1235:Y1235` → 1235). `null` se o intervalo não tem linha, ou
 * se cobre mais de uma (não dá para saber qual é a da solicitação).
 */
export function linhaDoIntervalo(intervalo: string | null | undefined): number | null {
    if (!intervalo) return null;
    // O nome da aba vem antes do último `!` e pode ter qualquer caractere; o que interessa é a parte das células.
    const celulas = intervalo.slice(intervalo.lastIndexOf('!') + 1);
    const m = /^\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?$/.exec(celulas.trim());
    if (!m) return null;
    const inicio = Number(m[1]);
    const fim = m[2] === undefined ? inicio : Number(m[2]);
    return inicio === fim && inicio > 0 ? inicio : null;
}
