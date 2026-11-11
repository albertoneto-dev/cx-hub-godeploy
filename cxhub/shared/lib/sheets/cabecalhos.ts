import type { MarcaCxHub } from '../constants';
import { letraDaColuna } from './a1';
import type { FluxoPlanilha, SheetCell } from './types';

/**
 * O cabeçalho (linha 1) que o CX Hub confere **inteiro** antes de gravar, nas planilhas das marcas sem Cosmos
 * (ADR-013): Ápice, Yenzah e Denavita, reenvio e reembolso. Lido das planilhas em 2026-11-05.
 *
 * Por que inteiro, e não só o carimbo e o pedido como nas 6 marcas do Cosmos: essas planilhas já mudaram de ordem antes
 * (as fórmulas de SLA da Yenzah e da Denavita ainda apontam para colunas de outra ordem), e uma coluna inserida
 * deslocaria a linha inteira sem erro nenhum. A conferência vai até a última coluna em que o CX Hub escreve (o
 * formulário e as fórmulas da operação); coluna nova **depois** dela não muda nada e não barra. Os espaços das pontas
 * não contam (`Observações ` e `Observações` são o mesmo cabeçalho).
 *
 * Mudou o cabeçalho na planilha de propósito? Mude aqui, no `build*Row` da marca e no `FORMULAS_DA_LINHA` — os testes
 * amarram os três.
 */
export const CABECALHO_ESPERADO: Partial<Record<FluxoPlanilha, Partial<Record<MarcaCxHub, readonly string[]>>>> = {
    reenvio: {
        apice: [
            'Carimbo de data/hora', 'Endereço de e-mail', 'Responsável :', 'Origem da reclamação', 'ID do atendimento',
            'Nome do(a) cliente:', 'Número da NF', 'Chave da NF', 'Número do pedido:', 'CD de Origem',
            'Endereço do cliente:', 'CEP', 'Estado', 'Qual produto apresentou problema?', 'Qual produto será reenviado?',
            'Qual foi o problema do produto?', 'Transportadora do pedido original', 'Número de telefone da cliente',
            'Observações', 'Pedido será devolvido para a operação?', 'ID do Ticket com a transportadora:',
            'Status do pedido', 'O reenvio é do pedido completo?', 'Qual o nº do lote do produto?', 'Rastreio',
            // Operação
            'Data solicitação', 'Prazo para execução', 'Reenvio feito', 'Valor da NF de reenvio (R$)', 'COD NFD',
            'Data de Execução', 'Status do Reenvio', 'Responsável Reenvio', 'Semana - execução', 'Semana', 'Mês', 'Ano',
            'Coluna 31', 'Custo (R$)', 'SLA',
        ],
        yenzah: [
            'Carimbo de data/hora', 'Endereço de e-mail', 'Responsável :', 'Origem da reclamação', 'ID do atendimento',
            'Nome do(a) cliente:', 'Número da NF', 'Chave da NF', 'Número do pedido:', 'CD de Origem',
            'Endereço do cliente:', 'CEP', 'Estado', 'Qual produto apresentou problema?', 'Qual produto será reenviado?',
            'Qual foi o problema do produto?', 'Transportadora do pedido original', 'Número de telefone da cliente',
            'Observações', 'Pedido será devolvido para a operação?', 'ID do Ticket com a transportadora:',
            'Status do pedido', 'O reenvio é do pedido completo?', 'Qual o nº do lote do produto?',
            // Operação
            'Data de Solicitação', 'Prazo para Execução', 'Competência', 'Reenvio Feito', 'Valor da NF de reenvio (R$)',
            'Data de Execução', 'COD NFD', 'Executor', 'Data NFD', 'Comentários Gerais', 'Status do Reenvio',
            'Semana - Execução', 'Responsável Reenvio', 'Custo (R$)', 'Semana', 'Mês', 'Ano', 'Data Hoje', 'SLA',
        ],
        denavita: [
            'Carimbo de data/hora', 'Endereço de e-mail', 'Responsável :', 'Origem da reclamação', 'ID do atendimento',
            'CD de Origem', 'Nome do(a) cliente:', 'Número da NF', 'Chave NF', 'Número do pedido:',
            'Endereço do cliente:', 'CEP', 'Estado', 'Qual produto apresentou problema?', 'Qual produto será reenviado?',
            'Observações', 'Qual foi o problema do produto?', 'Qual o nº do lote do produto?',
            'Pedido será devolvido para a operação?', 'Status do pedido', 'O reenvio é do pedido completo?',
            'Valor da NF de reenvio (R$)', 'ID do Ticket com a transportadora:', 'Transportadora do pedido original',
            'Número de telefone da cliente',
            // Operação
            'Data de Solicitação', 'Prazo para Execução', 'Competência', 'Reenvio Feito', 'Valor da NF de reenvio (R)',
            'Data de Execução', 'COD NFD', 'Executor', 'Data NFD', 'Comentários Gerais', 'Status do Reenvio',
            'Semana - Execução', 'Responsável Reenvio', 'Custo (R$)', 'Semana', 'Mês', 'Ano', 'Data Hoje', 'SLA',
        ],
    },
    reembolso: {
        apice: [
            'Carimbo de data/hora', 'Endereço de e-mail', 'Responsável:', 'Origem da reclamação', 'ID Atendimento',
            'CD de Origem', 'Nome do(a) cliente:', 'Número do pedido', 'Número da NF', 'Chave da NF',
            'Motivo da solicitação do reembolso?', 'Valor do reembolso', 'O reembolso é do frete e/ou do pedido?',
            'Transportadora do pedido original?', 'Status do pedido',
            'Prazo para o reembolso (considerar os 3 dias úteis a partir da solicitação):',
            'Pedido será devolvido para a operação?', 'ID do Ticket com a transportadora:',
            'O reembolso é do pedido completo?', 'Deseja reembolsar o pedido como exceção à política de CX?',
            'Origem do pedido', 'Recebimento - Chave Pix', 'Qual o nº do lote do produto?', 'Observações',
            // Operação
            'Data de Execução', 'Reembolso', 'NF de dev', 'COD NFD', 'Semana', 'Mês', 'Ano', 'Reembolso Feito',
            'Responsável Reembolso', 'Data', 'SLA',
        ],
        yenzah: [
            'Carimbo de data/hora', 'Endereço de e-mail', 'Responsável:', 'Origem da reclamação', 'ID Atendimento',
            'CD de Origem', 'Nome do(a) cliente:', 'Número do pedido', 'Número da NF', 'Chave da NF',
            'Motivo da solicitação do reembolso?', 'Valor do reembolso', 'O reembolso é do frete e/ou do pedido?',
            'Transportadora do pedido original?', 'Status do pedido',
            'Prazo para o reembolso (considerar os 5 dias úteis a partir da solicitação):',
            'Pedido será devolvido para a operação?', 'ID do Ticket com a transportadora:',
            'O reembolso é do pedido completo?', 'Deseja reembolsar o pedido como exceção à política de CX?',
            'Origem do pedido', 'Recebimento - Chave Pix', 'Qual o nº do lote do produto?',
            // Operação
            'Data de Execução', 'Status Reembolso', 'Responsável Reembolso', 'COD NFD', 'Executor', 'Data da NFD',
            'Comentários', 'Prazo de Execução', 'Semana', 'Mês', 'Ano', 'Competência', 'SLA',
        ],
        denavita: [
            'Carimbo de data/hora', 'Endereço de e-mail', 'Responsável:', 'Origem da reclamação', 'ID Atendimento',
            'CD de Origem', 'Nome do(a) cliente:', 'Número da NF', 'Chave da NF', 'Número do pedido',
            'Valor do reembolso', 'Recebimento - Chave Pix', 'Motivo da solicitação do reembolso?',
            'Qual o nº do lote do produto?', 'O reembolso é do frete e/ou do pedido?',
            'Pedido será devolvido para a operação?', 'ID do Ticket com a transportadora:',
            'Transportadora do pedido original?', 'Origem do pedido', 'Status do pedido',
            'O reembolso é do pedido completo?',
            'Prazo para o reembolso (considerar os 5 dias úteis a partir da solicitação):',
            'Deseja reembolsar o pedido como exceção à política de CX?',
            // Operação
            'Data de Execução', 'Status Reembolso', 'Responsável Reembolso', 'COD NFD', 'Executor', 'Data da NFD',
            'Comentários', 'Prazo de Execução', 'Semana', 'Mês', 'Ano', 'Competência', 'SLA',
        ],
    },
};

const texto = (celula: SheetCell | undefined): string => (celula === null || celula === undefined ? '' : String(celula)).trim();

/**
 * `null` quando o cabeçalho lido começa pelo esperado (comparando sem os espaços das pontas); senão, a primeira
 * coluna que diverge, em texto para o log e o aviso (cabeçalho não é dado pessoal).
 */
export function divergenciaNoCabecalho(esperado: readonly string[], lido: SheetCell[]): string | null {
    for (let i = 0; i < esperado.length; i++) {
        if (texto(lido[i]) !== esperado[i].trim()) {
            return `a coluna ${letraDaColuna(i)} tem o cabeçalho "${texto(lido[i])}", e o CX Hub espera "${esperado[i].trim()}"`;
        }
    }
    return null;
}
