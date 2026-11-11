import type { MarcaComPlanilha, MarcaCxHub, SupportedBrand } from '../constants';
import { letraDaColuna } from './a1';
import { CABECALHO_ESPERADO, divergenciaNoCabecalho } from './cabecalhos';
import { SheetsError, lerAba, lerIntervalos } from './server';
import { resolverPlanilha } from './targets';
import type { FluxoPlanilha, SheetCell } from './types';

/**
 * Como o CX Hub acha, na planilha da marca, a linha de um caso: **pelo número do pedido (só os dígitos) e pelo
 * carimbo de data/hora a até 2 minutos do `criado_em` do caso** (ADR-010). Não há coluna de id: o carimbo que o CX Hub
 * escreve na linha é o próprio `criado_em` (o mesmo instante que vai para a gold), e é ele, junto do pedido, que
 * identifica o caso.
 *
 * Duas coisas dependem disto: a **idempotência** da gravação (antes de cada tentativa de append, se a linha já está
 * lá, não se anexa de novo) e a **gestão do reembolso** (cancelar, editar, concluir e sincronizar reescrevem ou
 * leem a linha do caso).
 *
 * - **Só duas colunas são lidas** — a do carimbo e a do pedido, nunca a aba inteira (nome e endereço de toda cliente) —,
 *   e **numa requisição só** (`values:batchGet`, `lerIntervalos`): a conta de serviço é uma só para todas as marcas, e
 *   a cota de leitura do Google conta requisições.
 * - **Onde estão:** o `COLUNAS_DO_CASO` é o layout em que cada `build*Row` escreve (um teste amarra os dois), e o
 *   cabeçalho da linha 1 é conferido contra ele: se a coluna do carimbo não tem cara de carimbo, ou a do pedido não
 *   tem "pedido" no nome, alguém mexeu nas colunas — e a linha que o CX Hub escreve cairia em colunas trocadas. Aí a
 *   busca falha em vez de adivinhar.
 * - **Mais de uma linha** do mesmo pedido dentro da janela: vale a de carimbo mais próximo. **Nenhuma** ⇒ `null`.
 *
 * ⚠️ A parte que fala com o Google (`acharLinhaDoCaso`, `lerColunasDosCasos`) é server-only: este arquivo fica **fora do
 * barrel** de `shared/lib/sheets`. As funções puras (`lerCarimbo`, `distanciaAoCaso`, `linhasDosCasos`) podem ser
 * testadas à parte.
 */

/** A janela em que o carimbo da linha e o `criado_em` do caso são o mesmo instante: 2 minutos para cada lado. */
export const TOLERANCIA_CARIMBO_MS = 120_000;

/** O caso que se procura: o pedido e o instante em que o CX Hub o criou (o `criado_em` da gold). */
export interface CasoNaPlanilha {
    /** O número do pedido como estiver (`SH9000105LC`, `#9000105`): só os dígitos entram na comparação. */
    pedido: string;
    criadoEm: Date;
}

/** Em que colunas (índices 0-based) a linha de um caso tem o carimbo e o pedido. */
export interface ColunasDoCaso {
    carimbo: number;
    pedido: number;
}

/**
 * O layout de cada `build*Row`, por fluxo e marca. O carimbo é sempre a coluna A; o pedido varia, e **não é
 * inventado aqui**: é onde `buildResendRow`, `buildRefundRow` e `buildCancellationRow` o escrevem — o
 * `casoNaPlanilha.test.ts` monta uma linha com cada builder e confere que o carimbo e o pedido caem nestes índices.
 */
export const COLUNAS_DO_CASO: {
    reenvio: Record<MarcaComPlanilha, ColunasDoCaso>;
    reembolso: Record<MarcaComPlanilha, ColunasDoCaso>;
    /** Só as marcas do Cosmos: as sem Cosmos não cancelam pelo CX Hub (ADR-013). */
    cancelamento: Record<SupportedBrand, ColunasDoCaso>;
} = {
    reenvio: {
        lescent: { carimbo: 0, pedido: 4 },
        kokeshi: { carimbo: 0, pedido: 6 },
        bysamia: { carimbo: 0, pedido: 8 },
        aua: { carimbo: 0, pedido: 8 },
        barbours: { carimbo: 0, pedido: 8 },
        rituaria: { carimbo: 0, pedido: 9 },
        apice: { carimbo: 0, pedido: 8 },
        yenzah: { carimbo: 0, pedido: 8 },
        denavita: { carimbo: 0, pedido: 9 },
    },
    reembolso: {
        lescent: { carimbo: 0, pedido: 4 },
        kokeshi: { carimbo: 0, pedido: 4 },
        bysamia: { carimbo: 0, pedido: 9 },
        aua: { carimbo: 0, pedido: 9 },
        barbours: { carimbo: 0, pedido: 7 },
        rituaria: { carimbo: 0, pedido: 8 },
        apice: { carimbo: 0, pedido: 7 },
        yenzah: { carimbo: 0, pedido: 7 },
        denavita: { carimbo: 0, pedido: 9 },
    },
    cancelamento: {
        lescent: { carimbo: 0, pedido: 4 },
        kokeshi: { carimbo: 0, pedido: 4 },
        bysamia: { carimbo: 0, pedido: 3 },
        aua: { carimbo: 0, pedido: 3 },
        barbours: { carimbo: 0, pedido: 3 },
        rituaria: { carimbo: 0, pedido: 5 },
    },
};

/** O layout do caso no fluxo e marca. Lança quando o fluxo não existe para a marca (o cancelamento das sem Cosmos). */
export function colunasDoLayout(fluxo: FluxoPlanilha, marca: MarcaCxHub): ColunasDoCaso {
    const colunas = (COLUNAS_DO_CASO[fluxo] as Partial<Record<MarcaCxHub, ColunasDoCaso>>)[marca];
    if (!colunas) throw new SheetsError(`[Planilha] não há layout de ${fluxo} da marca ${marca}`, false);
    return colunas;
}

// ─── Funções puras ───────────────────────────────────────────────────

/** São Paulo não tem horário de verão desde 2019 — UTC−3 fixo. */
const OFFSET_SP_MS = 3 * 60 * 60 * 1000;
/** Dias entre a época do Sheets (30/12/1899) e a do Unix (01/01/1970). */
const EPOCA_SHEETS_EM_DIAS = 25569;
const MS_POR_DIA = 86_400_000;

/** `dd/mm/aaaa` com hora opcional (`hh:mm[:ss]`, com ou sem vírgula entre as duas), como a planilha mostra o carimbo. */
const CARIMBO_EM_TEXTO = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/;

/**
 * O instante (ms desde 1970) de um carimbo lido da planilha, ou `null` se a célula não for um carimbo. Os carimbos
 * são hora de **São Paulo**. Aceita as formas em que ele chega:
 * - **número serial** — a coluna é de data e o Sheets guardou o dia e a hora de parede (SP), como na leitura sem
 *   formatação (`UNFORMATTED_VALUE` + `SERIAL_NUMBER`);
 * - **texto** `dd/mm/aaaa hh:mm:ss` (e `hh:mm`), como o `formatarCarimboSP` escreve e a planilha mostra;
 * - **texto** `dd/mm/aaaa`, sem hora: vale meia-noite.
 *
 * Vazio, texto de outro formato ou data que não existe ⇒ `null`: é isso que faz uma linha em branco nunca casar.
 */
export function lerCarimbo(celula: SheetCell | undefined): number | null {
    if (typeof celula === 'number') {
        return Number.isFinite(celula) ? Math.round((celula - EPOCA_SHEETS_EM_DIAS) * MS_POR_DIA) + OFFSET_SP_MS : null;
    }
    if (typeof celula !== 'string') return null;

    const m = CARIMBO_EM_TEXTO.exec(celula.trim());
    if (!m) return null;
    // Os grupos da hora que não participaram do casamento vêm `undefined`: sem hora, vale meia-noite.
    const [dia, mes, ano, hora, minuto, segundo] = m.slice(1).map((parte) => (parte === undefined ? 0 : Number(parte)));
    const parede = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto, segundo));
    // Dia, mês ou hora que não existem (31/02, 25:00) fariam a data "rolar": não é um carimbo.
    if (
        parede.getUTCFullYear() !== ano || parede.getUTCMonth() !== mes - 1 || parede.getUTCDate() !== dia
        || parede.getUTCHours() !== hora || parede.getUTCMinutes() !== minuto || parede.getUTCSeconds() !== segundo
    ) {
        return null;
    }
    return parede.getTime() + OFFSET_SP_MS;
}

const digitos = (celula: SheetCell | undefined): string => (celula === null || celula === undefined ? '' : String(celula)).replace(/\D/g, '');

/**
 * Diz se uma linha é a do caso: o pedido (só os dígitos) é o mesmo **e** o carimbo está a até
 * `TOLERANCIA_CARIMBO_MS` do `criado_em`. Devolve a distância em ms (a menor vence quando há mais de uma linha), ou
 * `null` quando a linha **não** é a do caso: pedido diferente, carimbo vazio ou fora do formato, fora da janela, ou
 * caso sem dígito no pedido (não há o que comparar) ou sem data válida.
 */
export function distanciaAoCaso(
    linha: { carimbo: SheetCell | undefined; pedido: SheetCell | undefined },
    caso: CasoNaPlanilha,
): number | null {
    const pedido = digitos(caso.pedido);
    const criadoEm = caso.criadoEm.getTime();
    if (!pedido || Number.isNaN(criadoEm)) return null;
    if (digitos(linha.pedido) !== pedido) return null;

    const carimbo = lerCarimbo(linha.carimbo);
    if (carimbo === null) return null;
    const distancia = Math.abs(carimbo - criadoEm);
    return distancia <= TOLERANCIA_CARIMBO_MS ? distancia : null;
}

// ─── O cabeçalho confere com o layout ────────────────────────────────

const normalizar = (celula: SheetCell | undefined): string =>
    (celula === null || celula === undefined ? '' : String(celula)).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** O cabeçalho do carimbo: o `Carimbo de data/hora` do Google Forms, ou algo com cara disso. */
const PARECE_CARIMBO = /carimbo|timestamp|data\s*\/\s*hora/;
const PARECE_PEDIDO = /pedido/;

/**
 * O cabeçalho da aba não bate com o layout em que o CX Hub escreve. Não adianta repetir: a aba só muda quando alguém a
 * arruma.
 */
export class LayoutDaPlanilhaError extends SheetsError {
    constructor(message: string) {
        super(message, false);
        this.name = 'LayoutDaPlanilhaError';
    }
}

/** O que se guarda por planilha e aba por 10 min: o cabeçalho muda raramente, e ler a linha 1 a cada busca seria uma ida a mais. */
const TTL_COLUNAS_MS = 10 * 60_000;
const colunasConferidas = new Map<string, { colunas: ColunasDoCaso; ate: number }>();

/** Só para teste — o cache é estado de módulo e vazaria entre casos. */
export function __resetCasoNaPlanilha(): void {
    colunasConferidas.clear();
}

/**
 * O layout do caso, depois de conferir o cabeçalho da aba: a coluna do carimbo tem de ter cara de carimbo e a do
 * pedido, "pedido" no nome. Se não, alguém moveu ou inseriu colunas, e a busca **falha** (`SheetsError`) em vez de
 * olhar a coluna errada — a linha que o CX Hub escreve também cairia fora do lugar. Nas planilhas das marcas sem
 * Cosmos (ADR-013) o cabeçalho é conferido **inteiro** (`cabecalhos.ts`), até a última coluna em que o CX Hub escreve.
 * Só o que confere é guardado.
 */
async function colunasDoCaso(
    fluxo: FluxoPlanilha,
    marca: MarcaCxHub,
    destino: { spreadsheetId: string; aba: string },
    prazo: number,
    retentarCota?: boolean,
): Promise<ColunasDoCaso> {
    const chave = `${fluxo}/${marca}/${destino.spreadsheetId}/${destino.aba}`;
    const guardado = colunasConferidas.get(chave);
    if (guardado && guardado.ate > Date.now()) return guardado.colunas;

    const colunas = colunasDoLayout(fluxo, marca);
    const [cabecalho = []] = await lerAba(destino.spreadsheetId, destino.aba, prazo, { intervalo: '1:1', retentarCota });

    const problemas: string[] = [];
    if (!PARECE_CARIMBO.test(normalizar(cabecalho[colunas.carimbo]))) {
        problemas.push(`a coluna ${letraDaColuna(colunas.carimbo)} (carimbo) tem o cabeçalho "${String(cabecalho[colunas.carimbo] ?? '')}"`);
    }
    if (!PARECE_PEDIDO.test(normalizar(cabecalho[colunas.pedido]))) {
        problemas.push(`a coluna ${letraDaColuna(colunas.pedido)} (pedido) tem o cabeçalho "${String(cabecalho[colunas.pedido] ?? '')}"`);
    }
    const esperado = CABECALHO_ESPERADO[fluxo]?.[marca];
    const divergencia = esperado ? divergenciaNoCabecalho(esperado, cabecalho) : null;
    if (divergencia) problemas.push(divergencia);
    if (problemas.length > 0) {
        throw new LayoutDaPlanilhaError(
            `[Planilha] o cabeçalho da aba "${destino.aba}" não bate com o layout de ${fluxo}/${marca}: ${problemas.join('; ')}`,
        );
    }

    colunasConferidas.set(chave, { colunas, ate: Date.now() + TTL_COLUNAS_MS });
    return colunas;
}

// ─── Ler as duas colunas ─────────────────────────────────────────────

/** As colunas do carimbo e do pedido da aba, uma célula por linha: o índice 0 é a linha 1 (o cabeçalho). */
export interface ColunasLidas {
    carimbos: SheetCell[];
    pedidos: SheetCell[];
}

/**
 * Lê as duas colunas que acham um caso na aba — a do carimbo e a do pedido, numa requisição só (`lerIntervalos`) —,
 * depois de conferir o cabeçalho contra o layout (`colunasDoCaso`). Nunca a aba inteira. Erro do Google ou cabeçalho
 * que não confere **sobem** (`SheetsError`, `LayoutDaPlanilhaError`).
 *
 * `retentarCota: false` é o da lista (`presencaNaPlanilha.ts`): a cota estourada falha na hora, em vez de esperar.
 */
export async function lerColunasDosCasos(
    fluxo: FluxoPlanilha,
    marca: MarcaCxHub,
    prazo: number,
    opcoes: { retentarCota?: boolean } = {},
): Promise<ColunasLidas> {
    const destino = resolverPlanilha(fluxo, marca);
    const colunas = await colunasDoCaso(fluxo, marca, destino, prazo, opcoes.retentarCota);
    const recorte = (indice: number) => `${letraDaColuna(indice)}:${letraDaColuna(indice)}`;
    const [carimbos, pedidos] = await lerIntervalos(
        destino.spreadsheetId,
        destino.aba,
        [recorte(colunas.carimbo), recorte(colunas.pedido)],
        prazo,
        opcoes,
    );
    // A linha vazia vem como `[]`: a célula dela fica `null`, que nunca casa.
    const celulas = (linhas: SheetCell[][]): SheetCell[] => linhas.map((linha) => linha?.[0] ?? null);
    return { carimbos: celulas(carimbos), pedidos: celulas(pedidos) };
}

// ─── Achar a linha ───────────────────────────────────────────────────

/** O caso tem o que comparar: algum dígito no pedido e um `criado_em` válido. Sem nenhum caso assim, nem se lê a planilha. */
export function casoComparavel(caso: CasoNaPlanilha): boolean {
    return Boolean(digitos(caso.pedido)) && !Number.isNaN(caso.criadoEm.getTime());
}

/**
 * O número da linha (1 = cabeçalho) de cada caso nas colunas lidas, ou `null`, na ordem dos casos. Puro: a gravação o
 * aplica ao que acabou de ler, e a lista, também ao que guardou. Se mais de uma linha bate, vale a de carimbo mais
 * próximo do `criado_em` (no empate, a de cima).
 */
export function linhasDosCasos(colunas: ColunasLidas, casos: CasoNaPlanilha[]): (number | null)[] {
    const { carimbos, pedidos } = colunas;
    const total = Math.max(carimbos.length, pedidos.length);
    return casos.map((caso) => {
        if (!casoComparavel(caso)) return null;
        let melhor: { linha: number; distancia: number } | null = null;
        // O recorte `X:X` começa na linha 1 (o cabeçalho): os dados começam no índice 1, e o índice mais 1 é o número da linha.
        for (let i = 1; i < total; i++) {
            const distancia = distanciaAoCaso({ carimbo: carimbos[i], pedido: pedidos[i] }, caso);
            if (distancia !== null && (melhor === null || distancia < melhor.distancia)) melhor = { linha: i + 1, distancia };
        }
        return melhor?.linha ?? null;
    });
}

/**
 * O número da linha (1 = cabeçalho) do caso na planilha da marca, ou `null` se não há. Lê só a coluna do carimbo e a
 * do pedido. Se mais de uma linha bate, vale a de carimbo mais próximo do `criado_em`. Erro do Google ou cabeçalho
 * que não confere com o layout **sobem** (`SheetsError`): "não achei" e "não consegui olhar" são coisas diferentes, e
 * quem grava não pode tratar a segunda como a primeira.
 */
export async function acharLinhaDoCaso(
    fluxo: FluxoPlanilha,
    marca: MarcaCxHub,
    caso: CasoNaPlanilha,
    prazo: number,
): Promise<number | null> {
    const [linha] = await acharLinhasDosCasos(fluxo, marca, [caso], prazo);
    return linha;
}

/**
 * O `acharLinhaDoCaso` de vários casos da mesma marca com uma leitura só das duas colunas (uma requisição). Devolve um
 * número de linha (ou `null`) por caso, na mesma ordem. Erro do Google ou cabeçalho que não confere **sobem**, como no
 * `acharLinhaDoCaso`. Sem pedido (nenhum dígito) ou sem data válida não há o que comparar; sem nenhum caso comparável,
 * nem se lê a planilha.
 */
export async function acharLinhasDosCasos(
    fluxo: FluxoPlanilha,
    marca: MarcaCxHub,
    casos: CasoNaPlanilha[],
    prazo: number,
): Promise<(number | null)[]> {
    if (!casos.some(casoComparavel)) return casos.map(() => null);
    return linhasDosCasos(await lerColunasDosCasos(fluxo, marca, prazo), casos);
}
