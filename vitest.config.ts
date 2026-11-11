import path from "node:path";
import { defineConfig } from "vitest/config";

// Duas suítes, no Node:
//   - testes/: a fila (SQLite em memória no lugar do env.DB, falsos de Airflow, Slack e relógio) e a cola das rotas
//     do CX Hub com o Worker (api/). O log do worker só aparece nos testes que falham.
//   - cxhub/__tests__/: os testes do CX Hub que vieram junto com o código portado (cxhub/ORIGEM.md), com os aliases
//     de lá (@/, @shared/, @modules/) e o next/server trocado pelo adaptador do app.
const raiz = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  test: {
    include: ["testes/**/*.test.ts", "cxhub/__tests__/**/*.test.ts"],
    environment: "node",
    globals: true,
    silent: "passed-only",
  },
  resolve: {
    alias: {
      "@shared": raiz("cxhub/shared"),
      "@modules": raiz("cxhub/modules"),
      "@": raiz("cxhub"),
      "next/server": raiz("api/next-server.ts"),
    },
  },
});
