import { describe, it, expect } from 'vitest';
import { formatAlert, ALERT_POLICY, severidadeDe, deveAvisar } from '@shared/lib/alerts';
import type { AlertContext, AlertReason } from '@shared/lib/alerts';

/**
 * A régua destes testes é o requisito que o operador escreveu com todas as letras:
 * **"não pode ser uma mensagem de erro genérica"**. Um aviso só serve se quem lê no grupo
 * consegue agir sem abrir o código — então cada caso aqui afirma a presença de algo
 * ACIONÁVEL: qual pedido, o que o sistema já tentou, e o que fazer agora.
 *
 * O outro eixo é o inverso: o que **não** pode estar no card (PII da cliente), porque o
 * espaço do Chat tem gente fora do time do CXHub.
 */

const baseCtx: AlertContext = {
    reason: 'COSMOS_UNAVAILABLE',
    motivo: 'Não foi possível consultar o Cosmos (indisponível ou mal configurado)',
    requestId: 'req_abc123',
    brand: 'lescent',
    numeroPedido: '7980847997',
};

describe('ALERT_POLICY — política por causa', () => {
    it('tem entrada para TODA causa declarada (nenhuma causa cai num default genérico)', () => {
        const causas: AlertReason[] = [
            'GATE_CLOSED', 'INVALID_PAYLOAD', 'COSMOS_UNAVAILABLE', 'ORDER_NOT_FOUND',
            'NOT_ELIGIBLE', 'CARRIER_UNRESOLVED', 'AUTOMATION_DATA_MISSING', 'CARRIER_ID_MISSING',
            'NO_RESEND_ITEMS', 'PRODUCT_ID_MISSING', 'ORDER_ADDRESS_NO_CEP',
            'NEW_ADDRESS_INCOMPLETE', 'NEW_ADDRESS_CEP_INVALID', 'AUTOMATION_OFF',
            'INTERNAL_ERROR', 'ERP_REFUSED', 'ROW_UNCERTAIN', 'TEST_MODE_VIOLATION', 'RECORD_UNAVAILABLE',
            'GOLD_UPDATE_FAILED', 'GOLD_UPDATE_NO_CASE',
            'SHEET_WRITE_FAILED', 'SHEET_ROW_NOT_FOUND',
        ];

        for (const causa of causas) {
            expect(ALERT_POLICY[causa], `falta política para ${causa}`).toBeDefined();
            expect(ALERT_POLICY[causa].titulo.length).toBeGreaterThan(0);
            expect(ALERT_POLICY[causa].acao.length).toBeGreaterThan(0);
        }
    });

    it('cada causa avisável tem um plano de ação DISTINTO — nada de texto reciclado', () => {
        const acoes = Object.entries(ALERT_POLICY)
            .filter(([, p]) => p.severidade !== 'nenhuma')
            .map(([, p]) => p.acao);

        expect(new Set(acoes).size).toBe(acoes.length);
    });
});

describe('deveAvisar — a decisão do ADR-005 §3', () => {
    it.each<AlertReason>([
        'COSMOS_UNAVAILABLE', 'INTERNAL_ERROR', 'ERP_REFUSED', 'ROW_UNCERTAIN',
        'TEST_MODE_VIOLATION', 'GATE_CLOSED', 'GOLD_UPDATE_FAILED',
        'GOLD_UPDATE_NO_CASE', 'SHEET_WRITE_FAILED', 'SHEET_ROW_NOT_FOUND',
    ])('avisa quando o sistema está quebrado: %s', (causa) => {
        expect(deveAvisar(causa)).toBe(true);
    });

    it('alteração sem caso na gold é agregada: no começo, a maioria é solicitação de antes da integração', () => {
        expect(ALERT_POLICY.GOLD_UPDATE_NO_CASE.agrupar).toBe(true);
        expect(ALERT_POLICY.GOLD_UPDATE_FAILED.agrupar).toBe(false);
    });

    it('a linha que não está na planilha (gestão do reembolso) é agregada por marca; a escrita que falhou é por caso', () => {
        expect(ALERT_POLICY.SHEET_ROW_NOT_FOUND.agrupar).toBe(true);
        expect(ALERT_POLICY.SHEET_ROW_NOT_FOUND.severidade).toBe('media');
        expect(ALERT_POLICY.SHEET_WRITE_FAILED.agrupar).toBe(false);
    });

    it('o card da linha que não está na planilha manda procurar pelo pedido e conferir o carimbo da linha', () => {
        const texto = formatAlert({
            reason: 'SHEET_ROW_NOT_FOUND',
            motivo: 'Cancelar: a linha do caso não está na planilha',
            requestId: '6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f',
            brand: 'lescent',
            numeroPedido: 'SH9000105LC',
        });

        expect(texto).toContain('SH9000105LC');
        expect(texto).toContain('carimbo');
        expect(texto).toContain('6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f');
        expect(texto).toContain('agrupados');
    });

    it.each<AlertReason>([
        'NEW_ADDRESS_INCOMPLETE', 'NEW_ADDRESS_CEP_INVALID', 'ORDER_NOT_FOUND',
        'NOT_ELIGIBLE', 'AUTOMATION_OFF',
    ])('NÃO avisa falha de dado da cliente nem sistema funcionando: %s', (causa) => {
        expect(deveAvisar(causa)).toBe(false);
        expect(severidadeDe(causa)).toBe('nenhuma');
    });

    it('trata violação do modo de teste como crítica (um reenvio pode ter saído de verdade)', () => {
        expect(severidadeDe('TEST_MODE_VIOLATION')).toBe('critica');
    });
});

describe('formatAlert — o card acionável', () => {
    it('identifica o pedido: marca, número e requestId para casar com o log e a planilha', () => {
        const texto = formatAlert(baseCtx);

        expect(texto).toContain('7980847997');
        expect(texto.toLowerCase()).toContain('lescent');
        expect(texto).toContain('req_abc123');
    });

    it('inclui o plano de ação da causa — não só o que houve', () => {
        const texto = formatAlert(baseCtx);
        expect(texto).toContain(ALERT_POLICY.COSMOS_UNAVAILABLE.acao);
    });

    it('diz o que o código JÁ TENTOU antes de desistir (é o que separa contorno de desistência)', () => {
        const texto = formatAlert({
            ...baseCtx,
            tentativas: '2 tentativas ao Cosmos; última falha: HTTP 503',
        });

        expect(texto).toContain('2 tentativas ao Cosmos');
        expect(texto).toContain('HTTP 503');
    });

    it('aponta a transportadora exata quando o mapa não a reconhece', () => {
        const texto = formatAlert({
            ...baseCtx,
            reason: 'CARRIER_UNRESOLVED',
            motivo: 'Transportadora "Anjun Express" não foi reconhecida',
            detalhe: 'Anjun Express',
        });

        expect(texto).toContain('Anjun Express');
        expect(texto).toContain('CARRIER_MAP');
    });

    it('marca o ensaio como ensaio — um card de teste não pode parecer incidente real', () => {
        const texto = formatAlert({ ...baseCtx, testMode: true });
        expect(texto).toContain('TESTE');
    });

    it('carrega a severidade de forma visível para quem varre o grupo', () => {
        const critico = formatAlert({
            ...baseCtx,
            reason: 'TEST_MODE_VIOLATION',
            motivo: 'A resposta indica reenvio real',
        });

        expect(critico).toContain(ALERT_POLICY.TEST_MODE_VIOLATION.titulo);
    });

    it('NUNCA vaza PII da cliente, mesmo se o chamador enfiar campos a mais', () => {
        const contaminado = {
            ...baseCtx,
            nomeCliente: 'Maria Aparecida da Silva',
            telefoneCliente: '11988887777',
            enderecoCliente: 'Rua das Flores, 123',
        } as AlertContext;

        const texto = formatAlert(contaminado);

        expect(texto).not.toContain('Maria');
        expect(texto).not.toContain('11988887777');
        expect(texto).not.toContain('Rua das Flores');
    });

    // O `detalhe` e o `tentativas` carregam texto livre do ERP/n8n — sistema FORA deste repo. A leitura
    // nominal protege contra um campo novo com PII; não protege contra PII passando por campo existente.
    // O espaço do Chat tem membros fora do time do CXHub (ADR-005 §5).

    it('mascara números longos que o ERP possa ecoar no detalhe (CEP, telefone, documento)', () => {
        const texto = formatAlert({
            ...baseCtx,
            detalhe: 'Falha ao entregar em 01001-000, contato 11988887777',
        });

        expect(texto).not.toContain('01001-000');
        expect(texto).not.toContain('11988887777');
        expect(texto).toContain('[número omitido]');
    });

    it('trunca texto externo longo — recusa de ERP pode vir com dump inteiro', () => {
        const texto = formatAlert({ ...baseCtx, detalhe: 'x'.repeat(5000) });

        expect(texto.length).toBeLessThan(1000);
        expect(texto).toContain('…');
    });

    it('higieniza também o campo `tentativas`, que ecoa a mensagem de erro da última falha', () => {
        const texto = formatAlert({
            ...baseCtx,
            tentativas: 'retentativa esgotada; última falha: timeout no CEP 20040-020',
        });

        expect(texto).not.toContain('20040-020');
        expect(texto).toContain('retentativa esgotada');
    });

    it('não quebra quando o pedido não tem número (caso do modo de teste sem pedido)', () => {
        const texto = formatAlert({ ...baseCtx, numeroPedido: undefined, brand: undefined });
        expect(texto.length).toBeGreaterThan(0);
        expect(texto).toContain('req_abc123');
    });
});
