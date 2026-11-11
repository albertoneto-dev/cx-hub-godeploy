import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configuracaoQueFalta, prazoDaRequisicao } from '@shared/lib/backendDireto';
import { stubRegistroEnv } from '../helpers/registro-env';

describe('prazoDaRequisicao', () => {
    const AGORA = Date.parse('2026-10-29T12:00:00.000Z');

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(AGORA);
        vi.stubEnv('TIMEOUT', undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('o timeout de quem chama ganha da env', () => {
        vi.stubEnv('TIMEOUT', '30000');
        expect(prazoDaRequisicao(2_500)).toBe(AGORA + 2_500);
    });

    it('sem o timeout de quem chama, usa a env TIMEOUT', () => {
        vi.stubEnv('TIMEOUT', '7000');
        expect(prazoDaRequisicao()).toBe(AGORA + 7_000);
    });

    it('sem nenhum dos dois, 10 s', () => {
        expect(prazoDaRequisicao()).toBe(AGORA + 10_000);
    });

    it.each(['', 'abc', '0'])('TIMEOUT vazio, ilegível ou zero (%j) ⇒ 10 s', (valor) => {
        vi.stubEnv('TIMEOUT', valor);
        expect(prazoDaRequisicao()).toBe(AGORA + 10_000);
    });

    it('conta de agora: é um instante, não uma duração', () => {
        vi.setSystemTime(AGORA + 60_000);
        expect(prazoDaRequisicao(1_000)).toBe(AGORA + 61_000);
    });
});

describe('configuracaoQueFalta', () => {
    beforeEach(() => stubRegistroEnv());
    afterEach(() => vi.unstubAllEnvs());

    it('fila do Metabase e planilha (Google) configuradas ⇒ null', () => {
        expect(configuracaoQueFalta()).toBeNull();
    });

    it('a chave do gateway do GoDeploy não é obrigatória (o app local não tem gateway)', () => {
        vi.stubEnv('CXHUB_FILA_GODEPLOY_KEY', '');
        expect(configuracaoQueFalta()).toBeNull();
    });

    it.each(['CXHUB_FILA_URL', 'CXHUB_FILA_TOKEN'])('sem %s ⇒ diz que a fila não está configurada', (nome) => {
        vi.stubEnv(nome, '');
        expect(configuracaoQueFalta()).toBe('a fila do Metabase não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)');
    });

    it('o Airflow não é mais conferido aqui: quem dispara a DAG é o app da fila (ADR-012)', () => {
        vi.stubEnv('AIRFLOW_BASE_URL', '');
        vi.stubEnv('AIRFLOW_USER', '');
        vi.stubEnv('AIRFLOW_PASSWORD', '');
        expect(configuracaoQueFalta()).toBeNull();
    });

    it.each(['GOOGLE_PLANILHAS_EMAIL', 'GOOGLE_PLANILHAS_TOKEN', 'SHEETS_ENV'])('sem %s ⇒ diz que as planilhas não estão configuradas', (nome) => {
        vi.stubEnv(nome, '');
        expect(configuracaoQueFalta()).toBe('as planilhas não estão configuradas (GOOGLE_PLANILHAS_EMAIL, GOOGLE_PLANILHAS_TOKEN e SHEETS_ENV)');
    });

    it('faltando as duas, a fila vem primeiro', () => {
        vi.stubEnv('CXHUB_FILA_TOKEN', '');
        vi.stubEnv('SHEETS_ENV', '');
        expect(configuracaoQueFalta()).toContain('fila do Metabase');
    });
});
