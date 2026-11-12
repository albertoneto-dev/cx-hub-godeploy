# API do app GoDeploy `cx-hub`

Backend do CX Hub em `https://cx-hub.devgogroup.com` (app `66edd698`, visibilidade `authenticated`). Duas partes no
mesmo Worker:

- `/api/v1/*`: a fila do Metabase, que guarda casos e atualizações e dispara a DAG `gobeaute_reenvio_reembolso_etl`
  em lote a cada 10 min (era 20 até a v9). O contrato está em `docs/fila-cxhub.md`, no repositório do CX Hub. As
  edições do backoffice (abaixo) são atualizações desta fila.
- O resto: as 23 rotas que o CX Hub tem na Vercel, **nos mesmos caminhos, métodos, corpos e respostas**. O código é
  o do CX Hub (`cxhub/`, com origem em `cxhub/ORIGEM.md`); as regras de negócio estão no `CLAUDE.md` de lá.

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
| `/api/cosmos/*`, `/api/datamart/products`, `/api/refund/{cancel,update,complete,sync}`, `/api/registro`, `/api/solicitacoes` | `x-cosmos-token: <token>`: o `credentials.token` do `/api/auth/login`, com ou sem `Bearer `. Na Vercel ia no `Authorization`. O app o põe no `Authorization` só para a rota, e uma `gdk_` nunca chega ao Cosmos. |
| `/api/reenvio/bot` | `x-bot-secret` (o `BOT_RESEND_SECRET`), **junto da** `gdk_`: um só não passa. Quem chama é o Typebot e, quando for publicado, o Extravios Gobeaute do hub Jornada CX |
| `/api/v1/*` (a fila) | `x-cxhub-fila-token` |
| `/api/auth/login`, `/api/cancellation/submit`, `/api/refund/submit`, `/api/sheets/append`, `/api/logistica/submit`, `/api/resend/data`, `/api/shopify/orders` | nenhum, como na Vercel. Aqui ficam atrás do gateway, e na Vercel estavam abertas. |

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
| GET | `/api/shopify/orders?brand=&orderId=` | O pedido na Shopify: pelo REST da loja (Lescent, Kokeshi, BySamia, Auá, Barbours) ou pelo integrations-gateway (Rituária, Ápice, Yenzah, Denavita, Gobeaute) |
| GET | `/api/datamart/products?brand=apice\|yenzah\|denavita` | O catálogo de produtos avulsos da marca no Data Mart, no formato dos produtos do Cosmos: o mimo e a troca do reenvio das marcas sem Cosmos. Guardado por 6 h em memória |
| GET | `/api/resend/data?origin=reenvio\|reembolso\|logistica` | Os dropdowns do formulário (app `rota-dados-cxhub`) |
| POST | `/api/sheets/append` | Registra um reenvio da tela: dedup de 24 h, Cosmos (`POST /resend`), fila e planilha. `testMode: true` não grava |
| POST | `/api/reenvio/bot` | O reenvio do Typebot: busca o pedido, aplica as guardas e registra; toda dúvida vira registro sem automação. `testMode: true` não grava |
| POST | `/api/refund/submit` | Registra um reembolso: dedup de 24 h, fila e planilha |
| POST | `/api/cancellation/submit` | Registra um cancelamento junto do reenvio ou do reembolso: fila e planilha |
| POST | `/api/refund/cancel` | Cancela o reembolso mais recente do pedido (fila, depois planilha) |
| POST | `/api/refund/update` | Edita valor e motivo do reembolso |
| POST | `/api/refund/complete` | Marca o reembolso como Realizado (pelo `idSolicitacao`) |
| POST | `/api/refund/sync` | Leva à fila o Realizado ou o Cancelado que o backoffice marcou na planilha |
| GET | `/api/solicitacoes?tipo=[&marca=][&pedido=][&pagina=]` | Uma página (20) das solicitações dos últimos 30 dias, raw e fila juntas |
| GET | `/api/registro?ids=` | Onde estão até 20 casos: `gravado`, `aguardando` ou `recusado` |
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
- A Rituária lê a Shopify pelo integrations-gateway, sem `SHOPIFY_TOKEN_RITUARIA` (o app não tem o token da loja). É o
  fallback da tela quando o Cosmos não acha o pedido. No resto, inclusive no bot, ela segue no Cosmos.
- O pedido que o integrations-gateway não acha (ele só enxerga os últimos 60 dias) ou com ele fora do ar vem do Data
  Mart (`api.vw_shopify_orders`, pela chave do Metabase), no mesmo formato: no `/api/shopify/orders` (Ápice, Yenzah,
  Denavita e Rituária) e no bot (as sem Cosmos). Na Ápice, quando a Shopify não tem o telefone, vale o do Tiny. Na
  Vercel, o pedido de mais de 60 dias voltava como não encontrado e a
  agente não conseguia pedir o reenvio (o #1607929 da Ápice, em 2026-11-12). A Gobeaute não está no Data Mart e continua
  com o limite. Código: `cxhub/shared/lib/shopify/buscarPedidoNoGatewayOuNoDataMart.ts` e
  `cxhub/shared/lib/datamart/pedidoDaShopifyServer.ts`.
- O `COSMOS_RESEND_SIMULADO` não vale aqui: este app é a produção. Para ensaiar, use o `testMode`.
- Não existe `maxDuration`. O bot continua calculando o orçamento dele para 150 s, então quem chama precisa esperar
  pelo menos isso.
- Log: cada requisição às rotas deixa uma linha `MÉTODO caminho → status em N ms` (sem a query string) no
  `getAppLogs` do GoDeploy, além do que as rotas já logavam.

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
