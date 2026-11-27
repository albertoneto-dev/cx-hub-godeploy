# API do app GoDeploy `cx-hub`

Backend do CX Hub em `https://cx-hub.devgogroup.com` (app `66edd698`, visibilidade `authenticated`). Duas partes no
mesmo Worker (além do backoffice, da cache da rota dados e da saúde, mais abaixo):

- `/api/v1/*`: a fila do Metabase, que guarda casos e atualizações e dispara a DAG `gobeaute_reenvio_reembolso_etl`
  em lote a cada 10 min (era 20 até a v9). O contrato está em `docs/fila-cxhub.md`, no repositório do CX Hub. As
  edições do backoffice (abaixo) são atualizações desta fila.
- O resto: as 23 rotas que o CX Hub tem na Vercel, **nos mesmos caminhos, métodos, corpos e respostas**, o
  `GET /api/datamart/order-context` da ADR-018, que a Vercel não tem, e o `GET /api/reenvio/existente`, que só este app
  tem. O código é o do CX Hub (`cxhub/`, com origem
  em `cxhub/ORIGEM.md`); as regras de negócio estão no `CLAUDE.md` de lá.

Para quem integra: `GET /docs` é uma página HTML (`api/docs.ts`) com o que muda para quem chamava a Vercel, os
exemplos de antes e depois e as rotas. Ela vai no pacote do Worker, porque esta pasta `docs/` não sobe ao GoDeploy.
Mudou rota, header ou resposta: atualize a página também (o `testes/docs.test.ts` cobra as rotas e os métodos).

## Autenticação

Toda chamada passa primeiro pelo gateway do GoDeploy:

| Quem chama | Como passa pelo gateway |
|---|---|
| Servidor (Central de Tickets, Typebot, n8n, outro app) | `Authorization: Bearer gdk_…`, uma chave de API do GoDeploy **para este app** (a de outro app leva 403; sem chave, 302 para o login) |
| Navegador numa página deste app | a sessão do GoDeploy |

Como o `Authorization` é do gateway, o que cada rota confere vai em outro header:

| Rotas | Header da rota |
|---|---|
| `/api/cosmos/*`, `/api/datamart/{products,order-context}`, `/api/refund/{cancel,update,complete,sync}`, `/api/registro`, `/api/solicitacoes` | `x-cosmos-token: <token>`: o `credentials.token` do `/api/auth/login`, com ou sem `Bearer `. Na Vercel ia no `Authorization`. O app o põe no `Authorization` só para a rota, e uma `gdk_` nunca chega ao Cosmos. |
| `/api/reenvio/bot` | `x-bot-secret` (o `BOT_RESEND_SECRET`), **junto da** `gdk_`: um só não passa. Quem chama é o Typebot e, quando for publicado, o Extravios Gobeaute do hub Jornada CX |
| `/api/v1/*` (a fila) | `x-cxhub-fila-token` |
| `/api/auth/login`, `/api/cancellation/submit`, `/api/refund/submit`, `/api/sheets/append`, `/api/logistica/submit`, `/api/resend/data`, `/api/shopify/orders` | nenhum, como na Vercel. Aqui ficam atrás do gateway, e na Vercel estavam abertas. |
| `/api/saude` | nenhum: basta a `gdk_` (é como o Monitor da Black lê) |
| `/api/reenvio/existente` | nenhum: basta a `gdk_`. Só lê, e não devolve dado de cliente (decisão de 2026-11-24) |

Use o `x-cosmos-token` também no navegador. O app ainda aceita o token no `Authorization` quando ele chega até a rota
(e o repassa como veio), mas ninguém conferiu se o gateway deixa passar, junto com a sessão, um `Authorization` que
não é `gdk_`.

## Rotas do CX Hub

| Método | Caminho | O que faz |
|---|---|---|
| POST | `/api/auth/login` | Confere `{ email, password }` com a credencial do CX Hub e devolve o login do usuário de serviço do Cosmos (`credentials.token`) |
| GET | `/api/cosmos/orders?brand=&orderId=` | Pedidos do Cosmos pelo número da loja (repasse) |
| GET | `/api/cosmos/orders/{id}?brand=` | Um pedido do Cosmos pelo id interno (repasse) |
| GET | `/api/cosmos/products?brand=[&sku=]` | Produtos da marca: um SKU, ou o catálogo (até 10 páginas de 100) |
| GET | `/api/cosmos/products/{id}?brand=` | Um produto (repasse) |
| GET | `/api/cosmos/carriers?brand=&shopify_name=` | Transportadora pelo nome da Shopify (repasse) |
| GET | `/api/cosmos/resends?brand=&orderId=` | Os reenvios (`-R-n`) de um pedido |
| PATCH | `/api/cosmos/resends/{id}?brand=` | Edita endereço, transportadora ou cliente de um reenvio; endereço novo vai à gold pela fila, depois da resposta |
| POST | `/api/cosmos/resends/{id}/cancel?brand=` | Cancela um reenvio no Cosmos (sem volta); o cancelamento vai à gold pela fila |
| GET | `/api/shopify/orders?brand=&orderId=` | O pedido na Shopify, pelo gateway da Shopify com o nome da marca (as 10), e o Data Mart de reserva. Sem token de loja |
| GET | `/api/datamart/products?brand=apice\|yenzah\|denavita` | O catálogo de produtos avulsos da marca no Data Mart, no formato dos produtos do Cosmos: o mimo e a troca do reenvio das marcas sem Cosmos. Guardado por 6 h em memória |
| GET | `/api/datamart/order-context?brand=apice\|yenzah\|denavita&order=` | O que o servidor vai gravar para o pedido (ADR-018): `nf` e `nfStatus` (`achada`, com o `nfOrigem`: `datamart`, `shopify` ou `intelipost`; `ausente`; ou `desconhecida`, com o `nfMotivo`: `sem_resposta`, `nf_fora_do_data_mart` ou `pedido_cancelado_no_tiny`), `cd`, `statusSugerido`, `avisos`, a composição dos `kits` e o que ficou em `naoConferidos`. Data Mart fora dá 200 com `desconhecida`, não erro. Sem cache |
| GET | `/api/resend/data?origin=reenvio\|reembolso\|logistica` | Os dropdowns do formulário (app `rota-dados-cxhub`) |
| POST | `/api/sheets/append` | Registra um reenvio da tela: dedup de 24 h (com a conferência no Data Mart junto, nas três sem Cosmos com planilha), Cosmos (`POST /resend`), fila e planilha. `testMode: true` não grava. O `data.fotoAvaria` (booleano, opcional) vai à fila como `foto_avaria` |
| POST | `/api/reenvio/bot` | O reenvio do Typebot: busca o pedido, aplica as guardas e registra; toda dúvida vira registro sem automação. `testMode: true` não grava |
| POST | `/api/refund/submit` | Registra um reembolso: chave Pix gravada como veio (toda marca com planilha), dedup de 24 h com a conferência no Data Mart junto, fila e planilha. O `data.damagePhotoSent` (booleano, opcional) vai à fila como `foto_avaria` |
| POST | `/api/cancellation/submit` | Registra um cancelamento junto do reenvio ou do reembolso: fila e planilha |
| POST | `/api/refund/cancel` | Cancela o reembolso mais recente do pedido (fila, depois planilha) |
| POST | `/api/refund/update` | Edita valor e motivo do reembolso |
| POST | `/api/refund/complete` | Marca o reembolso como Realizado (pelo `idSolicitacao`) |
| POST | `/api/refund/sync` | Leva à fila o Realizado ou o Cancelado que o backoffice marcou na planilha |
| GET | `/api/solicitacoes?tipo=[&marca=][&pedido=][&pagina=]` | Uma página (20) das solicitações dos últimos 30 dias, raw e fila juntas |
| GET | `/api/registro?ids=` | Onde estão até 20 casos: `gravado`, `aguardando` ou `recusado` |
| GET | `/api/reenvio/existente?marca=&pedido=` | **Só deste app.** Se o pedido já tem reenvio, nas 10 marcas: `bloqueiaNovo` (o mesmo bloqueio de 24 h do `DUPLICATE_RESEND`) e a lista do registro do CX Hub (raw + fila) com o histórico de antes dele (a gold, fora do `cxhub\|`). Veja abaixo |
| POST | `/api/logistica/submit` | Abre o ticket de logística no worker `cx-ticketcreator` |

Os corpos e as respostas são os da Vercel. Um 200 com `code` de erro e `reason` (`SHEETS_ERROR`, `UNKNOWN_ERROR`)
quer dizer "registrado, não repita", e o chamador depende disso.

## O que é diferente da Vercel

- O token do Cosmos de quem chama de servidor vai no `x-cosmos-token` (acima).
- A fila é chamada dentro do próprio Worker, sem rede nem chave `gdk_`.
- Erro não tratado numa rota responde `500 { code: "UNKNOWN_ERROR", message }` (no Next era 500 sem JSON). Caminho que
  não existe responde `404 { code: "NOT_FOUND" }`, e método errado responde `405 { code: "METHOD_NOT_ALLOWED" }` com
  `Allow`.
- Os avisos que iam ao Google Chat vão ao Slack (`SLACK_ALERT_WEBHOOK_URL`, o mesmo canal da fila), com o mesmo texto.
- **Nenhum token de loja da Shopify (2026-11-17).** O `/api/shopify/orders` lê toda marca pelo gateway da Shopify:
  `POST {SHOPIFY_GATEWAY_URL}/{marca}`, com a `SHOPIFY_GATEWAY_KEY` (veja "Um gateway por serviço", abaixo).
  Na Vercel, Lescent, Kokeshi, BySamia, Auá, Barbours
  e Rituária liam o REST `orders.json` da loja com os `SHOPIFY_TOKEN_*`. Aqui a Rituária passou ao gateway em
  2026-11-10, e as outras 5 em 2026-11-17, porque os tokens das lojas vão ser trocados. O que muda para quem chama, nas
  6 marcas do Cosmos:
  - a resposta traz 0 ou 1 pedido e só os campos que o formulário usa (antes, o objeto completo da Shopify, às vezes com
    o reenvio do Cosmos `SH…-R-1` junto e primeiro). O nome é conferido pelos dígitos, então o reenvio não é escolhido no
    lugar do original;
  - o erro do gateway vira `502 { "error": "Shopify gateway error: <status>" }`, e não o status da Shopify repassado;
  - só os últimos 60 dias vêm da Shopify; o resto vem do Data Mart (abaixo).

  No Cosmos e no bot, as marcas do Cosmos seguem iguais. Código: `cxhub/shared/lib/shopify/gateway.ts`.
- **Um gateway por serviço (2026-11-23, decisão deste app).** O integrations-gateway (`INTEGRATIONS_GATEWAY_URL`,
  `INTEGRATIONS_GATEWAY_READ_KEY` e `INTEGRATIONS_GATEWAY_WRITE_KEY`) foi descontinuado. A Shopify e a Intelipost têm
  agora a URL e a chave próprias: `SHOPIFY_GATEWAY_URL` e `SHOPIFY_GATEWAY_KEY` (o pedido e o metacampo da NF),
  `INTELIPOST_GATEWAY_URL` e `INTELIPOST_GATEWAY_KEY` (a Intelipost ao vivo). O gateway novo é o GoAccess
  (`https://api.gogroup.cc/v1`), com o `Authorization: Bearer` de antes e os caminhos do contrato dele:
  - **Shopify:** `POST {SHOPIFY_GATEWAY_URL}/{marca}`, o GraphQL da Shopify direto no endereço da marca. O
    integrations-gateway pedia `…/{marca}/graphql`; com o `/graphql`, o GoAccess responde 400. Foi o defeito da v21
    (publicada em 23/11 às 19:03 UTC): toda busca caiu no Data Mart, e a produção voltou ao código da v20 às 19:20;
  - **Intelipost:** `GET {INTELIPOST_GATEWAY_URL}/{marca}/{caminho da API}`. O antigo pedia a conta (`lescent`,
    `beautyhub`); o app vai pela marca e, se o gateway responder 404 com o `error` dele (rota que não conhece), tenta a
    conta. Esse 404 nunca vale "envio não existe": antes valia, e um caminho errado daria "sem NF" e a recusa;
  - o erro do gateway vai ao log com a mensagem dele (`[Shopify Gateway] apice: HTTP 400 (…)`), só o texto de erro;
  - o cabeçalho `X-On-Behalf-Of` (quem pediu, só para a trilha do GoAccess) é opcional, e o app não o manda;
  - a URL vale com ou sem o nome do serviço no fim (`https://…/v1/shopify` ou `https://…/v1`): o app acrescenta o
    `/shopify` ou o `/intelipost` só quando falta, e nunca o duplica (`baseDoServicoNoGateway`);
  - não há endereço padrão, e só https vale, porque a chave vai no header. Sem a URL ou a chave, o serviço conta como não
    configurado: o `/api/shopify/orders` responde 500 (`Shopify gateway key not configured`), o bot registra com
    `SHOPIFY_UNAVAILABLE` e a NF fora do Data Mart fica `desconhecida`, nunca `ausente`;
  - o gateway novo responde `403 {"error":"invalid_key"}` à chave ausente ou recusada (o antigo respondia 401), antes de
    olhar a rota. Para o app, os dois são erro: o 502 no `/api/shopify/orders` e "sem resposta" na Intelipost;
  - as `INTEGRATIONS_GATEWAY_*` não são lidas por nenhuma rota.

  Código: `acessoAoGateway` em `cxhub/shared/lib/shopify/gateway.ts`, usado por `buscarPedidoNoGateway.ts` e
  `cxhub/shared/lib/intelipost/nfNaIntelipostServer.ts`.
- O pedido que o gateway da Shopify não acha (ele só enxerga os últimos 60 dias) ou com ele fora do ar vem do Data
  Mart (`api.vw_shopify_orders`, pela chave do Metabase), no mesmo formato: no `/api/shopify/orders` (as 9 marcas com
  planilha; a BySamia é `by_samia` lá) e no bot (as sem Cosmos). Na Ápice, quando a Shopify não tem o telefone, vale o
  do Tiny. Na Vercel, o pedido de mais de 60 dias das sem Cosmos voltava como não encontrado e a agente não conseguia
  pedir o reenvio (o #1607929 da Ápice, em 2026-11-12). A Gobeaute não está no Data Mart e continua com o limite.
  Código: `cxhub/shared/lib/shopify/buscarPedidoNoGatewayOuNoDataMart.ts` e
  `cxhub/shared/lib/datamart/pedidoDaShopifyServer.ts`.
- **ADR-018 (do `11cebff`, o último commit do repositório antigo do CX Hub, encerrado em 2026-11-13; a Vercel não a
  tem):** o reenvio e o reembolso da Ápice, da Yenzah e da Denavita conferem o pedido no Data Mart, em toda entrada
  (tela, Central de Tickets, bot):
  - a NF de venda (a da primeira remessa da Intelipost; na Ápice, sem ela, a NF não cancelada do pedido ativo no Tiny) e o
    CD (Ápice: a tabela do Tiny do pedido ativo; Yenzah: a UF de origem da Intelipost; Denavita: `CD MG`) entram no lugar
    dos que vieram. A NF que veio e difere vai para o log;
  - o Data Mart prova que o pedido não foi faturado ⇒ `422 UNKNOWN_ERROR`, nada gravado (no bot,
    `reason: ORDER_NOT_INVOICED`, sem aviso). O que conta como prova está nos itens seguintes: desde 2026-11-19, a
    prova do Data Mart só vale com a Intelipost ao vivo (e, na Yenzah, o metacampo da Shopify) respondendo sem NF;
  - o "Valor da NF de reenvio (R$)" é calculado; na Ápice e na Yenzah vai para a coluna da operação (AC), junto com as
    fórmulas;
  - a chave Pix do reembolso **não é mais validada** (v14, 16/11/2026): é gravada como veio (`trim()`), em toda marca com
    planilha; só vai normalizada quando vem o `pixKeyType` e a chave vale para ele. É obrigatória só na Ápice, Yenzah e
    Denavita, com `CHAVE_PIX_OBRIGATORIA=on` (desligada neste app); nas 6 do Cosmos é sempre opcional. Colunas: Lescent W,
    BySamia M, Auá L, Barbours Q, Rituária K; na Kokeshi, no fim das Observações da linha (a planilha dela está
    deslocada);
  - o registro nunca depende do Data Mart: a conferência corre junto do dedup, com teto de 12 s, e o que não foi
    conferido fica com o valor que veio e a nota do motivo (`[… NÃO CONFERIDOS: DATA MART SEM RESPOSTA]` e as do item
    seguinte).

  A leitura usa a mesma chave do Metabase (banco 43): `gold.fct_intelipost_orders`, `gold.fct_shopify_orders`,
  `gold.vw_shopify_order_items_exploded_priced_enriched` e, na Ápice, `api.tiny_pedidos_ap_cosmetics_{es,rj}` e
  `api.tiny_nfe_ap_cosmetics_{es,rj}` (com os `_itens`). Cada registro dessas marcas faz de 3 a 7 consultas. As 6 marcas
  do Cosmos e a Gobeaute não mudam. Código: `cxhub/shared/lib/datamart/{pedidoServer,pedido,conferenciaServer}.ts` e
  `cxhub/modules/*/actions/conferenciaDo*.ts`.
- **A NF da Ápice só é recusada com prova (2026-11-16, decisão deste app):** a ADR-018 recusava como "sem NF" todo pedido
  que o Data Mart ainda não mostrava inteiro. O SH1832330AP, cancelado no ES e refeito no RJ, levou dois 422 com a NF já
  emitida: a Intelipost só chega ao gold cerca de 1 h depois da NF, e a busca no Tiny por data procurava só o
  `numero_ecommerce`, que no RJ vem sempre vazio. Agora:
  - a NF fica `ausente` (422) só com prova de que o pedido não foi faturado: o pedido ativo no Tiny sem o id da NF, a NF
    achada e cancelada, ou o pedido em lugar nenhum;
  - na dúvida, a NF fica `desconhecida`, a tela pede a NF, e o registro grava a que veio com a nota do motivo:
    - `nf_fora_do_data_mart`, `[NF NÃO CONFERIDA: AINDA FORA DO DATA MART]`: o pedido ativo já tem o id da NF no Tiny,
      e a tabela de NFs, que chega em lotes horas depois, ainda não a tem;
    - `pedido_cancelado_no_tiny`, `[CD/NF NÃO CONFERIDOS: PEDIDO CANCELADO NO TINY]`: o Tiny só tem o pedido cancelado.
      O CD nunca sai dele: vale a UF da Intelipost, se houver.

    A falta de resposta (`sem_resposta`) vem antes dos dois. A `order-context` diz o motivo no `nfMotivo`;
  - o pedido escolhido no Tiny é o ativo antes do cancelado; entre eles, o que tem o id da NF (a cópia "Em aberto"
    importada de novo não derruba o pedido faturado), depois o mais recente, depois o do ES. A NF do pedido cancelado não
    vale, nem é lida: o cancelado com NF autorizada quase sempre foi refeito com outra NF;
  - sem a Intelipost no gold, a busca no Tiny por data procura o número no `numero_ordem_compra` ou no
    `numero_ecommerce`, nos dois CDs. A janela vai de 1 dia antes da criação na Shopify a 12 dias depois no ES e a 60
    no RJ, que recebe os pedidos cancelados no ES e refeitos lá. As medidas estão no comentário de `sqlDoTinyPorData`.
- **A NF procurada em todas as fontes antes de dar "sem NF" (2026-11-19, decisão deste app):** o Data Mart leva cerca
  de 1 h para receber a NF da Intelipost, e nessa janela o reenvio e o reembolso da Ápice, da Yenzah e da Denavita de
  pedido já faturado eram recusados (a pergunta do Nai na thread dos reembolsos de cancelamento: "só puxa se tiver
  NF?"; o portal de cancelamento também chama o CX Hub direto). Agora, sem a NF no Data Mart (nem a da primeira remessa
  da Intelipost, nem, na Ápice, a do Tiny), a conferência lê, nesta ordem e cada uma só se a anterior não deu a NF:
  - o metacampo `custom.nf_numero` da Shopify pelo gateway (`SHOPIFY_GATEWAY_URL` e `SHOPIFY_GATEWAY_KEY`), só nas marcas
    que o preenchem. Medido em 19/11 nos 50 pedidos de 05 a 15/11 de cada marca: 100% dos despachados das 6 do Cosmos
    e da Yenzah, 0% da Ápice (0/42), da Denavita (0/46) e da Gobeaute (0/32), e nenhum dos 71 cancelados. Das três sem
    Cosmos, só a Yenzah o lê;
  - a Intelipost ao vivo pelo gateway (`INTELIPOST_GATEWAY_URL` e `INTELIPOST_GATEWAY_KEY`, desde 2026-11-23):
    `GET {INTELIPOST_GATEWAY_URL}/{marca}/shipment_order/sales_order_number/SH{n}{sigla}` e, se o envio enxuto vier sem
    a NF, `GET …/shipment_order/{order_number}`. Se o gateway não conhecer a marca, vai a conta do gateway antigo:
    `beautyhub` (Yenzah, Barbours, Rituária) ou `lescent` (Kokeshi, BySamia, Auá). O 400 da Intelipost e o 404 sem o
    `error` do gateway são "não achou"; o 404 com o `error` do gateway (rota que ele não conhece), 401, 403, 429 e 5xx,
    erro.

  As duas têm até 4 s cada, dentro do teto da conferência (12 s); com a NF no Data Mart, nenhuma sai. O que conta como
  prova de `ausente` passa a ser a do Data Mart (acima) **com** a Intelipost ao vivo e, na Yenzah, o metacampo
  respondendo sem NF. A leitura nova que falha (sem a chave, chave recusada, limite, gateway fora, prazo) nunca vira
  `ausente`: a NF fica `desconhecida` com `sem_resposta`, o aviso diz que a Shopify ou a Intelipost não responderam, e a
  nota é `[NF NÃO CONFERIDA: CONSULTA AO VIVO SEM RESPOSTA]`. A NF achada fora do Data Mart vale como a dele, e a
  `order-context` diz de onde ela veio no campo novo `nfOrigem` (`datamart`, `shopify` ou `intelipost`); nenhum outro
  campo mudou. A Ápice cancelada no Tiny continua `desconhecida` (`pedido_cancelado_no_tiny`). A recusa da Yenzah diz
  "não tem NF de venda na Intelipost nem na Shopify". Código: `cxhub/shared/lib/datamart/nfForaDoDataMartServer.ts`,
  `cxhub/shared/lib/intelipost/`, `nfNoMetacampoDaShopify` em `cxhub/shared/lib/shopify/buscarPedidoNoGateway.ts` e
  `derivarContextoDoPedido`.

  **Risco que não deu para conferir (19/11):** a chave `INTEGRATIONS_GATEWAY_WRITE_KEY` do `.env` local respondeu 401 no
  gateway (no `/whoami` também), então a Intelipost ao vivo não foi testada daqui em marca nenhuma. O contrato é o que o
  usuário testou com a chave dele em 18/11 para a Central. Em especial, o `sales_order_number` da Ápice (o SH1832330AP,
  com a NF 183916 esperada): a anotação de 16/11 diz que "na Ápice, a Intelipost não acha pelo número da Shopify". Se a
  Intelipost não achar o envio de uma marca pelo SH, ela responde 400, e a marca fica, na prática, só com o Data Mart (e
  o Tiny, na Ápice), como antes. Com a chave do app recusada, nenhum pedido sem a NF no Data Mart dá `ausente`: fica
  `desconhecida` e é gravado com a nota.
- **A NF das marcas do Cosmos pela Intelipost (2026-11-17, decisão deste app):** o pedido do Cosmos V3 (desde 21/10)
  vem sem `invoice_number`, e a NF chegava como `"-"`. No `/api/sheets/append` e no `/api/refund/submit` (e no bot, que
  passa por eles), a NF vazia, `-`, `na` ou só zeros das 6 marcas do Cosmos vira a da primeira remessa da Intelipost
  (`gold.fct_intelipost_orders`, uma consulta pelo índice, teto de 12 s junto do dedup), sem os zeros à esquerda. Desde
  2026-11-19, sem ela no Data Mart, vale a do metacampo `custom.nf_numero` da Shopify e, depois, a da Intelipost ao vivo
  (`nfDoPedidoDoCosmos`). A NF que veio nunca é trocada, e sem resposta fica a que veio. Código:
  `cxhub/shared/lib/datamart/nfDaIntelipostServer.ts`.
- **A NF no `/api/shopify/orders` (2026-11-19):** o `note_attributes.nf_number` que a tela e a Central leem (pelo
  `adaptShopifyOrder`, em `numeroNF`) vem do metacampo `custom.nf_numero` do pedido. O atributo `nf_number` da Shopify,
  que era o lido, não existe em nenhum pedido consultado em 19/11; fica de reserva.
- **O reenvio que o pedido já tem no Cosmos (2026-11-22, decisão deste app):** em 19/11 o Cosmos levou de 10 a 50 s
  para criar reenvios. O `processResend` desiste do `POST /resend` no `TIMEOUT` (12 s, do início da requisição) e
  respondia "o reenvio PODE ter sido criado" sem registrar nada; o Cosmos criava o reenvio mesmo assim, o agente
  repetia, e 8 pedidos ficaram com dois reenvios ativos (o Lescent 716185 com três). O dedup não via o primeiro, que não
  tinha registro. Agora, com automação, o `/api/sheets/append` e o bot perguntam antes ao Cosmos
  (`reenvioRecenteNoCosmos`, junto do dedup e no mesmo prazo do `POST /resend`):
  - `GET /organizations/{org}/orders?external_id=<dígitos, ou o GC inteiro>&per_page=100`, com o token de quem pede,
    até 5 s por tentativa, e uma segunda tentativa quando o Cosmos não responde, cai ou dá 5xx/429 (o `origin=resend`
    saiu em 2026-11-27: veja "Pedidos da Gocreators", abaixo);
  - conta o reenvio do pedido (o mesmo filtro `SH<n><sigla>-R-<k>` / `#SHOPIFY<n>-R-<k>` / `GC<n><sigla>-R-<k>` da
    gestão de reenvios, de qualquer origem)
    criado nas últimas 24 h e não cancelado. Com um, a solicitação é registrada como automação e sem `POST`: `SUCCESS`,
    com a mensagem "O reenvio <SH…-R-n> já estava no Cosmos (nenhum outro foi criado)." e a nota
    `[REENVIO JÁ EXISTIA NO COSMOS: …]` na frente das observações da linha (a fila não leva as observações);
  - sem resposta do Cosmos, procura a remessa na `gold.fct_intelipost_orders` (pelo `sales_order_number`, com a marca e
    a data: os reenvios não têm o `shopify_order_number`). Ela só chega lá cerca de 1 h depois da criação (15 min até a
    Intelipost, no SH1585904KS-R-1, mais a cópia ao Data Mart), então acha o reenvio antigo, mas não o de minutos atrás.
    Sem ele lá, nada é criado nem registrado: `API_ERROR` "Não deu para conferir no Cosmos se o pedido já tem reenvio
    (…)". No bot, isso vira a linha sem automação com `ERP_REFUSED`, como a recusa do ERP;
  - a decisão de registrar com o reenvio que já existia (e não recusar como duplicado) é do usuário, em 22/11. O reenvio
    feito à mão no Cosmos nas últimas 24 h, sem registro no CX Hub, também é aproveitado, e a linha sai como automação.

  O `POST /resend` continua sem retentativa. A consulta gasta do mesmo prazo, então, com o Cosmos lento, sobra menos
  tempo para o `POST`; a repetição, que antes duplicava, agora acha o reenvio. Código:
  `cxhub/modules/reenvios/actions/reenvioRecenteNoCosmos.ts`.
- **Pedidos da Gocreators (2026-11-27, decisão deste app).** Os pedidos da Gocreators estão na Shopify de cada marca
  com o nome `GC{n}{sigla}` (`GC104306BB`, `GC109828LC`), em Aua, Barbour's, Kokeshi, Lescent, Rituária e Yenzah, desde
  13/10/2026. Até a v24 o CX Hub reduzia o pedido aos dígitos em toda parte, e o GC achava o pedido errado: os dígitos
  do GC são os de outro pedido da mesma loja (em 26/11, o `GC104306BB` devolvia o `#104306` de 2024, e o `GC109828LC`, o
  `#109828` de 10/2025). O `order_number` do GC é o interno da Shopify (2901055), e o `external_id` dele no Cosmos é o
  GC inteiro (`origin = gocreators`). Agora há um leitor só, `lerNumeroDaLoja` (`cxhub/shared/lib/pedido/numeroDaLoja.ts`),
  que devolve `{ prefixo: 'SH' | 'GC', digitos, sufixo }`:
  - **GC** é o texto com `GC` seguido de dígito, no formato `GC{n}` com ou sem a sigla (sem ela, vale a da marca). O GC
    fora do formato (`GC107465BB-R-1`, que é um reenvio) não é procurado, em vez de cair nos dígitos;
  - **SH** é o resto com dígito: `SH…XX`, `#n`, `n`, `#SHOPIFYn`. Só os dígitos continuam significando o SH/`#n`;
  - **Shopify:** o GC por `name:GC…` e nome exato; os dígitos nunca escolhem um nome que comece com GC. No Data Mart, o GC
    pelo `order_name`, com a marca e `created_at >= 2026-09-01` (o `order_name` não tem índice: 0,5 a 2,6 s);
  - **Cosmos:** o GC por `external_id=GC…` e casado pelo nome inteiro; os reenvios, `GC…-R-n`. O reenvio criado pelo
    `POST /resend` a partir do GC já sai `GC…-R-n`;
  - **reenvios de qualquer origem:** os reenvios GC criados pela Shopify têm `origin = shopify` (370 da Barbour's em
    25/11, como o `GC107465BB-R-1`), e o filtro `origin = resend` os perdia. Vale o nome, no SH e no GC (nenhum `SH…-R-n`
    teve outra origem desde 01/11). Decisão do usuário em 27/11;
  - **NF:** a Intelipost (Data Mart e ao vivo) pelo `sales_order_number = 'GC…'` e o metacampo pelo nome do GC. O
    `shopify_order_number` do GC na Intelipost é o interno da Shopify, e os dígitos achariam a NF do `#n`. Os GC não
    têm envio na Intelipost e, no Cosmos, estão em `status = erp` sem `invoice_number` desde 21/10, mas têm a NF no
    metacampo `custom.nf_numero` da Shopify (conferido ao vivo na v25, em 27/11: os 4 GC testados tinham);
  - **o reembolso GC precisa da NF** (decisão do usuário em 27/11), em toda marca: sem a NF que veio nem a achada,
    `422` e nada gravado (`recusaDoReembolsoGcSemNf`). O reenvio GC não precisa: na Yenzah, a conferência da ADR-018 não
    o dá como `ausente`, e sim `desconhecida` com o motivo `pedido_gocreators` e a nota
    `[NF NÃO CONFERIDA: PEDIDO DA GOCREATORS SEM NF]`;
  - **dedup e listas:** a fila continua consultada pelos dígitos (o contrato do `/api/v1` não mudou), e o resultado é
    filtrado pelo pedido; a raw, a gold, o histórico e a planilha comparam os dígitos e o lado (GC ou não) com o
    `sqlDoMesmoPedido`. O GC e o SH de mesmos dígitos nunca se barram;
  - **`/api/reenvio/existente`:** o `pedido` da resposta é o GC inteiro no GC (os dígitos no SH, como antes);
  - **backoffice:** os itens do GC vêm pelo `order_name` (`backoffice/servidor/pedido.ts`).
- **A solicitação da tela que não deu certo também é registrada (2026-11-27, decisão deste app, atrás da trava
  `REGISTRAR_FALHA_DA_TELA=on`, desligada por padrão).** Na Black, o Cosmos lento fez o `/api/sheets/append` barrar
  reenvios sem gravar nada. Com a trava:
  - **o que é registrado:** no reenvio, o dedup do Cosmos sem resposta, a recusa do Cosmos, o Cosmos sem resposta depois
    do `POST /resend`, o pedido sem NF (Ápice, Yenzah, Denavita) e o dedup fora do ar; no reembolso, os 422 (sem NF, GC
    sem NF, chave Pix exigida e ausente) e o dedup fora do ar. O caso vai à fila sem automação, com `status_execucao`
    Cancelado e `responsavel_execucao = "CX Hub"` (a DAG só aceita Realizado, Cancelado e Pendente). O "a conferir" (o
    Cosmos sem resposta depois do envio) vai Pendente, e a gold casa o `-R-n` se o reenvio existir. A linha vai à
    planilha com o status na coluna de status e a nota `[CXHub] <status>: <o que fazer>` nos comentários (reenvio, sem os
    campos da automação) ou nas observações (reembolso). Na Ápice, a planilha de reembolso não tem coluna de status
    conhecida: o status fica só nas observações;
  - **a resposta:** o mesmo `code`, texto e status HTTP de antes, mais `idSolicitacao`, `reason: REGISTRADO_SEM_EXECUCAO`
    e `statusRegistrado` (o texto da coluna de status);
  - **a nova tentativa:** a tela manda o `idSolicitacao` no corpo, e o CX Hub atualiza o mesmo caso (Pendente; "Automação"
    de responsável quando o Cosmos fez o reenvio) e reescreve a mesma linha. O id só vale para um caso sem execução do
    mesmo tipo, marca e pedido; outro é ignorado, e vale o dedup;
  - **a fila que recusa:** a linha vai assim mesmo, e a resposta é a da fila incerta (não repita);
  - **o cancelamento:** o do mesmo pedido em 24 h é barrado com `DUPLICATE_CANCELLATION`;
  - **antes de ligar:** a Central precisa mandar o `idSolicitacao` na nova tentativa e mostrar o `statusRegistrado`; o
    texto do status do reembolso precisa ser alinhado com o financeiro (a planilha é de onde ele paga), e os indicadores
    (Monitor da Black, backoffice) precisam ignorar o Cancelado do "CX Hub".

  Código: `cxhub/shared/lib/fila/semExecucao.ts`, `processResend.ts`, `processRefund.ts`, `processCancellation.ts` e
  `cxhub/shared/lib/sheets/gravarLinha.ts`.
- O `COSMOS_RESEND_SIMULADO` não vale aqui: este app é a produção. Para ensaiar, use o `testMode`.
- Não existe `maxDuration`. O bot continua calculando o orçamento dele para 150 s, então quem chama precisa esperar
  pelo menos isso.
- Log: cada requisição às rotas deixa uma linha `MÉTODO caminho → status em N ms` (sem a query string) no
  `getAppLogs` do GoDeploy, além do que as rotas já logavam.

## O reenvio que o pedido já tem (`GET /api/reenvio/existente`)

Rota nova (2026-11-24), para quem quer saber se o pedido já tem reenvio antes de pedir outro. O
`GET /api/cosmos/resends` só responde nas 6 marcas do Cosmos, e o `GET /api/solicitacoes` pede o token do Cosmos.
Esta rota vale para as 10 marcas, e basta a `gdk_`. Na Ápice, na Yenzah, na Denavita e na Gobeaute, ela é a única
consulta que existe: essas marcas não têm ERP para consultar, e o reenvio é feito pela operação a partir do registro.

Três leituras em paralelo (`cxhub/modules/reenvios/actions/reenviosDoPedido.ts`):

| Leitura | De onde | O que dá |
|---|---|---|
| O bloqueio | `solicitacaoRecenteNoRegistro`, a mesma função do dedup do `POST /api/sheets/append` e do bot | `bloqueiaNovo` e `bloqueadoPor`: o reenvio das últimas 24 h, da mesma marca e do mesmo pedido (pelos dígitos e pelo lado: o GC só com o GC), não cancelado, na fila ou na raw. É o `DUPLICATE_RESEND` que um reenvio novo levaria agora |
| O registro do CX Hub | `listarSolicitacoesNoRegistro` com o pedido: raw + fila, todo o histórico | `reenvios[]` com `fonte: "cxhub"`, sem o caso que a DAG recusou |
| O histórico | `gold.fct_reenvio_reembolso_gobeaute`, só a `chave_unica` fora do `cxhub\|` | `reenvios[]` com `fonte: "historico"`: as linhas do Supabase, de antes do CX Hub |

- **Por que a gold só pelo histórico:** as linhas `cxhub|…` dela são a raw copiada de hora em hora, então o registro já
  as tem, e mais novas. Em 24/11/2026 o histórico só existia nas 6 marcas do Cosmos (Supabase, de 11/2025 a
  28/10/2026); na Ápice, na Yenzah, na Denavita e na Gobeaute a gold é só do CX Hub, e essa consulta volta vazia. Ela é
  feita assim mesmo: leva 25 ms, e um histórico que a DAG trouxer depois aparece sem mudar o código.
- **O que pode faltar:** sem a raw ou a fila, a rota responde erro (502, 503 ou 504), porque o `bloqueiaNovo` depende
  delas. Sem a gold, responde 200 com `historicoLido: false` e só o registro.
- **O que ela não vê:** o reenvio feito fora do CX Hub (a linha digitada direto na planilha, o pedido criado à mão na
  loja). Nas marcas do Cosmos, o reenvio criado lá (`-R-n`) se confere no `GET /api/cosmos/resends`, e o POST do
  reenvio com automação também pergunta ao Cosmos (v19). Esta rota não pergunta.

## Backoffice (`/api/backoffice/*`)

O backend do app `backoffice-hub`, que vai virar uma página da Central de Tickets, está portado em `backoffice/`. A
origem e as adaptações estão em `backoffice/ORIGEM.md`; as regras de negócio, no `CLAUDE.md` deste repositório.

| Método | Caminho | O que faz |
|---|---|---|
| GET | `/api/backoffice/eu` | Quem chama, a janela de edição (30 dias) e o tamanho da página (50) |
| GET | `/api/backoffice/solicitacoes?tipo=REENVIO\|REEMBOLSO[&marca=<sigla>][&status=][&busca=][&cursor=][&contar=1]` | Uma página da gold + raw, com os casos ainda na fila, por cursor (`proximo` leva à seguinte; `contar=1` traz o `total`) |
| GET | `/api/backoffice/solicitacoes/{chave}` | A linha com o que a fila guarda por cima, as edições (e as atualizações do CX Hub ainda na fila), os dados do cliente e, se ela se edita, os motivos, o pedido e o catálogo do mimo |
| POST | `/api/backoffice/solicitacoes/{chave}/edicoes` | `{ campos?, cliente?, itens? }`: põe a edição na fila (vai à DAG no próximo lote) e/ou guarda os dados do cliente |
| DELETE | `/api/backoffice/edicoes/{id}` | Desfaz uma edição pendente ou dispensa uma recusada (a enviada não volta: 409; a do CX Hub: 403) |
| GET | `/api/backoffice/estado` | Diagnóstico: as edições por situação, a fila, o lote em andamento, os últimos lotes e a última rodada |

- **Quem chama:** o autor de cada edição vem do `x-usuario-email`, a pessoa na tela de quem chama, como na Central.
  Sem ele, vale o e-mail que o gateway põe no login do navegador. Sem nenhum dos dois, a chamada leva 401; com um
  `x-usuario-email` fora do formato, 400.
- **Escrita pelo navegador** (chamada com `Origin`): exige `x-backoffice: 1` e a origem do app. A chamada de servidor,
  sem `Origin`, não exige.
- **Fila única:** a edição é uma atualização da fila do app (a tabela `atualizacoes`, a mesma das do CX Hub), e quem
  editou fica em `bo_autoria`. Ela sobe no lote da fila (`cxhub_lote__…`), depois do caso, se ele ainda estiver lá. O
  caso que ainda está na fila entra na lista como uma raw virtual, montado pelo mesmo SQL do dbt. A rodada da fila
  confere na raw as edições gravadas (`backoffice/servidor/conferencia.ts`); o backoffice não tem lote nem cron
  próprios. As outras tabelas dele no `env.DB` têm o prefixo `bo_`.

## Cache da rota dados (`POST /api/interno/rota-dados`)

As listas do app `rota-dados-cxhub` ficam guardadas no `env.DB` (tabela `cache_rota_dados`). Quem lê por ela: o
`/api/resend/data`, as marcas que o bot aceita e os motivos do backoffice.

| Situação | O que acontece |
|---|---|
| Cache com menos de 15 min | Serve a cache, sem chamar a rota dados |
| Cache mais velha | Busca ao vivo e guarda a resposta |
| Rota dados fora | Serve a última resposta boa até 24 h, com aviso no log |
| Rota `POST /api/interno/rota-dados` | Renova as três origens. Chamada pelo cron ou à mão, com o `x-cxhub-fila-token`. Responde 200, ou 502 quando nenhuma origem renovou |

## Saúde (`GET /api/saude`)

Pedido do Monitor da Black (17/11/2026): saber se cada função está de pé, e não só se o app responde. O contrato é o
mesmo da `/api/saude` da Central de Tickets: 16 componentes, cada um com `nivel` (`ok`, `alerta`, `erro`),
`ultimo_sucesso`, `ultima_tentativa`, `erros_ultima_hora`, `pendentes`, `detalhe`, `critico` e `tipo`. Responde 503
só quando um componente crítico está em `erro`, em até ~4 s. O `HEAD` responde o mesmo status, sem corpo.

| Componente | Crítico | Vira erro | Alerta |
|---|---|---|---|
| `app` | sim | o `env.DB` não responde em 1,5 s | |
| `fila_rodada` | sim | 30 min sem rodada do lote com sucesso | 15 min, ou uma etapa falhou |
| `fila_entrega` | sim | um item na fila há mais de 60 min | 30 min, ou um lote sem resultado na última hora |
| `reenvio`, `reembolso`, `cancelamento` | sim | 3 falhas na hora sem nenhum registro | 1 falha na hora |
| `bot_reenvio` | sim | idem (no bot, 401 e 503 contam) | idem, ou registrou sem a automação porque o Cosmos ou a Shopify caiu |
| `consulta_pedido` | sim | 5 buscas na hora sem achar nenhum pedido | 1 falha na hora |
| `cache_rota_dados` | não | 30 min sem renovar | 15 min |
| `backoffice` | não | 3 falhas ao salvar ou desfazer na hora | 1 falha |
| `dep_airflow`, `dep_cosmos`, `dep_sheets`, `dep_datamart`, `dep_gateway`, `dep_rota_dados` | não | 2 falhas seguidas | 1 falha, ou resposta lenta |

Como cada desfecho é medido (código em `api/saude/`):

- **Onde a função termina, nunca pelo HTTP da rota.** Os envios e o bot pelo `code` do corpo, com a mesma régua do
  `desfechoEnvioCxHub` da Central (`SHEET_WRITE_FAILED` é registro, porque a fila guardou). O que é dado de quem chama
  (400, 409, 422, duplicado, estoque) é neutro, e o ensaio (`testMode`) não conta. A busca pelo pedido achado. A rodada
  do lote e a da cache pelo resumo que devolvem. O backoffice pelo status (o 4xx é a regra de edição).
- **A `fila_entrega` não grava nada:** é lida de `casos`, `atualizacoes`, `lotes` e `controle.ultima_rodada` a cada
  chamada. O item mais antigo esperando pega qualquer causa de fila parada, inclusive a rodada que "dá certo" sem
  entregar nada (o Airflow sem resposta, a DAG pausada). Nos logs de 17/11, cada caso chega à raw em até ~20 min.
- **As dependências pelo `fetch` global:** o `worker.ts` põe um envoltório na frente dele (`api/saude/medidor.ts`), que
  olha só o host e anota o desfecho, sem mudar a chamada. Assim o `cxhub/` não foi editado. O 401/403 do Cosmos é o token
  de quem chama, e não conta. O `dep_gateway` mede os hosts da `SHOPIFY_GATEWAY_URL` e da `INTELIPOST_GATEWAY_URL`
  (desde 2026-11-23; antes, o do integrations-gateway inteiro): a Shopify e, desde 2026-11-19, a Intelipost ao vivo; o
  400/404 da Intelipost (envio que não existe) não é falha, e a chave recusada (401 ou 403) é. Sem nenhuma chamada há
  15 min, a rota faz uma sonda só de leitura: a DAG no Airflow (que
  também diz se ela está pausada) e `select 1` no Data Mart. O Cosmos não tem sonda.
- **Gravação:** `anotarSaude` guarda em memória; o `worker.ts` grava no fim de cada requisição e de cada tarefa do
  `after()`, no `ctx.waitUntil`. A falha do registro só vai ao log (`[saude] registro não gravado`). Tabelas no `env.DB`:
  `saude_estado`, `saude_janela` (blocos de 5 min, apagados depois de 48 h) e `saude_meta`.
- **Custo:** a rodada do lote e a da cache gravam sempre (~430 rodadas por dia, 2 escritas cada); a dependência com
  sucesso grava no máximo uma vez por minuto; a leitura lê ~250 linhas.

## Crons

| Rota | Agenda | Situação |
|---|---|---|
| `POST /api/v1/interno/lote` (a fila e as edições do backoffice) | `*/10 * * * *` | Existe em `*/20`; passa a `*/10` com a versão da fila única |
| `POST /api/interno/rota-dados` | `*/5 * * * *` | Existe (v9) |

Sem assinatura conferida, cada rota aceita no máximo uma chamada a cada 30 s. A trava é uma por rota, então os crons
podem disparar no mesmo minuto.

## Segredos

Todos estão em `.env.example`, com o motivo de cada um e o que acontece sem ele.

## Antes de publicar

```bash
npm run checar   # tsc com os tipos do Node e tsc do Worker sem eles
npm test         # a fila, a cola (testes/api.test.ts) e os testes do CX Hub (cxhub/__tests__)
npm run workerd  # o worker.ts empacotado rodando no workerd, sem nodejs_compat (ferramentas/workerd/)
```

Sobem para o GoDeploy `worker.ts`, `servidor/`, `api/` (inclusive a página `api/docs.ts`), `cxhub/` (sem
`cxhub/__tests__` e sem o `ORIGEM.md`) e `backoffice/servidor/` e `backoffice/shared/` (sem `backoffice/testes/` e sem o
`ORIGEM.md`).
