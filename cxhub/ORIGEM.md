# Origem desta pasta

Cópia do backend do CX Hub (repositório `rpaiagogroup/cx-hub`), commit `8a1b1a9cbd7db6662f9673df303116e42d1bf68f`, feita por
`ferramentas/portar-do-cxhub.mjs`: o fecho de imports das 23 rotas que rodam na Vercel e os testes que só
dependem dele, com os mesmos caminhos relativos do CX Hub. O script só troca especificadores de import no código
(aliases → caminho relativo; `next/server` → `api/next-server.ts`); as adaptações ao Worker vieram à mão, depois.
Para ver só elas: rode o script com `--saida <pasta vazia>` e compare com `diff -r <pasta>/cxhub cxhub`.

Código (136 arquivos) e testes (95 arquivos). Testes que ficaram de fora (dependem de
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
  requisição chega): `app/api/shopify/orders/route.ts` (os `SHOPIFY_TOKEN_*`), `shared/lib/cosmos/server.ts`
  (`COSMOS_FETCH_BUDGET_MS`) e `gchatAlert.ts`.
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
  Ela continua marca do Cosmos em todo o resto, inclusive no `adaptShopifyOrder` e no bot.
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
