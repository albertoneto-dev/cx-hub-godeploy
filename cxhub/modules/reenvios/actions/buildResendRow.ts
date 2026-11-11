import type { MarcaComPlanilha } from '../../../shared/lib/constants';
import { estadoComSigla } from '../../../shared/lib/format';
import type { SheetCell } from '../../../shared/lib/sheets/index';
import type { ResendSubmissionData } from '../types/index';

/**
 * Linha da planilha de reenvio — transcrição dos code nodes `Create <Marca> Row` do workflow
 * `[PROD] - Webhook CXHub`. O node "Data", que só renomeava os campos, foi absorvido aqui. `null` é coluna
 * que o n8n pulava (o "buraco" `[a, , b]` do array).
 *
 * Cada marca tem cabeçalho próprio, herdado do Google Forms que a planilha teve um dia — por isso nenhum
 * layout é igual ao outro, e há colunas repetidas de propósito (o "Tipo de solicitação" sai duas vezes na
 * Lescent, os comentários saem duas vezes na BySamia, Auá e Barbours).
 *
 * **O carimbo não vem mais do `timestamp` do corpo** (que o n8n copiava, hora do formulário): é o `criado_em` do caso,
 * o mesmo instante que vai para a gold, formatado por quem monta a linha (ADR-010). É por ele e pelo pedido que o CX
 * Hub acha esta linha depois (`casoNaPlanilha.ts`).
 */

/** O node "Data" tirava o `#SHOPIFY` do número do pedido — é esse valor que vai para a planilha. */
export function pedidoDoReenvio(data: ResendSubmissionData): string {
    return (data.numeroPedido ?? '').replace('#SHOPIFY', '');
}

const v = (valor: string | null | undefined): SheetCell => valor ?? null;

/** `"1234,56"` (o `valorReenvio`) → 1234.56. Vazio ou fora do formato ⇒ célula vazia: dinheiro vai como número. */
function valorEmNumero(valor: string | null | undefined): number | null {
    const texto = (valor ?? '').trim();
    if (!/^\d+(,\d{1,2})?$/.test(texto)) return null;
    return Number(texto.replace(',', '.'));
}

function campos(data: ResendSubmissionData, carimbo: string) {
    return {
        carimbo: v(carimbo),
        // A data do carimbo (`dd/MM/yyyy`, São Paulo): a "Data solicitação" do reenvio da Ápice, gravada como valor.
        dataDoCarimbo: v(carimbo.slice(0, 10)),
        dataSolicitacao: v(data.dataSolicitacao),
        tipo: v(data.tipoSolicitacao),
        responsavel: v(data.responsavel),
        origem: v(data.origemReclamacao),
        idAtendimento: v(data.idAtendimento),
        cd: v(data.cdOrigem),
        nome: v(data.nomeCliente),
        telefone: v(data.telefoneCliente),
        endereco: v(data.enderecoCliente),
        cep: v(data.cep),
        estado: v(data.estado),
        pedido: v(pedidoDoReenvio(data)),
        nf: v(data.numeroNF),
        chaveNF: v(data.chaveNF),
        produtoProblema: v(data.produtoComProblema),
        produtoReenviar: v(data.produtoReenviar),
        lote: v(data.loteProduto),
        problema: v(data.problemaProduto),
        transpOriginal: v(data.transportadoraOriginal),
        transpReenvio: v(data.transportadoraReenvio),
        devolucao: v(data.devolucao),
        ticket: v(data.ticketTransportadora),
        statusPedido: v(data.statusPedido),
        reenvioCompleto: v(data.ReenvioCompleto),
        valor: v(data.valorReenvio),
        comentarios: v(data.comentarios),
        status: v(data.status),
        codNfd: v(data.codNfd),
        automacao: v(data.automacao),
        erp: v(data.erp),
        // O vocabulário das planilhas das marcas sem Cosmos (ADR-013), conferido nas linhas que o app grava.
        reenvioCompletoComDetalhe: v(data.ReenvioCompleto === 'Sim' ? 'Sim (Pedido completo)' : data.ReenvioCompleto),
        estadoComSigla: v(estadoComSigla(data.estado)),
        valorEmNumero: valorEmNumero(data.valorReenvio),
    };
}

type Campos = ReturnType<typeof campos>;

const BUILDERS: Record<MarcaComPlanilha, (c: Campos) => SheetCell[]> = {
    lescent: (c) => [
        c.carimbo, c.tipo, c.responsavel, c.nome, c.pedido, c.origem, c.idAtendimento, c.cd, c.nf, c.chaveNF,
        c.endereco, c.cep, c.estado, c.produtoProblema, c.produtoReenviar, c.lote, null, null, c.problema,
        c.transpOriginal, c.transpReenvio, c.telefone, c.devolucao, c.tipo, c.statusPedido, c.ticket, null,
        c.reenvioCompleto, c.dataSolicitacao, null, null, null, c.status, c.valor, null, null, c.codNfd, null,
        null, null, c.comentarios, c.automacao, null,
    ],
    kokeshi: (c) => [
        c.carimbo, null, c.responsavel, c.nome, c.nf, c.chaveNF, c.pedido, c.origem, c.idAtendimento, c.cd,
        c.endereco, c.cep, c.estado, c.produtoProblema, c.produtoReenviar, c.lote, null, null, c.problema,
        c.transpOriginal, c.transpReenvio, c.telefone, c.devolucao, c.tipo, c.ticket, null, c.statusPedido,
        c.reenvioCompleto, null, c.dataSolicitacao, null, null, c.status, c.valor, null, c.codNfd, null, null,
        c.comentarios, null, null, null, null, c.automacao,
    ],
    bysamia: (c) => [
        c.carimbo, c.responsavel, c.origem, c.idAtendimento, c.cd, c.nome, c.nf, c.chaveNF, c.pedido, c.endereco,
        c.estado, c.produtoProblema, c.produtoReenviar, c.problema, c.lote, c.transpOriginal, c.comentarios,
        c.telefone, c.devolucao, c.tipo, c.ticket, c.statusPedido, c.reenvioCompleto, null, null, null,
        c.comentarios, c.dataSolicitacao, null, c.status, c.valor, null, c.codNfd, null, null, null, null,
        c.automacao,
    ],
    aua: (c) => [
        c.carimbo, c.responsavel, c.origem, c.idAtendimento, c.cd, c.nome, c.nf, c.chaveNF, c.pedido, c.endereco,
        c.estado, c.produtoProblema, c.produtoReenviar, c.problema, c.lote, c.devolucao, c.transpOriginal,
        c.comentarios, c.telefone, c.ticket, c.statusPedido, c.reenvioCompleto, null, c.status, c.valor, null,
        null, c.codNfd, null, c.comentarios, null, null, null, c.automacao,
    ],
    barbours: (c) => [
        c.carimbo, c.responsavel, c.origem, c.idAtendimento, c.cd, c.nome, c.nf, c.chaveNF, c.pedido, c.endereco,
        c.estado, c.produtoProblema, c.produtoReenviar, c.problema, c.transpOriginal, c.telefone, c.comentarios,
        c.lote, c.devolucao, c.ticket, c.statusPedido, c.reenvioCompleto, c.tipo, c.dataSolicitacao, null,
        c.status, c.valor, c.erp, c.codNfd, null, c.automacao, c.comentarios,
    ],
    rituaria: (c) => [
        c.carimbo, c.responsavel, c.origem, c.idAtendimento, c.cd, c.nome, c.nf, c.valor, c.chaveNF, c.pedido,
        c.endereco, c.problema, c.produtoReenviar, c.produtoProblema, c.comentarios, c.transpOriginal,
        c.reenvioCompleto, c.lote, c.telefone, null, null, null, c.estado, c.ticket, c.devolucao, c.statusPedido,
        c.tipo, null, c.erp, c.codNfd, null, null, null, c.status, c.automacao,
    ],
    // ─── Marcas sem Cosmos (ADR-013): o layout das planilhas que o app "Reenvio e Reembolso" grava, cabeçalho em
    // `shared/lib/sheets/cabecalhos.ts`. O "Endereço de e-mail" (B) fica vazio: o login do CX Hub não identifica a
    // pessoa. As colunas da operação não são escritas aqui; as de fórmula vêm depois (`formulas.ts`).
    apice: (c) => [
        c.carimbo, null, c.responsavel, c.origem, c.idAtendimento, c.nome, c.nf, c.chaveNF, c.pedido, c.cd,
        c.endereco, c.cep, c.estadoComSigla, c.produtoProblema, c.produtoReenviar, c.problema, c.transpOriginal,
        c.telefone, c.comentarios, c.devolucao, c.ticket, c.statusPedido, c.reenvioCompletoComDetalhe, c.lote,
        // Rastreio: vazio, como nas linhas que o app grava hoje. Z, a "Data solicitação", é valor (o AA a usa).
        null, c.dataDoCarimbo,
    ],
    yenzah: (c) => [
        c.carimbo, null, c.responsavel, c.origem, c.idAtendimento, c.nome, c.nf, c.chaveNF, c.pedido, c.cd,
        c.endereco, c.cep, c.estadoComSigla, c.produtoProblema, c.produtoReenviar, c.problema, c.transpOriginal,
        c.telefone, c.comentarios, c.devolucao, c.ticket, c.statusPedido, c.reenvioCompletoComDetalhe, c.lote,
    ],
    denavita: (c) => [
        c.carimbo, null, c.responsavel, c.origem, c.idAtendimento, c.cd, c.nome, c.nf, c.chaveNF, c.pedido,
        c.endereco, c.cep, c.estadoComSigla, c.produtoProblema, c.produtoReenviar, c.comentarios, c.problema,
        c.lote, c.devolucao, c.statusPedido, c.reenvioCompletoComDetalhe,
        // "Valor da NF de reenvio (R$)": na Denavita é do formulário, e o app grava número.
        c.valorEmNumero, c.ticket, c.transpOriginal, c.telefone,
    ],
};

/** @param carimbo `dd/MM/yyyy HH:mm:ss` em São Paulo, do `criado_em` do caso (`formatarCarimboSP`) */
export function buildResendRow(brand: MarcaComPlanilha, data: ResendSubmissionData, carimbo: string): SheetCell[] {
    return BUILDERS[brand](campos(data, carimbo));
}
