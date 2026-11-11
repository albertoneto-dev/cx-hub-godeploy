// Só o que é puro (tipos e a escolha da planilha). O que fala com o Google — `./server`, `./googleAuth` e
// `./gravarLinha` — fica fora do barrel de propósito: lê segredo e manda aviso. Importe pelo caminho completo
// (`@shared/lib/sheets/gravarLinha`).
export { ambienteDasPlanilhas, planilhaQueFalta, resolverPlanilha } from './targets';
export type {
    SheetCell,
    FluxoPlanilha,
    AmbientePlanilha,
    PlanilhaDestino,
} from './types';
