// Relógio injetável (os testes andam no tempo sem esperar) e as conversões de hora que o app usa.

export interface Relogio {
  agora(): number;
}

export const relogioDoSistema: Relogio = { agora: () => Date.now() };

export const MINUTO = 60_000;
export const HORA = 60 * MINUTO;
export const DIA = 24 * HORA;

// No banco: ISO em UTC, que ordena como texto.
export const isoUtc = (ms: number) => new Date(ms).toISOString();

// O sufixo do dag_run_id do lote (cxhub_backoffice__<aaaammddThhmmss>), em UTC.
export const carimboDoLote = (ms: number) => isoUtc(ms).slice(0, 19).replace(/[-:]/g, "");

// Hora de São Paulo sem fuso ("2026-11-10T14:05:03"): a mesma convenção da data_solicitacao da gold. O Brasil não tem
// horário de verão desde 2019, então o fuso é sempre UTC−3.
export const horaSP = (ms: number) => isoUtc(ms - 3 * HORA).slice(0, 19);

// O dia em São Paulo (aaaa-mm-dd).
export const diaSP = (ms: number) => horaSP(ms).slice(0, 10);
