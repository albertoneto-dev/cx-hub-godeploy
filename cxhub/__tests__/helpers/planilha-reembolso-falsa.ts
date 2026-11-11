import type { SupportedBrand } from '@shared/lib/constants';
import { formatarCarimboSP } from '@shared/lib/format';
import { distanciaAoCaso, type CasoNaPlanilha } from '@shared/lib/sheets/casoNaPlanilha';
import type { CelulaDaPlanilha, PlanilhaDoReembolso } from '@modules/reembolsos/actions/refundSheetPort';

/**
 * A planilha de reembolso em memória, para os testes da gestão: implementa o `PlanilhaDoReembolso` sem nenhuma
 * chamada de rede. Cada marca é uma aba, com o cabeçalho na linha 1 e os casos a partir da 2. Cada linha guarda o
 * pedido e o instante em que foi criada (o carimbo dela), e a busca usa a MESMA regra de produção
 * (`distanciaAoCaso`: o pedido pelos dígitos e o carimbo a até 2 min do `criado_em`, a mais próxima vence). Guarda as
 * escritas para o teste conferir o que foi (e o que não foi) tocado, e o `prazo` de cada chamada para provar que a
 * gestão o repassa.
 */

/** O pedido e o `criado_em` do caso de exemplo dos testes da gestão. */
export const PEDIDO_EXEMPLO = 'SH9000105LC';
export const CRIADO_EM_EXEMPLO = new Date('2026-10-28T13:00:00Z');

export interface EscritaNaPlanilha {
    marca: SupportedBrand;
    linha: number;
    coluna: number;
    valor: CelulaDaPlanilha;
}

interface Aba {
    cabecalho: CelulaDaPlanilha[];
    /** Índice 0 = linha 2 da planilha. */
    linhas: { caso: CasoNaPlanilha; valores: CelulaDaPlanilha[] }[];
}

export type MetodoDaPlanilha = keyof PlanilhaDoReembolso;

export class PlanilhaFalsa implements PlanilhaDoReembolso {
    readonly escritas: EscritaNaPlanilha[] = [];
    readonly chamadas: MetodoDaPlanilha[] = [];
    /** O `prazo` recebido em cada chamada, na ordem. */
    readonly prazos: number[] = [];
    /** Os casos que `acharLinhaDoCaso` recebeu, na ordem. */
    readonly casosProcurados: CasoNaPlanilha[] = [];
    /** Métodos que lançam, para simular a planilha fora do ar. */
    falhaEm = new Set<MetodoDaPlanilha>();
    private abas = new Map<SupportedBrand, Aba>();

    adicionarAba(marca: SupportedBrand, cabecalho: CelulaDaPlanilha[]): this {
        this.abas.set(marca, { cabecalho, linhas: [] });
        return this;
    }

    /**
     * Acrescenta a linha de um caso (por padrão, o de exemplo); devolve o número da linha na planilha (1 = cabeçalho).
     * `caso` é o pedido e o instante de criação que a linha tem: é por eles que a busca a acha.
     */
    adicionarCaso(
        marca: SupportedBrand,
        valores: CelulaDaPlanilha[],
        caso: CasoNaPlanilha = { pedido: PEDIDO_EXEMPLO, criadoEm: CRIADO_EM_EXEMPLO },
    ): number {
        const aba = this.aba(marca);
        aba.linhas.push({ caso, valores });
        return aba.linhas.length + 1;
    }

    /** O que a planilha tem hoje numa linha, já com as escritas aplicadas. */
    valoresDaLinha(marca: SupportedBrand, linha: number): CelulaDaPlanilha[] {
        return [...this.aba(marca).linhas[linha - 2].valores];
    }

    private aba(marca: SupportedBrand): Aba {
        const aba = this.abas.get(marca);
        if (!aba) throw new Error(`aba de ${marca} não montada no teste`);
        return aba;
    }

    private chamar(metodo: MetodoDaPlanilha, prazo: number) {
        this.chamadas.push(metodo);
        this.prazos.push(prazo);
        if (this.falhaEm.has(metodo)) throw new Error(`planilha falsa: ${metodo} falhou`);
    }

    async acharLinhaDoCaso(marca: SupportedBrand, caso: CasoNaPlanilha, prazo: number): Promise<number | null> {
        this.chamar('acharLinhaDoCaso', prazo);
        this.casosProcurados.push(caso);
        let melhor: { linha: number; distancia: number } | null = null;
        this.aba(marca).linhas.forEach(({ caso: daLinha }, indice) => {
            const distancia = distanciaAoCaso({ carimbo: formatarCarimboSP(daLinha.criadoEm), pedido: daLinha.pedido }, caso);
            if (distancia !== null && (melhor === null || distancia < melhor.distancia)) melhor = { linha: indice + 2, distancia };
        });
        return (melhor as { linha: number } | null)?.linha ?? null;
    }

    async lerCabecalho(marca: SupportedBrand, prazo: number): Promise<CelulaDaPlanilha[]> {
        this.chamar('lerCabecalho', prazo);
        return [...this.aba(marca).cabecalho];
    }

    async lerLinha(marca: SupportedBrand, linha: number, prazo: number): Promise<CelulaDaPlanilha[]> {
        this.chamar('lerLinha', prazo);
        return this.valoresDaLinha(marca, linha);
    }

    async atualizarCelulas(
        marca: SupportedBrand,
        alteracoes: { linha: number; coluna: number; valor: CelulaDaPlanilha }[],
        prazo: number,
    ): Promise<void> {
        this.chamar('atualizarCelulas', prazo);
        for (const { linha, coluna, valor } of alteracoes) {
            const valores = this.aba(marca).linhas[linha - 2].valores;
            while (valores.length <= coluna) valores.push(null);
            valores[coluna] = valor;
            this.escritas.push({ marca, linha, coluna, valor });
        }
    }
}
