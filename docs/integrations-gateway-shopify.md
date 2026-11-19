# integrations-gateway: a Shopify e a Intelipost

> Trazido do repositório antigo do CX Hub (`docs/integrations-gateway-shopify.md`, testado em **2026-11-06**, só com
> leitura) em 2026-11-19, quando aquele repositório já estava encerrado. Revisto para o que este app faz desde a v15
> (toda marca pelo gateway, sem token de loja) e para a NF de venda (o metacampo da Shopify e a Intelipost ao vivo).
> Tudo o que está aqui foi observado; o que não foi testado está marcado.

## Resumo

| Item | Valor |
|---|---|
| Base | `https://integrations-gateway-prod.rpa-ia.workers.dev` (a `INTEGRATIONS_GATEWAY_URL`, quando cadastrada) |
| Autenticação | `Authorization: Bearer <chave igw_…>` |
| Chave de leitura da Shopify | `INTEGRATIONS_GATEWAY_READ_KEY` (escopo `shopify:read`): o pedido de toda marca e o metacampo da NF |
| Chave da Intelipost | `INTEGRATIONS_GATEWAY_WRITE_KEY`: a chave com `intelipost:read` (a mesma que a Central de Tickets usa). O nome é histórico: ela também escreve na Shopify (nota e endereço), e o app nunca chama essas rotas |
| Leitura da Shopify | **`POST /shopify/{marca}/graphql`**: Admin API **GraphQL** da loja da marca |
| Leitura da Intelipost | **`GET /intelipost/{conta}/shipment_order/…`**: a API da Intelipost, ao vivo |
| Janela da Shopify | **só os últimos 60 dias** de pedidos (sem `read_all_orders`); o resto vem do Data Mart |

## Rotas

| Rota | Método | O que faz |
|---|---|---|
| `/whoami` | `GET` | Mostra o título, o dono e os escopos da chave |
| `/shopify/{marca}/graphql` | `POST` | Executa uma consulta GraphQL na loja da marca. É **a rota de leitura** da Shopify |
| `/shopify/{marca}/orders/{shopify_order_id}/note` | `PUT` | **Escreve** a nota do pedido. O app não usa |
| `/intelipost/{conta}/shipment_order/sales_order_number/{SH…}` | `GET` | O envio enxuto do pedido, pelo número dele na loja (`SH1832330AP`) |
| `/intelipost/{conta}/shipment_order/{order_number}` | `GET` | O envio completo, pelo `order_number` da Intelipost (`SH712937LC001804367`) |

**O gateway resolve a rota antes da chave:** sem chave, uma rota inexistente dá `404`, um método errado dá `405` (com
`Allow:`) e uma rota existente dá `401`.

| Resposta | Quando |
|---|---|
| `401 {"error":"invalid_key"}` + `WWW-Authenticate: Bearer realm="integrations-gateway"` | sem chave ou chave errada |
| `403 {"error":"insufficient_scope"}` | chave válida sem o escopo da rota (na Intelipost, sem `intelipost:read`) |
| `404 {"error":"unknown_store"}` | marca que o gateway não conhece (testado: `gocase`, `xyz`) |
| `404 {"error":"not_found"}` | rota que não existe |
| `405 {"error":"method_not_allowed"}` | método errado |
| `200` com `errors[]` | erro do GraphQL, **inclusive campo sem permissão**: confira sempre o `errors`, o status HTTP não basta |
| `429` | limite de taxa (visto em 06/11, numa rajada de ~10 consultas em poucos segundos com a mesma chave). O limite e o `Retry-After` não são documentados |
| `400` na Intelipost | o envio não existe (a resposta da própria Intelipost) |

## Marcas e contas

| `{marca}` (Shopify) | Loja (`myshopifyDomain`) | Sigla do pedido | Conta da Intelipost |
|---|---|---|---|
| `lescent` | `568499-ef.myshopify.com` | `LC` | `lescent` |
| `kokeshi` | `kokeshi-loja.myshopify.com` | `KS` | `lescent` |
| `bysamia` | `gcpf8a-ki.myshopify.com` | `BS` | `lescent` |
| `aua` | `ca0rd1-ft.myshopify.com` | `AU` | `lescent` |
| `barbours` | `742eae-3.myshopify.com` | `BB` | `beautyhub` |
| `rituaria` | `uyckuc-fw.myshopify.com` | `RT` | `beautyhub` |
| `apice` | `apse-cosmetics-dev.myshopify.com` | `AP` | `apice` |
| `yenzah` | `40wu41-md.myshopify.com` | `YE` | `beautyhub` |
| `denavita` | `74535e-3.myshopify.com` | `DN` | `denavita` |
| `gobeaute` | `syz4re-14.myshopify.com` | `GB` | — |

As lojas foram conferidas com `query { shop { name myshopifyDomain primaryDomain { host } } }` em 06/11. As contas da
Intelipost são as da Central de Tickets (`src/torre/gateway.ts`) e das `INTELIPOST_ACCOUNTS` do Airflow. As siglas das
marcas do Cosmos são as da Central (`SH52988BS`, `SH1452727RT`, `SH712937LC`).

## A NF de venda (2026-11-19)

### Na Shopify: o metacampo `custom.nf_numero`

A Shopify guarda a NF no **metacampo** `custom.nf_numero` (o XML fica em `custom.nf_xml`), e **não** no atributo
`nf_number` dos `customAttributes`, que o CX Hub lia: ele não existe em nenhum pedido consultado. Medido pelo gateway em
19/11, nos 50 pedidos de 05 a 15/11 de cada marca:

| Marcas | Pedidos despachados com o metacampo |
|---|---|
| Lescent, Kokeshi, BySamia, Auá, Barbours, Rituária, Yenzah | 100% |
| Ápice | 0 de 42 |
| Denavita | 0 de 46 |
| Gobeaute | 0 de 32 |

Nenhum dos 71 pedidos cancelados tinha o metacampo. Exemplos: o `SH52988BS` (BySamia) tem `1834451`, e o reenvio dele,
`SH52988BS-R-1`, que o filtro `name:52988` devolve junto, tem `1905557` (por isso o pedido é escolhido pelo nome). O
`SH1832330AP` (Ápice) não tem o metacampo, e a NF 183916 está na Intelipost. O `SH1837266AP` (Ápice) foi pago e
cancelado antes de faturar e não tem NF em lugar nenhum (evento na Shopify: "Sem emissão de NF").

Na consulta: `nf: metafield(namespace: "custom", key: "nf_numero") { value }`. Conferido em 19/11 que a
`CONSULTA_DO_PEDIDO` inteira com ele responde normalmente (o `data` não volta nulo, como volta com `fulfillmentOrders`)
na BySamia, na Ápice e na Yenzah.

### Na Intelipost ao vivo

- `GET {base}/intelipost/{conta}/shipment_order/sales_order_number/SH{n}{sigla}` devolve o envio enxuto; se ele vier
  sem a NF, `GET …/shipment_order/{order_number}` devolve o completo.
- A resposta é a da API: `{ "status": "OK", "content": … }`, com o envio direto no `content`, num array ou em
  `content.shipment_orders[]`.
- A NF fica em `shipment_order_volume_array[].shipment_order_volume_invoice.invoice_number`, com 9 dígitos
  (`000183916`); o app a grava sem os zeros à esquerda.
- **Teste:** o contrato é o que o usuário testou com a chave dele em 18/11 (comentário de
  `src/torre/intelipost-gateway.ts` na Central). Em 19/11, a `INTEGRATIONS_GATEWAY_WRITE_KEY` do `.env` local deste
  repositório respondeu **401** (no `/whoami` e na Intelipost), então o `sales_order_number` não foi testado daqui.
  **Ainda não conferido:** se a Intelipost da Ápice acha o envio pelo SH (a anotação de 16/11 diz que "na Ápice, a
  Intelipost não acha pelo número da Shopify"). Se não achar, ela responde 400, e a Ápice fica, na prática, só com o
  Data Mart e o Tiny.

## Como testar

```bash
curl -s -H "Authorization: Bearer $INTEGRATIONS_GATEWAY_READ_KEY" https://integrations-gateway-prod.rpa-ia.workers.dev/whoami
```

```bash
curl -s -X POST https://integrations-gateway-prod.rpa-ia.workers.dev/shopify/yenzah/graphql -H "Authorization: Bearer $INTEGRATIONS_GATEWAY_READ_KEY" -H "Content-Type: application/json" --data '{"query":"query ($q: String!) { orders(first: 5, query: $q) { edges { node { name nf: metafield(namespace: \"custom\", key: \"nf_numero\") { value } } } } }","variables":{"q":"name:SH10373YE"}}'
```

```bash
curl -s -H "Authorization: Bearer $INTEGRATIONS_GATEWAY_WRITE_KEY" https://integrations-gateway-prod.rpa-ia.workers.dev/intelipost/apice/shipment_order/sales_order_number/SH1832330AP
```

Nunca escreva a chave no comando, no log ou na mensagem: leia do ambiente. A resposta da Intelipost e a do pedido da
Shopify têm nome, telefone e endereço da cliente: não as cole em lugar nenhum.

## Buscar um pedido pelo número

`orders(first: N, query: "name:<número>")`. O filtro é tolerante (só os dígitos acham o `SH…`, e o reenvio `SH…-R-1`
vem junto), então **confira o `name` do resultado** antes de usar o pedido (`escolherPedido`): nas sem Cosmos, o nome
exato (`SH{n}{sufixo}`, depois só os dígitos para o `#n` antigo); nas 6 do Cosmos, os dígitos do nome.

## O que a chave de leitura consegue e o que não consegue

| O quê | Resultado |
|---|---|
| Pedido, itens (`sku`, `vendor`, quantidade, preço, desconto), cliente, endereço, frete (valor e título), nota, tags, status | ✅ |
| O metacampo `custom.nf_numero` | ✅ (19/11) |
| `fulfillments.trackingInfo.company` (a transportadora do despacho) | ⚠️ quase sempre **vazio**: só a Yenzah trouxe `J&T` |
| `fulfillmentOrders` (o local de atendimento) | ❌ `ACCESS_DENIED` — e a resposta veio com `data` **nulo para a consulta inteira** |
| `fulfillments.location.name` | ❌ `Required access: read_locations or read_markets_home` — esse campo volta `null`, o resto vem |
| Pedidos com **mais de 60 dias** | ❌ sem `read_all_orders`; o app os busca no Data Mart |
| Escrever qualquer coisa | ❌ escopo `shopify:read` |

## Como o app usa o gateway

1. **O pedido de toda marca** (desde a v15, 2026-11-17): o `/api/shopify/orders` (a tela e a Central, quando o Cosmos
   não acha o pedido) e o bot (as sem Cosmos) buscam pelo gateway, com a `CONSULTA_DO_PEDIDO` de
   `cxhub/shared/lib/shopify/gateway.ts`. O `pedidoDoGatewayParaShopify` traduz o nó GraphQL para o `ShopifyOrder` que
   o `adaptShopifyOrder` lê. O pedido que o gateway não acha (mais de 60 dias) ou com ele fora vem do Data Mart
   (`buscarPedidoNoGatewayOuNoDataMart`).
2. **A NF no formulário:** o `note_attributes.nf_number` do pedido traduzido é a NF do metacampo (o atributo
   `nf_number` fica de reserva). O `adaptShopifyOrder` a entrega em `numeroNF` à tela e à Central.
3. **A NF fora do Data Mart** (`cxhub/shared/lib/datamart/nfForaDoDataMartServer.ts`): quando o Data Mart não tem a
   NF, a conferência da ADR-018 (Ápice, Yenzah, Denavita) e a NF das 6 marcas do Cosmos leem o metacampo
   (`nfNoMetacampoDaShopify`, com a `CONSULTA_DA_NF`, que só pede o nome e o metacampo) e depois a Intelipost ao vivo
   (`cxhub/shared/lib/intelipost/`), até 4 s cada. Uma fonte que não responde nunca vira "sem NF".
4. **Transportadora** das sem Cosmos: a do despacho quando vem (só a Yenzah traz), senão o título do frete, na grafia
   das planilhas (`transportadoraNaGrafiaDaPlanilha`).
5. **429:** uma nova tentativa depois do `Retry-After` (até 3 s; sem ele, 1 s), se couber no prazo.

### De-para REST → GraphQL

| REST (`ShopifyOrder`) | GraphQL | Testado |
|---|---|---|
| `name` | `name` | ✅ |
| `id` | `legacyResourceId`, ou o número do `id` (`gid://shopify/Order/18981000478905`) | só o `id` |
| `created_at` | `createdAt` | ✅ |
| `financial_status` (`paid`) | `displayFinancialStatus` (`PAID`, em maiúscula) | ✅ |
| `current_total_price` | `currentTotalPriceSet.shopMoney.amount` (o `totalPriceSet` é o total original) | não |
| `total_shipping_price_set.shop_money.amount` | `totalShippingPriceSet.shopMoney.amount` | ✅ |
| `customer.first_name` / `last_name` | `customer.firstName` / `lastName` (ou `displayName`) | só `displayName` |
| `customer.phone` | `customer.phone` | ✅ |
| `shipping_address.*` | `shippingAddress { name address1 address2 city zip provinceCode phone }` | ✅ |
| `shipping_lines[0].title` | `shippingLines(first: 1).edges[0].node.title` | ✅ |
| `line_items[].id` | `lineItems…node.id` é **gid** (`gid://shopify/LineItem/…`): converter para o número | gid visto |
| `line_items[].price` | `originalUnitPriceSet.shopMoney.amount` | ✅ |
| `line_items[].discount_allocations[].amount` (soma) | `totalDiscountSet.shopMoney.amount` | ✅ |
| `line_items[].vendor`, `sku`, `quantity`, `name` | os mesmos nomes | ✅ |
| `note_attributes` (`nf_number`) | **o metacampo** `metafield(namespace: "custom", key: "nf_numero") { value }`. O atributo `nf_number` dos `customAttributes` **não existe** em nenhum pedido consultado em 19/11 (50 por marca, de 05 a 15/11); o metacampo está em 100% dos despachados das 6 marcas do Cosmos e da Yenzah, e em nenhum da Ápice, da Denavita e da Gobeaute | ✅ (19/11) |
| `fulfillments[].tracking_company` | `fulfillments { trackingInfo { company number } }` | ✅ (quase sempre vazio) |

## Limites e custo

Cada resposta da Shopify traz `extensions.cost`: balde de **2000** pontos, recarga de **100/s**, **por loja e
compartilhado** com quem mais usa o gateway. Um pedido por solicitação está muito abaixo do limite. A leitura da NF fora
do Data Mart só sai quando o Data Mart não tem a NF.

## Segurança

- **Só no servidor:** as chaves nunca vão para o navegador.
- **As tags trazem o CPF da cliente**: nenhuma consulta do app as pede. Não logue nem copie as tags para a planilha ou a
  fila.
- Não logue o corpo das respostas: o pedido da Shopify e o envio da Intelipost têm nome, telefone e endereço.

## Contexto: pedidos do site Gobeaute

- **Decisão de 2026-11-06:** os pedidos da loja `gobeaute` **não** são separados pelas marcas dos produtos. A Gobeaute
  é uma **marca própria no CX Hub**, **sem planilha** (ADR-014).
- Números `SH{n}GB`; os itens trazem o `vendor` da marca do produto e o SKU da loja da marca.
- O pedido só existe na loja Gobeaute (nota "Pedido Yampi <id>", tag `multi_store_sync`), e não tem o metacampo da NF.
