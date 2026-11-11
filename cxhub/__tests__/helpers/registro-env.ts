import { vi } from 'vitest';

/**
 * A configuração do registro (ADR-010, ADR-012): a fila do Metabase (o app `cx-hub`) e a conta de serviço do Google
 * (planilha). O `process*` recusa a solicitação antes do dedup e do Cosmos se faltar qualquer uma — por isso todo
 * teste que o executa precisa delas. Valores de teste: nenhum fala com nada real, e a chave é só um texto (a
 * configuração confere presença, não validade).
 */
export const REGISTRO_ENV = {
    CXHUB_FILA_URL: 'https://cx-hub.test',
    CXHUB_FILA_TOKEN: 'token-da-fila',
    GOOGLE_PLANILHAS_EMAIL: 'cxhub@projeto-teste.iam.gserviceaccount.com',
    GOOGLE_PLANILHAS_TOKEN: 'chave-de-teste',
    SHEETS_ENV: 'staging',
};

export function stubRegistroEnv(): void {
    for (const [nome, valor] of Object.entries(REGISTRO_ENV)) vi.stubEnv(nome, valor);
}

/** As variáveis cuja falta recusa o registro, com o trecho que a mensagem tem de citar. */
export const CONFIG_OBRIGATORIA: Array<[nome: string, citado: string]> = [
    ['CXHUB_FILA_URL', 'CXHUB_FILA'],
    ['CXHUB_FILA_TOKEN', 'CXHUB_FILA'],
    ['GOOGLE_PLANILHAS_EMAIL', 'GOOGLE_PLANILHAS'],
    ['GOOGLE_PLANILHAS_TOKEN', 'GOOGLE_PLANILHAS'],
    ['SHEETS_ENV', 'SHEETS_ENV'],
];
