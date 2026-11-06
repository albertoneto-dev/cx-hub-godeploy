import { defineConfig } from "vitest/config";

// Testes do worker: rodam no Node com SQLite em memória no lugar do env.DB e falsos de Airflow, Google Chat e relógio.
// O log do worker (rodadas, avisos) só aparece nos testes que falham.
export default defineConfig({
  test: { include: ["testes/**/*.test.ts"], environment: "node", silent: "passed-only" },
});
