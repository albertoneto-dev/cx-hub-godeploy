// Só para o tsc do Worker (tsconfig.worker.json, sem os tipos do Node): o process.env que api/ambiente.ts monta a
// partir dos segredos do app. Qualquer outra API do Node (Buffer, require, node:*) continua acusada como erro.
declare var process: { env: Record<string, string | undefined> };
