# API do app GoDeploy `cx-hub`

Backend do CX Hub em `https://cx-hub.devgogroup.com` (app `66edd698`, visibilidade `authenticated`). Duas partes no
mesmo Worker:

- `/api/v1/*`: a fila do Metabase, que guarda casos e atualizações e dispara a DAG `gobeaute_reenvio_reembolso_etl`
  em lote a cada 20 min. O contrato está em `docs/fila-cxhub.md`, no repositório do CX Hub.
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
  fallback da tela quando o Cosmos não acha o pedido, e agora só acha pedido dos últimos 60 dias. No resto, inclusive no
  bot, ela segue no Cosmos.
- O `COSMOS_RESEND_SIMULADO` não vale aqui: este app é a produção. Para ensaiar, use o `testMode`.
- Não existe `maxDuration`. O bot continua calculando o orçamento dele para 150 s, então quem chama precisa esperar
  pelo menos isso.
- Log: cada requisição às rotas deixa uma linha `MÉTODO caminho → status em N ms` (sem a query string) no
  `getAppLogs` do GoDeploy, além do que as rotas já logavam.

## Segredos

Todos estão em `.env.example`, com o motivo de cada um e o que acontece sem ele.

## Antes de publicar

```bash
npm run checar   # tsc com os tipos do Node e tsc do Worker sem eles
npm test         # a fila, a cola (testes/api.test.ts) e os testes do CX Hub (cxhub/__tests__)
npm run workerd  # o worker.ts empacotado rodando no workerd, sem nodejs_compat (ferramentas/workerd/)
```

Sobem para o GoDeploy `worker.ts`, `servidor/`, `api/` (inclusive a página `api/docs.ts`) e `cxhub/` (sem
`cxhub/__tests__` e sem o `ORIGEM.md`).
