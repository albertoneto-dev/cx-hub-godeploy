// Relógio injetável: os testes andam no tempo sem esperar (o intervalo do cron, os 7 dias da limpeza).

export interface Relogio {
  agora(): number;
}

export const relogioDoSistema: Relogio = { agora: () => Date.now() };

// No banco: ISO em UTC, que ordena como texto.
export const isoUtc = (ms: number) => new Date(ms).toISOString();

// O sufixo do dag_run_id do lote (cxhub_lote__<aaaammddThhmmss>), em UTC: 2026-11-04T13:20:05Z → 20261104T132005.
export const carimboDoLote = (ms: number) => isoUtc(ms).slice(0, 19).replace(/[-:]/g, "");
