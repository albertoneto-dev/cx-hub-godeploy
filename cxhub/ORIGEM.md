# Origem desta pasta

Cópia do backend do CX Hub (repositório `rpaiagogroup/cx-hub`), commit `11cebffcaeb745df32bcb6e7091ff0fec309b462`, feita por
`ferramentas/portar-do-cxhub.mjs`: o fecho de imports das 24 rotas de app/api do CX Hub e os testes que só
dependem dele, com os mesmos caminhos relativos do CX Hub. O script só troca especificadores de import no código
(aliases → caminho relativo; `next/server` → `api/next-server.ts`); as adaptações ao Worker vieram à mão, depois.
Para ver só elas: rode o script com `--saida <pasta vazia>` e compare com `diff -r <pasta>/cxhub cxhub`.

Código (145 arquivos) e testes (102 arquivos). Testes que ficaram de fora (dependem de
código que não roda no servidor):

- __tests__/integration/api-datamart-products.test.ts: shared/lib/datamart/index.ts, shared/lib/datamart/client.ts, shared/lib/auth/index.ts
- __tests__/integration/fila-metabase-falsos.test.ts: scripts/fila-metabase-falsos.mjs
- __tests__/logistica/submitLogistica.test.ts: modules/logistica/actions/submitLogistica.ts
- __tests__/logistica/validateSteps.test.ts: modules/logistica/actions/validateSteps.ts
- __tests__/reembolsos/buildRefundRow.test.ts: modules/reembolsos/actions/index.ts, modules/reembolsos/actions/refundList.ts, modules/reembolsos/actions/refundManagementForm.ts
- __tests__/reembolsos/buildRefundSubmissionData.test.ts: modules/reembolsos/actions/buildRefundSubmissionData.ts, modules/reembolsos/actions/calculateRefundValue.ts
- __tests__/reembolsos/calculateRefundValue.test.ts: modules/reembolsos/actions/calculateRefundValue.ts
- __tests__/reembolsos/casoDoReembolso.test.ts: modules/reembolsos/actions/index.ts, modules/reembolsos/actions/refundList.ts, modules/reembolsos/actions/refundManagementForm.ts
- __tests__/reembolsos/envioDoReembolso.test.ts: modules/reembolsos/actions/index.ts, modules/reembolsos/actions/refundList.ts, modules/reembolsos/actions/refundManagementForm.ts
- __tests__/reembolsos/refundList.test.ts: shared/lib/solicitacoes/index.ts, shared/lib/solicitacoes/client.ts, shared/lib/auth/index.ts
- __tests__/reembolsos/refundManagementClient.test.ts: shared/lib/auth/index.ts, shared/lib/auth/auth-context.tsx, modules/reembolsos/actions/refundManagementClient.ts
- __tests__/reembolsos/refundManagementForm.test.ts: modules/reembolsos/actions/refundManagementForm.ts
- __tests__/reembolsos/validateRefundSteps.test.ts: modules/reembolsos/actions/validateSteps.ts
- __tests__/reenvios/buildResendRow.test.ts: modules/reenvios/actions/index.ts, modules/reenvios/actions/resendManagementForm.ts, modules/reenvios/actions/resendManagementClient.ts
- __tests__/reenvios/casoDoReenvio.test.ts: modules/reenvios/actions/index.ts, modules/reenvios/actions/resendManagementForm.ts, modules/reenvios/actions/resendManagementClient.ts
- __tests__/reenvios/cosmosResend.test.ts: modules/reenvios/actions/index.ts, modules/reenvios/actions/resendManagementForm.ts, modules/reenvios/actions/resendManagementClient.ts
- __tests__/reenvios/envioDoReenvio.test.ts: modules/reenvios/actions/index.ts, modules/reenvios/actions/resendManagementForm.ts, modules/reenvios/actions/resendManagementClient.ts
- __tests__/reenvios/listaDeReenvios.test.ts: shared/lib/solicitacoes/index.ts, shared/lib/solicitacoes/client.ts, shared/lib/auth/index.ts
- __tests__/reenvios/mimoETroca.test.ts: modules/reenvios/actions/mimoETroca.ts
- __tests__/reenvios/reenvioDaSolicitacao.test.ts: modules/reenvios/actions/reenvioDaSolicitacao.ts
- __tests__/reenvios/resendManagementClient.test.ts: shared/lib/auth/index.ts, shared/lib/auth/auth-context.tsx, modules/reenvios/actions/resendManagementClient.ts
- __tests__/reenvios/resendManagementForm.test.ts: modules/reenvios/actions/resendManagementForm.ts
- __tests__/reenvios/resolveCarrierLoose.test.ts: modules/reenvios/actions/index.ts, modules/reenvios/actions/resendManagementForm.ts, modules/reenvios/actions/resendManagementClient.ts
- __tests__/reenvios/resolveManageableResend.test.ts: modules/reenvios/actions/resolveManageableResend.ts, modules/reenvios/actions/reenvioDaSolicitacao.ts
- __tests__/reenvios/submitResend.test.ts: modules/reenvios/actions/index.ts, modules/reenvios/actions/resendManagementForm.ts, modules/reenvios/actions/resendManagementClient.ts
- __tests__/reenvios/validateSteps.test.ts: modules/reenvios/actions/validateSteps.ts, modules/reenvios/actions/mimoETroca.ts, modules/reenvios/components/ResendStep1.tsx
- __tests__/shared/casoNaPlanilha.test.ts: modules/reenvios/actions/index.ts, modules/reenvios/actions/resendManagementForm.ts, modules/reenvios/actions/resendManagementClient.ts
- __tests__/shared/catalogoDataMart.test.ts: shared/lib/datamart/index.ts, shared/lib/datamart/client.ts, shared/lib/auth/index.ts
- __tests__/shared/cosmosAdapter.test.ts: modules/reembolsos/actions/calculateRefundValue.ts
- __tests__/shared/gestao.test.ts: shared/lib/gestao.ts
- __tests__/shared/gobeaute.test.ts: modules/reembolsos/actions/buildRefundSubmissionData.ts, modules/reembolsos/actions/calculateRefundValue.ts
- __tests__/shared/listarSolicitacoes.test.ts: shared/lib/solicitacoes/index.ts, shared/lib/solicitacoes/client.ts, shared/lib/auth/index.ts
- __tests__/shared/marcasSemCosmos.test.ts: modules/reembolsos/actions/validateSteps.ts, modules/reembolsos/actions/refundList.ts, modules/reembolsos/actions/refundManagementForm.ts
- __tests__/shared/pedidoSemCosmos.test.ts: shared/lib/datamart/index.ts, shared/lib/datamart/client.ts, shared/lib/auth/index.ts
- __tests__/shared/shopifyAdapter.test.ts: modules/reembolsos/actions/calculateRefundValue.ts
- __tests__/shared/solicitacoesClient.test.ts: shared/lib/solicitacoes/index.ts, shared/lib/solicitacoes/client.ts, shared/lib/auth/index.ts
- __tests__/shared/solicitacoesPaginacao.test.ts: shared/lib/solicitacoes/index.ts, shared/lib/solicitacoes/client.ts, shared/lib/auth/index.ts
- __tests__/shared/submissaoSemCosmos.test.ts: modules/reembolsos/actions/buildRefundSubmissionData.ts, modules/reembolsos/actions/calculateRefundValue.ts

## Adaptações ao Worker (à mão, depois da cópia)

O GoDeploy roda no workerd sem `nodejs_compat`: sem `Buffer`, `node:crypto` nem `process`. O que mudou, e por quê:

- `shared/lib/sheets/googleAuth.ts`: o JWT RS256 da conta de serviço é assinado pelo WebCrypto (`crypto.subtle`),
  não pelo `createSign` do `node:crypto`; o resto (leitura tolerante da chave, cache, erros sem a chave) é o mesmo.
- `shared/lib/jwt.ts`: o payload do JWT é lido com `atob` + `TextDecoder`, não com `Buffer`.
- `app/api/reenvio/bot/route.ts`: o `x-bot-secret` é comparado byte a byte em tempo constante com `TextEncoder`, não
  com o `timingSafeEqual` do `node:crypto`; dois comentários citam o Slack no lugar do Google Chat.
- `shared/lib/fila/client.ts`: a chamada sai por um transporte trocável (`usarTransporteDaFila`; o `worker.ts` põe o
  de `api/filaNoWorker.ts`, que entrega à fila deste mesmo Worker sem rede); `randomUUID` é o do `crypto` global.
- `shared/lib/alerts/gchatAlert.ts` (e o comentário de `formatAlert.ts`): o aviso vai ao Slack
  (`SLACK_ALERT_WEBHOOK_URL`, com `&`, `<` e `>` escapados), e a janela é `ALERT_THROTTLE_MS`; o texto é o mesmo.
- Env lida na carga do módulo passou a ser lida na chamada (no Worker o `process.env` só existe depois que a
  requisição chega): `shared/lib/cosmos/server.ts` (`COSMOS_FETCH_BUDGET_MS`) e `gchatAlert.ts`. O
  `app/api/shopify/orders/route.ts` lia assim os `SHOPIFY_TOKEN_*`, até deixar de usá-los (2026-11-17, abaixo).
- `cache: 'no-store'` saiu das chamadas de servidor (o runtime do Worker pode recusar a opção, e não há o cache do Next
  aqui): `processResend.ts`, `formDataApi.ts`, `metabase/client.ts`, `fila/client.ts`, `products/[id]/route.ts`,
  `googleAuth.ts`, `cosmos/http.ts`, `cosmos/server.ts` e `sheets/server.ts`. Os clientes de navegador que os barrels
  trazem (`cosmos/client.ts`, `shopify/client.ts`, `registro/client.ts`) ficaram como estão: não rodam no servidor.
- O `after()` do Next, o `NextRequest`, o `NextResponse` e o `VERCEL_ENV` vêm de `api/` (`next-server.ts`,
  `ambiente.ts`), sem mudança nas rotas.
- `shared/lib/formDataApi.ts` (2026-11-11): a leitura passa por um leitor trocável (`usarLeitorDaRotaDados`). O
  `worker.ts` põe nele a cache do `env.DB` (`api/cacheDaRotaDados.ts`), que o cron renova a cada 5 min. O motivo é
  que cada chamada à rota dados, outro app do GoDeploy, paga o gateway de novo (~0,8 s). A busca de antes virou
  `buscarDadosDoFormularioAoVivo`, que o cron usa. Sem leitor (os testes do CX Hub), tudo fica como no CX Hub.

## Decisões deste app (o comportamento muda em relação ao CX Hub)

- A Rituária lê a Shopify pelo integrations-gateway, porque este app não tem o `SHOPIFY_TOKEN_RITUARIA` (2026-11-10).
  `shared/lib/shopify/gateway.ts` ganhou `MarcaNoGateway` e `lePedidoPeloGateway` (as sem Cosmos e a Rituária), que
  `app/api/shopify/orders/route.ts` usa no lugar do `ehMarcaSemCosmos`, e a Rituária saiu do `SHOPIFY_STORES`. O
  `buscarPedidoNoGateway.ts` e o `nomeDoPedido.ts` aceitam a `MarcaNoGateway`; na Rituária, a busca é só pelos dígitos.
  Ela continua marca do Cosmos em todo o resto, inclusive no `adaptShopifyOrder` e no bot. Em 2026-11-17 as outras 5
  marcas do Cosmos seguiram o mesmo caminho (abaixo).
- O lote da fila roda a cada 10 min (2026-11-11), e não a cada 20 como diz o `docs/fila-cxhub.md` de lá. As mensagens
  do CX Hub que prometem "até 20 min" (`NO_PROXIMO_LOTE` e as de sucesso do registro) ficaram como estão: são resposta
  de sucesso, que o contrato manda manter igual à da Vercel, e continuam verdadeiras. Nenhum arquivo daqui mudou por isso.
- A fila também recebe as edições do backoffice (`backoffice/ORIGEM.md`, fila única). Quem lê as atualizações de um caso
  pela fila (`GET /api/v1/atualizacoes`, o `shared/lib/fila/estado.ts`) passa a ver as do backoffice junto das do CX Hub.
- O pedido das marcas do gateway tem o Data Mart de reserva (2026-11-12). O integrations-gateway só enxerga os últimos
  60 dias (falta o `read_all_orders` nas lojas), e o pedido #1607929 da Ápice, de 64 dias, não pôde ter o reenvio pedido.
  Arquivos novos: `shared/lib/datamart/pedidoDaShopifyServer.ts` (lê `api.vw_shopify_orders` pela chave, com o
  `order_id` da `gold.fct_shopify_orders` pelo índice de marca e número, e devolve o mesmo `ShopifyOrder` do gateway; na
  Ápice, sem telefone na Shopify, vale o do Tiny, pelo `external_erp_id` da Intelipost) e
  `shared/lib/shopify/buscarPedidoNoGatewayOuNoDataMart.ts` (o gateway primeiro; o Data Mart quando ele não acha ou
  falha; sem o pedido nos dois, o desfecho do gateway). `app/api/shopify/orders/route.ts` e a busca do
  `app/api/reenvio/bot/route.ts` chamam a função nova no lugar do `buscarPedidoNoGateway`, e o motivo do
  `ORDER_NOT_FOUND` do bot diz "na Shopify nem no Data Mart". Vale para Ápice, Yenzah, Denavita e Rituária; a Gobeaute
  não está no Data Mart. A tela do CX Hub ainda diz "a busca alcança só os pedidos dos últimos 60 dias" quando nada é
  achado: é texto do navegador, que não está nesta cópia.
- A cópia é do `11cebff` (ADR-018), o último commit do repositório antigo do CX Hub, na branch
  `feat/regras-sem-cosmos-no-servidor`, que nunca foi para a `main` de lá. Em 2026-11-13 o repositório antigo foi
  encerrado e **este passou a ser o CX Hub**: não há mais commit de lá para trazer. O motivo de trazer a ADR-018: o
  `GET /api/datamart/order-context` respondia 404 aqui, e o reembolso da Ápice, da Yenzah e da Denavita chegava à
  planilha com a NF que a Central de Tickets mandava ("-"). A `main` de lá e a Vercel ficaram sem ela: só aqui o reenvio
  e o reembolso dessas três marcas conferem o pedido no Data Mart (NF, CD e valor da NF de reenvio; pedido sem NF ⇒ 422)
  e validam a chave Pix pelo tipo. O código da ADR-018 entrou sem adaptação ao Worker: nenhum `cache`, `Buffer` ou
  `node:*`, e o `CHAVE_PIX_OBRIGATORIA` é lido a cada chamada.
- A chave Pix em todas as marcas, aceita como vier (2026-11-16, v14). A Maria pediu "coletar chave Pix aceitando qualquer
  valor" em todas as marcas: as agentes digitavam a chave nas Observações à mão, porque nas 6 do Cosmos o servidor nem a
  lia e a coluna "Recebimento - Chave Pix" ficava vazia. Mudou:
  - `chavePixDoReembolso` nunca recusa por formato: com `pixKeyType` e chave válida para ele grava a normalizada (outros
    clientes ainda mandam o tipo); sem tipo, tipo desconhecido ou chave fora do formato, grava o texto com `trim()`.
    A Central de Tickets manda o texto sem tipo. O 422 por chave inválida deixou de existir; o 422 por chave que falta
    continua só na Ápice, Yenzah e Denavita com `CHAVE_PIX_OBRIGATORIA=on`;
  - `processRefund` lê a chave em toda marca com planilha (a Gobeaute não a lê). Nas 6 do Cosmos é sempre opcional: o
    bot e a tela antiga do CX Hub não a mandam;
  - `buildRefundRow` grava a chave na coluna "Recebimento - Chave Pix" (índice 0 = A): Lescent W (22, com um `null` na V,
    "Origem do pedido"), BySamia M (12), Auá L (11), Barbours Q (16), Rituária K (10);
  - **Kokeshi:** a planilha está deslocada. O cabeçalho diz Devolvido(R), Ticket(S), Observações(T), Completo(U),
    Exceção(V) e Chave Pix(W), mas o builder (e as linhas reais, desde antes do CX Hub) põe um `null` a mais, e a coluna
    W guarda a "Exceção". Corrigir muda a planilha da dona: fica para combinar com ela. Até lá, a chave vai no fim da
    célula de Observações da **linha da planilha** (`obs` + quebra de linha + `Chave Pix: <chave>`); o caso da fila e a
    gold seguem sem ela;
  - `COLUNA_DA_CHAVE_PIX` cobre as 9 marcas (na Kokeshi, é a célula de Observações): a linha que falhou vai ao log com
    essa coluna omitida. A chave nunca vai à fila, à gold, ao log nem ao Chat.
- A NF da Ápice só é recusada com prova de que o pedido não foi faturado (2026-11-16). O SH1832330AP, cancelado no ES e
  refeito no RJ no mesmo dia, levou dois 422 ("não tem NF de venda") com a NF já emitida, e a order-context mostrou o CD
  ES. As causas: sem a Intelipost no gold (~1 h depois da NF), a busca no Tiny por data procurava só o `numero_ecommerce`,
  que vem vazio em todo pedido do RJ; o pedido cancelado do ES podia ser o escolhido; e não achar a NF no Data Mart valia
  como prova de que ela não existe. O que mudou:
  - `shared/lib/datamart/pedido.ts`: o `derivarContextoDoPedido` só dá `ausente` com prova (o pedido ativo sem o id da
    NF, a NF achada e cancelada, ou o pedido em lugar nenhum). Na dúvida, dá `desconhecida` com o motivo e o aviso dele:
    `sem_resposta` (como antes), `nf_fora_do_data_mart` (o pedido ativo já tem o id da NF, que ainda não chegou à tabela
    de NFs) ou `pedido_cancelado_no_tiny` (o Tiny só tem o pedido cancelado). O `pedidoEscolhidoNoTiny` prefere o ativo,
    depois o que tem o id da NF, depois o mais recente, depois o ES. O CD e a NF nunca saem de pedido cancelado: dos
    cancelados com NF autorizada, os 20 do RJ de 03 a 07/11 e 42 dos 56 do ES de 05 e 06/11 tinham sido refeitos com
    outra NF. O `notaDeNaoConferido` diz o motivo real, e o `motivosDoNaoConferido` o tira do contexto;
  - `shared/lib/datamart/pedidoServer.ts`: o Tiny lê a `situacao`. A busca por data procura o número no
    `numero_ordem_compra` ou no `numero_ecommerce`, nos dois CDs: no ES, 2,6% dos pedidos só têm o primeiro. A janela do
    RJ vai a 60 dias, e a do ES fica em 12. A NF do pedido cancelado não é lida. As medidas estão nos comentários;
  - `shared/lib/datamart/pedidoTipos.ts`: o `PedidoNoTiny.cancelado`, o `MotivoDoNaoConferido`, o `MotivoPorCampo`, e o
    motivo na NF `desconhecida` e no CD sem conferência;
  - `modules/{reembolsos,reenvios}/actions/conferenciaDo*.ts`: a nota leva o motivo, como
    `[NF NÃO CONFERIDA: AINDA FORA DO DATA MART]` ou `[CD/NF NÃO CONFERIDOS: PEDIDO CANCELADO NO TINY]`;
  - `app/api/datamart/order-context/route.ts`: o campo novo `nfMotivo`, só com `nfStatus: 'desconhecida'`, para a
    Central de Tickets deixar de dizer "o Data Mart não respondeu" em toda NF desconhecida. O aviso "O Data Mart não
    respondeu a tempo" fica só para o que ficou sem resposta. Nada do que a resposta já tinha mudou.

  Yenzah e Denavita ficaram como estavam: a única prova delas é a Intelipost, e o atraso de ~1 h até a remessa chegar ao
  gold também as bloqueia (a NF fica `ausente`, e o registro, recusado, até lá).
- Nenhum token de loja da Shopify (2026-11-17). O usuário pediu: "o cx-hub não deve mais usar nenhuma chave da Shopify
  [...] as chaves vão ser trocadas [...] a INTEGRATIONS_GATEWAY_URL já resolve". Lescent, Kokeshi, BySamia, Auá e
  Barbours liam o REST `orders.json` da loja com os `SHOPIFY_TOKEN_*`. Passaram ao integrations-gateway, como a Rituária
  e as sem Cosmos. O gateway conhece as 10 lojas pelo slug do CX Hub (conferido em 2026-11-06, com os mesmos domínios do
  `SHOPIFY_STORES`). O que mudou:
  - `shared/lib/shopify/gateway.ts`: `MarcaNoGateway` é a `MarcaCxHub`, e `lePedidoPeloGateway` é o `ehMarcaCxHub`. A
    URL vem de `urlDoGateway()`: a `INTEGRATIONS_GATEWAY_URL` quando cadastrada, senão a de produção
    (`URL_PADRAO_DO_GATEWAY`, o antigo `URL_DO_GATEWAY`), lida a cada chamada;
  - `app/api/shopify/orders/route.ts`: sem o `SHOPIFY_STORES` e sem o REST. Marca fora do CX Hub continua `400 Unknown
    brand`. Nas 5 marcas, a resposta passou a ter 0 ou 1 pedido, só com os campos que o `adaptShopifyOrder` lê (a cópia
    dele na Central de Tickets, o `cxAdaptarPedidoShopify`, lê os mesmos), e o erro passou a ser o do gateway (`502`,
    não o status da Shopify repassado). O `escolherPedido` confere os dígitos do nome, então o reenvio do Cosmos
    (`SH…-R-1`), que o filtro `name=` do REST devolvia primeiro, deixa de ser candidato;
  - `shared/lib/shopify/nomeDoPedido.ts`: nas 6 do Cosmos a busca é só pelos dígitos, como o `name=` do REST fazia.
    Mudou só o comentário;
  - `shared/lib/datamart/pedidoDaShopifyServer.ts`: a reserva vale para as 9 marcas com planilha. A lista virou o mapa
    `MARCA_NO_DATA_MART`, porque a BySamia é `by_samia` na `gold.fct_shopify_orders`. Conferido em 2026-11-17: as 5
    marcas novas estão lá, desde 2024 ou 2025, com o pedido de 90 dias atrás na `api.vw_shopify_orders` e o nome
    (`SH592465LC`, `SH39996BS`…) com os dígitos do `order_number`. Sem isso, o pedido de mais de 60 dias dessas marcas,
    que o REST achava, deixaria de ser achado.

  Publicado como v15. Os 5 `SHOPIFY_TOKEN_*` foram apagados do app no GoDeploy logo depois, a pedido do usuário, e as
  13 chamadas de conferência ao `/api/shopify/orders` no ar (um pedido de 3 dias por marca do Cosmos e a Ápice, pelo
  gateway; um de 95 dias por marca nova, pelo Data Mart; e uma marca inválida) deram o mesmo resultado sem eles.
- A NF das 6 marcas do Cosmos sai da Intelipost quando não vem (2026-11-17). Desde a virada do Cosmos para o V3 (21/10),
  o pedido criado depois dela vem sem `invoice_number`, e a tela e a Central de Tickets mandavam `"-"`: a planilha e a
  gold ficaram sem NF em 88 a 97% dos reenvios e reembolsos dessas marcas com pedido de 26/10 em diante, e a Intelipost
  tinha a NF em 92% deles. Arquivo novo: `shared/lib/datamart/nfDaIntelipostServer.ts` (`nfAusente`: vazia, `-`, `na`,
  `n/a` ou só zeros; `nfDaIntelipost`: a NF da primeira remessa pelo índice `(shopify_order_number, brand_code)`, sem
  os zeros à esquerda, com a BySamia como `by_samia`; nunca lança). O `processResend` e o `processRefund` a consultam
  junto do dedup, com o teto da conferência, só nas marcas do Cosmos e só quando a NF não veio; sem resposta, fica a
  que veio. A NF que veio nunca é trocada. O Cosmos não recebe a NF, então o reenvio automático não muda.

## Testes

- Mudados para o contrato novo: `shared/gchatAlert.test.ts` e `shared/gravarLinhaAviso.test.ts` (Slack, e dois casos
  novos: o escape do `<!channel>` e o erro do Slack no log sem a URL), `integration/api-resend-data.test.ts` (sem a
  opção `cache`) e um comentário de `integration/api-reenvio-bot-alertas.test.ts`.
- Trazidos à mão, trocando só o import do barrel de actions pelo arquivo da função (o barrel arrasta código de tela):
  `reenvios/buildResendRow`, `reenvios/casoDoReenvio`, `reenvios/cosmosResend`, `reembolsos/buildRefundRow`,
  `reembolsos/casoDoReembolso` e `shared/casoNaPlanilha`. O `reenvios/resolveCarrierLoose` testa o próprio barrel e
  ficou de fora.
- `helpers/relogio-falso.ts`: o `ateTerminar` só anda o relógio falso quando há timer falso pendente; sem nenhum, espera
  a vez de verdade (`setImmediate`). Aqui o JWT do Google é assinado pelo WebCrypto, assíncrono de verdade (no CX Hub, o
  `createSign` é síncrono). Enquanto ele assinava, o relógio andava à toa e a primeira chamada ao Google saía segundos
  depois do instante zero: 8 testes de `shared/sheetsServer` e `shared/gravarLinha` falhavam assim.
- Trazido à mão do mesmo jeito: `integration/api-datamart-products`. O `fnv1a32` vem de `shared/lib/datamart/catalogo`,
  e não do barrel `shared/lib/datamart`, que traz o cliente do navegador.
- Ficam de fora por dependerem de código de tela: `shared/shopifyAdapter` e `shared/cosmosAdapter` (usam o
  `calculateRefundValue`), e `shared/catalogoDataMart` (testa também o cliente do navegador). O `adapter.ts` daqui é
  idêntico ao do CX Hub, e a suíte de lá o cobre.
- Novos: dois casos da Rituária pelo gateway em `integration/api-marcas-sem-cosmos.test.ts`. O caso do REST passou a
  dizer "as outras 5 marcas do Cosmos".
- Novos (o Data Mart de reserva, 2026-11-12): `shared/pedidoDaShopifyNoDataMart.test.ts` e
  `shared/buscarPedidoNoGatewayOuNoDataMart.test.ts`, um caso em `integration/api-marcas-sem-cosmos.test.ts` (o pedido
  fora dos 60 dias vem do Data Mart) e um em `integration/api-reenvio-bot-sem-cosmos.test.ts` (o bot registra com os
  dados do pedido do Data Mart). O caso do `ORDER_NOT_FOUND` do bot passou a esperar "na Shopify nem no Data Mart".
- Trazido à mão (ADR-018): `shared/pedidoSemCosmos`, as regras puras de `shared/lib/datamart/pedido.ts` (com o pedido
  real SH1731559AP). Só o import mudou: o barrel `shared/lib/datamart`, que traz o cliente do navegador, deu lugar a
  `shared/lib/datamart/pedido` e `shared/lib/datamart/pedidoTipos`.
- Novos (2026-11-16, a NF da Ápice só recusada com prova), 35 casos:
  - `shared/pedidoSemCosmos`: o pedido real SH1832330AP, sem e com a Intelipost, só com o ES cancelado, cancelado nos
    dois CDs, com a NF autorizada de um pedido cancelado, com o pedido ativo sem NF, com a NF cancelada, com a falta de
    resposta antes dos outros motivos, e o desempate pela NF. Também a escolha do pedido no Tiny e a nota com o motivo;
  - `shared/pedidoNoDataMart`: a busca pelo `numero_ordem_compra`, a `situacao`, a janela de 60 dias do RJ e a NF do
    pedido cancelado, que não é lida;
  - `reembolsos/conferenciaDoReembolso`, `reenvios/conferenciaDoReenvio` e `reembolsos/processSemCosmos`: a NF que veio
    é gravada com a nota do motivo, e o `ausente` continua recusado;
  - `integration/api-datamart-order-context`: o `nfMotivo`, e o aviso de sem resposta só quando foi falta de resposta.

  Mudaram: os testes do `ausente` usam um pedido do Tiny sem o id da NF (com o id, agora é `nf_fora_do_data_mart`), e as
  fixtures da NF `desconhecida` e do CD sem conferência levam o motivo.
- Sem token de loja (2026-11-17):
  - `integration/api-shopify-orders` foi reescrito: testava o REST com os `SHOPIFY_TOKEN_*`, e agora testa as 6 do
    Cosmos pelo gateway (o nome da marca na URL, só os dígitos, nenhum token de loja nem `myshopify.com` nas chamadas
    mesmo com os tokens no ambiente, o reenvio `SH…-R-1` que não é escolhido, a `INTEGRATIONS_GATEWAY_URL`, a reserva
    com `by_samia`, o 500 sem a chave, o 502 do gateway e os 400);
  - `integration/api-marcas-sem-cosmos`: saiu o caso "as outras 5 marcas do Cosmos seguem no REST", e o `beforeEach`
    não estuba mais o token;
  - `shared/pedidoDaShopifyNoDataMart`: as 5 marcas novas na reserva, e a BySamia como `by_samia` no SQL.

## Atualizar para um commit novo do CX Hub

Do `e8fe51c` para o `8a1b1a9`, em 2026-11-11, foi feito assim:

1. Regere o porte cru do commit atual (o do cabeçalho) com o script como ele era naquele commit. A lista de rotas pode
   ter mudado: esse porte é a **base**.
2. Gere o porte cru do commit novo com o script do repo, com rota nova em `ROTAS`: esse é o **novo**.
3. Mescle arquivo a arquivo, em 3 vias (`git merge-file <cxhub/arquivo> <base> <novo>`):
   - o que não mudou no CX Hub fica como está aqui;
   - o que não foi adaptado aqui entra como veio;
   - o que mudou dos dois lados é mesclado, e os conflitos são resolvidos à mão.
4. Refaça os testes trazidos à mão a partir das versões novas.
5. Confira o código novo ou mudado contra o Worker: `cache`, env lida na carga do módulo, `Buffer`, `node:*`.
6. Ponha a rota nova em `api/roteador.ts`, em `docs/api.md` e na página `/docs` (`api/docs.ts`, com o commit novo no
   cabeçalho dela), e a env nova no `.env.example`.

Nessa atualização houve um conflito só, em `shared/lib/sheets/server.ts`: o CX Hub renomeou a variável do `catch` e
este app tinha tirado o `cache: 'no-store'`. Ficaram as duas mudanças.

Do `8a1b1a9` para o `11cebff` (ADR-018), em 2026-11-13, pelo mesmo roteiro, com a rota
`app/api/datamart/order-context/route.ts` acrescentada ao `ROTAS` do script:
- 9 arquivos de código novos e 14 mudados. Três deles tinham adaptação daqui e mesclaram sem conflito:
  `shared/lib/metabase/client.ts` e `modules/reenvios/actions/processResend.ts` (sem o `cache: 'no-store'`) e
  `app/api/reenvio/bot/route.ts` (o `x-bot-secret` sem `node:crypto`, o Slack e o Data Mart de reserva da v11);
- 7 testes novos e 6 mudados. Um conflito, em `integration/api-reenvio-bot-sem-cosmos.test.ts`: a ADR pôs dois casos
  novos (`ORDER_NOT_INVOICED`) logo antes do caso do `ORDER_NOT_FOUND`, que a v11 tinha renomeado. Ficaram os dois casos
  novos e o título daqui;
- o `shared/pedidoSemCosmos` foi trazido à mão (acima);
- a rota nova entrou em `api/roteador.ts`, `testes/api.test.ts`, `docs/api.md` e na página `/docs`, e o
  `CHAVE_PIX_OBRIGATORIA` no `.env.example`.
