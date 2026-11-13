import type { AlertPolicy, AlertReason, AlertSeverity } from './types';

/**
 * A política por causa — o coração do requisito *"não pode ser uma mensagem de erro genérica"*.
 *
 * Cada causa tem **plano de ação próprio**, e o teste
 * `__tests__/shared/formatAlert.test.ts` afirma que nenhuma ação avisável se repete: texto reciclado
 * entre causas é exatamente como um aviso volta a ser genérico sem ninguém perceber.
 *
 * A coluna que decide se algo chega ao grupo é a `severidade`, e a régua é o ADR-005 §3: **avisa
 * sistema quebrado, não avisa dado da cliente.**
 */
export const ALERT_POLICY: Record<AlertReason, AlertPolicy> = {
    // ─── Crítico: pode ter havido efeito irreversível ────────────────────────
    TEST_MODE_VIOLATION: {
        severidade: 'critica',
        titulo: '🔴 CRÍTICO — o modo de teste foi ignorado pelo fluxo',
        acao: 'Um reenvio real pode ter sido executado num ensaio. Confira no Cosmos se saiu um pedido -R- e se a '
            + 'solicitação foi registrada de verdade ANTES de repetir qualquer teste, e avise o time.',
        agrupar: false,
    },

    // ─── Alta: a solicitação pode ter se perdido, ou a porta está quebrada ───
    GATE_CLOSED: {
        severidade: 'alta',
        titulo: '🔴 A porta do bot está fechada — todo pedido está sendo recusado',
        acao: 'Cadastre `BOT_RESEND_SECRET` nas variáveis de ambiente da Vercel (Production e Preview) e '
            + 'refaça o deploy. Enquanto faltar, o endpoint responde 503 para tudo.',
        agrupar: true,
    },
    COSMOS_UNAVAILABLE: {
        severidade: 'alta',
        titulo: '🔴 O Cosmos não respondeu, mesmo após as retentativas',
        acao: 'Verifique se o ERP está de pé e se COSMOS_API_URL/COSMOS_EMAIL/COSMOS_PASSWORD estão certos. '
            + 'As solicitações deste período foram registradas SEM automação — precisam de reenvio manual.',
        agrupar: true,
    },
    SHOPIFY_UNAVAILABLE: {
        severidade: 'alta',
        titulo: '🔴 O integrations-gateway não devolveu o pedido da Shopify',
        acao: 'Verifique se o integrations-gateway está de pé e se a INTEGRATIONS_GATEWAY_READ_KEY está certa. As '
            + 'solicitações do bot deste período (marcas sem Cosmos) foram registradas só com o que o bot informou, '
            + 'sem os itens e o endereço do pedido: confira o pedido na Shopify antes da execução.',
        agrupar: true,
    },
    ERP_REFUSED: {
        severidade: 'alta',
        titulo: '🔴 O ERP não confirmou o reenvio — registrado sem automação',
        acao: 'Leia o detalhe abaixo. Se o ERP recusou (falta de saldo do SKU, transportadora inválida), nenhuma '
            + 'remessa saiu: refaça o reenvio à mão depois de resolver a causa. Se o Cosmos não respondeu, a remessa '
            + 'PODE ter saído: confira no Cosmos se existe o pedido -R- antes de refazer.',
        agrupar: false,
    },
    ROW_UNCERTAIN: {
        severidade: 'alta',
        titulo: '🔴 Não deu para confirmar se a solicitação foi registrada',
        acao: 'CONFIRA o registro antes de qualquer coisa (o run cxhub__<requestId> no Airflow): '
            + 'se existe, não repita (geraria duplicata); se não existe, refaça a '
            + 'solicitação.',
        agrupar: false,
    },
    // Por caso: cada card é uma linha da gold que ficou com o estado de antes do cancelamento ou da edição.
    GOLD_UPDATE_FAILED: {
        severidade: 'alta',
        titulo: '🔴 A alteração foi feita, mas não chegou à base do Metabase',
        acao: 'O Cosmos ou a planilha já têm a alteração; falta atualizar a linha na '
            + 'gold.fct_reenvio_reembolso_gobeaute. Confira se o Metabase e o Airflow estão de pé e se as variáveis '
            + 'METABASE_* e AIRFLOW_* estão certas, e redispare a DAG gobeaute_reenvio_reembolso_etl com '
            + 'conf.atualizacoes para o caso (requestId abaixo, quando o caso foi achado).',
        agrupar: false,
    },
    // Por caso: cada card é uma solicitação cuja(s) linha(s) o backoffice não vai ver na planilha até alguém repô-la(s).
    SHEET_WRITE_FAILED: {
        severidade: 'alta',
        titulo: '🔴 A linha da solicitação não chegou à planilha',
        acao: 'Se o card é de uma solicitação nova, a linha completa está no log da Vercel (busque um dos ids do '
            + 'requestId abaixo, "linha não gravada"): cole-a na aba da marca, na ordem das colunas, depois de conferir '
            + 'pelo número do pedido e pelo carimbo que ela ainda não está lá (o aviso lista todas as linhas que '
            + 'falharam). Se é de cancelar, editar ou concluir um reembolso (o motivo diz), a linha já existe: ajuste à '
            + 'mão as células citadas no detalhe, na linha desse pedido e carimbo. Se o motivo diz que o registro no '
            + 'Metabase também não foi confirmado, confira antes o run cxhub__<id> no Airflow. Se diz que o cabeçalho '
            + 'da aba não bate com o layout, alguém moveu ou inseriu colunas: desfaça, ou ajuste o layout no código. '
            + 'Depois descubra por que a gravação falhou: GOOGLE_PLANILHAS_EMAIL/TOKEN e SHEETS_ENV na Vercel, e se a '
            + 'conta de serviço é editora da planilha e está na exceção da proteção da aba.',
        agrupar: false,
    },
    RECORD_UNAVAILABLE: {
        severidade: 'alta',
        titulo: '🔴 O CXHub não conseguiu registrar a solicitação',
        acao: 'Nada foi registrado. Confira se a DAG gobeaute_reenvio_reembolso_etl está despausada e se AIRFLOW_* e '
            + 'METABASE_* estão certas na Vercel. Se o card diz que o reenvio saiu no Cosmos, NÃO refaça (duplicaria '
            + 'a remessa): redispare a DAG com o conf que está no log da Vercel (requestId abaixo); se não saiu, '
            + 'refaça a solicitação depois de corrigir.',
        agrupar: false,
    },
    INTERNAL_ERROR: {
        severidade: 'alta',
        titulo: '🔴 Falha inesperada do CXHub — degradado para registro',
        acao: 'É bug nosso, não do bot nem do ERP. A solicitação foi registrada sem automação. Abra o log da '
            + 'Vercel pelo requestId abaixo e registre em logs/problems/OPEN.md.',
        agrupar: false,
    },

    // ─── Média: agregada; é cadastro/configuração a corrigir ────────────────
    // Agregado: no começo, a maioria é solicitação de antes da integração, e um card por janela basta.
    GOLD_UPDATE_NO_CASE: {
        severidade: 'media',
        titulo: '🟡 Alteração sem caso correspondente na base do Metabase',
        acao: 'Nenhum caso do CX Hub na gold casou com o pedido. É o esperado para solicitação aberta antes da '
            + 'integração com a gold. Se a solicitação é recente, a réplica do Data Mart pode estar atrasada: '
            + 'confira a linha pelo número do pedido e, se ela já existe, aplique a alteração pela DAG.',
        agrupar: true,
    },
    // Agregado POR MARCA (`agruparPor`): no começo, a maioria é reembolso aberto antes de o CX Hub gravar o carimbo do
    // caso na planilha, e um card por marca por janela basta — o motivo diz qual ação não achou a linha.
    SHEET_ROW_NOT_FOUND: {
        severidade: 'media',
        titulo: '🟡 A linha do reembolso não está na planilha da marca',
        acao: 'A ação (cancelar, editar, concluir ou atualizar o acompanhamento) não achou, na aba de reembolso da marca, '
            + 'uma linha com o número do pedido e um carimbo de data/hora a até 2 minutos da criação do caso. Se o '
            + 'reembolso foi aberto antes de o CX Hub gravar a linha, ou alguém mexeu no carimbo ou no pedido, é o esperado: '
            + 'procure a linha pelo número do pedido e faça à mão o que a ação faria. Se é recente, confira se a '
            + 'linha entrou na aba (e com que carimbo) e se SHEETS_ENV aponta para o conjunto de planilhas certo (prod ou staging).',
        agrupar: true,
    },
    CARRIER_UNRESOLVED: {
        severidade: 'media',
        titulo: '🟡 Transportadora não reconhecida — reenvio parado',
        acao: 'Acrescente o nome ao CARRIER_MAP (modules/reenvios/actions/carrierMap.ts) com o id real do '
            + 'Cosmos, levantado por GET /organizations/{org}/carriers.',
        agrupar: true,
    },
    PRODUCT_ID_MISSING: {
        severidade: 'media',
        titulo: '🟡 Item do reenvio sem cadastro no Cosmos',
        acao: 'Confira o cadastro do SKU no Cosmos da marca — sem id de produto o ERP recusaria a remessa, '
            + 'então a automação foi desligada de propósito.',
        agrupar: true,
    },
    CARRIER_ID_MISSING: {
        severidade: 'media',
        titulo: '🟡 Transportadora sem id no Cosmos',
        acao: 'A transportadora foi reconhecida pelo nome mas não tem id utilizável. Confira o cadastro de '
            + 'transportadoras da organização no Cosmos.',
        agrupar: true,
    },
    NO_RESEND_ITEMS: {
        severidade: 'media',
        titulo: '🟡 Nenhum item para reenviar foi resolvido no pedido',
        acao: 'Confira se os itens que o bot enviou existem no pedido do ERP — divergência aqui costuma ser '
            + 'SKU trocado na conversa com a cliente.',
        agrupar: true,
    },
    AUTOMATION_DATA_MISSING: {
        severidade: 'media',
        titulo: '🟡 Os dados de automação não foram montados a partir do pedido',
        acao: 'O pedido foi encontrado mas não gerou corpo para o ERP. Confira o pedido no Cosmos pelo número '
            + 'abaixo; se estiver íntegro, é bug do builder — registre em logs/problems/OPEN.md.',
        agrupar: true,
    },
    ORDER_ADDRESS_NO_CEP: {
        severidade: 'media',
        titulo: '🟡 O endereço do pedido está sem CEP no ERP',
        acao: 'Complete o CEP no cadastro do pedido no Cosmos — despachar sem endereço de entrega faria a '
            + 'remessa ficar parada sem CD.',
        agrupar: true,
    },
    INVALID_PAYLOAD: {
        severidade: 'media',
        titulo: '🟡 O Typebot está mandando payload inválido — a solicitação foi descartada',
        acao: 'Corrija a configuração do bot: marca entre as 6 aceitas, testMode booleano (não a string '
            + '"true") e order.ecommerceOrderId sempre presente fora do modo de teste.',
        agrupar: true,
    },
    // Dado de quem chamou (o portal tem uma pessoa na frente para corrigir e reenviar): volta pelo
    // `reason`/`message`, não vira trabalho do grupo.
    INVALID_ITEMS: {
        severidade: 'nenhuma',
        titulo: 'Reenvio parcial com itens que não conferem com o pedido',
        acao: 'Conferir SKU, lineItemId e quantidade de cada item contra o pedido e reenviar a solicitação.',
        agrupar: true,
    },

    // ─── Nenhuma: é dado da cliente ou o sistema funcionando ────────────────
    // Volta ao bot pelo `reason` para ELE agir (perguntar de novo à cliente). O `acao` existe para o
    // log e para o contrato do bot, não para o grupo.
    ORDER_NOT_FOUND: {
        severidade: 'nenhuma',
        titulo: 'Pedido não encontrado no Cosmos',
        acao: 'Confirmar o número do pedido com a cliente; a solicitação fica registrada para tratativa manual.',
        agrupar: true,
    },
    NOT_ELIGIBLE: {
        severidade: 'nenhuma',
        titulo: 'Pedido não elegível à automação',
        acao: 'Tratativa manual — a regra de elegibilidade é a mesma do fluxo da tela.',
        agrupar: true,
    },
    NEW_ADDRESS_INCOMPLETE: {
        severidade: 'nenhuma',
        titulo: 'Endereço novo incompleto',
        acao: 'O bot deve voltar e coletar o campo que faltou antes de reenviar a solicitação.',
        agrupar: true,
    },
    NEW_ADDRESS_CEP_INVALID: {
        severidade: 'nenhuma',
        titulo: 'CEP do endereço novo ilegível',
        acao: 'O bot deve pedir o CEP de novo à cliente (8 dígitos, com ou sem hífen).',
        agrupar: true,
    },
    AUTOMATION_OFF: {
        severidade: 'nenhuma',
        titulo: 'Automação desligada por interruptor',
        acao: 'Desligamento intencional — a solicitação é registrada e tratada à mão. Nada a corrigir.',
        agrupar: true,
    },
    // O pedido ainda não foi faturado: é dado do pedido, não sistema quebrado (ADR-005 §3, ADR-018).
    ORDER_NOT_INVOICED: {
        severidade: 'nenhuma',
        titulo: 'Pedido sem NF de venda — reenvio recusado',
        acao: 'Avisar a cliente que o pedido ainda não foi faturado; o reenvio só pode ser pedido depois da NF de venda.',
        agrupar: true,
    },
};

/**
 * Tolerante a `reason` fora do mapa **de propósito**: o tipo já garante totalidade, mas este predicado é
 * consultado no caminho do aviso, cujo invariante (INV-06) é não alterar o desfecho da solicitação. Um
 * `?.` aqui custa nada; um `TypeError` custaria a solicitação. Desconhecido cai em `alta` — o lado que
 * avisa, porque não saber o que aconteceu não é motivo para silêncio.
 */
export function severidadeDe(reason: AlertReason): AlertSeverity {
    return ALERT_POLICY[reason]?.severidade ?? 'alta';
}

/** Só o que exige ação de quem mantém o sistema chega ao grupo (ADR-005 §3). */
export function deveAvisar(reason: AlertReason): boolean {
    return severidadeDe(reason) !== 'nenhuma';
}
