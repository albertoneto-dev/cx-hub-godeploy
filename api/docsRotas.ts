// A especificação de cada endpoint que a página /docs (api/docs.ts) mostra no estilo Swagger: parâmetros, corpo da
// requisição e respostas por status, com exemplos. Levantada do código das rotas (cxhub/app/api, servidor/) em
// 2026-11-11, com o CX Hub no commit 8a1b1a9; "sources" diz de onde veio cada uma, para conferir quando a rota mudar.
// Os exemplos são fictícios: nenhum dado de cliente, token ou segredo. O testes/docs.test.ts cobra que toda rota do
// roteador e da fila esteja aqui, e que nada aqui seja rota que não existe.

/** Campo de um corpo JSON. O nome é o caminho: "itens[].sku" é o sku de cada item do array itens. */
export type CampoDoCorpo = {
  name: string;
  type: string;
  required: boolean | "condicional";
  description: string;
  enum?: string[];
};

export type Parametro = CampoDoCorpo & { in: "query" | "path" | "header" };

export type Resposta = {
  status: number;
  description: string;
  fields?: CampoDoCorpo[];
  example?: unknown;
};

export type HeaderDaRota = "x-cosmos-token" | "x-bot-secret" | "x-cxhub-fila-token";

export type Endpoint = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  tag: string;
  summary: string;
  description: string;
  routeHeader: HeaderDaRota | null;
  params: Parametro[];
  requestBody: { contentType: string; fields: CampoDoCorpo[]; example: unknown } | null;
  responses: Resposta[];
  notes?: string[];
  sources?: string[];
};

/** Os grupos da navegação, nesta ordem, com a frase que abre cada um. */
export const GRUPOS: ReadonlyArray<{ tag: string; descricao: string }> = [
  { tag: "Autenticação", descricao: "O login do usuário de serviço do Cosmos. O token devolvido vai no `x-cosmos-token` das outras rotas." },
  { tag: "Cosmos", descricao: "Leitura de pedidos, produtos e transportadoras no Cosmos." },
  { tag: "Reenvios no Cosmos", descricao: "Lista, edita e cancela os reenvios (`-R-n`) já criados no Cosmos." },
  { tag: "Shopify e Data Mart", descricao: "O pedido na Shopify e o catálogo do Data Mart, para as marcas sem Cosmos e a Rituária." },
  { tag: "Formulário", descricao: "As opções dos formulários do CX Hub." },
  { tag: "Reenvio", descricao: "O registro do reenvio, pela tela do CX Hub e pelo bot (Typebot)." },
  { tag: "Reembolso", descricao: "O registro do reembolso e a gestão depois dele: cancelar, editar, concluir e sincronizar." },
  { tag: "Cancelamento", descricao: "O registro do cancelamento junto do reenvio ou do reembolso." },
  { tag: "Logística", descricao: "A abertura do ticket de logística." },
  { tag: "Consultas", descricao: "A lista de solicitações e a situação do registro de cada caso." },
  { tag: "Fila", descricao: "A fila de registro (`/api/v1`), que manda os casos em lote ao Airflow a cada 20 min. Não mudou na migração." },
];

export const ENDPOINTS: Endpoint[] = [
  {
    "method": "POST",
    "path": "/api/auth/login",
    "tag": "Autenticação",
    "summary": "Confere a credencial do CX Hub e devolve o token do Cosmos",
    "description": "Compara email e senha com a credencial única do CX Hub (segredos do app) e, se baterem, faz o signin no Cosmos (POST /auth/signin) com o usuário de serviço e repassa a resposta dele com o mesmo status. Não grava nada; o Cosmos tem 10 s para responder por padrão (env TIMEOUT).",
    "routeHeader": null,
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "email",
          "type": "string",
          "required": true,
          "description": "E-mail da credencial do CX Hub, comparado exatamente."
        },
        {
          "name": "password",
          "type": "string",
          "required": true,
          "description": "Senha da credencial do CX Hub, comparada exatamente."
        }
      ],
      "example": {
        "email": "agente@exemplo.com",
        "password": "senha-ficticia"
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "Credencial certa e signin aceito: o JSON do Cosmos, repassado como veio.",
        "fields": [
          {
            "name": "credentials",
            "type": "object",
            "required": true,
            "description": "Credenciais do usuário de serviço do Cosmos."
          },
          {
            "name": "credentials.token",
            "type": "string",
            "required": true,
            "description": "JWT do Cosmos: é o valor a mandar no x-cosmos-token das outras rotas."
          }
        ],
        "example": {
          "credentials": {
            "token": "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTU0MDAwMDB9.assinatura-ficticia"
          }
        }
      },
      {
        "status": 401,
        "description": "Email ou senha diferentes da credencial do CX Hub (o Cosmos nem é chamado). O 401 do signin no Cosmos também volta como 401, com o corpo do Cosmos.",
        "example": {
          "error": "Credenciais inválidas"
        }
      },
      {
        "status": 500,
        "description": "Segredo de autenticação ausente no app. Também {\"error\": \"Internal Server Error\"} na falha de rede até o Cosmos, e {\"code\": \"UNKNOWN_ERROR\", \"message\": \"Erro interno. Veja o log do app.\"} (do roteador) quando o corpo não é um objeto JSON.",
        "example": {
          "error": "Server configuration error"
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo.",
        "example": {
          "error": "Request timeout"
        }
      }
    ],
    "notes": [
      "A resposta de sucesso é repasse do signin do Cosmos; o CX Hub só lê credentials.token. Não confirmado o que mais vem no corpo.",
      "Qualquer outro status do signin (ex.: 404, 422, 5xx) volta igual, com o corpo do Cosmos; se o corpo do Cosmos não for JSON, vem {\"error\": \"Invalid response from upstream server\"} com o status dele (inclusive 200).",
      "O token é um JWT com exp: quando as rotas do Cosmos responderem 401, faça o login de novo.",
      "O corpo precisa ser um objeto JSON: JSON inválido ou null derruba a rota no 500 do roteador."
    ],
    "sources": [
      "cxhub/app/api/auth/login/route.ts",
      "cxhub/shared/lib/auth/auth-utils.ts",
      "cxhub/shared/lib/cosmos/server.ts",
      "cxhub/__tests__/integration/api-auth-login.test.ts",
      "api/roteador.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/cosmos/orders",
    "tag": "Cosmos",
    "summary": "Busca pedidos no Cosmos pelo número da loja",
    "description": "Repassa ao Cosmos GET /organizations/{org}/orders?external_id={orderId} com o token de quem chama e devolve a lista como veio. Não grava nada; o Cosmos tem 10 s para responder por padrão (env TIMEOUT).",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca do CX Hub, que vira a organização no Cosmos (sem diferenciar maiúsculas).",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria"
        ]
      },
      {
        "name": "orderId",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Número do pedido na loja, só os dígitos (ex.: 123456)."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Pedidos que o Cosmos achou para o número (lista vazia quando nenhum).",
        "fields": [
          {
            "name": "[].id",
            "type": "number",
            "required": true,
            "description": "Id interno do pedido no Cosmos: o {id} de GET /api/cosmos/orders/{id}."
          },
          {
            "name": "[].external_id",
            "type": "string",
            "required": true,
            "description": "Número do pedido na origem (ex.: SH123456LC, #SHOPIFY123456, ou SH123456LC-R-1 num reenvio)."
          },
          {
            "name": "[].status",
            "type": "string",
            "required": true,
            "description": "Situação do pedido no Cosmos (ex.: pending, delivered, cancelled)."
          },
          {
            "name": "[].origin",
            "type": "string",
            "required": true,
            "description": "Origem do pedido (ex.: shopify; resend num reenvio)."
          },
          {
            "name": "[].total_amount",
            "type": "string",
            "required": true,
            "description": "Valor total do pedido, em texto decimal."
          },
          {
            "name": "[].shipping_cost",
            "type": "string",
            "required": true,
            "description": "Valor do frete, em texto decimal."
          },
          {
            "name": "[].erp_status",
            "type": "string",
            "required": true,
            "description": "Situação no ERP (ex.: waiting, invoicing, invoiced)."
          },
          {
            "name": "[].logistic_status",
            "type": "string",
            "required": true,
            "description": "Situação logística no Cosmos."
          },
          {
            "name": "[].invoice_number",
            "type": "string | null",
            "required": true,
            "description": "Número da nota fiscal, quando já emitida."
          },
          {
            "name": "[].created_at",
            "type": "string",
            "required": true,
            "description": "Data e hora de criação no Cosmos."
          },
          {
            "name": "[].customer",
            "type": "object",
            "required": true,
            "description": "Cliente: name, email, phone, document."
          },
          {
            "name": "[].shipping",
            "type": "object",
            "required": true,
            "description": "Resumo do destino: state e postal_code."
          },
          {
            "name": "[].carrier",
            "type": "object",
            "required": true,
            "description": "Transportadora do pedido, no formato de GET /api/cosmos/carriers."
          },
          {
            "name": "[].distribution_center",
            "type": "object",
            "required": true,
            "description": "Centro de distribuição: id, name, code, state_code e outros."
          }
        ],
        "example": [
          {
            "id": 987654,
            "external_id": "SH123456LC",
            "status": "delivered",
            "origin": "shopify",
            "total_amount": "189.90",
            "shipping_cost": "15.00",
            "erp_status": "invoiced",
            "invoice_number": "000123",
            "created_at": "2026-10-20T14:32:00Z",
            "customer": {
              "name": "Maria Exemplo",
              "email": "maria@exemplo.com",
              "document": "00000000000"
            },
            "shipping": {
              "state": "SP",
              "postal_code": "01001-000"
            },
            "carrier": {
              "id": 161,
              "name": "J&T Express",
              "shopify_name": "NORMAL_J&T"
            }
          }
        ]
      },
      {
        "status": 400,
        "description": "Falta brand ou orderId. Marca sem Cosmos (apice, yenzah, denavita, gobeaute) também dá 400, com {\"error\": \"A marca apice não tem organização no Cosmos\"} (a marca como veio), sem chamar o Cosmos.",
        "example": {
          "error": "Missing brand or orderId parameter"
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O 401 do próprio Cosmos (token inválido ou expirado) volta como {\"error\": \"Cosmos API error: 401\"}.",
        "example": {
          "error": "Missing authorization header"
        }
      },
      {
        "status": 500,
        "description": "Falha de rede ou resposta do Cosmos que não é JSON. Também {\"error\": \"Cosmos API URL not configured\"} quando falta o COSMOS_API_URL no app.",
        "example": {
          "error": "Failed to fetch from Cosmos"
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo.",
        "example": {
          "error": "Request timeout"
        }
      }
    ],
    "notes": [
      "A resposta de sucesso é repasse do Cosmos (tipo CosmosOrder em cxhub/shared/types/cosmos.ts), sem filtro nem transformação.",
      "A busca do Cosmos por external_id é por semelhança: a lista pode trazer pedidos de número parecido e os reenvios (-R-n). A tela fica com o primeiro cujo external_id casa ^SH{n}[A-Za-z]{2}[0-9]*$ ou é #SHOPIFY{n}.",
      "Qualquer outro erro do Cosmos (403, 404, 422, 5xx...) volta com o mesmo status e {\"error\": \"Cosmos API error: <status>\"}; a mensagem do Cosmos não é repassada.",
      "Pedido inexistente pode vir como 200 com lista vazia ou como 404 do Cosmos; a tela trata os dois como não encontrado.",
      "O orderId vai ao Cosmos sem codificação: mande só os dígitos (a tela tira #, SH e o sufixo).",
      "Uma brand fora da lista (e que não seja sem Cosmos) vai crua como id da organização: brand=3 consulta a org 3."
    ],
    "sources": [
      "cxhub/app/api/cosmos/orders/route.ts",
      "cxhub/shared/types/cosmos.ts",
      "cxhub/shared/lib/cosmos/client.ts",
      "cxhub/shared/lib/constants.ts",
      "cxhub/__tests__/integration/api-cosmos-orders.test.ts",
      "cxhub/__tests__/integration/api-marcas-sem-cosmos.test.ts",
      "api/roteador.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/cosmos/orders/{id}",
    "tag": "Cosmos",
    "summary": "Detalha um pedido do Cosmos pelo id interno",
    "description": "Repassa ao Cosmos GET /organizations/{org}/orders/{id} com o token de quem chama e devolve o pedido completo como veio. Não grava nada; o Cosmos tem 10 s para responder por padrão (env TIMEOUT).",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "id",
        "in": "path",
        "type": "string",
        "required": true,
        "description": "Id interno do pedido no Cosmos (o id da lista de GET /api/cosmos/orders)."
      },
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca do CX Hub, que vira a organização no Cosmos (sem diferenciar maiúsculas).",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria"
        ]
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "O pedido detalhado, como o Cosmos devolveu.",
        "fields": [
          {
            "name": "id",
            "type": "number",
            "required": true,
            "description": "Id interno do pedido no Cosmos."
          },
          {
            "name": "external_id",
            "type": "string",
            "required": true,
            "description": "Número do pedido na origem (ex.: SH123456LC)."
          },
          {
            "name": "status",
            "type": "string",
            "required": true,
            "description": "Situação do pedido no Cosmos (ex.: pending, delivered, cancelled)."
          },
          {
            "name": "origin",
            "type": "string",
            "required": true,
            "description": "Origem do pedido (ex.: shopify; resend num reenvio)."
          },
          {
            "name": "total_amount",
            "type": "string",
            "required": true,
            "description": "Valor total do pedido, em texto decimal."
          },
          {
            "name": "items_amount",
            "type": "string",
            "required": true,
            "description": "Soma dos itens antes do desconto."
          },
          {
            "name": "discount_amount",
            "type": "string",
            "required": true,
            "description": "Desconto do pedido."
          },
          {
            "name": "shipping_cost",
            "type": "string",
            "required": true,
            "description": "Valor do frete."
          },
          {
            "name": "erp_status",
            "type": "string",
            "required": true,
            "description": "Situação no ERP (ex.: waiting, invoicing, invoiced)."
          },
          {
            "name": "invoice_number",
            "type": "string | null",
            "required": true,
            "description": "Número da nota fiscal, quando já emitida."
          },
          {
            "name": "invoice_access_key",
            "type": "string | null",
            "required": true,
            "description": "Chave de acesso da nota fiscal."
          },
          {
            "name": "tracking_code",
            "type": "string | null",
            "required": true,
            "description": "Código de rastreio."
          },
          {
            "name": "tracking_url",
            "type": "string | null",
            "required": true,
            "description": "Link de rastreio."
          },
          {
            "name": "created_at",
            "type": "string",
            "required": true,
            "description": "Data e hora de criação no Cosmos."
          },
          {
            "name": "customer",
            "type": "object",
            "required": true,
            "description": "Cliente: name, email, phone, document e type (CPF ou CNPJ)."
          },
          {
            "name": "shipping.name",
            "type": "string",
            "required": true,
            "description": "Nome do destinatário."
          },
          {
            "name": "shipping.phone",
            "type": "string",
            "required": true,
            "description": "Telefone do destinatário."
          },
          {
            "name": "shipping.address",
            "type": "object",
            "required": true,
            "description": "Endereço de entrega: street, number, complement, neighborhood, city, state, postal_code."
          },
          {
            "name": "shipping.service_name",
            "type": "string",
            "required": true,
            "description": "Serviço de frete (o título do frete na Shopify, ex.: NORMAL_J&T)."
          },
          {
            "name": "shipping.cost",
            "type": "string",
            "required": true,
            "description": "Valor do frete na entrega."
          },
          {
            "name": "billing",
            "type": "object",
            "required": true,
            "description": "Cobrança: name, phone e address (mesmo formato da entrega)."
          },
          {
            "name": "line_items[]",
            "type": "array",
            "required": true,
            "description": "Itens do pedido: id, product_id, sku, name, quantity, unit_price."
          },
          {
            "name": "carrier",
            "type": "object",
            "required": true,
            "description": "Transportadora do pedido, no formato de GET /api/cosmos/carriers."
          },
          {
            "name": "distribution_center",
            "type": "object",
            "required": true,
            "description": "Centro de distribuição: id, name, code, state_code e outros."
          },
          {
            "name": "erp_payload",
            "type": "object",
            "required": false,
            "description": "O que foi ao ERP: items (Protheus, com desconto por item) ou lineItems (ERP Shopify do Cosmos)."
          }
        ],
        "example": {
          "id": 987654,
          "external_id": "SH123456LC",
          "status": "delivered",
          "origin": "shopify",
          "total_amount": "189.90",
          "items_amount": "199.80",
          "discount_amount": "24.90",
          "shipping_cost": "15.00",
          "erp_status": "invoiced",
          "invoice_number": "000123",
          "tracking_code": "JT0000000000000",
          "created_at": "2026-10-20T14:32:00Z",
          "customer": {
            "name": "Maria Exemplo",
            "email": "maria@exemplo.com",
            "phone": "11900000000",
            "document": "00000000000",
            "type": "cpf"
          },
          "shipping": {
            "name": "Maria Exemplo",
            "phone": "11900000000",
            "address": {
              "street": "Rua das Flores",
              "number": "100",
              "complement": "Ap 12",
              "neighborhood": "Centro",
              "city": "São Paulo",
              "state": "SP",
              "postal_code": "01001-000"
            },
            "service_name": "NORMAL_J&T",
            "cost": "15.00"
          },
          "line_items": [
            {
              "id": 5551,
              "product_id": 4321,
              "sku": "LC01020",
              "name": "Sérum Facial 30ml",
              "quantity": 2,
              "unit_price": "99.90"
            }
          ],
          "carrier": {
            "id": 161,
            "name": "J&T Express",
            "shopify_name": "NORMAL_J&T"
          }
        }
      },
      {
        "status": 400,
        "description": "Falta brand. Marca sem Cosmos (apice, yenzah, denavita, gobeaute) também dá 400, com {\"error\": \"A marca apice não tem organização no Cosmos\"}, sem chamar o Cosmos.",
        "example": {
          "error": "Missing brand parameter"
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O 401 do próprio Cosmos (token inválido ou expirado) volta como {\"error\": \"Cosmos API error: 401\"}.",
        "example": {
          "error": "Missing authorization header"
        }
      },
      {
        "status": 500,
        "description": "Falha de rede ou resposta do Cosmos que não é JSON. Também {\"error\": \"Cosmos API URL not configured\"} quando falta o COSMOS_API_URL no app.",
        "example": {
          "error": "Failed to fetch from Cosmos"
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo.",
        "example": {
          "error": "Request timeout"
        }
      }
    ],
    "notes": [
      "A resposta de sucesso é repasse do Cosmos (tipo CosmosDetailedOrder em cxhub/shared/types/cosmos.ts); o exemplo mostra só os campos principais.",
      "Qualquer outro erro do Cosmos volta com o mesmo status e {\"error\": \"Cosmos API error: <status>\"}; id inexistente na organização da marca chega como 404 assim.",
      "O id não é validado pela rota: vai como veio para o Cosmos.",
      "Uma brand fora da lista (e que não seja sem Cosmos) vai crua como id da organização."
    ],
    "sources": [
      "cxhub/app/api/cosmos/orders/[id]/route.ts",
      "cxhub/shared/types/cosmos.ts",
      "cxhub/shared/lib/cosmos/adapter.ts",
      "cxhub/__tests__/integration/api-cosmos-order-detail.test.ts",
      "api/roteador.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/cosmos/products",
    "tag": "Cosmos",
    "summary": "Lista o catálogo de produtos da marca no Cosmos, ou busca um SKU",
    "description": "Sem sku, lê GET /organizations/{org}/products página a página (100 por página, até 10 páginas, no máximo 1.000 produtos) e devolve tudo num array; com sku, faz uma consulta só (products?sku=) e repassa a resposta. Não grava nada; todas as páginas dividem um prazo único de 10 s por padrão (env TIMEOUT).",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca do CX Hub, que vira a organização no Cosmos (sem diferenciar maiúsculas).",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria"
        ]
      },
      {
        "name": "sku",
        "in": "query",
        "type": "string",
        "required": false,
        "description": "SKU a buscar; sem ele, vem o catálogo inteiro."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Os produtos da marca (ativos e inativos), ou o resultado da busca pelo SKU.",
        "fields": [
          {
            "name": "[].id",
            "type": "number",
            "required": true,
            "description": "Id do produto no Cosmos: o {id} de GET /api/cosmos/products/{id}."
          },
          {
            "name": "[].name",
            "type": "string",
            "required": true,
            "description": "Nome do produto."
          },
          {
            "name": "[].sku",
            "type": "string",
            "required": true,
            "description": "SKU do produto."
          },
          {
            "name": "[].price",
            "type": "string",
            "required": true,
            "description": "Preço de catálogo, em texto decimal."
          },
          {
            "name": "[].gtin",
            "type": "string",
            "required": true,
            "description": "Código de barras (EAN)."
          },
          {
            "name": "[].ncm",
            "type": "string",
            "required": true,
            "description": "NCM fiscal."
          },
          {
            "name": "[].active",
            "type": "boolean",
            "required": true,
            "description": "Se o produto está ativo."
          },
          {
            "name": "[].is_kit",
            "type": "boolean",
            "required": true,
            "description": "Se é kit; os componentes saem em GET /api/cosmos/products/{id} (kit_skus)."
          },
          {
            "name": "[].created_at",
            "type": "string",
            "required": true,
            "description": "Data e hora de criação no Cosmos."
          },
          {
            "name": "[].updated_at",
            "type": "string",
            "required": true,
            "description": "Data e hora da última alteração no Cosmos."
          }
        ],
        "example": [
          {
            "id": 4321,
            "name": "Sérum Facial 30ml",
            "price": "99.90",
            "sku": "LC01020",
            "gtin": "7890000000000",
            "ncm": "33049990",
            "active": true,
            "is_kit": false
          },
          {
            "id": 4400,
            "name": "Kit Rotina Facial",
            "price": "189.90",
            "sku": "LC09001",
            "gtin": "7890000000017",
            "ncm": "33049990",
            "active": true,
            "is_kit": true
          }
        ]
      },
      {
        "status": 400,
        "description": "Falta brand. Marca sem Cosmos (apice, yenzah, denavita, gobeaute) também dá 400, com {\"error\": \"A marca yenzah não tem organização no Cosmos\"}, sem chamar o Cosmos.",
        "example": {
          "error": "Missing brand parameter"
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O 401 do próprio Cosmos (token inválido ou expirado) volta como {\"error\": \"Cosmos API error: 401\"}.",
        "example": {
          "error": "Missing authorization header"
        }
      },
      {
        "status": 500,
        "description": "Falha de rede ou resposta do Cosmos que não é JSON. Também {\"error\": \"Cosmos API URL not configured\"} quando falta o COSMOS_API_URL no app.",
        "example": {
          "error": "Failed to fetch from Cosmos"
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo (somando todas as páginas).",
        "example": {
          "error": "Request timeout"
        }
      }
    ],
    "notes": [
      "A resposta de sucesso é repasse do Cosmos (tipo CosmosProduct em cxhub/shared/types/cosmos.ts). O isGift do tipo não vem daqui: a tela o calcula.",
      "Erro do Cosmos em qualquer página volta com o mesmo status e {\"error\": \"Cosmos API error: <status>\"}, e o que já foi lido se perde.",
      "Página que não vem como array encerra a leitura sem erro: a rota devolve o que juntou até ali.",
      "Catálogo com mais de 1.000 produtos vem cortado, sem aviso.",
      "Com sku, o formato é o que o Cosmos devolve; a tela o lê como array de produtos.",
      "Uma brand fora da lista (e que não seja sem Cosmos) vai crua como id da organização."
    ],
    "sources": [
      "cxhub/app/api/cosmos/products/route.ts",
      "cxhub/shared/types/cosmos.ts",
      "cxhub/shared/lib/cosmos/client.ts",
      "cxhub/__tests__/integration/api-cosmos-products.test.ts",
      "cxhub/__tests__/integration/api-marcas-sem-cosmos.test.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/cosmos/products/{id}",
    "tag": "Cosmos",
    "summary": "Detalha um produto do Cosmos, com os componentes do kit",
    "description": "Repassa ao Cosmos GET /organizations/{org}/products/{id} com o token de quem chama e devolve o produto como veio; a tela usa para expandir kits (kit_skus). Não grava nada; o Cosmos tem 10 s para responder por padrão (env TIMEOUT).",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "id",
        "in": "path",
        "type": "string",
        "required": true,
        "description": "Id do produto no Cosmos (o id de GET /api/cosmos/products)."
      },
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca do CX Hub, que vira a organização no Cosmos (sem diferenciar maiúsculas); aceita também o id da org.",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria",
          "3",
          "4",
          "5",
          "6",
          "8",
          "9"
        ]
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "O produto, como o Cosmos devolveu.",
        "fields": [
          {
            "name": "id",
            "type": "number",
            "required": true,
            "description": "Id do produto no Cosmos."
          },
          {
            "name": "kit_skus",
            "type": "array",
            "required": false,
            "description": "SKUs dos componentes, quando é kit; SKU repetido indica a quantidade (dois iguais = 2 unidades)."
          }
        ],
        "example": {
          "id": 4400,
          "kit_skus": [
            "LC01020",
            "LC01020",
            "LC02030"
          ]
        }
      },
      {
        "status": 400,
        "description": "Falta brand. Marca sem Cosmos (apice, yenzah, denavita, gobeaute) dá {\"error\": \"A marca apice não tem organização no Cosmos\"}, sem chamar o Cosmos; id vazio daria {\"error\": \"Missing product ID parameter\"}, mas o roteador não chega aqui sem id.",
        "example": {
          "error": "Missing brand parameter (required for Org ID)"
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O 401 do próprio Cosmos (token inválido ou expirado) volta como {\"error\": \"Cosmos API error: 401\"}.",
        "example": {
          "error": "Missing authorization header"
        }
      },
      {
        "status": 500,
        "description": "Falha de rede ou resposta do Cosmos que não é JSON. Também {\"error\": \"Cosmos API URL not configured\"} quando falta o COSMOS_API_URL no app.",
        "example": {
          "error": "Failed to fetch product details from Cosmos"
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo.",
        "example": {
          "error": "Request timeout"
        }
      }
    ],
    "notes": [
      "A resposta de sucesso é repasse do Cosmos. O CX Hub só lê id e kit_skus; não confirmado no código quais outros campos o detalhe traz (não há tipo para ele).",
      "Qualquer outro erro do Cosmos volta com o mesmo status e {\"error\": \"Cosmos API error: <status>\"}.",
      "Uma brand fora da lista (e que não seja sem Cosmos) vai crua como id da organização."
    ],
    "sources": [
      "cxhub/app/api/cosmos/products/[id]/route.ts",
      "cxhub/shared/lib/cosmos/client.ts",
      "cxhub/__tests__/integration/api-cosmos-product-detail.test.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/cosmos/carriers",
    "tag": "Cosmos",
    "summary": "Acha a transportadora do Cosmos pelo título do frete na Shopify",
    "description": "Repassa ao Cosmos GET /organizations/{org}/carriers?shopify_name= com o token de quem chama e devolve a lista como veio; a tela usa o primeiro item para traduzir o frete da Shopify no nome da transportadora. Não grava nada; o Cosmos tem 10 s para responder por padrão (env TIMEOUT).",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca do CX Hub, que vira a organização no Cosmos (sem diferenciar maiúsculas).",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria"
        ]
      },
      {
        "name": "shopify_name",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Título do frete na Shopify (ex.: NORMAL_J&T); a rota o codifica na URL."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Transportadoras com esse shopify_name na marca (lista vazia quando nenhuma).",
        "fields": [
          {
            "name": "[].id",
            "type": "number",
            "required": true,
            "description": "Id da transportadora no Cosmos (o carrierId do PATCH de reenvio)."
          },
          {
            "name": "[].name",
            "type": "string",
            "required": true,
            "description": "Nome da transportadora no Cosmos."
          },
          {
            "name": "[].shopify_name",
            "type": "string",
            "required": true,
            "description": "Título do frete na Shopify ligado a ela."
          },
          {
            "name": "[].document",
            "type": "string",
            "required": true,
            "description": "CNPJ da transportadora."
          },
          {
            "name": "[].intelipost_id",
            "type": "string",
            "required": true,
            "description": "Id da transportadora na Intelipost."
          },
          {
            "name": "[].express",
            "type": "boolean",
            "required": true,
            "description": "Se é serviço expresso."
          },
          {
            "name": "[].active",
            "type": "boolean",
            "required": true,
            "description": "Se está ativa na marca."
          },
          {
            "name": "[].send_track_code_to_intelipost",
            "type": "boolean",
            "required": true,
            "description": "Se o rastreio é enviado à Intelipost."
          },
          {
            "name": "[].created_at",
            "type": "string",
            "required": true,
            "description": "Data e hora de criação no Cosmos."
          },
          {
            "name": "[].updated_at",
            "type": "string",
            "required": true,
            "description": "Data e hora da última alteração no Cosmos."
          },
          {
            "name": "[].document_for_dc",
            "type": "string",
            "required": false,
            "description": "Documento usado pelo centro de distribuição, quando há."
          }
        ],
        "example": [
          {
            "id": 161,
            "name": "J&T Express",
            "shopify_name": "NORMAL_J&T",
            "document": "00000000000000",
            "express": false,
            "active": true
          }
        ]
      },
      {
        "status": 400,
        "description": "Falta brand ou shopify_name. Marca sem Cosmos (apice, yenzah, denavita, gobeaute) dá {\"error\": \"A marca denavita não tem organização no Cosmos\"}, sem chamar o Cosmos.",
        "example": {
          "error": "Missing brand or shopify_name parameter"
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O 401 do próprio Cosmos (token inválido ou expirado) volta como {\"error\": \"Cosmos API error: 401\"}.",
        "example": {
          "error": "Missing authorization header"
        }
      },
      {
        "status": 500,
        "description": "Falha de rede ou resposta do Cosmos que não é JSON. Também {\"error\": \"Cosmos API URL not configured\"} quando falta o COSMOS_API_URL no app.",
        "example": {
          "error": "Failed to fetch carriers from Cosmos"
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo.",
        "example": {
          "error": "Request timeout"
        }
      }
    ],
    "notes": [
      "A resposta de sucesso é repasse do Cosmos (tipo CosmosCarrier em cxhub/shared/types/cosmos.ts); o exemplo mostra só os campos principais.",
      "A comparação do shopify_name é feita pelo Cosmos: não confirmado se é exata ou por semelhança.",
      "Qualquer outro erro do Cosmos volta com o mesmo status e {\"error\": \"Cosmos API error: <status>\"}.",
      "Uma brand fora da lista (e que não seja sem Cosmos) vai crua como id da organização."
    ],
    "sources": [
      "cxhub/app/api/cosmos/carriers/route.ts",
      "cxhub/shared/types/cosmos.ts",
      "cxhub/shared/lib/cosmos/client.ts",
      "cxhub/__tests__/integration/api-cosmos-carriers.test.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/cosmos/resends",
    "tag": "Reenvios no Cosmos",
    "summary": "Lista os reenvios de um pedido original",
    "description": "Consulta o Cosmos (GET /organizations/{org}/orders?external_id={dígitos}&origin=resend&per_page=100) com o token de quem chama e devolve só os reenvios do pedido, os de external_id {pedido original}-R-{n}. Não grava nada; o Cosmos tem 10 s para responder por padrão (env TIMEOUT).",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca com organização no Cosmos (sem diferenciar maiúsculas); qualquer outra é recusada.",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria"
        ]
      },
      {
        "name": "orderId",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Número do pedido original; a rota fica só com os dígitos (#123456 e SH123456LC viram 123456)."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Consulta feita: os reenvios do pedido, ou lista vazia.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre SUCCESS."
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Vazia quando há reenvio; 'Nenhum reenvio encontrado para este pedido.' quando não há."
          },
          {
            "name": "resends",
            "type": "array",
            "required": true,
            "description": "Reenvios do pedido, no formato da lista de GET /api/cosmos/orders."
          },
          {
            "name": "resends[].id",
            "type": "number",
            "required": true,
            "description": "Id interno do reenvio no Cosmos: o {id} do PATCH e do cancel."
          },
          {
            "name": "resends[].external_id",
            "type": "string",
            "required": true,
            "description": "Número do reenvio, {original}-R-{n} (ex.: SH123456LC-R-1)."
          },
          {
            "name": "resends[].status",
            "type": "string",
            "required": true,
            "description": "Situação no Cosmos; cancelled não pode mais ser editado nem cancelado."
          },
          {
            "name": "resends[].erp_status",
            "type": "string",
            "required": true,
            "description": "Situação no ERP; invoicing ou invoiced trava edição e cancelamento."
          },
          {
            "name": "resends[].created_at",
            "type": "string",
            "required": true,
            "description": "Data e hora de criação do reenvio."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "",
          "resends": [
            {
              "id": 987700,
              "external_id": "SH123456LC-R-1",
              "origin": "resend",
              "status": "pending",
              "erp_status": "waiting",
              "created_at": "2026-10-28T10:05:00Z",
              "shipping": {
                "state": "SP",
                "postal_code": "01001-000"
              }
            }
          ]
        }
      },
      {
        "status": 400,
        "description": "Marca fora da lista ('Marca inválida: <brand>.', ou '(vazia)' sem brand) ou orderId sem dígito: 'Informe orderId (número do pedido original).'.",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "Marca inválida: apice."
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O 401 do Cosmos também volta como UNAUTHORIZED, com a mensagem do Cosmos ou 'Token do Cosmos inválido ou expirado.'.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Header Authorization ausente."
        }
      },
      {
        "status": 403,
        "description": "O Cosmos recusou o acesso: a mensagem do Cosmos, ou a padrão do exemplo.",
        "example": {
          "code": "FORBIDDEN",
          "message": "O usuário do CX Hub não tem permissão para esta ação no Cosmos."
        }
      },
      {
        "status": 404,
        "description": "O Cosmos respondeu 404: a mensagem do Cosmos, ou a padrão do exemplo.",
        "example": {
          "code": "NOT_FOUND",
          "message": "Pedido não encontrado nesta marca."
        }
      },
      {
        "status": 422,
        "description": "O Cosmos respondeu 422: a mensagem do Cosmos, ou a padrão do exemplo.",
        "example": {
          "code": "COSMOS_REJECTED",
          "message": "O Cosmos recusou a operação."
        }
      },
      {
        "status": 500,
        "description": "Falta o COSMOS_API_URL no app.",
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Cosmos API URL não configurada."
        }
      },
      {
        "status": 502,
        "description": "Status inesperado do Cosmos, falha de rede, ou 200 que não é lista.",
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível concluir a operação no Cosmos."
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo.",
        "example": {
          "code": "API_TIMEOUT",
          "message": "O Cosmos demorou para responder."
        }
      }
    ],
    "notes": [
      "Erros sempre em {code, message}: decida pelo code, não pelo texto.",
      "'Header Authorization ausente.' quer dizer que faltou o x-cosmos-token (o app o põe no Authorization para a rota).",
      "Os itens de resends são repasse do Cosmos (tipo CosmosOrder em cxhub/shared/types/cosmos.ts), filtrados pelo external_id ^(SH{n}[A-Za-z]{2}[0-9]*|#SHOPIFY{n})-R-[0-9]+$ e por origin = resend.",
      "Só a primeira página do Cosmos é lida (até 100 pedidos de origem resend parecidos com o número)."
    ],
    "sources": [
      "cxhub/app/api/cosmos/resends/route.ts",
      "cxhub/modules/reenvios/actions/resendCosmos.ts",
      "cxhub/modules/reenvios/actions/resendManagement.ts",
      "cxhub/modules/reenvios/types/management.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "cxhub/shared/lib/cosmos/client.ts",
      "cxhub/__tests__/integration/api-cosmos-resends.test.ts"
    ]
  },
  {
    "method": "PATCH",
    "path": "/api/cosmos/resends/{id}",
    "tag": "Reenvios no Cosmos",
    "summary": "Edita endereço, transportadora ou cliente de um reenvio",
    "description": "Relê o reenvio no Cosmos, confere a janela de gestão (é reenvio, não está cancelado, faturamento não começou) e grava com PUT /organizations/{org}/orders/{id} os objetos inteiros, mesclados sobre o pedido atual; transportadora nova é conferida antes na org da marca. Depois da resposta, endereço trocado leva a UF à gold pela fila, sem mudar a resposta; cada chamada ao Cosmos tem 10 s por padrão (env TIMEOUT) e não há retentativa.",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "id",
        "in": "path",
        "type": "string",
        "required": true,
        "description": "Id interno do reenvio no Cosmos, só dígitos (o resends[].id de GET /api/cosmos/resends)."
      },
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca com organização no Cosmos (sem diferenciar maiúsculas); qualquer outra é recusada.",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria"
        ]
      }
    ],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "handledBy",
          "type": "string",
          "required": true,
          "description": "Agente responsável pela edição (vai ao log do app)."
        },
        {
          "name": "shippingAddress",
          "type": "object",
          "required": false,
          "description": "Campos do endereço de entrega a trocar; o que não vier fica como está."
        },
        {
          "name": "shippingAddress.name",
          "type": "string",
          "required": false,
          "description": "Nome do destinatário."
        },
        {
          "name": "shippingAddress.phone",
          "type": "string",
          "required": false,
          "description": "Telefone do destinatário."
        },
        {
          "name": "shippingAddress.street",
          "type": "string",
          "required": false,
          "description": "Rua."
        },
        {
          "name": "shippingAddress.number",
          "type": "string",
          "required": false,
          "description": "Número."
        },
        {
          "name": "shippingAddress.complement",
          "type": "string",
          "required": false,
          "description": "Complemento."
        },
        {
          "name": "shippingAddress.neighborhood",
          "type": "string",
          "required": false,
          "description": "Bairro."
        },
        {
          "name": "shippingAddress.city",
          "type": "string",
          "required": false,
          "description": "Cidade."
        },
        {
          "name": "shippingAddress.state",
          "type": "string",
          "required": false,
          "description": "UF (ex.: SP)."
        },
        {
          "name": "shippingAddress.postalCode",
          "type": "string",
          "required": false,
          "description": "CEP com 8 dígitos, com ou sem hífen."
        },
        {
          "name": "carrierId",
          "type": "integer",
          "required": false,
          "description": "Id da transportadora no Cosmos, ativa e da mesma marca (veja GET /api/cosmos/carriers)."
        },
        {
          "name": "customer",
          "type": "object",
          "required": false,
          "description": "Campos do cliente a trocar; o que não vier fica como está."
        },
        {
          "name": "customer.name",
          "type": "string",
          "required": false,
          "description": "Nome do cliente."
        },
        {
          "name": "customer.email",
          "type": "string",
          "required": false,
          "description": "E-mail do cliente."
        },
        {
          "name": "customer.phone",
          "type": "string",
          "required": false,
          "description": "Telefone do cliente."
        },
        {
          "name": "customer.document",
          "type": "string",
          "required": false,
          "description": "CPF ou CNPJ do cliente."
        }
      ],
      "example": {
        "handledBy": "Ana Exemplo",
        "shippingAddress": {
          "street": "Rua das Flores",
          "number": "200",
          "postalCode": "01001-000"
        },
        "carrierId": 161
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "O Cosmos aceitou a edição.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre SUCCESS."
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Sempre 'Reenvio atualizado no Cosmos.'."
          },
          {
            "name": "order",
            "type": "object",
            "required": true,
            "description": "O reenvio como o Cosmos devolveu depois do PUT (formato de GET /api/cosmos/orders/{id})."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Reenvio atualizado no Cosmos.",
          "order": {
            "id": 987700,
            "external_id": "SH123456LC-R-1",
            "origin": "resend",
            "status": "pending",
            "erp_status": "waiting",
            "shipping": {
              "name": "Maria Exemplo",
              "phone": "11900000000",
              "address": {
                "street": "Rua das Flores",
                "number": "200",
                "complement": "Ap 12",
                "neighborhood": "Centro",
                "city": "São Paulo",
                "state": "SP",
                "postal_code": "01001-000"
              },
              "service_name": "NORMAL_J&T",
              "cost": "12.50"
            }
          }
        }
      },
      {
        "status": 400,
        "description": "Pedido inválido, antes ou depois de reler o reenvio. Outras mensagens: 'Marca inválida: <brand>.', 'id deve ser o id numérico do reenvio no Cosmos.', 'Corpo da requisição inválido.', 'Informe handledBy (agente responsável).', 'Campo desconhecido em shippingAddress: <campo>.', '<objeto>.<campo> deve ser texto.', '<objeto> deve ser um objeto.', '<objeto> está vazio.', 'carrierId deve ser o id numérico da transportadora no Cosmos.', 'Nada para editar: informe shippingAddress, carrierId ou customer.', 'Endereço incompleto depois da edição: falta <campos>.', 'CEP inválido: precisa ter 8 dígitos.'.",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "Campo não editável: products. Só shippingAddress, carrierId e customer podem ser editados; para trocar produtos ou frete, cancele e abra outro reenvio."
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O 401 do Cosmos também volta como UNAUTHORIZED, com a mensagem do Cosmos ou 'Token do Cosmos inválido ou expirado.'.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Header Authorization ausente."
        }
      },
      {
        "status": 403,
        "description": "O Cosmos recusou o acesso (na releitura, na transportadora ou no PUT): a mensagem do Cosmos, ou a padrão do exemplo.",
        "example": {
          "code": "FORBIDDEN",
          "message": "O usuário do CX Hub não tem permissão para esta ação no Cosmos."
        }
      },
      {
        "status": 404,
        "description": "O reenvio não existe na organização da marca: a mensagem do Cosmos, ou a padrão do exemplo.",
        "example": {
          "code": "NOT_FOUND",
          "message": "Pedido não encontrado nesta marca."
        }
      },
      {
        "status": 422,
        "description": "Fora da janela de gestão ou recusado. Outros: NOT_A_RESEND 'Este pedido não é um reenvio.', RESEND_CANCELLED 'Este reenvio já está cancelado.', CARRIER_NOT_FOUND 'Transportadora não encontrada nesta marca.' ou 'Transportadora inativa nesta marca.', COSMOS_REJECTED com a mensagem do Cosmos ou 'O Cosmos recusou a operação.'.",
        "example": {
          "code": "RESEND_LOCKED",
          "message": "O faturamento deste reenvio já começou: ele não pode mais ser cancelado nem editado."
        }
      },
      {
        "status": 500,
        "description": "Falta o COSMOS_API_URL no app.",
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Cosmos API URL não configurada."
        }
      },
      {
        "status": 502,
        "description": "Status inesperado do Cosmos, falha de rede, ou 200 sem um pedido (ou transportadora) válido no corpo.",
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível concluir a operação no Cosmos."
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo.",
        "example": {
          "code": "API_TIMEOUT",
          "message": "O Cosmos demorou para responder."
        }
      }
    ],
    "notes": [
      "Validação estrita: campo desconhecido é recusado com 400, não ignorado. Produtos e frete não se editam: cancele e abra outro reenvio.",
      "A ordem das checagens é brand, x-cosmos-token, COSMOS_API_URL, id e corpo; só depois o Cosmos é chamado.",
      "Os textos vão ao Cosmos sem espaços nas pontas. Endereço trocado: a cobrança passa a ser igual à entrega, e frete (cost) e serviço do pedido são preservados.",
      "Transportadora trocada: shipping.service_name passa a ser o shopify_name dela. Cliente: o tipo (CPF/CNPJ) não é editável e é preservado.",
      "Sem retentativa de propósito: repetir depois de um 5xx pode aplicar a edição duas vezes; releia o reenvio antes de repetir.",
      "O order da resposta é repasse do Cosmos, tipado como CosmosDetailedOrder; não confirmado que o PUT devolve todos os campos do detalhe.",
      "A gold recebe só a UF da entrega (cidade, CEP, transportadora e cliente não vão); a atualização roda depois da resposta e, se falhar, vira aviso no Slack."
    ],
    "sources": [
      "cxhub/app/api/cosmos/resends/[id]/route.ts",
      "cxhub/modules/reenvios/actions/resendCosmos.ts",
      "cxhub/modules/reenvios/actions/resendManagement.ts",
      "cxhub/modules/reenvios/types/management.ts",
      "cxhub/modules/reenvios/actions/atualizacaoGoldDoReenvio.ts",
      "cxhub/shared/lib/airflow/atualizarCaso.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "cxhub/shared/lib/format.ts",
      "cxhub/__tests__/integration/api-cosmos-resends.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/cosmos/resends/{id}/cancel",
    "tag": "Reenvios no Cosmos",
    "summary": "Cancela um reenvio no Cosmos",
    "description": "Relê o reenvio no Cosmos, confere a janela de gestão (é reenvio, não está cancelado, faturamento não começou) e chama POST /organizations/{org}/orders/{id}/cancel com o motivo 'Cancelado via CX Hub por {handledBy}: {reason}'. Não tem volta; depois da resposta, o caso é marcado como Cancelado na gold pela fila, sem mudar a resposta. Cada chamada ao Cosmos tem 10 s por padrão (env TIMEOUT) e não há retentativa.",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "id",
        "in": "path",
        "type": "string",
        "required": true,
        "description": "Id interno do reenvio no Cosmos, só dígitos (o resends[].id de GET /api/cosmos/resends)."
      },
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca com organização no Cosmos (sem diferenciar maiúsculas); qualquer outra é recusada.",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria"
        ]
      }
    ],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "handledBy",
          "type": "string",
          "required": true,
          "description": "Agente que pediu o cancelamento (vai no motivo gravado no Cosmos)."
        },
        {
          "name": "reason",
          "type": "string",
          "required": true,
          "description": "Motivo do cancelamento."
        }
      ],
      "example": {
        "handledBy": "Ana Exemplo",
        "reason": "Cliente desistiu do reenvio"
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "O Cosmos cancelou o reenvio.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre SUCCESS."
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Sempre 'Reenvio cancelado no Cosmos.'."
          },
          {
            "name": "order",
            "type": "object",
            "required": true,
            "description": "O reenvio como o Cosmos devolveu depois do cancelamento (formato de GET /api/cosmos/orders/{id})."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Reenvio cancelado no Cosmos.",
          "order": {
            "id": 987700,
            "external_id": "SH123456LC-R-1",
            "origin": "resend",
            "status": "cancelled",
            "erp_status": "waiting",
            "created_at": "2026-10-28T10:05:00Z"
          }
        }
      },
      {
        "status": 400,
        "description": "Pedido inválido, antes de chamar o Cosmos. Outras mensagens: 'Marca inválida: <brand>.', 'id deve ser o id numérico do reenvio no Cosmos.', 'Corpo da requisição inválido.', 'Informe handledBy (agente responsável).'.",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "Informe reason (motivo do cancelamento)."
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O 401 do Cosmos também volta como UNAUTHORIZED, com a mensagem do Cosmos ou 'Token do Cosmos inválido ou expirado.'.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Header Authorization ausente."
        }
      },
      {
        "status": 403,
        "description": "O Cosmos recusou o cancelamento (exemplo). Na releitura do reenvio, o 403 vem com a mensagem do Cosmos ou 'O usuário do CX Hub não tem permissão para esta ação no Cosmos.'.",
        "example": {
          "code": "FORBIDDEN",
          "message": "O usuário de serviço do CX Hub não tem a permissão cancel_order no Cosmos para esta marca (org 3)."
        }
      },
      {
        "status": 404,
        "description": "O reenvio não existe na organização da marca: a mensagem do Cosmos, ou a padrão do exemplo.",
        "example": {
          "code": "NOT_FOUND",
          "message": "Pedido não encontrado nesta marca."
        }
      },
      {
        "status": 422,
        "description": "Fora da janela de gestão ou recusado. Outros: NOT_A_RESEND 'Este pedido não é um reenvio.', RESEND_LOCKED 'O faturamento deste reenvio já começou: ele não pode mais ser cancelado nem editado.', COSMOS_REJECTED com a mensagem do Cosmos ou 'O Cosmos recusou a operação.'.",
        "example": {
          "code": "RESEND_CANCELLED",
          "message": "Este reenvio já está cancelado."
        }
      },
      {
        "status": 500,
        "description": "Falta o COSMOS_API_URL no app.",
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Cosmos API URL não configurada."
        }
      },
      {
        "status": 502,
        "description": "Status inesperado do Cosmos, falha de rede, ou 200 sem um pedido válido no corpo.",
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível concluir a operação no Cosmos."
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo.",
        "example": {
          "code": "API_TIMEOUT",
          "message": "O Cosmos demorou para responder."
        }
      }
    ],
    "notes": [
      "Sem volta e sem retentativa de propósito: repetir depois de um 5xx pode cancelar duas vezes; releia o reenvio antes de repetir.",
      "Campos extras no corpo são ignorados (aqui a validação não é estrita como no PATCH); handledBy e reason vão sem espaços nas pontas.",
      "O Cosmos registra como autor o usuário de serviço do CX Hub; o agente fica só no motivo.",
      "O order da resposta é repasse do Cosmos, tipado como CosmosDetailedOrder; não confirmado que o cancelamento devolve todos os campos do detalhe.",
      "A gold recebe status_execucao = Cancelado e responsavel_execucao = handledBy; a atualização roda depois da resposta e, se falhar, vira aviso no Slack."
    ],
    "sources": [
      "cxhub/app/api/cosmos/resends/[id]/cancel/route.ts",
      "cxhub/modules/reenvios/actions/resendCosmos.ts",
      "cxhub/modules/reenvios/actions/resendManagement.ts",
      "cxhub/modules/reenvios/types/management.ts",
      "cxhub/modules/reenvios/actions/atualizacaoGoldDoReenvio.ts",
      "cxhub/shared/lib/airflow/atualizarCaso.ts",
      "cxhub/__tests__/integration/api-cosmos-resends.test.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/shopify/orders",
    "tag": "Shopify e Data Mart",
    "summary": "Busca o pedido na Shopify da marca",
    "description": "Lescent, Kokeshi, BySamia, Auá e Barbours: lê o REST orders.json da loja (status=any&name={orderId}) com o token da loja e repassa a resposta. Rituária, Ápice, Yenzah, Denavita e Gobeaute: consulta o integrations-gateway (GraphQL), confere o nome do pedido e devolve no mesmo formato REST, com 0 ou 1 pedido e só os campos que o formulário usa. Não grava nada; cada consulta tem 10 s por padrão (env TIMEOUT).",
    "routeHeader": null,
    "params": [
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca do CX Hub (sem diferenciar maiúsculas); define se a leitura é pelo REST da loja ou pelo gateway.",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria",
          "apice",
          "yenzah",
          "denavita",
          "gobeaute"
        ]
      },
      {
        "name": "orderId",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Número do pedido na loja; mande só os dígitos (nas marcas do gateway, SH1629891AP ou #1475900 também servem)."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Consulta feita: os pedidos achados, ou lista vazia.",
        "fields": [
          {
            "name": "orders",
            "type": "array",
            "required": true,
            "description": "Pedidos achados; vazia quando nenhum casa (pelo gateway, 0 ou 1)."
          },
          {
            "name": "orders[].id",
            "type": "number",
            "required": true,
            "description": "Id do pedido na Shopify."
          },
          {
            "name": "orders[].name",
            "type": "string",
            "required": true,
            "description": "Número do pedido na loja (ex.: #123456 ou SH1629891AP)."
          },
          {
            "name": "orders[].created_at",
            "type": "string",
            "required": true,
            "description": "Data e hora da compra."
          },
          {
            "name": "orders[].email",
            "type": "string",
            "required": true,
            "description": "E-mail do pedido."
          },
          {
            "name": "orders[].financial_status",
            "type": "string | null",
            "required": true,
            "description": "Situação do pagamento, em minúsculas (ex.: paid)."
          },
          {
            "name": "orders[].current_total_price",
            "type": "string",
            "required": true,
            "description": "Total atual do pedido."
          },
          {
            "name": "orders[].total_price",
            "type": "string",
            "required": true,
            "description": "Total da compra."
          },
          {
            "name": "orders[].total_shipping_price_set.shop_money.amount",
            "type": "string",
            "required": true,
            "description": "Valor do frete."
          },
          {
            "name": "orders[].customer",
            "type": "object | null",
            "required": true,
            "description": "Cliente: first_name, last_name, phone."
          },
          {
            "name": "orders[].shipping_address",
            "type": "object | null",
            "required": true,
            "description": "Entrega: name, address1, address2, city, zip, province, province_code, phone."
          },
          {
            "name": "orders[].shipping_lines[].title",
            "type": "string",
            "required": true,
            "description": "Título do frete (ex.: NORMAL_J&T)."
          },
          {
            "name": "orders[].note_attributes",
            "type": "array",
            "required": true,
            "description": "Atributos do pedido (name, value); pelo gateway, só o nf_number."
          },
          {
            "name": "orders[].line_items",
            "type": "array",
            "required": true,
            "description": "Itens: id, name, sku, vendor, quantity, price e discount_allocations[].amount."
          },
          {
            "name": "orders[].fulfillments",
            "type": "array",
            "required": true,
            "description": "Despachos: tracking_company e tracking_number."
          }
        ],
        "example": {
          "orders": [
            {
              "id": 9001,
              "name": "SH1629891AP",
              "created_at": "2026-11-01T12:00:00Z",
              "email": "cliente@exemplo.com",
              "financial_status": "paid",
              "current_total_price": "149.80",
              "total_price": "149.80",
              "total_shipping_price_set": {
                "shop_money": {
                  "amount": "19.90"
                }
              },
              "customer": {
                "first_name": "Maria",
                "last_name": "Exemplo",
                "phone": null
              },
              "shipping_address": {
                "name": "Maria Exemplo",
                "address1": "Rua das Flores, 100",
                "address2": "Centro",
                "city": "São Paulo",
                "zip": "01001-000",
                "province": "São Paulo",
                "province_code": "SP",
                "phone": "+5511900000000"
              },
              "shipping_lines": [
                {
                  "title": "NORMAL_J&T"
                }
              ],
              "note_attributes": [],
              "line_items": [
                {
                  "id": 555,
                  "name": "Sérum Facial",
                  "sku": "20001",
                  "vendor": "Apice",
                  "quantity": 2,
                  "price": "69.95",
                  "discount_allocations": [
                    {
                      "amount": "10.00",
                      "discount_application_index": 0
                    }
                  ]
                }
              ],
              "fulfillments": []
            }
          ]
        }
      },
      {
        "status": 400,
        "description": "Falta brand ou orderId. Marca fora da lista dá {\"error\": \"Unknown brand: <brand>\"} (a marca como veio).",
        "example": {
          "error": "Missing brand or orderId parameter"
        }
      },
      {
        "status": 401,
        "description": "Só nas marcas do REST: a Shopify recusou o token da loja. Qualquer outro status de erro da Shopify (403, 404, 429, 5xx...) também volta com o mesmo status e {\"error\": \"Shopify API error: <status>\"}.",
        "example": {
          "error": "Shopify API error: 401"
        }
      },
      {
        "status": 500,
        "description": "Falta o token da loja no app (REST). Também {\"error\": \"Shopify gateway key not configured\"} sem a chave do gateway, e {\"error\": \"Failed to fetch from Shopify\"} na falha de rede ou resposta que não é JSON.",
        "example": {
          "error": "Shopify token not configured for this brand"
        }
      },
      {
        "status": 502,
        "description": "Só nas marcas do gateway: o gateway respondeu erro (inclusive 429 que persiste depois de uma nova tentativa). Também {\"error\": \"Shopify gateway invalid response\"} (200 sem JSON) e {\"error\": \"Shopify gateway query error\"} (GraphQL com errors).",
        "example": {
          "error": "Shopify gateway error: 401"
        }
      },
      {
        "status": 504,
        "description": "A Shopify ou o gateway não respondeu no prazo.",
        "example": {
          "error": "Request timeout"
        }
      }
    ],
    "notes": [
      "Nas marcas do REST, a resposta é repasse da Shopify Admin API 2025-01 (o objeto completo de orders.json, tipo ShopifyOrder em cxhub/shared/types/shopify.ts) e pode trazer mais de um pedido.",
      "Pelo gateway, só os últimos 60 dias de pedidos aparecem. Nas sem Cosmos, procura SH{n}{sufixo} (AP, YE, DN, GB) e depois só os dígitos; na Rituária, só os dígitos. Não achado é 200 {\"orders\": []}.",
      "Pelo gateway ficam de fora tags, note e os atributos com CPF e endereço; de note_attributes só passa o nf_number.",
      "No gateway, um 429 tem uma nova tentativa depois do Retry-After (até 3 s).",
      "No REST, o orderId vai cru no filtro name da Shopify: mande só os dígitos (a tela já manda assim).",
      "A Rituária só lê pelo gateway aqui; nas rotas do Cosmos ela segue como marca do Cosmos.",
      "Sem header próprio: só a chave gdk_ do gateway do GoDeploy."
    ],
    "sources": [
      "cxhub/app/api/shopify/orders/route.ts",
      "cxhub/shared/lib/shopify/gateway.ts",
      "cxhub/shared/lib/shopify/buscarPedidoNoGateway.ts",
      "cxhub/shared/lib/shopify/nomeDoPedido.ts",
      "cxhub/shared/lib/shopify/client.ts",
      "cxhub/shared/lib/constants.ts",
      "cxhub/shared/types/shopify.ts",
      "cxhub/__tests__/integration/api-shopify-orders.test.ts",
      "cxhub/__tests__/integration/api-marcas-sem-cosmos.test.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/datamart/products",
    "tag": "Shopify e Data Mart",
    "summary": "Catálogo de produtos avulsos de uma marca sem Cosmos",
    "description": "Confere o token no Cosmos (lendo uma transportadora da org da Lescent) e devolve o catálogo da marca lido do Data Mart pelo Metabase (gold.dim_produto_gobeauty, sem kits; na Ápice, também o Tiny), no formato dos produtos do Cosmos. O catálogo fica em cache na memória do Worker por 6 h por marca; o token é conferido em toda chamada.",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "brand",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca sem Cosmos com catálogo (sem diferenciar maiúsculas; espaços nas pontas são ignorados).",
        "enum": [
          "apice",
          "yenzah",
          "denavita"
        ]
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "O catálogo da marca.",
        "fields": [
          {
            "name": "products",
            "type": "array",
            "required": true,
            "description": "Produtos avulsos: ativos primeiro, depois pelo nome e pelo SKU."
          },
          {
            "name": "products[].id",
            "type": "number",
            "required": true,
            "description": "Id estável derivado do SKU (FNV-1a de 32 bits); não é id do Cosmos."
          },
          {
            "name": "products[].sku",
            "type": "string",
            "required": true,
            "description": "SKU do produto, um item por SKU."
          },
          {
            "name": "products[].name",
            "type": "string",
            "required": true,
            "description": "Nome do produto, sem o EAN que alguns trazem na frente."
          },
          {
            "name": "products[].price",
            "type": "string",
            "required": true,
            "description": "Preço de referência da loja com 2 casas; '0.00' quando o Data Mart não tem preço."
          },
          {
            "name": "products[].is_kit",
            "type": "boolean",
            "required": true,
            "description": "Sempre false: o catálogo só tem avulsos."
          },
          {
            "name": "products[].ativo",
            "type": "boolean",
            "required": true,
            "description": "Se o produto está ativo."
          }
        ],
        "example": {
          "products": [
            {
              "id": 2434151137,
              "sku": "YE01120",
              "name": "Sérum Facial 30ml",
              "price": "59.90",
              "is_kit": false,
              "ativo": true
            },
            {
              "id": 3372576050,
              "sku": "YE02010",
              "name": "Shampoo Nutritivo 300ml",
              "price": "49.90",
              "is_kit": false,
              "ativo": true
            }
          ]
        }
      },
      {
        "status": 400,
        "description": "Falta brand, ou a marca não tem catálogo: {\"error\": \"A marca <brand> não é sem Cosmos com catálogo no Data Mart: use apice, yenzah ou denavita.\"} (inclusive gobeaute e as marcas do Cosmos).",
        "example": {
          "error": "Parâmetro brand ausente."
        }
      },
      {
        "status": 401,
        "description": "Falta o x-cosmos-token. O Cosmos recusar o token dá {\"error\": \"Token do Cosmos inválido ou expirado.\"}.",
        "example": {
          "error": "Header Authorization ausente."
        }
      },
      {
        "status": 403,
        "description": "O Cosmos respondeu 403 na conferência do token.",
        "example": {
          "error": "O token não tem acesso ao Cosmos."
        }
      },
      {
        "status": 502,
        "description": "A conferência do token falhou (status inesperado, rede, ou COSMOS_API_URL ausente). Falha do Metabase dá {\"error\": \"Não foi possível ler o catálogo de produtos no Data Mart. Tente de novo em instantes.\"}.",
        "example": {
          "error": "Não foi possível conferir o token no Cosmos."
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não respondeu no prazo ao conferir o token.",
        "example": {
          "error": "O Cosmos demorou para conferir o token."
        }
      }
    ],
    "notes": [
      "Erros em {error}, não em {code, message}.",
      "Nada da marca vai ao Cosmos: ele só confere o token, na org da Lescent.",
      "Na Ápice, só SKUs numéricos entram; o Tiny dá o nome, acrescenta códigos ativos que faltam (sem preço, menos os que começam com kit) e tira os inativos em todas as empresas.",
      "O Metabase corta a consulta em 2.000 linhas sem erro: um catálogo maior viria incompleto.",
      "O cache é por isolate do Worker e falha do Metabase não fica guardada: a chamada seguinte tenta de novo."
    ],
    "sources": [
      "cxhub/app/api/datamart/products/route.ts",
      "cxhub/shared/lib/datamart/catalogo.ts",
      "cxhub/shared/lib/datamart/catalogoServer.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "cxhub/shared/lib/metabase/client.ts",
      "cxhub/__tests__/integration/api-datamart-products.test.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/resend/data",
    "tag": "Formulário",
    "summary": "Listas dos dropdowns do formulário",
    "description": "Lê do app GoDeploy rota-dados-cxhub (GET /api/v1/form-data?origin=) as listas do formulário e repassa o corpo sem transformação, depois de conferir que marcas e responsáveis vêm preenchidos. Não grava nada; o app tem 10 s para responder por padrão (env TIMEOUT).",
    "routeHeader": null,
    "params": [
      {
        "name": "origin",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Formulário que vai usar as listas, em minúsculas.",
        "enum": [
          "reenvio",
          "reembolso",
          "logistica"
        ]
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "As listas do formulário, como o app de dados devolveu.",
        "fields": [
          {
            "name": "marcas",
            "type": "array",
            "required": true,
            "description": "Marcas do formulário (nunca vazia)."
          },
          {
            "name": "responsáveis",
            "type": "array",
            "required": true,
            "description": "Agentes que podem constar como responsáveis (nunca vazia)."
          },
          {
            "name": "motivos",
            "type": "array",
            "required": false,
            "description": "Motivos da solicitação para a origem pedida."
          },
          {
            "name": "transportadoras_reenvio",
            "type": "array",
            "required": false,
            "description": "Transportadoras de reenvio aceitas por centro de distribuição."
          },
          {
            "name": "transportadoras_reenvio[].CD",
            "type": "string",
            "required": true,
            "description": "Centro de distribuição (ex.: SP)."
          },
          {
            "name": "transportadoras_reenvio[].Transportadoras de Reenvio",
            "type": "string",
            "required": true,
            "description": "Transportadoras do CD, separadas por vírgula."
          }
        ],
        "example": {
          "marcas": [
            "lescent",
            "kokeshi"
          ],
          "responsáveis": [
            "Ana Exemplo",
            "Bruno Exemplo"
          ],
          "motivos": [
            "Avaria informada pelo cliente",
            "Extravio"
          ],
          "transportadoras_reenvio": [
            {
              "CD": "SP",
              "Transportadoras de Reenvio": "J&T Express, PAC, Sedex"
            }
          ]
        }
      },
      {
        "status": 400,
        "description": "origin fora da lista (o app nem é chamado). O 400 do app de dados também volta como 400: {\"error\": \"App de configuração do formulário: <code ou HTTP 400>\", \"code\": \"<code>\"}, com code só quando o app manda.",
        "example": {
          "error": "origin inválido: use reenvio, reembolso, logistica"
        }
      },
      {
        "status": 500,
        "description": "Falta FORM_DATA_API_URL ou FORM_DATA_API_TOKEN no app (o app de dados nem é chamado).",
        "example": {
          "error": "App de configuração do formulário não configurado"
        }
      },
      {
        "status": 502,
        "description": "Credencial recusada pelo app de dados ou pelo gateway (3xx, 401, 403), como no exemplo, com o code do app quando vem. Também {\"error\": \"App de configuração do formulário: HTTP <status>\"} (outro erro do app), {\"error\": \"App de configuração do formulário inalcançável\"} (rede) e {\"error\": \"Resposta do app de configuração do formulário fora do contrato\"} (não JSON, ou marcas ou responsáveis vazios).",
        "example": {
          "error": "Credencial do app de configuração do formulário recusada",
          "code": "UNAUTHORIZED"
        }
      },
      {
        "status": 503,
        "description": "O app de dados disse o que falta nele; o code vem junto (NOT_CONFIGURED, CONFIG_INCOMPLETE ou DB_UNAVAILABLE).",
        "example": {
          "error": "App de configuração do formulário: NOT_CONFIGURED",
          "code": "NOT_CONFIGURED"
        }
      },
      {
        "status": 504,
        "description": "O app de dados não respondeu no prazo.",
        "example": {
          "error": "O app de configuração do formulário não respondeu a tempo"
        }
      }
    ],
    "notes": [
      "A resposta de sucesso é repasse do app rota-dados-cxhub: campos extras passam como vieram.",
      "motivos e transportadoras_reenvio variam por origem e podem faltar; não confirmado no código o que cada origem traz.",
      "A chave responsáveis tem acento, e a chave dos itens de transportadoras_reenvio tem espaços: 'Transportadoras de Reenvio'.",
      "Erros em {error}, com code quando o app de dados mandou um.",
      "Sem header próprio: só a chave gdk_ do gateway do GoDeploy."
    ],
    "sources": [
      "cxhub/app/api/resend/data/route.ts",
      "cxhub/shared/lib/formDataApi.ts",
      "cxhub/shared/lib/fetchFormData.ts",
      "cxhub/modules/reenvios/types/resend.ts",
      "cxhub/__tests__/integration/api-resend-data.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/sheets/append",
    "tag": "Reenvio",
    "summary": "Registra o reenvio montado pela tela do CX Hub e, com automação, executa no Cosmos.",
    "description": "Recebe a solicitação já montada pela tela (data); se data.automacao vier preenchida numa marca com Cosmos e fora do modo de teste, chama POST /resend no Cosmos com o token do agente, depois entrega o caso à fila do Metabase e grava a linha na planilha da marca (a gobeaute só vai à fila). Antes de tudo barra duplicata do mesmo pedido e marca nas últimas 24 h (fila e raw). testMode: true roda o dedup mas não chama o Cosmos nem grava nada; a rota foi dimensionada para caber em 120 s.",
    "routeHeader": null,
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca em minúsculas e sem acento; escolhe a planilha e a organização no Cosmos (comparação exata, \"Kokeshi\" dá 400).",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria",
            "apice",
            "yenzah",
            "denavita",
            "gobeaute"
          ]
        },
        {
          "name": "data",
          "type": "object",
          "required": true,
          "description": "A solicitação montada pela tela (ResendSubmissionData); a rota só confere que existe, sem validar os campos."
        },
        {
          "name": "token",
          "type": "string",
          "required": "condicional",
          "description": "Token do Cosmos do agente (o credentials.token do /api/auth/login), exigido quando data.automacao está preenchida; sem ele a resposta é API_ERROR e nada é gravado."
        },
        {
          "name": "testMode",
          "type": "boolean",
          "required": false,
          "description": "Ensaio: true não chama o Cosmos nem grava nada e responde SUCCESS_TEST_MODE; se vier, tem de ser booleano (\"true\" em texto dá 400)."
        },
        {
          "name": "data.timestamp",
          "type": "string",
          "required": false,
          "description": "Aceito e ignorado: o carimbo da linha é gerado no servidor, no fuso de São Paulo."
        },
        {
          "name": "data.dataSolicitacao",
          "type": "string",
          "required": false,
          "description": "Data da solicitação (dd/mm/aaaa), gravada na planilha."
        },
        {
          "name": "data.data_criacao",
          "type": "string",
          "required": false,
          "description": "Data de criação do pedido (dd/mm/aaaa), vai à fila como data do pedido."
        },
        {
          "name": "data.tipoSolicitacao",
          "type": "string",
          "required": false,
          "description": "Tipo de solicitação; \"Reenvio\" ou \"Cashback\" vão à fila, outro valor só à planilha.",
          "enum": [
            "Reenvio",
            "Cashback"
          ]
        },
        {
          "name": "data.responsavel",
          "type": "string",
          "required": false,
          "description": "Agente responsável, gravado na planilha e na fila."
        },
        {
          "name": "data.origemReclamacao",
          "type": "string",
          "required": false,
          "description": "Origem da reclamação (ex.: \"Chat Atendimento\")."
        },
        {
          "name": "data.idAtendimento",
          "type": "string",
          "required": false,
          "description": "ID do atendimento, gravado na planilha e na fila."
        },
        {
          "name": "data.cdOrigem",
          "type": "string",
          "required": false,
          "description": "CD de origem do pedido."
        },
        {
          "name": "data.nomeCliente",
          "type": "string",
          "required": false,
          "description": "Nome da cliente; vai à planilha e ao Cosmos, nunca à fila."
        },
        {
          "name": "data.telefoneCliente",
          "type": "string",
          "required": false,
          "description": "Telefone da cliente; vai à planilha e ao Cosmos (só dígitos e +)."
        },
        {
          "name": "data.enderecoCliente",
          "type": "string",
          "required": false,
          "description": "Endereço de entrega em uma linha, gravado na planilha."
        },
        {
          "name": "data.cep",
          "type": "string",
          "required": false,
          "description": "CEP do endereço de entrega, gravado na planilha."
        },
        {
          "name": "data.estado",
          "type": "string",
          "required": false,
          "description": "UF do endereço de entrega, gravada na planilha e na fila."
        },
        {
          "name": "data.numeroPedido",
          "type": "string",
          "required": true,
          "description": "Número do pedido (ex.: SH1029384KS ou #SHOPIFY220183); a rota não valida, mas o dedup usa e a fila recusa o caso sem ele (SHEETS_ERROR/RECORD_UNAVAILABLE)."
        },
        {
          "name": "data.numeroNF",
          "type": "string",
          "required": false,
          "description": "Número da nota fiscal."
        },
        {
          "name": "data.chaveNF",
          "type": "string",
          "required": false,
          "description": "Chave de acesso da nota fiscal."
        },
        {
          "name": "data.cosmosId",
          "type": "string",
          "required": "condicional",
          "description": "ID interno do pedido no Cosmos, exigido quando data.automacao está preenchida."
        },
        {
          "name": "data.produtoComProblema",
          "type": "string",
          "required": false,
          "description": "SKUs com problema, separados por ponto e vírgula."
        },
        {
          "name": "data.produtoReenviar",
          "type": "string",
          "required": false,
          "description": "Itens a reenviar no formato \"SKU - qtd\", separados por ponto e vírgula (texto da linha; quem define a remessa é data.apiData)."
        },
        {
          "name": "data.loteProduto",
          "type": "string",
          "required": false,
          "description": "Lote do produto."
        },
        {
          "name": "data.problemaProduto",
          "type": "string",
          "required": false,
          "description": "Problema do produto; com automação, é também o motivo enviado ao Cosmos."
        },
        {
          "name": "data.transportadoraOriginal",
          "type": "string",
          "required": false,
          "description": "Transportadora do pedido original."
        },
        {
          "name": "data.transportadoraReenvio",
          "type": "string",
          "required": false,
          "description": "Transportadora escolhida para o reenvio (texto da linha)."
        },
        {
          "name": "data.devolucao",
          "type": "string",
          "required": false,
          "description": "Se o pedido volta para a operação.",
          "enum": [
            "Sim",
            "Não"
          ]
        },
        {
          "name": "data.ticketTransportadora",
          "type": "string",
          "required": false,
          "description": "ID do ticket aberto com a transportadora."
        },
        {
          "name": "data.statusPedido",
          "type": "string",
          "required": false,
          "description": "Status do pedido (ex.: \"Produto avariado/extraviado\")."
        },
        {
          "name": "data.ReenvioCompleto",
          "type": "string",
          "required": false,
          "description": "Se o reenvio é do pedido inteiro.",
          "enum": [
            "Sim",
            "Não"
          ]
        },
        {
          "name": "data.valorReenvio",
          "type": "string",
          "required": false,
          "description": "Valor do reenvio no formato 1234,56 (vai como número à planilha; fora desse formato a célula fica vazia)."
        },
        {
          "name": "data.status",
          "type": "string",
          "required": false,
          "description": "\"Realizado\" quando há automação, vazio quando não há."
        },
        {
          "name": "data.codNfd",
          "type": "string",
          "required": false,
          "description": "\"Pendente\" quando há automação, vazio quando não há."
        },
        {
          "name": "data.automacao",
          "type": "string",
          "required": "condicional",
          "description": "Texto não vazio (a tela manda \"Automação\") liga a execução no Cosmos nas marcas com Cosmos; vazio só registra."
        },
        {
          "name": "data.erp",
          "type": "string",
          "required": false,
          "description": "ERP do pedido quando há automação (\"Protheus\" ou, na Rituária vinda da Shopify, \"Bling\"); vazio quando não há."
        },
        {
          "name": "data.comentarios",
          "type": "string",
          "required": false,
          "description": "Comentários gerais; vão só à planilha."
        },
        {
          "name": "data.apiData",
          "type": "object",
          "required": "condicional",
          "description": "Corpo do reenvio no Cosmos, exigido quando data.automacao está preenchida (sem ele: API_ERROR e nada gravado)."
        },
        {
          "name": "data.apiData.carrierId",
          "type": "integer",
          "required": "condicional",
          "description": "ID da transportadora no Cosmos."
        },
        {
          "name": "data.apiData.carrierServiceName",
          "type": "string",
          "required": "condicional",
          "description": "Nome do serviço da transportadora no Cosmos (vai como service_name do endereço)."
        },
        {
          "name": "data.apiData.shippingCost",
          "type": "string",
          "required": "condicional",
          "description": "Frete do pedido original (ex.: \"15.00\")."
        },
        {
          "name": "data.apiData.discountAmount",
          "type": "string",
          "required": "condicional",
          "description": "Desconto proporcional dos itens reenviados (ex.: \"0.00\")."
        },
        {
          "name": "data.apiData.resendProducts[].product_id",
          "type": "integer",
          "required": "condicional",
          "description": "ID do produto no Cosmos."
        },
        {
          "name": "data.apiData.resendProducts[].quantity",
          "type": "integer",
          "required": "condicional",
          "description": "Quantidade a reenviar."
        },
        {
          "name": "data.apiData.resendProducts[].unit_price",
          "type": "string",
          "required": "condicional",
          "description": "Preço unitário enviado ao Cosmos (ex.: \"50\")."
        },
        {
          "name": "data.apiData.shippingAddress.street",
          "type": "string",
          "required": "condicional",
          "description": "Logradouro de entrega."
        },
        {
          "name": "data.apiData.shippingAddress.number",
          "type": "string",
          "required": "condicional",
          "description": "Número de entrega."
        },
        {
          "name": "data.apiData.shippingAddress.complement",
          "type": "string",
          "required": false,
          "description": "Complemento de entrega."
        },
        {
          "name": "data.apiData.shippingAddress.neighborhood",
          "type": "string",
          "required": "condicional",
          "description": "Bairro de entrega."
        },
        {
          "name": "data.apiData.shippingAddress.city",
          "type": "string",
          "required": "condicional",
          "description": "Cidade de entrega."
        },
        {
          "name": "data.apiData.shippingAddress.state",
          "type": "string",
          "required": "condicional",
          "description": "UF de entrega."
        },
        {
          "name": "data.apiData.shippingAddress.postal_code",
          "type": "string",
          "required": "condicional",
          "description": "CEP de entrega."
        }
      ],
      "example": {
        "brand": "kokeshi",
        "token": "TOKEN_DO_COSMOS_DO_LOGIN",
        "data": {
          "timestamp": "10/11/2026, 14:32:05",
          "dataSolicitacao": "10/11/2026",
          "data_criacao": "02/11/2026",
          "tipoSolicitacao": "Reenvio",
          "responsavel": "Ana Exemplo",
          "origemReclamacao": "Chat Atendimento",
          "idAtendimento": "TKT-48213",
          "cdOrigem": "SP",
          "nomeCliente": "Cliente Exemplo",
          "telefoneCliente": "(11) 90000-0000",
          "enderecoCliente": "Rua Exemplo, 100, Apto 12, Centro, Campinas/SP",
          "cep": "13010-000",
          "estado": "SP",
          "numeroPedido": "SH1029384KS",
          "numeroNF": "123456",
          "chaveNF": "35261112345678000190550010001234561000012345",
          "cosmosId": "987654",
          "produtoComProblema": "KS01002",
          "produtoReenviar": "KS01002 - 1",
          "loteProduto": "L2611",
          "problemaProduto": "Extravio confirmado pela transportadora",
          "transportadoraOriginal": "PAC",
          "transportadoraReenvio": "PAC",
          "devolucao": "Não",
          "ticketTransportadora": "",
          "statusPedido": "Produto avariado/extraviado",
          "ReenvioCompleto": "Sim",
          "valorReenvio": "65,00",
          "status": "Realizado",
          "codNfd": "Pendente",
          "automacao": "Automação",
          "erp": "Protheus",
          "comentarios": "",
          "apiData": {
            "carrierId": 161,
            "carrierServiceName": "PAC",
            "shippingCost": "15.00",
            "discountAmount": "0.00",
            "resendProducts": [
              {
                "product_id": 101,
                "quantity": 1,
                "unit_price": "50"
              }
            ],
            "shippingAddress": {
              "street": "Rua Exemplo",
              "number": "100",
              "complement": "Apto 12",
              "neighborhood": "Centro",
              "city": "Campinas",
              "state": "SP",
              "postal_code": "13010-000"
            }
          }
        }
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "SUCCESS: o Cosmos criou o reenvio, o caso entrou na fila do Metabase e a linha na planilha; não repita (repetir despacharia outra caixa).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação; decida por ele, não pelo status HTTP.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Frase em português para exibir à pessoa."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "true: o reenvio foi criado no Cosmos."
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso na fila do Metabase, para acompanhar o registro."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).",
          "sentToAPI": true,
          "idSolicitacao": "3f1c9a2e-7b4d-4e8a-9c1f-2a6b8d0e5f71"
        }
      },
      {
        "status": 200,
        "description": "SUCCESS_SHEETS_ONLY: registrado na fila e na planilha sem executar no Cosmos (data.automacao vazia ou marca sem Cosmos); não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SUCCESS_SHEETS_ONLY"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Frase em português para exibir à pessoa."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false: nada foi enviado ao Cosmos."
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso na fila do Metabase."
          }
        ],
        "example": {
          "code": "SUCCESS_SHEETS_ONLY",
          "message": "Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).",
          "sentToAPI": false,
          "idSolicitacao": "6a2d8e1f-4c3b-4a7e-8f90-1b2c3d4e5f60"
        }
      },
      {
        "status": 200,
        "description": "SUCCESS_TEST_MODE: ensaio com testMode true; o dedup rodou, mas nada foi enviado ao Cosmos nem gravado; pode repetir à vontade.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SUCCESS_TEST_MODE"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Frase em português para exibir à pessoa."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          }
        ],
        "example": {
          "code": "SUCCESS_TEST_MODE",
          "message": "Solicitação de TESTE: nada foi registrado e nenhum reenvio foi executado.",
          "sentToAPI": false
        }
      },
      {
        "status": 200,
        "description": "DUPLICATE_RESEND: já existe reenvio não cancelado do mesmo pedido e marca nas últimas 24 h (também no modo de teste); nada novo foi registrado nem enviado; não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "DUPLICATE_RESEND"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o pedido, quem pediu e quando (hora de São Paulo)."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          }
        ],
        "example": {
          "code": "DUPLICATE_RESEND",
          "message": "Já existe um reenvio para o pedido SH1029384KS feito por Ana Exemplo em 10/11/2026 09:15:42",
          "sentToAPI": false
        }
      },
      {
        "status": 200,
        "description": "OUT_OF_STOCK: o Cosmos recusou com HTTP 422 por SKU sem saldo; nada foi registrado; pode repetir depois de ajustar os itens ou o estoque.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "OUT_OF_STOCK"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o SKU sem saldo."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          }
        ],
        "example": {
          "code": "OUT_OF_STOCK",
          "message": "Não foi possível reenviar: o SKU KS01002 está sem saldo no Cosmos. Verifique o estoque ou solicite reenvio manual.",
          "sentToAPI": false
        }
      },
      {
        "status": 200,
        "description": "API_ERROR: o Cosmos recusou, não respondeu, o prazo acabou antes da chamada ou faltou dado da automação (token, apiData, cosmosId); nada foi registrado; repita só depois de corrigir, e quando o message diz que o reenvio PODE ter sido criado, confira no Cosmos antes.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "API_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma de: \"O Cosmos recusou o reenvio: <erro>\", \"Ocorreu um erro ao se conectar ao servidor do Cosmos.\", \"O Cosmos não respondeu — o reenvio PODE ter sido criado. Confira no Cosmos antes de repetir.\", \"O tempo acabou antes de chamar o Cosmos — o reenvio não foi enviado.\" ou \"Os dados da automação estão incompletos — o reenvio não foi enviado ao Cosmos.\"."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false (mesmo quando o Cosmos não respondeu e a remessa pode ter saído)."
          }
        ],
        "example": {
          "code": "API_ERROR",
          "message": "O Cosmos recusou o reenvio: Transportadora inválida",
          "sentToAPI": false
        }
      },
      {
        "status": 200,
        "description": "SHEETS_ERROR com reason RECORD_UNAVAILABLE: a fila do Metabase recusou o caso, então nada foi registrado (nem na planilha); com sentToAPI false pode repetir, com sentToAPI true o reenvio já saiu no Cosmos e repetir criaria outro.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz se o Cosmos já processou e o motivo da fila."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "true quando o reenvio já foi criado no Cosmos antes da recusa da fila."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Registro com certeza não feito.",
            "enum": [
              "RECORD_UNAVAILABLE"
            ]
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "Houve um erro ao registrar o reenvio (a fila respondeu HTTP 400 INVALID_REQUEST). Tente novamente.",
          "sentToAPI": false,
          "reason": "RECORD_UNAVAILABLE"
        }
      },
      {
        "status": 200,
        "description": "SHEETS_ERROR com reason ROW_UNCERTAIN: a linha entrou na planilha, mas a entrada na fila do Metabase não foi confirmada (na gobeaute, que não tem planilha, só a fila ficou incerta); não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que foi gravado e pede para não repetir."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "true quando o reenvio foi criado no Cosmos."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Registro incerto.",
            "enum": [
              "ROW_UNCERTAIN"
            ]
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso, para o suporte conferir."
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "O reenvio foi processado com sucesso no Cosmos e a solicitação foi registrada na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.",
          "sentToAPI": true,
          "reason": "ROW_UNCERTAIN",
          "idSolicitacao": "3f1c9a2e-7b4d-4e8a-9c1f-2a6b8d0e5f71"
        }
      },
      {
        "status": 200,
        "description": "SHEETS_ERROR com reason SHEET_WRITE_FAILED: o caso entrou (ou pode ter entrado) na fila do Metabase, mas a linha não chegou à planilha ou entrou sem as fórmulas; o suporte é avisado; não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que foi gravado e termina com \"NÃO repita a solicitação.\"."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "true quando o reenvio foi criado no Cosmos."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Só a planilha falhou.",
            "enum": [
              "SHEET_WRITE_FAILED"
            ]
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso na fila do Metabase."
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "O reenvio foi processado com sucesso no Cosmos e a solicitação entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.",
          "sentToAPI": true,
          "reason": "SHEET_WRITE_FAILED",
          "idSolicitacao": "3f1c9a2e-7b4d-4e8a-9c1f-2a6b8d0e5f71"
        }
      },
      {
        "status": 400,
        "description": "Corpo sem brand ou data, marca fora da lista ou testMode não booleano; nada é feito; corrija e reenvie.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Missing brand or data\", \"Invalid brand: <marca>\" ou \"Invalid testMode: expected boolean\"."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Invalid brand: Kokeshi",
          "sentToAPI": false
        }
      },
      {
        "status": 500,
        "description": "Exceção não tratada, inclusive corpo que não é JSON válido; pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível se conectar ao sistema.",
          "sentToAPI": false
        }
      },
      {
        "status": 502,
        "description": "Salvaguarda do modo de teste: testMode true recebeu resposta de fluxo real (SUCCESS ou sentToAPI true); um reenvio pode ter sido executado; não repita e avise o time.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Modo de teste violado.",
            "enum": [
              "TEST_MODE_VIOLATION"
            ]
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "O modo de teste foi ignorado pelo fluxo: a resposta indica reenvio real. Um reenvio pode ter sido executado — avise o time antes de repetir.",
          "sentToAPI": false,
          "reason": "TEST_MODE_VIOLATION"
        }
      },
      {
        "status": 503,
        "description": "Fila ou planilha sem configuração no ambiente (fora do modo de teste), ou o dedup não conseguiu ler as solicitações recentes; nada foi registrado nem enviado; pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que falta (\"Não foi possível registrar a solicitação (<o que falta>) — nada foi registrado nem reenviado.\") ou que o dedup falhou."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Registro com certeza não feito.",
            "enum": [
              "RECORD_UNAVAILABLE"
            ]
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível consultar as solicitações recentes — nada foi registrado nem reenviado. Tente novamente.",
          "sentToAPI": false,
          "reason": "RECORD_UNAVAILABLE"
        }
      }
    ],
    "notes": [
      "Decida pelo code (e pelo reason) do corpo, não pelo status HTTP: DUPLICATE_RESEND, OUT_OF_STOCK, API_ERROR e SHEETS_ERROR chegam como 200.",
      "A rota não confere credencial própria: o token do Cosmos vai no corpo (token), e o header x-cosmos-token não é lido aqui.",
      "Ordem do processamento: configuração → dedup de 24 h → POST /resend no Cosmos → fila do Metabase → planilha; recusa ou silêncio do Cosmos voltam sem registro nenhum (diferente do /api/reenvio/bot, que garante a linha).",
      "O dedup procura o mesmo tipo (REENVIO), marca e data.numeroPedido nas últimas 24 h, na fila e na raw; um reenvio cancelado libera o pedido.",
      "O POST /resend no Cosmos não é retentado; o prazo dele é a env TIMEOUT (10 s sem ela), contado do início da requisição.",
      "Marcas sem Cosmos (apice, yenzah, denavita, gobeaute) nunca executam no Cosmos, mesmo com data.automacao preenchida; a gobeaute não tem planilha e o registro termina na fila.",
      "Corpo que não é JSON válido responde 500, não 400.",
      "O código API_TIMEOUT existe no tipo WebhookResponseCode, mas esta rota não o produz mais.",
      "Campos extras no corpo (ex.: assincrono, da tela antiga) são ignorados sem erro.",
      "Pelo roteador do app, outro método responde 405 { code: \"METHOD_NOT_ALLOWED\", message: \"Use POST nesta rota.\" } com o header Allow.",
      "O comentário de SheetsAppendResponse diz que reason fica ausente no fluxo da tela, mas o processResend devolve reason também aqui (RECORD_UNAVAILABLE, ROW_UNCERTAIN, SHEET_WRITE_FAILED, TEST_MODE_VIOLATION); vale o código.",
      "Tempo: a rota declara maxDuration 120 s (o GoDeploy não impõe esse limite) e o comentário de gravarLinha.ts estima o pior caso em cerca de 73 s com TIMEOUT 12 s; use timeout de cliente de pelo menos 120 s.",
      "Não confirmado: o que o dedup faz quando data.numeroPedido vem vazio (a fila recusaria o caso depois, e com automação o Cosmos já teria sido chamado)."
    ],
    "sources": [
      "cxhub/app/api/sheets/append/route.ts",
      "cxhub/modules/reenvios/actions/postResendWebhook.ts",
      "cxhub/modules/reenvios/actions/processResend.ts",
      "cxhub/modules/reenvios/actions/cosmosResend.ts",
      "cxhub/modules/reenvios/actions/buildResendRow.ts",
      "cxhub/modules/reenvios/actions/casoDoReenvio.ts",
      "cxhub/modules/reenvios/types/sheets.ts",
      "cxhub/shared/lib/constants.ts",
      "cxhub/shared/lib/airflow/contrato.ts",
      "cxhub/shared/lib/fila/estado.ts",
      "cxhub/shared/lib/fila/client.ts",
      "cxhub/shared/lib/sheets/gravarLinha.ts",
      "cxhub/shared/lib/backendDireto.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-sheets-append.test.ts",
      "cxhub/__tests__/reenvios/processResend.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/reenvio/bot",
    "tag": "Reenvio",
    "summary": "Reenvio pedido pelo Typebot: busca o pedido, aplica as guardas e registra, executando no Cosmos quando tudo confere.",
    "description": "Confere o x-bot-secret, busca o pedido real (no Cosmos para lescent, kokeshi, bysamia, aua, barbours e rituaria; na Shopify pelo integrations-gateway para apice, yenzah, denavita e gobeaute) e monta o reenvio do pedido inteiro ou dos itens de reshipment.items; se todas as guardas passam, executa POST /resend no Cosmos e registra na fila do Metabase e na planilha da marca, e qualquer dúvida degrada para registro sem automação com o motivo em reason (recusa do Cosmos também: a linha é garantida por uma segunda postagem). Vale o dedup de 24 h por marca e pedido; testMode: true percorre o caminho inteiro sem chamar o Cosmos nem gravar nada e devolve apiPreview. O orçamento interno da rota é de 150 s.",
    "routeHeader": "x-bot-secret",
    "params": [
      {
        "name": "x-bot-secret",
        "in": "header",
        "type": "string",
        "required": true,
        "description": "Segredo da porta do bot (o BOT_RESEND_SECRET do ambiente); ausente ou errado dá 401 antes de o corpo ser lido."
      }
    ],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca em minúsculas e sem acento, que precisa estar entre as marcas de reenvio da rota dados (com a rota dados fora do ar, vale a lista do enum).",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria",
            "apice",
            "yenzah",
            "denavita",
            "gobeaute"
          ]
        },
        {
          "name": "testMode",
          "type": "boolean",
          "required": false,
          "description": "Ensaio: true percorre o caminho todo sem chamar o Cosmos nem gravar nada; se vier, tem de ser booleano (\"true\" em texto ou null dão 400)."
        },
        {
          "name": "executeResend",
          "type": "boolean",
          "required": false,
          "description": "Só false tem efeito: desliga a execução no Cosmos nesta requisição e a solicitação é só registrada (reason AUTOMATION_OFF)."
        },
        {
          "name": "handledBy",
          "type": "string",
          "required": false,
          "description": "Responsável gravado na planilha e na fila (identifica o bot, ex.: \"Typebot\")."
        },
        {
          "name": "sourceChannel",
          "type": "string",
          "required": false,
          "description": "Origem da reclamação; CHAT_ATENDIMENTO vira \"Chat Atendimento\" e qualquer outro valor vai como veio."
        },
        {
          "name": "supportTicketId",
          "type": "string",
          "required": false,
          "description": "ID do atendimento, gravado na planilha e na fila."
        },
        {
          "name": "notes",
          "type": "string",
          "required": false,
          "description": "Comentários gerais da linha; a causa de uma degradação é anexada depois, com o prefixo [CXHub]."
        },
        {
          "name": "externalRequestId",
          "type": "string",
          "required": false,
          "description": "ID da solicitação no Portal de Cancelamento; vai aos comentários como \"Portal: <id>\"."
        },
        {
          "name": "customer.name",
          "type": "string",
          "required": false,
          "description": "Nome da cliente; só vale quando o pedido não é encontrado (com o pedido achado, vale o nome do pedido)."
        },
        {
          "name": "order.ecommerceOrderId",
          "type": "string",
          "required": "condicional",
          "description": "Número do pedido na loja (ex.: SH1029384KS); obrigatório fora do modo de teste, é a chave do dedup e da busca do pedido."
        },
        {
          "name": "order.invoiceNumber",
          "type": "string",
          "required": false,
          "description": "Número da NF; só vale quando o pedido não vem do Cosmos (marca sem Cosmos ou pedido não encontrado)."
        },
        {
          "name": "order.invoiceKey",
          "type": "string",
          "required": false,
          "description": "Chave de acesso da NF; mesma regra de order.invoiceNumber."
        },
        {
          "name": "order.batchNumber",
          "type": "string",
          "required": false,
          "description": "Lote do produto, gravado na planilha e na fila."
        },
        {
          "name": "order.originWarehouse",
          "type": "string",
          "required": false,
          "description": "CD de origem; só vale quando o pedido não é encontrado (com o pedido achado, vale o CD do pedido)."
        },
        {
          "name": "order.orderStatus",
          "type": "string",
          "required": false,
          "description": "Status do pedido; NOT_SHIPPED vira \"Pedido não foi enviado\" e qualquer outro valor vai como veio."
        },
        {
          "name": "reshipment.isFullReshipment",
          "type": "boolean",
          "required": false,
          "description": "false pede reenvio parcial e exige reshipment.items; true ou ausente reenvia o pedido inteiro."
        },
        {
          "name": "reshipment.requiresReturn",
          "type": "boolean",
          "required": false,
          "description": "Se o pedido volta para a operação (true vira \"Sim\"; false ou ausente, \"Não\")."
        },
        {
          "name": "reshipment.reason",
          "type": "string",
          "required": false,
          "description": "Problema do produto; vai à planilha e à fila e é o motivo enviado ao Cosmos no reenvio."
        },
        {
          "name": "reshipment.carrier.name",
          "type": "string",
          "required": false,
          "description": "Transportadora do reenvio, casada de forma tolerante com o mapa da marca; fora do mapa vale a transportadora do pedido no Cosmos, e omitir usa direto a do pedido."
        },
        {
          "name": "reshipment.problemItems[].sku",
          "type": "string",
          "required": false,
          "description": "SKUs com problema; só vão à linha quando o pedido não é encontrado (com o pedido achado, valem os itens do pedido)."
        },
        {
          "name": "reshipment.reshipmentItems[]",
          "type": "array",
          "required": false,
          "description": "Itens a reenviar ({ sku, quantity }) só como texto da linha quando o pedido não é encontrado; não escolhem o que é reenviado."
        },
        {
          "name": "reshipment.items[].sku",
          "type": "string",
          "required": "condicional",
          "description": "SKU de um item do reenvio parcial; obrigatório quando isFullReshipment é false e precisa existir no pedido."
        },
        {
          "name": "reshipment.items[].quantity",
          "type": "integer",
          "required": "condicional",
          "description": "Quantidade do item no reenvio parcial: inteiro de 1 até a quantidade do pedido."
        },
        {
          "name": "reshipment.items[].lineItemId",
          "type": "integer",
          "required": "condicional",
          "description": "ID da linha do pedido; obrigatório quando o mesmo SKU aparece em mais de uma linha."
        },
        {
          "name": "reshipment.removedItems[]",
          "type": "array",
          "required": false,
          "description": "Itens que saem do reenvio parcial ({ sku, quantity, lineItemId }); só histórico, vão aos comentários como \"Itens removidos: SKU - qtd\"."
        },
        {
          "name": "addressChange.enabled",
          "type": "boolean",
          "required": false,
          "description": "true manda o reenvio (e a execução no Cosmos) para addressChange.address; ausente ou false usa o endereço original do pedido."
        },
        {
          "name": "addressChange.address.street",
          "type": "string",
          "required": "condicional",
          "description": "Logradouro; obrigatório com enabled true (faltando, reason NEW_ADDRESS_INCOMPLETE)."
        },
        {
          "name": "addressChange.address.number",
          "type": "string",
          "required": "condicional",
          "description": "Número; obrigatório com enabled true."
        },
        {
          "name": "addressChange.address.complement",
          "type": "string",
          "required": false,
          "description": "Complemento; opcional."
        },
        {
          "name": "addressChange.address.district",
          "type": "string",
          "required": "condicional",
          "description": "Bairro; obrigatório com enabled true."
        },
        {
          "name": "addressChange.address.city",
          "type": "string",
          "required": "condicional",
          "description": "Cidade; obrigatória com enabled true."
        },
        {
          "name": "addressChange.address.state",
          "type": "string",
          "required": "condicional",
          "description": "UF; obrigatória com enabled true."
        },
        {
          "name": "addressChange.address.postalCode",
          "type": "string",
          "required": "condicional",
          "description": "CEP com 8 dígitos, com ou sem hífen; ausente dá NEW_ADDRESS_INCOMPLETE e malformado dá NEW_ADDRESS_CEP_INVALID."
        },
        {
          "name": "return.carrierName",
          "type": "string",
          "required": false,
          "description": "Transportadora original; só vale quando o pedido não é encontrado (com o pedido achado, vale a do pedido)."
        },
        {
          "name": "return.carrierTicketId",
          "type": "string",
          "required": false,
          "description": "ID do ticket aberto com a transportadora, gravado na planilha e na fila."
        }
      ],
      "example": {
        "brand": "kokeshi",
        "handledBy": "Typebot",
        "sourceChannel": "CHAT_ATENDIMENTO",
        "supportTicketId": "TKT-48213",
        "notes": "Cliente relatou extravio; rastreio parado há 10 dias.",
        "customer": {
          "name": "Cliente Exemplo"
        },
        "order": {
          "ecommerceOrderId": "SH1029384KS",
          "invoiceNumber": "123456",
          "batchNumber": "L2611",
          "orderStatus": "Produto avariado/extraviado"
        },
        "reshipment": {
          "isFullReshipment": true,
          "requiresReturn": false,
          "reason": "Extravio confirmado pela transportadora",
          "carrier": {
            "name": "PAC"
          }
        },
        "addressChange": {
          "enabled": true,
          "address": {
            "street": "Rua Exemplo",
            "number": "100",
            "complement": "Apto 12",
            "district": "Centro",
            "city": "Campinas",
            "state": "SP",
            "postalCode": "13010-000"
          }
        },
        "return": {
          "carrierName": "Correios PAC",
          "carrierTicketId": "TR-5501"
        }
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "SUCCESS: todas as guardas passaram, o Cosmos criou o reenvio e a solicitação entrou na fila e na planilha; não repita (repetir despacharia outra caixa).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação; decida por ele, não pelo status HTTP.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Frase em português; não ramifique nela."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "true: o reenvio foi criado no Cosmos."
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso (o id da requisição), o mesmo do aviso e do log."
          },
          {
            "name": "items",
            "type": "array",
            "required": "condicional",
            "description": "Só no reenvio parcial: os itens que foram, como { sku, quantity } com o SKU escrito como no pedido."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).",
          "sentToAPI": true,
          "idSolicitacao": "8c5e2f4a-1b3d-4f6e-9a7c-0d2e4b6f8a10"
        }
      },
      {
        "status": 200,
        "description": "SUCCESS_SHEETS_ONLY sem reason: marca sem Cosmos (apice, yenzah, denavita, gobeaute) com o pedido achado na Shopify; a solicitação só é registrada (fila e planilha; a gobeaute só na fila), que é o caminho normal dessas marcas; não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SUCCESS_SHEETS_ONLY"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Frase em português; não ramifique nela."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso na fila do Metabase."
          },
          {
            "name": "items",
            "type": "array",
            "required": "condicional",
            "description": "Só no reenvio parcial que conferiu: { sku, quantity } de cada item que vai."
          }
        ],
        "example": {
          "code": "SUCCESS_SHEETS_ONLY",
          "message": "Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).",
          "sentToAPI": false,
          "idSolicitacao": "b7e3c1d9-2a4f-4b6c-8d0e-5f1a3c7e9b20"
        }
      },
      {
        "status": 200,
        "description": "SUCCESS_SHEETS_ONLY com reason: uma guarda reprovou (ou o Cosmos recusou, reason ERP_REFUSED) e a solicitação foi registrada sem automação, com a causa no message, no reason e nos comentários da linha; não repita igual: em 24 h o dedup devolveria DUPLICATE_RESEND.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SUCCESS_SHEETS_ONLY"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"<motivo da degradação> — <frase do registro>\"; não ramifique nela."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false: nada foi executado no Cosmos por esta resposta."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Por que não executou, em nome estável para o Typebot ramificar (nunca pelo message); se o registro também falhou, o reason do registro (SHEET_WRITE_FAILED, ROW_UNCERTAIN, RECORD_UNAVAILABLE) prevalece sobre o da guarda. Todos os valores de AlertReason:\n- GATE_CLOSED: o BOT_RESEND_SECRET falta no ambiente; só vai ao aviso do Slack, porque o 503 da porta fechada não traz reason.\n- INVALID_PAYLOAD: corpo inválido (JSON torto, marca ausente ou não aceita, testMode não booleano, sem order.ecommerceOrderId fora do teste), respondido com 400 e solicitação descartada, então corrija e reenvie.\n- INVALID_ITEMS: reenvio parcial com lista vazia ou itens que não conferem com o pedido, respondido com 422 sem gravar nada, então corrija os itens e reenvie.\n- COSMOS_UNAVAILABLE: o Cosmos ficou inacessível ou mal configurado depois das retentativas, a solicitação foi registrada sem automação e o time foi avisado.\n- SHOPIFY_UNAVAILABLE: marca sem Cosmos e o integrations-gateway falhou, a solicitação foi registrada com o que o bot mandou e o time foi avisado.\n- ORDER_NOT_FOUND: o pedido não foi achado no Cosmos (ou na Shopify, que só alcança 60 dias, nas marcas sem Cosmos), a linha ficou para tratativa manual e não há aviso, então confirme o número com a cliente.\n- NOT_ELIGIBLE: o pedido não é elegível à automação (pedido da Shopify, só brindes ou extras que não são brinde) e foi registrado sem automação, sem aviso.\n- CARRIER_UNRESOLVED: a transportadora não está no mapa da marca e o pedido não trouxe ID de transportadora, registrado sem automação com aviso ao time.\n- AUTOMATION_DATA_MISSING: os dados para o Cosmos não foram montados a partir do pedido, registrado sem automação com aviso ao time.\n- CARRIER_ID_MISSING: a transportadora ficou sem ID no Cosmos, registrado sem automação com aviso ao time.\n- NO_RESEND_ITEMS: nenhum item de reenvio foi resolvido no pedido, registrado sem automação com aviso ao time.\n- PRODUCT_ID_MISSING: um item ficou sem ID de produto no Cosmos (SKU sem cadastro), registrado sem automação com aviso ao time.\n- ORDER_ADDRESS_NO_CEP: o endereço do próprio pedido está sem CEP, registrado sem automação com aviso ao time.\n- NEW_ADDRESS_INCOMPLETE: troca de endereço com campo faltando (o message diz qual), registrado sem automação e sem aviso, porque é dado a coletar com a cliente.\n- NEW_ADDRESS_CEP_INVALID: troca de endereço com CEP que não tem 8 dígitos, registrado sem automação e sem aviso, então peça o CEP de novo.\n- AUTOMATION_OFF: a execução está desligada (BOT_RESEND_EXECUTE=off no ambiente ou executeResend false no corpo), registrado sem automação e sem aviso.\n- INTERNAL_ERROR: exceção inesperada no CX Hub, que com 200 foi registrada sem automação e com 500 não gravou nada, com aviso ao time nos dois casos.\n- ERP_REFUSED: o Cosmos recusou o reenvio ou não respondeu (aí a remessa pode ter saído), e o CX Hub garantiu a linha sem automação e avisou o time, então não repita.\n- ROW_UNCERTAIN: a linha entrou na planilha mas a entrada na fila do Metabase não foi confirmada (na gobeaute, só a fila ficou incerta), então não repita.\n- RECORD_UNAVAILABLE: o registro não foi feito (fila ou planilha sem configuração, dedup sem leitura ou fila recusou), e com sentToAPI false pode repetir, com true a remessa já saiu e não deve repetir.\n- TEST_MODE_VIOLATION: o modo de teste recebeu resposta de fluxo real, respondido com 502, e um reenvio pode ter saído, então pare e avise o time.\n- GOLD_UPDATE_FAILED: só existe nos avisos de outras rotas (atualização da gold) e não aparece nesta resposta.\n- GOLD_UPDATE_NO_CASE: só existe nos avisos de outras rotas (nenhum caso na gold casou com o pedido) e não aparece nesta resposta.\n- SHEET_WRITE_FAILED: a solicitação entrou (ou pode ter entrado) na fila do Metabase mas a linha não chegou à planilha, e o suporte repõe, então não repita.\n- SHEET_ROW_NOT_FOUND: só existe nos avisos da gestão de reembolso e não aparece nesta resposta.",
            "enum": [
              "GATE_CLOSED",
              "INVALID_PAYLOAD",
              "INVALID_ITEMS",
              "COSMOS_UNAVAILABLE",
              "SHOPIFY_UNAVAILABLE",
              "ORDER_NOT_FOUND",
              "NOT_ELIGIBLE",
              "CARRIER_UNRESOLVED",
              "AUTOMATION_DATA_MISSING",
              "CARRIER_ID_MISSING",
              "NO_RESEND_ITEMS",
              "PRODUCT_ID_MISSING",
              "ORDER_ADDRESS_NO_CEP",
              "NEW_ADDRESS_INCOMPLETE",
              "NEW_ADDRESS_CEP_INVALID",
              "AUTOMATION_OFF",
              "INTERNAL_ERROR",
              "ERP_REFUSED",
              "ROW_UNCERTAIN",
              "RECORD_UNAVAILABLE",
              "TEST_MODE_VIOLATION",
              "GOLD_UPDATE_FAILED",
              "GOLD_UPDATE_NO_CASE",
              "SHEET_WRITE_FAILED",
              "SHEET_ROW_NOT_FOUND"
            ]
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso (o id da requisição), o mesmo do aviso no Slack."
          }
        ],
        "example": {
          "code": "SUCCESS_SHEETS_ONLY",
          "message": "Endereço novo incompleto — campo(s) ausente(s): bairro — registrado sem automação — Reenvio registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).",
          "sentToAPI": false,
          "reason": "NEW_ADDRESS_INCOMPLETE",
          "idSolicitacao": "8c5e2f4a-1b3d-4f6e-9a7c-0d2e4b6f8a10"
        }
      },
      {
        "status": 200,
        "description": "SUCCESS_TEST_MODE: ensaio com testMode true; o pedido foi buscado, as guardas rodaram e o dedup também, mas nada foi enviado ao Cosmos nem gravado; pode repetir à vontade.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SUCCESS_TEST_MODE"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Frase do ensaio, precedida do motivo quando uma guarda reprovou."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": "condicional",
            "description": "Presente quando uma guarda reprovou no ensaio; mesmos valores do 200 SUCCESS_SHEETS_ONLY com reason."
          },
          {
            "name": "items",
            "type": "array",
            "required": "condicional",
            "description": "Só no reenvio parcial que conferiu: { sku, quantity } de cada item."
          },
          {
            "name": "apiPreview",
            "type": "object",
            "required": "condicional",
            "description": "O corpo que iria ao Cosmos; só em marca com Cosmos e quando nenhuma guarda reprovou."
          },
          {
            "name": "apiPreview.carrierId",
            "type": "integer",
            "required": "condicional",
            "description": "ID da transportadora no Cosmos."
          },
          {
            "name": "apiPreview.carrierServiceName",
            "type": "string",
            "required": "condicional",
            "description": "Serviço da transportadora no Cosmos."
          },
          {
            "name": "apiPreview.shippingCost",
            "type": "string",
            "required": "condicional",
            "description": "Frete do pedido original."
          },
          {
            "name": "apiPreview.discountAmount",
            "type": "string",
            "required": "condicional",
            "description": "Desconto proporcional dos itens reenviados, com 2 casas."
          },
          {
            "name": "apiPreview.resendProducts[].product_id",
            "type": "integer",
            "required": "condicional",
            "description": "ID do produto no Cosmos."
          },
          {
            "name": "apiPreview.resendProducts[].quantity",
            "type": "integer",
            "required": "condicional",
            "description": "Quantidade a reenviar."
          },
          {
            "name": "apiPreview.resendProducts[].unit_price",
            "type": "string",
            "required": "condicional",
            "description": "Preço unitário enviado ao Cosmos."
          },
          {
            "name": "apiPreview.shippingAddress",
            "type": "object",
            "required": "condicional",
            "description": "Endereço de entrega: street, number, complement, neighborhood, city, state e postal_code."
          },
          {
            "name": "apiPreview.valorReenvio",
            "type": "string",
            "required": "condicional",
            "description": "Valor do reenvio como vai à planilha (ex.: \"65,00\")."
          }
        ],
        "example": {
          "code": "SUCCESS_TEST_MODE",
          "message": "Solicitação de TESTE: nada foi registrado e nenhum reenvio foi executado.",
          "sentToAPI": false,
          "apiPreview": {
            "carrierId": 161,
            "carrierServiceName": "PAC",
            "shippingCost": "15.00",
            "discountAmount": "0.00",
            "resendProducts": [
              {
                "product_id": 101,
                "quantity": 1,
                "unit_price": "50"
              }
            ],
            "shippingAddress": {
              "street": "Rua Exemplo",
              "number": "100",
              "complement": "Apto 12",
              "neighborhood": "Centro",
              "city": "Campinas",
              "state": "SP",
              "postal_code": "13010-000"
            },
            "valorReenvio": "65,00"
          }
        }
      },
      {
        "status": 200,
        "description": "DUPLICATE_RESEND: já existe solicitação não cancelada do mesmo pedido e marca nas últimas 24 h (inclusive no modo de teste); nada novo foi registrado nem enviado; não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "DUPLICATE_RESEND"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o pedido, quem pediu e quando (hora de São Paulo), precedido do motivo quando uma guarda havia reprovado."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": "condicional",
            "description": "Presente só quando uma guarda reprovou antes do dedup: é o reason da guarda, não da duplicata."
          }
        ],
        "example": {
          "code": "DUPLICATE_RESEND",
          "message": "Já existe um reenvio para o pedido SH1029384KS feito por Typebot em 10/11/2026 09:15:42",
          "sentToAPI": false
        }
      },
      {
        "status": 200,
        "description": "OUT_OF_STOCK: o Cosmos recusou o reenvio por SKU sem saldo (HTTP 422); pelo código a rota não regrava a linha nesse caso, então nada foi registrado e não há reason nem aviso; não repita igual, encaminhe para tratativa manual.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "OUT_OF_STOCK"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o SKU sem saldo."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "items",
            "type": "array",
            "required": "condicional",
            "description": "Só no reenvio parcial: { sku, quantity } dos itens pedidos."
          }
        ],
        "example": {
          "code": "OUT_OF_STOCK",
          "message": "Não foi possível reenviar: o SKU KS01002 está sem saldo no Cosmos. Verifique o estoque ou solicite reenvio manual.",
          "sentToAPI": false
        }
      },
      {
        "status": 200,
        "description": "SHEETS_ERROR com reason SHEET_WRITE_FAILED: a solicitação entrou (ou pode ter entrado) na fila do Metabase, mas a linha não chegou à planilha ou entrou sem as fórmulas; o suporte já foi avisado; não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que foi gravado e termina com \"NÃO repita a solicitação.\" (precedido do motivo quando houve degradação)."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "true quando o reenvio foi criado no Cosmos."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Só a planilha falhou.",
            "enum": [
              "SHEET_WRITE_FAILED"
            ]
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso na fila do Metabase."
          },
          {
            "name": "items",
            "type": "array",
            "required": "condicional",
            "description": "Só no reenvio parcial sem degradação: { sku, quantity } de cada item."
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "O reenvio foi processado com sucesso no Cosmos e a solicitação entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.",
          "sentToAPI": true,
          "reason": "SHEET_WRITE_FAILED",
          "idSolicitacao": "8c5e2f4a-1b3d-4f6e-9a7c-0d2e4b6f8a10"
        }
      },
      {
        "status": 200,
        "description": "SHEETS_ERROR com reason ROW_UNCERTAIN: a linha entrou na planilha, mas a entrada na fila do Metabase não foi confirmada (na gobeaute, só a fila ficou incerta); o time é avisado; não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que foi gravado e pede para não repetir."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "true quando o reenvio foi criado no Cosmos."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Registro incerto.",
            "enum": [
              "ROW_UNCERTAIN"
            ]
          },
          {
            "name": "idSolicitacao",
            "type": "string",
            "required": true,
            "description": "UUID do caso, para o suporte conferir."
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "A solicitação foi registrada na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.",
          "sentToAPI": false,
          "reason": "ROW_UNCERTAIN",
          "idSolicitacao": "8c5e2f4a-1b3d-4f6e-9a7c-0d2e4b6f8a10"
        }
      },
      {
        "status": 200,
        "description": "SHEETS_ERROR com reason RECORD_UNAVAILABLE: a fila do Metabase recusou o caso e nada foi registrado; com sentToAPI false pode repetir, com sentToAPI true o reenvio já saiu no Cosmos e repetir criaria outro.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho da solicitação.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz se o Cosmos já processou e o motivo da fila."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "true quando o reenvio já foi criado no Cosmos antes da recusa."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Registro com certeza não feito.",
            "enum": [
              "RECORD_UNAVAILABLE"
            ]
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "O reenvio foi processado com sucesso no Cosmos, porém houve um erro ao registrar a solicitação (a fila respondeu HTTP 400 INVALID_REQUEST).",
          "sentToAPI": true,
          "reason": "RECORD_UNAVAILABLE"
        }
      },
      {
        "status": 400,
        "description": "Payload inválido (JSON torto, brand ausente ou não aceita, testMode não booleano, order.ecommerceOrderId ausente fora do modo de teste); a solicitação é descartada e o time é avisado; corrija e reenvie.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Invalid JSON payload\", \"Invalid brand: (ausente)\", \"Invalid brand: <marca> (não está entre as marcas de reenvio da rota dados)\", \"Invalid brand: <marca> (marca desconhecida)\", \"Invalid testMode: expected boolean\" ou \"Missing order.ecommerceOrderId: obrigatório fora do modo de teste\"."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Solicitação descartada.",
            "enum": [
              "INVALID_PAYLOAD"
            ]
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Invalid brand: nivea (não está entre as marcas de reenvio da rota dados)",
          "sentToAPI": false,
          "reason": "INVALID_PAYLOAD"
        }
      },
      {
        "status": 401,
        "description": "x-bot-secret ausente ou errado (mesma resposta nos dois casos); o corpo nem é lido e não há aviso; corrija o segredo antes de repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não autorizado.",
          "sentToAPI": false
        }
      },
      {
        "status": 422,
        "description": "Reenvio parcial recusado: isFullReshipment false com reshipment.items vazio ou ausente, ou itens que não conferem com o pedido (SKU fora do pedido, quantidade inválida ou maior que a original, lineItemId de outra linha, SKU repetido em várias linhas sem lineItemId); nada é gravado; corrija os itens e reenvie.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Recusa do reenvio parcial.",
            "enum": [
              "INVALID_ITEMS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Lista todos os problemas, um por item, separados por ponto e vírgula."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Itens não conferem.",
            "enum": [
              "INVALID_ITEMS"
            ]
          }
        ],
        "example": {
          "code": "INVALID_ITEMS",
          "message": "Itens do reenvio parcial não conferem com o pedido: KS99999: SKU não está no pedido; KS03010: quantidade 3 maior que a do pedido (2)",
          "sentToAPI": false,
          "reason": "INVALID_ITEMS"
        }
      },
      {
        "status": 500,
        "description": "Exceção inesperada antes de haver o que registrar; pelo comentário do código nenhuma linha foi gravada e o time é avisado; pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Falha nossa.",
            "enum": [
              "INTERNAL_ERROR"
            ]
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível se conectar ao sistema.",
          "sentToAPI": false,
          "reason": "INTERNAL_ERROR"
        }
      },
      {
        "status": 502,
        "description": "Salvaguarda do modo de teste: testMode true recebeu resposta de fluxo real; um reenvio pode ter sido executado; não repita e avise o time.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa (precedida do motivo quando houve degradação)."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Modo de teste violado.",
            "enum": [
              "TEST_MODE_VIOLATION"
            ]
          },
          {
            "name": "apiPreview",
            "type": "object",
            "required": "condicional",
            "description": "O corpo que iria ao Cosmos, quando havia automação montada."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "O modo de teste foi ignorado pelo fluxo: a resposta indica reenvio real. Um reenvio pode ter sido executado — avise o time antes de repetir.",
          "sentToAPI": false,
          "reason": "TEST_MODE_VIOLATION"
        }
      },
      {
        "status": 503,
        "description": "Porta fechada: o BOT_RESEND_SECRET não está configurado no ambiente e toda chamada é recusada antes de ler o corpo; o time é avisado; repita só depois de configurado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Endpoint não configurado.",
          "sentToAPI": false
        }
      },
      {
        "status": 503,
        "description": "Registro indisponível: fila ou planilha sem configuração (fora do modo de teste) ou o dedup não conseguiu ler as solicitações recentes; nada foi registrado nem enviado e o time é avisado; pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre UNKNOWN_ERROR.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que falta ou que o dedup falhou (precedido do motivo quando houve degradação)."
          },
          {
            "name": "sentToAPI",
            "type": "boolean",
            "required": true,
            "description": "Sempre false."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Registro com certeza não feito.",
            "enum": [
              "RECORD_UNAVAILABLE"
            ]
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível consultar as solicitações recentes — nada foi registrado nem reenviado. Tente novamente.",
          "sentToAPI": false,
          "reason": "RECORD_UNAVAILABLE"
        }
      }
    ],
    "notes": [
      "Decida pelo code e pelo reason do corpo, nunca pelo status HTTP nem pelo texto do message: DUPLICATE_RESEND, OUT_OF_STOCK e SHEETS_ERROR chegam como 200, e o message muda de redação.",
      "Ordem das checagens: segredo configurado (503) → x-bot-secret (401) → JSON (400) → brand presente e aceita (400) → testMode booleano (400) → order.ecommerceOrderId fora do teste (400) → reenvio parcial com itens (422) → busca do pedido e guardas.",
      "As marcas aceitas vêm da rota dados (as mesmas do formulário de reenvio da tela); se ela não responder em 5 s, valem as 10 marcas do enum.",
      "Busca do pedido: nas marcas com Cosmos usa só os dígitos de order.ecommerceOrderId e aceita o external_id SH<dígitos><2 letras> ou #SHOPIFY<dígitos>; nas marcas sem Cosmos procura SH<dígitos><sufixo da marca> (AP, YE, DN, GB) e depois só os dígitos, nos últimos 60 dias da Shopify.",
      "Toda reprovação de guarda grava a solicitação sem automação, então corrigir o dado (endereço, CEP, número) e chamar de novo para o mesmo pedido em 24 h volta DUPLICATE_RESEND; não confirmado se há um caminho previsto para reenviar com a correção.",
      "OUT_OF_STOCK é a única recusa do Cosmos que a rota não regrava como ERP_REFUSED (ela só reposta quando o code é API_ERROR): pelo código, a solicitação não fica registrada em lugar nenhum, sem reason e sem aviso ao time.",
      "API_ERROR e API_TIMEOUT nunca chegam a quem chama esta rota: API_ERROR vira a repostagem com reason ERP_REFUSED, e API_TIMEOUT não é mais produzido.",
      "ERP_REFUSED cobre recusa e falta de resposta do Cosmos; o erro do ERP vai só aos comentários da linha e ao aviso, não ao message, e quando o Cosmos não respondeu a remessa pode ter saído.",
      "Sem addressChange (ou com enabled false) o reenvio executa no endereço original do pedido; o CEP do endereço novo só tem o formato conferido (8 dígitos), não a existência.",
      "Em marca com Cosmos, a remessa é sempre montada a partir do pedido real: o pedido inteiro, ou só reshipment.items no parcial; problemItems e reshipmentItems são texto da linha.",
      "Exemplo de reenvio parcial (Portal de Cancelamento): \"reshipment\": { \"isFullReshipment\": false, \"items\": [{ \"sku\": \"KS01002\", \"quantity\": 1, \"lineItemId\": 9912001 }], \"removedItems\": [{ \"sku\": \"KS05007\", \"quantity\": 1, \"lineItemId\": 9912003 }] }, e a resposta ecoa items: [{ \"sku\": \"KS01002\", \"quantity\": 1 }].",
      "O eco items vem quando o reenvio parcial conferiu e não houve degradação; nas respostas degradadas (com reason de guarda ou ERP_REFUSED) ele não vem.",
      "Campos opcionais do corpo aceitam null, que vale como ausente; token e cosmosToken no corpo são ignorados (o token do Cosmos é gerado no servidor).",
      "O dedup roda também no modo de teste (um reenvio real do mesmo pedido em 24 h devolve DUPLICATE_RESEND no ensaio), e o ensaio não grava nada: o guia docs/qa-reenvio-bot.md do CX Hub, que fala em aba TESTE e em 504 API_TIMEOUT, está desatualizado nesses pontos.",
      "O 503 da porta fechada não traz reason: GATE_CLOSED só aparece no aviso ao time.",
      "Avisos ao time vão ao Slack só nos reasons que são do time; dado da cliente (ORDER_NOT_FOUND, NEW_ADDRESS_*, NOT_ELIGIBLE, AUTOMATION_OFF, INVALID_ITEMS) não gera aviso.",
      "Tempo: o orçamento é de 150 s (a fase de busca do pedido recebe 150 s menos 2×TIMEOUT, 5 s da rota dados, 16 s da fila, 25 s da planilha, 2,5 s do aviso e 5 s de folga, com piso de 8 s, e cada postagem tem teto de min(TIMEOUT, 44,25 s)); o GoDeploy não impõe maxDuration, então configure o Typebot para esperar pelo menos 150 s.",
      "Não confirmado: o que acontece com o registro se quem chama desistir da conexão antes da resposta (se o Worker segue até gravar).",
      "Não confirmado: o comportamento do dedup e da busca no modo de teste sem order.ecommerceOrderId (pelo código, o pedido não é achado e a resposta degrada com ORDER_NOT_FOUND).",
      "Pelo roteador do app, outro método responde 405 { code: \"METHOD_NOT_ALLOWED\", message: \"Use POST nesta rota.\" } com o header Allow."
    ],
    "sources": [
      "cxhub/app/api/reenvio/bot/route.ts",
      "cxhub/modules/reenvios/actions/adaptBotPayload.ts",
      "cxhub/modules/reenvios/actions/buildBotResendData.ts",
      "cxhub/modules/reenvios/actions/buildSubmissionData.ts",
      "cxhub/modules/reenvios/actions/shouldSendToAPI.ts",
      "cxhub/modules/reenvios/actions/resolvePartialReshipment.ts",
      "cxhub/modules/reenvios/actions/marcasDoBot.ts",
      "cxhub/modules/reenvios/actions/postResendWebhook.ts",
      "cxhub/modules/reenvios/actions/processResend.ts",
      "cxhub/modules/reenvios/actions/cosmosResend.ts",
      "cxhub/modules/reenvios/types/sheets.ts",
      "cxhub/shared/lib/alerts/types.ts",
      "cxhub/shared/lib/alerts/policy.ts",
      "cxhub/shared/lib/constants.ts",
      "cxhub/shared/lib/format.ts",
      "cxhub/shared/lib/cosmos/server.ts",
      "cxhub/shared/lib/cosmos/client.ts",
      "cxhub/shared/lib/shopify/buscarPedidoNoGateway.ts",
      "cxhub/shared/lib/shopify/nomeDoPedido.ts",
      "cxhub/shared/lib/fila/estado.ts",
      "cxhub/shared/lib/fila/client.ts",
      "cxhub/shared/lib/sheets/gravarLinha.ts",
      "api/roteador.ts",
      "docs/api.md",
      "cxhub/__tests__/integration/api-reenvio-bot.test.ts",
      "cxhub/__tests__/integration/api-reenvio-bot-cosmos.test.ts",
      "cxhub/__tests__/integration/api-reenvio-bot-alertas.test.ts",
      "cxhub/__tests__/integration/api-reenvio-bot-parcial.test.ts",
      "cxhub/__tests__/integration/api-reenvio-bot-sem-cosmos.test.ts",
      "cxhub/__tests__/reenvios/processResend.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/refund/submit",
    "tag": "Reembolso",
    "summary": "Registra uma solicitação de reembolso",
    "description": "Confere os campos obrigatórios, barra o reembolso do mesmo pedido feito nas últimas 24 h (fila + raw), entrega o caso REEMBOLSO à fila do Metabase (o lote o leva à gold em até 20 min) e, só depois, grava a linha na planilha da marca. A Gobeaute não tem planilha: o registro dela termina na fila. Não existe modo de teste: toda chamada válida registra de verdade.",
    "routeHeader": null,
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca da solicitação, em minúsculas e sem espaços (a rota não normaliza).",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria",
            "apice",
            "yenzah",
            "denavita",
            "gobeaute"
          ]
        },
        {
          "name": "data",
          "type": "object",
          "required": true,
          "description": "Os dados do reembolso."
        },
        {
          "name": "data.brand",
          "type": "string",
          "required": true,
          "description": "Não pode faltar nem ser null, mas o valor não é usado: vale o brand de fora."
        },
        {
          "name": "data.handledBy",
          "type": "string",
          "required": true,
          "description": "Agente responsável; com o valor exato \"Bot\", o registro leva também um caso de cancelamento e ignora policyException."
        },
        {
          "name": "data.sourceChannel",
          "type": "string",
          "required": true,
          "description": "Origem da reclamação (o formulário usa, por exemplo, \"Chat Atendimento\" ou \"Reclame Aqui\")."
        },
        {
          "name": "data.supportTicketId",
          "type": "string",
          "required": true,
          "description": "ID do atendimento."
        },
        {
          "name": "data.originWarehouse",
          "type": "string",
          "required": true,
          "description": "CD de origem do pedido."
        },
        {
          "name": "data.customerName",
          "type": "string",
          "required": true,
          "description": "Nome do cliente; vai só para a planilha, nunca para a fila."
        },
        {
          "name": "data.invoiceNumber",
          "type": "string",
          "required": true,
          "description": "Número da NF do pedido."
        },
        {
          "name": "data.nfeAccessKey",
          "type": "string",
          "required": true,
          "description": "Chave de acesso da NF-e (string vazia é aceita)."
        },
        {
          "name": "data.ecommerceOrderId",
          "type": "string",
          "required": true,
          "description": "Número do pedido na loja, como a solicitação o grava; o dedup compara só os dígitos."
        },
        {
          "name": "data.refundAmount",
          "type": "number",
          "required": true,
          "description": "Valor do reembolso em reais."
        },
        {
          "name": "data.refundReason",
          "type": "string",
          "required": true,
          "description": "Motivo do reembolso."
        },
        {
          "name": "data.refundScope",
          "type": "string",
          "required": true,
          "description": "O que é reembolsado: itens \"SKU - qtd\" e/ou \"Frete\", separados por \";\"."
        },
        {
          "name": "data.requiresReturn",
          "type": "boolean",
          "required": true,
          "description": "Se o pedido será devolvido para a operação."
        },
        {
          "name": "data.carrierName",
          "type": "string",
          "required": true,
          "description": "Transportadora do pedido original."
        },
        {
          "name": "data.orderStatus",
          "type": "string",
          "required": true,
          "description": "Status do pedido (texto; o formulário oferece opções fixas, a rota não confere)."
        },
        {
          "name": "data.isFullRefund",
          "type": "boolean",
          "required": true,
          "description": "Se o reembolso é do pedido completo."
        },
        {
          "name": "data.data_criacao",
          "type": "string",
          "required": false,
          "description": "Data da compra do pedido (dd/mm/aaaa); sem ela, a DAG de acompanhamento busca na Shopify."
        },
        {
          "name": "data.policyException",
          "type": "boolean",
          "required": false,
          "description": "Reembolso fora da política; só conta o true literal, e nunca quando handledBy é \"Bot\"."
        },
        {
          "name": "data.batchNumber",
          "type": "string | null",
          "required": false,
          "description": "Lote do produto."
        },
        {
          "name": "data.carrierTicketId",
          "type": "string | null",
          "required": false,
          "description": "Ticket aberto com a transportadora."
        },
        {
          "name": "data.notes",
          "type": "string | null",
          "required": false,
          "description": "Observações do agente; vão só para a planilha, nunca para a fila."
        },
        {
          "name": "data.pixKey",
          "type": "string | null",
          "required": false,
          "description": "Chave Pix da cliente; só é gravada na planilha de apice, yenzah e denavita, e a rota não confere o formato."
        }
      ],
      "example": {
        "brand": "lescent",
        "data": {
          "brand": "lescent",
          "data_criacao": "20/10/2026",
          "handledBy": "Ana Souza",
          "sourceChannel": "Chat Atendimento",
          "supportTicketId": "T-48213",
          "originWarehouse": "SP",
          "customerName": "Cliente Exemplo",
          "invoiceNumber": "123456",
          "nfeAccessKey": "35261000000000000000550010001234561000000000",
          "batchNumber": null,
          "ecommerceOrderId": "SH9000105LC",
          "policyException": false,
          "refundAmount": 150.5,
          "refundReason": "Produto avariado",
          "refundScope": "LSC001 - 1;Frete",
          "requiresReturn": false,
          "carrierTicketId": null,
          "carrierName": "PAC",
          "orderStatus": "Produto avariado/extraviado",
          "isFullRefund": false,
          "notes": null
        }
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "SUCCESS: o caso entrou na fila e a linha na planilha (na Gobeaute, só a fila). Não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Texto para mostrar ao agente."
          },
          {
            "name": "idSolicitacao",
            "type": "string (UUID)",
            "required": true,
            "description": "Id do caso na fila; é o que /api/refund/complete e /api/refund/sync pedem."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Reembolso registrado com sucesso. O Metabase recebe no próximo lote (até 20 min).",
          "idSolicitacao": "6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f"
        }
      },
      {
        "status": 200,
        "description": "DUPLICATE_REFUND: já há reembolso não cancelado do mesmo pedido (mesmos dígitos) e marca nas últimas 24 h; nada foi registrado e repetir dá o mesmo resultado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "DUPLICATE_REFUND"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o pedido, quem pediu e quando (dd/mm/aaaa hh:mm:ss, hora de São Paulo)."
          }
        ],
        "example": {
          "code": "DUPLICATE_REFUND",
          "message": "Já existe um reembolso para o pedido SH9000105LC feito por Bia Lima em 10/11/2026 14:32:05"
        }
      },
      {
        "status": 200,
        "description": "SHEETS_ERROR sem reason: a fila recusou o caso, nada foi gravado (nem fila nem planilha) e pode repetir; se o motivo for \"fora do contrato da DAG\", corrija o corpo antes.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Erro ao registrar o reembolso (<motivo da fila>).\""
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "Erro ao registrar o reembolso (a fila respondeu HTTP 400 INVALID_REQUEST)."
        }
      },
      {
        "status": 200,
        "description": "SHEETS_ERROR com reason SHEET_WRITE_FAILED: o caso entrou (ou pode ter entrado) na fila, mas a planilha falhou ou ficou sem as fórmulas de prazo e SLA; a solicitação ESTÁ registrada, NÃO repita (o suporte é avisado).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz se o caso entrou ou pode ter entrado na fila e o que houve com a planilha."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Distingue este caso (registrado) do SHEETS_ERROR em que nada foi gravado.",
            "enum": [
              "SHEET_WRITE_FAILED"
            ]
          },
          {
            "name": "idSolicitacao",
            "type": "string (UUID)",
            "required": true,
            "description": "Id do caso entregue à fila."
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "O reembolso entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.",
          "reason": "SHEET_WRITE_FAILED",
          "idSolicitacao": "6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f"
        }
      },
      {
        "status": 504,
        "description": "API_TIMEOUT (marcas com planilha): a linha foi gravada na planilha, mas a entrada na fila não pôde ser confirmada; NÃO repita, avise o suporte.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "API_TIMEOUT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Explica a incerteza com o motivo da fila."
          },
          {
            "name": "idSolicitacao",
            "type": "string (UUID)",
            "required": true,
            "description": "Id do caso que pode estar na fila."
          }
        ],
        "example": {
          "code": "API_TIMEOUT",
          "message": "O reembolso foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.",
          "idSolicitacao": "6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f"
        }
      },
      {
        "status": 504,
        "description": "API_TIMEOUT (gobeaute, sem planilha): a entrada na fila não pôde ser confirmada; NÃO repita, confira a lista de reembolsos em alguns minutos.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "API_TIMEOUT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Explica a incerteza com o motivo da fila."
          },
          {
            "name": "idSolicitacao",
            "type": "string (UUID)",
            "required": true,
            "description": "Id do caso que pode estar na fila."
          }
        ],
        "example": {
          "code": "API_TIMEOUT",
          "message": "Não deu para confirmar a entrada do reembolso na fila do Metabase (a fila não respondeu em 8000ms). NÃO repita a solicitação: confira na lista de reembolsos em alguns minutos ou avise o suporte.",
          "idSolicitacao": "6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f"
        }
      },
      {
        "status": 400,
        "description": "UNKNOWN_ERROR: falta brand ou data (\"Missing brand or data\") ou a marca não é aceita (\"Invalid brand: <valor>\"); nada foi registrado, corrija antes de repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Missing brand or data\" ou \"Invalid brand: <valor>\"."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Invalid brand: Lescent"
        }
      },
      {
        "status": 400,
        "description": "UNKNOWN_ERROR: campo obrigatório de data ausente ou null; nada foi consultado nem registrado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"missing field(s): \" seguido dos campos, separados por vírgula."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "missing field(s): carrierName, nfeAccessKey"
        }
      },
      {
        "status": 503,
        "description": "UNKNOWN_ERROR: falta configuração do app (fila ou planilha da marca); recusado antes do dedup, nada registrado, pode repetir depois de configurar.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível registrar o reembolso (<o que falta>) — nada foi registrado. Tente novamente.\""
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível registrar o reembolso (a fila do Metabase não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)) — nada foi registrado. Tente novamente."
        }
      },
      {
        "status": 503,
        "description": "UNKNOWN_ERROR: não deu para consultar as solicitações recentes (fila ou raw fora); nada registrado, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível consultar as solicitações recentes — nada foi registrado. Tente novamente."
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: corpo que não é JSON ou exceção inesperada; se a exceção veio de um campo com tipo errado depois da fila (ex.: pixKey que não é texto), o caso pode já estar na fila, então confira a lista antes de repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível se conectar ao sistema."
        }
      }
    ],
    "notes": [
      "Não há testMode nesta rota: um \"testMode\": true no corpo é ignorado e a chamada registra de verdade.",
      "Decida pelo code (e pelo reason), não só pelo HTTP: DUPLICATE_REFUND e os dois SHEETS_ERROR vêm com 200.",
      "Só brand e data são lidos; outros campos no topo (ex.: assincrono) e campos extras em data são ignorados.",
      "Os campos obrigatórios só não podem faltar nem ser null: string vazia passa na validação.",
      "Dedup: mesmo tipo (REEMBOLSO), mesma marca e mesmos dígitos do pedido, criado nas últimas 24 h, na fila ou na raw; um reembolso já cancelado não conta.",
      "Guarde o idSolicitacao: é o id que /api/refund/complete e /api/refund/sync pedem.",
      "handledBy = \"Bot\": entrega também um caso CANCELAMENTO (tratativa Reembolso) à fila e, nas 6 marcas do Cosmos, grava a linha na planilha de cancelamento.",
      "apice, yenzah e denavita gravam a pixKey só na planilha (dado sensível: não vai à fila nem ao log); a planilha delas recebe fórmulas de prazo e SLA, e é daí que vem a variante \"sem as fórmulas\" do SHEET_WRITE_FAILED.",
      "Pior caso calculado no código ≈ 73 s (dedup + fila até 16 s + planilha até 25 s); a rota declara maxDuration de 120 s, então use um timeout de cliente de pelo menos 120 s.",
      "Método diferente de POST responde 405 {\"code\": \"METHOD_NOT_ALLOWED\", \"message\": \"Use POST nesta rota.\"} (roteador)."
    ],
    "sources": [
      "cxhub/app/api/refund/submit/route.ts",
      "cxhub/modules/reembolsos/actions/processRefund.ts",
      "cxhub/modules/reembolsos/actions/validateRefundBody.ts",
      "cxhub/modules/reembolsos/types/submission.ts",
      "cxhub/modules/reembolsos/actions/casoDoReembolso.ts",
      "cxhub/modules/reembolsos/actions/buildRefundRow.ts",
      "cxhub/shared/lib/constants.ts",
      "cxhub/shared/lib/backendDireto.ts",
      "cxhub/shared/lib/fila/client.ts",
      "cxhub/shared/lib/fila/estado.ts",
      "cxhub/shared/lib/airflow/contrato.ts",
      "cxhub/shared/lib/sheets/gravarLinha.ts",
      "cxhub/shared/lib/sheets/formulas.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-refund-submit.test.ts",
      "cxhub/__tests__/reembolsos/processRefund.test.ts",
      "cxhub/__tests__/reembolsos/processSemCosmos.test.ts",
      "cxhub/__tests__/reembolsos/processGobeaute.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/refund/cancel",
    "tag": "Reembolso",
    "summary": "Cancela o reembolso mais recente de um pedido",
    "description": "Confere o token do Cosmos na organização da marca, acha a solicitação de reembolso mais recente do pedido (na raw ou ainda na fila), entrega status_execucao = Cancelado (com o agente como responsável) à fila do Metabase e, depois de ela aceitar, marca Cancelado na planilha da marca. Nada muda se o reembolso já foi realizado, no Metabase ou na planilha.",
    "routeHeader": "x-cosmos-token",
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca; só as 6 do Cosmos (maiúsculas e espaços nas pontas são aceitos).",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria"
          ]
        },
        {
          "name": "ecommerceOrderId",
          "type": "string",
          "required": true,
          "description": "Número do pedido da solicitação: letras, dígitos, \"#\" e \"-\", até 40 caracteres e com algum dígito."
        },
        {
          "name": "handledBy",
          "type": "string",
          "required": true,
          "description": "Agente que cancela; vira o responsável da execução no Metabase."
        },
        {
          "name": "reason",
          "type": "string",
          "required": true,
          "description": "Motivo do cancelamento; obrigatório e não vazio, mas não é gravado em lugar nenhum."
        }
      ],
      "example": {
        "brand": "lescent",
        "ecommerceOrderId": "SH9000105LC",
        "handledBy": "Ana Souza",
        "reason": "Cliente desistiu do reembolso"
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "SUCCESS: o Cancelado entrou na fila e a planilha foi atualizada.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Texto para o agente."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Reembolso cancelado. O Metabase recebe no próximo lote (até 20 min)."
        }
      },
      {
        "status": 200,
        "description": "SUCCESS com reason: o Cancelado entrou na fila, mas a planilha não acompanhou; acerte a planilha à mão (o suporte é avisado). Repetir responde 422 e tenta reescrever o Cancelado na planilha.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que falhou na planilha."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "SHEET_ROW_NOT_FOUND: a linha do caso não está na planilha; SHEET_WRITE_FAILED: a planilha não respondeu ou falta a coluna.",
            "enum": [
              "SHEET_WRITE_FAILED",
              "SHEET_ROW_NOT_FOUND"
            ]
          }
        ],
        "example": {
          "code": "SUCCESS",
          "reason": "SHEET_ROW_NOT_FOUND",
          "message": "Reembolso cancelado na fila do Metabase, mas a planilha não foi atualizada (a linha do caso não está na planilha). Atualize a planilha à mão."
        }
      },
      {
        "status": 400,
        "description": "INVALID_REQUEST: corpo inválido; nada foi consultado. Mensagens: \"Corpo da requisição inválido.\", \"Campo desconhecido: <campos>.\", \"Marca inválida: <marca>.\", \"Informe ecommerceOrderId (número do pedido da solicitação).\", \"Informe handledBy (agente responsável).\", \"Informe reason (motivo do cancelamento).\"",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "INVALID_REQUEST"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "O primeiro problema encontrado."
          }
        ],
        "example": {
          "code": "INVALID_REQUEST",
          "message": "Marca inválida: apice."
        }
      },
      {
        "status": 401,
        "description": "UNAUTHORIZED: sem x-cosmos-token (\"Header Authorization ausente.\", antes de ler o corpo) ou token recusado pelo Cosmos (\"Token do Cosmos inválido ou expirado.\"); faça login de novo antes de repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNAUTHORIZED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Token do Cosmos inválido ou expirado."
        }
      },
      {
        "status": 403,
        "description": "FORBIDDEN: o token não tem acesso à organização da marca no Cosmos.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "FORBIDDEN"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "FORBIDDEN",
          "message": "O token não tem acesso a esta marca no Cosmos."
        }
      },
      {
        "status": 404,
        "description": "NOT_FOUND: não há solicitação de reembolso deste pedido nesta marca (raw nem fila).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "NOT_FOUND"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "NOT_FOUND",
          "message": "Nenhuma solicitação de reembolso deste pedido."
        }
      },
      {
        "status": 422,
        "description": "ALREADY_EXECUTED (realizado): o Metabase ou a planilha já marca Realizado; nada foi alterado e repetir não muda. Mensagens: a do exemplo ou \"A planilha já marca este reembolso como Realizado: nada foi alterado. Use \\\"Atualizar acompanhamento\\\" para levar o Realizado da planilha ao Metabase.\"",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "ALREADY_EXECUTED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz onde consta o Realizado."
          }
        ],
        "example": {
          "code": "ALREADY_EXECUTED",
          "message": "O reembolso já foi executado: não dá mais para alterar."
        }
      },
      {
        "status": 422,
        "description": "ALREADY_EXECUTED (já cancelada): se a planilha ainda não marcava Cancelado, ela é reescrita e a mensagem diz o resultado; com a planilha falhando vem também o reason. Não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "ALREADY_EXECUTED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"A solicitação mais recente deste pedido já está cancelada: não dá mais para alterar.\", às vezes seguida de \"A planilha foi atualizada para Cancelado.\" ou \"A planilha não foi atualizada (<detalhe>): ajuste à mão.\""
          },
          {
            "name": "reason",
            "type": "string",
            "required": false,
            "description": "Só quando a reescrita da planilha falhou.",
            "enum": [
              "SHEET_WRITE_FAILED",
              "SHEET_ROW_NOT_FOUND"
            ]
          }
        ],
        "example": {
          "code": "ALREADY_EXECUTED",
          "message": "A solicitação mais recente deste pedido já está cancelada: não dá mais para alterar. A planilha foi atualizada para Cancelado."
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: o app está sem a URL do Cosmos (COSMOS_API_URL); configuração, repetir não resolve.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Cosmos API URL não configurada."
        }
      },
      {
        "status": 502,
        "description": "UNKNOWN_ERROR: o Cosmos respondeu algo inesperado (ou a rede falhou) ao conferir o token; nada foi alterado, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível conferir o token no Cosmos."
        }
      },
      {
        "status": 502,
        "description": "UNKNOWN_ERROR: a consulta da solicitação (raw ou fila) falhou; nada foi alterado, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível consultar a solicitação. Nada foi alterado."
        }
      },
      {
        "status": 502,
        "description": "SHEETS_ERROR: a fila recusou a alteração; nada foi guardado nem a planilha tocada, pode repetir (se o motivo for \"fora do contrato da DAG\", repetir dá o mesmo).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível registrar a alteração (<motivo da fila>).\""
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "Não foi possível registrar a alteração (a fila respondeu HTTP 400 INVALID_REQUEST)."
        }
      },
      {
        "status": 503,
        "description": "UNKNOWN_ERROR: falta configuração do app (fila ou planilhas); recusado antes de consultar, nada alterado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível cancelar o reembolso (<o que falta>) — nada foi alterado. Tente novamente.\""
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível cancelar o reembolso (as planilhas não estão configuradas (GOOGLE_PLANILHAS_EMAIL, GOOGLE_PLANILHAS_TOKEN e SHEETS_ENV)) — nada foi alterado. Tente novamente."
        }
      },
      {
        "status": 504,
        "description": "API_TIMEOUT: o Cosmos demorou para conferir o token (\"O Cosmos demorou para conferir o token.\", nada alterado) ou a entrada na fila ficou incerta (mensagem do exemplo, planilha não tocada); nos dois casos pode repetir, e repetir não duplica.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "API_TIMEOUT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "API_TIMEOUT",
          "message": "Não deu para confirmar a entrada da alteração na fila do Metabase (a fila respondeu HTTP 502). A planilha não foi atualizada. Repita a ação: repetir não duplica a alteração."
        }
      }
    ],
    "notes": [
      "O token do Cosmos vai no x-cosmos-token, com ou sem \"Bearer \"; sem ele a rota responde 401 antes de ler o corpo.",
      "Ordem das conferências: x-cosmos-token, corpo, token no Cosmos (GET /organizations/{org da marca}/carriers?per_page=1, com o TIMEOUT do app, padrão 10 s), configuração, solicitação, travas, fila e planilha.",
      "Corpo estrito: campo fora de brand, ecommerceOrderId, handledBy e reason dá 400.",
      "As marcas sem Cosmos (apice, yenzah, denavita, gobeaute) não são aceitas aqui: 400 \"Marca inválida\".",
      "O alvo é o reembolso mais recente do pedido, achado pelos dígitos do número, na raw ou ainda na fila; um caso de agora pode ser cancelado antes de o lote rodar.",
      "A planilha vence: se ela marca Realizado, nada é alterado (422); planilha fora do ar ou sem a linha não bloqueia o cancelamento.",
      "Pior caso calculado no código para a gestão ≈ 92,5 s; a rota declara maxDuration de 120 s.",
      "Exceção não tratada vira 500 {\"code\": \"UNKNOWN_ERROR\", \"message\": \"Erro interno. Veja o log do app.\"} (roteador); método diferente de POST, 405 METHOD_NOT_ALLOWED."
    ],
    "sources": [
      "cxhub/app/api/refund/cancel/route.ts",
      "cxhub/modules/reembolsos/actions/refundManagement.ts",
      "cxhub/modules/reembolsos/actions/refundAcesso.ts",
      "cxhub/modules/reembolsos/actions/refundGold.ts",
      "cxhub/modules/reembolsos/actions/refundGestaoComum.ts",
      "cxhub/modules/reembolsos/actions/refundGestaoDeps.ts",
      "cxhub/modules/reembolsos/types/management.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "cxhub/shared/lib/backendDireto.ts",
      "cxhub/shared/lib/fila/client.ts",
      "cxhub/shared/lib/fila/estado.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-refund-management.test.ts",
      "cxhub/__tests__/reembolsos/refundGold.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/refund/update",
    "tag": "Reembolso",
    "summary": "Edita valor e motivo do reembolso mais recente de um pedido",
    "description": "Confere o token do Cosmos, acha a solicitação de reembolso mais recente do pedido (raw ou fila), entrega o novo valor e/ou motivo à fila do Metabase e, depois de ela aceitar, reescreve as colunas na planilha da marca. As observações são aceitas no corpo, mas não são mais guardadas.",
    "routeHeader": "x-cosmos-token",
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca; só as 6 do Cosmos (maiúsculas e espaços nas pontas são aceitos).",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria"
          ]
        },
        {
          "name": "ecommerceOrderId",
          "type": "string",
          "required": true,
          "description": "Número do pedido da solicitação: letras, dígitos, \"#\" e \"-\", até 40 caracteres e com algum dígito."
        },
        {
          "name": "handledBy",
          "type": "string",
          "required": true,
          "description": "Agente que edita; obrigatório, mas só vai ao log."
        },
        {
          "name": "changes",
          "type": "object",
          "required": true,
          "description": "O que editar: pelo menos um dos três campos abaixo, e nenhum outro."
        },
        {
          "name": "changes.refundAmount",
          "type": "number",
          "required": "condicional",
          "description": "Novo valor em reais, maior que zero; obrigatório se refundReason não vier."
        },
        {
          "name": "changes.refundReason",
          "type": "string",
          "required": "condicional",
          "description": "Novo motivo, não vazio; obrigatório se refundAmount não vier."
        },
        {
          "name": "changes.notes",
          "type": "string",
          "required": false,
          "description": "Aceito, mas não é guardado; sozinho dá 422."
        }
      ],
      "example": {
        "brand": "lescent",
        "ecommerceOrderId": "SH9000105LC",
        "handledBy": "Ana Souza",
        "changes": {
          "refundAmount": 59.9,
          "refundReason": "Extravio"
        }
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "SUCCESS: a alteração entrou na fila e a planilha foi atualizada; com notes no corpo, a mensagem avisa que as observações não são guardadas.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Reembolso atualizado.\", às vezes com \" As observações não são mais guardadas.\", e o aviso do lote."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Reembolso atualizado. O Metabase recebe no próximo lote (até 20 min)."
        }
      },
      {
        "status": 200,
        "description": "SUCCESS com reason: a alteração entrou na fila, mas a planilha não acompanhou (ou só em parte, se faltou uma coluna); acerte a planilha à mão, o suporte é avisado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que falhou na planilha."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "SHEET_ROW_NOT_FOUND: a linha do caso não está na planilha; SHEET_WRITE_FAILED: a planilha não respondeu ou falta a coluna.",
            "enum": [
              "SHEET_WRITE_FAILED",
              "SHEET_ROW_NOT_FOUND"
            ]
          }
        ],
        "example": {
          "code": "SUCCESS",
          "reason": "SHEET_WRITE_FAILED",
          "message": "Reembolso atualizado na fila do Metabase, mas a planilha não foi atualizada (a planilha não respondeu). Atualize a planilha à mão."
        }
      },
      {
        "status": 400,
        "description": "INVALID_REQUEST: corpo inválido; nada foi consultado. Além das mensagens comuns (\"Corpo da requisição inválido.\", \"Campo desconhecido: <campos>.\", \"Marca inválida: <marca>.\", \"Informe ecommerceOrderId (número do pedido da solicitação).\", \"Informe handledBy (agente responsável).\"), há: \"Informe changes com refundAmount, refundReason ou notes.\", \"Campo não editável: <campos>. Só refundAmount, refundReason e notes podem ser editados.\", \"refundAmount deve ser um número maior que zero.\", \"refundReason deve ser texto não vazio.\", \"notes deve ser texto.\" e \"Nada para editar: informe refundAmount, refundReason ou notes.\"",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "INVALID_REQUEST"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "O primeiro problema encontrado."
          }
        ],
        "example": {
          "code": "INVALID_REQUEST",
          "message": "Campo não editável: refundScope. Só refundAmount, refundReason e notes podem ser editados."
        }
      },
      {
        "status": 401,
        "description": "UNAUTHORIZED: sem x-cosmos-token (\"Header Authorization ausente.\", antes de ler o corpo) ou token recusado pelo Cosmos (\"Token do Cosmos inválido ou expirado.\").",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNAUTHORIZED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Header Authorization ausente."
        }
      },
      {
        "status": 403,
        "description": "FORBIDDEN: o token não tem acesso à organização da marca no Cosmos.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "FORBIDDEN"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "FORBIDDEN",
          "message": "O token não tem acesso a esta marca no Cosmos."
        }
      },
      {
        "status": 404,
        "description": "NOT_FOUND: não há solicitação de reembolso deste pedido nesta marca.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "NOT_FOUND"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "NOT_FOUND",
          "message": "Nenhuma solicitação de reembolso deste pedido."
        }
      },
      {
        "status": 422,
        "description": "INVALID_REQUEST: changes trouxe só notes; nada foi alterado (vem depois da conferência do token).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "INVALID_REQUEST"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "INVALID_REQUEST",
          "message": "As observações não são mais guardadas: nada foi alterado."
        }
      },
      {
        "status": 422,
        "description": "ALREADY_EXECUTED: o reembolso já foi realizado (no Metabase ou na planilha) ou a solicitação já está cancelada; nada foi alterado. Mensagens: a do exemplo, \"A planilha já marca este reembolso como Realizado: nada foi alterado. Use \\\"Atualizar acompanhamento\\\" para levar o Realizado da planilha ao Metabase.\" ou \"A solicitação mais recente deste pedido já está cancelada: não dá mais para alterar.\"",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "ALREADY_EXECUTED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que trava a edição."
          }
        ],
        "example": {
          "code": "ALREADY_EXECUTED",
          "message": "O reembolso já foi executado: não dá mais para alterar."
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: o app está sem a URL do Cosmos (COSMOS_API_URL).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Cosmos API URL não configurada."
        }
      },
      {
        "status": 502,
        "description": "UNKNOWN_ERROR: falha ao conferir o token no Cosmos (\"Não foi possível conferir o token no Cosmos.\") ou ao consultar a solicitação (exemplo); nada alterado, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível consultar a solicitação. Nada foi alterado."
        }
      },
      {
        "status": 502,
        "description": "SHEETS_ERROR: a fila recusou a alteração; nada foi guardado nem a planilha tocada, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível registrar a alteração (<motivo da fila>).\""
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "Não foi possível registrar a alteração (a fila respondeu HTTP 400 INVALID_REQUEST)."
        }
      },
      {
        "status": 503,
        "description": "UNKNOWN_ERROR: falta configuração do app (fila ou planilhas); nada alterado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível editar o reembolso (<o que falta>) — nada foi alterado. Tente novamente.\""
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível editar o reembolso (a fila do Metabase não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)) — nada foi alterado. Tente novamente."
        }
      },
      {
        "status": 504,
        "description": "API_TIMEOUT: o Cosmos demorou para conferir o token (\"O Cosmos demorou para conferir o token.\") ou a entrada na fila ficou incerta (exemplo, planilha não tocada); pode repetir, repetir não duplica.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "API_TIMEOUT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "API_TIMEOUT",
          "message": "Não deu para confirmar a entrada da alteração na fila do Metabase (a fila respondeu HTTP 502). A planilha não foi atualizada. Repita a ação: repetir não duplica a alteração."
        }
      }
    ],
    "notes": [
      "O token do Cosmos vai no x-cosmos-token, com ou sem \"Bearer \"; sem ele a rota responde 401 antes de ler o corpo.",
      "Corpo estrito, no topo e em changes: campo desconhecido dá 400, para um nome errado não virar sucesso sem mudar nada.",
      "Só as 6 marcas do Cosmos; as sem Cosmos dão 400 \"Marca inválida\".",
      "O alvo é o reembolso mais recente do pedido, achado pelos dígitos do número, na raw ou ainda na fila.",
      "Na planilha o valor vai como número e o motivo como texto; se o cabeçalho não tiver uma das colunas, a outra é escrita e a resposta traz SHEET_WRITE_FAILED.",
      "A edição não reescreve a planilha de um caso cancelado: só responde 422.",
      "Exceção não tratada vira 500 {\"code\": \"UNKNOWN_ERROR\", \"message\": \"Erro interno. Veja o log do app.\"} (roteador); método diferente de POST, 405 METHOD_NOT_ALLOWED."
    ],
    "sources": [
      "cxhub/app/api/refund/update/route.ts",
      "cxhub/modules/reembolsos/actions/refundManagement.ts",
      "cxhub/modules/reembolsos/actions/refundAcesso.ts",
      "cxhub/modules/reembolsos/actions/refundGold.ts",
      "cxhub/modules/reembolsos/actions/refundGestaoComum.ts",
      "cxhub/modules/reembolsos/actions/refundGestaoDeps.ts",
      "cxhub/modules/reembolsos/types/management.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-refund-management.test.ts",
      "cxhub/__tests__/reembolsos/refundGold.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/refund/complete",
    "tag": "Reembolso",
    "summary": "Marca um reembolso como concluído (Realizado)",
    "description": "Confere o token do Cosmos, acha o caso pelo idSolicitacao (raw ou fila; tem de ser REEMBOLSO da marca do corpo), entrega Realizado com a data de hoje (fuso de São Paulo) e o agente como responsável à fila do Metabase e, depois de ela aceitar, grava status, data e responsável na planilha da marca. Não passa por cima de um Realizado ou de um Cancelado já registrado.",
    "routeHeader": "x-cosmos-token",
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca; só as 6 do Cosmos (maiúsculas e espaços nas pontas são aceitos).",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria"
          ]
        },
        {
          "name": "idSolicitacao",
          "type": "string (UUID)",
          "required": true,
          "description": "Id do caso, como o /api/refund/submit e a lista de solicitações devolvem."
        },
        {
          "name": "handledBy",
          "type": "string",
          "required": true,
          "description": "Agente que conclui; vira o responsável da execução no Metabase e na planilha."
        }
      ],
      "example": {
        "brand": "lescent",
        "idSolicitacao": "6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f",
        "handledBy": "Ana Souza"
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "SUCCESS: o Realizado entrou na fila e a planilha foi atualizada.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Texto para o agente."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Reembolso marcado como concluído. O Metabase recebe no próximo lote (até 20 min)."
        }
      },
      {
        "status": 200,
        "description": "SUCCESS com reason: o Realizado entrou na fila, mas a planilha não acompanhou; acerte à mão (o suporte é avisado). Repetir responde 422 e tenta reescrever o Realizado na planilha.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que falhou na planilha."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "SHEET_ROW_NOT_FOUND: a linha do caso não está na planilha; SHEET_WRITE_FAILED: a planilha não respondeu ou falta coluna.",
            "enum": [
              "SHEET_WRITE_FAILED",
              "SHEET_ROW_NOT_FOUND"
            ]
          }
        ],
        "example": {
          "code": "SUCCESS",
          "reason": "SHEET_ROW_NOT_FOUND",
          "message": "Reembolso concluído na fila do Metabase, mas a planilha não foi atualizada (a linha do caso não está na planilha). Atualize a planilha à mão."
        }
      },
      {
        "status": 400,
        "description": "INVALID_REQUEST: corpo inválido; nada foi consultado. Mensagens: \"Corpo da requisição inválido.\", \"Campo desconhecido: <campos>.\", \"Marca inválida: <marca>.\", \"Informe idSolicitacao (o id da solicitação, um UUID, como a lista devolve).\", \"Informe handledBy (agente responsável).\"",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "INVALID_REQUEST"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "O primeiro problema encontrado."
          }
        ],
        "example": {
          "code": "INVALID_REQUEST",
          "message": "Informe idSolicitacao (o id da solicitação, um UUID, como a lista devolve)."
        }
      },
      {
        "status": 401,
        "description": "UNAUTHORIZED: sem x-cosmos-token (\"Header Authorization ausente.\", antes de ler o corpo) ou token recusado pelo Cosmos (\"Token do Cosmos inválido ou expirado.\").",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNAUTHORIZED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Token do Cosmos inválido ou expirado."
        }
      },
      {
        "status": 403,
        "description": "FORBIDDEN: o token não tem acesso à organização da marca no Cosmos.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "FORBIDDEN"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "FORBIDDEN",
          "message": "O token não tem acesso a esta marca no Cosmos."
        }
      },
      {
        "status": 404,
        "description": "NOT_FOUND: o id não é de um reembolso desta marca (não existe, ou é de reenvio, cancelamento ou outra marca); nada alterado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "NOT_FOUND"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "NOT_FOUND",
          "message": "Nenhuma solicitação de reembolso com este id nesta marca. Nada foi alterado."
        }
      },
      {
        "status": 422,
        "description": "ALREADY_EXECUTED (já Realizado no Metabase): se a planilha ainda não marcava Realizado, ela é reescrita com a data e o responsável do caso e a mensagem diz o resultado (com reason se falhou); se a planilha marca Cancelado, nada muda e a mensagem manda usar /api/refund/sync. Não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "ALREADY_EXECUTED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"O reembolso já foi marcado como realizado: não dá para concluir de novo.\", às vezes seguida de \"A planilha foi atualizada para Realizado.\" ou \"A planilha não foi atualizada (<detalhe>): ajuste à mão.\"; ou \"O Metabase consta como Realizado, mas a planilha marca Cancelado: nada foi alterado. Use \\\"Atualizar acompanhamento\\\" para levar o Cancelado da planilha ao Metabase.\""
          },
          {
            "name": "reason",
            "type": "string",
            "required": false,
            "description": "Só quando a reescrita da planilha falhou.",
            "enum": [
              "SHEET_WRITE_FAILED",
              "SHEET_ROW_NOT_FOUND"
            ]
          }
        ],
        "example": {
          "code": "ALREADY_EXECUTED",
          "message": "O reembolso já foi marcado como realizado: não dá para concluir de novo. A planilha foi atualizada para Realizado."
        }
      },
      {
        "status": 422,
        "description": "ALREADY_EXECUTED (travado): a planilha já marca Realizado (\"A planilha já marca este reembolso como Realizado: nada foi alterado. Use \\\"Atualizar acompanhamento\\\" para levar o Realizado da planilha ao Metabase.\") ou o caso está cancelado (exemplo); nada alterado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "ALREADY_EXECUTED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Diz o que trava."
          }
        ],
        "example": {
          "code": "ALREADY_EXECUTED",
          "message": "A solicitação já está cancelada: não dá para marcá-la como concluída."
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: o app está sem a URL do Cosmos (COSMOS_API_URL).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Cosmos API URL não configurada."
        }
      },
      {
        "status": 502,
        "description": "UNKNOWN_ERROR: falha ao conferir o token no Cosmos (\"Não foi possível conferir o token no Cosmos.\") ou ao consultar o caso (exemplo); nada alterado, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível consultar a solicitação. Nada foi alterado."
        }
      },
      {
        "status": 502,
        "description": "SHEETS_ERROR: a fila recusou o Realizado; nada guardado nem a planilha tocada, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível registrar a alteração (<motivo da fila>).\""
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "Não foi possível registrar a alteração (a fila respondeu HTTP 400 INVALID_REQUEST)."
        }
      },
      {
        "status": 503,
        "description": "UNKNOWN_ERROR: falta configuração do app (fila ou planilhas); nada alterado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível concluir o reembolso (<o que falta>) — nada foi alterado. Tente novamente.\""
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível concluir o reembolso (as planilhas não estão configuradas (GOOGLE_PLANILHAS_EMAIL, GOOGLE_PLANILHAS_TOKEN e SHEETS_ENV)) — nada foi alterado. Tente novamente."
        }
      },
      {
        "status": 504,
        "description": "API_TIMEOUT: o Cosmos demorou para conferir o token (\"O Cosmos demorou para conferir o token.\") ou a entrada na fila ficou incerta (exemplo, planilha não tocada); pode repetir, repetir não duplica.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "API_TIMEOUT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "API_TIMEOUT",
          "message": "Não deu para confirmar a entrada da alteração na fila do Metabase (a fila respondeu HTTP 502). A planilha não foi atualizada. Repita a ação: repetir não duplica a alteração."
        }
      }
    ],
    "notes": [
      "O token do Cosmos vai no x-cosmos-token, com ou sem \"Bearer \"; sem ele a rota responde 401 antes de ler o corpo.",
      "Corpo estrito: só brand, idSolicitacao e handledBy; o idSolicitacao tem de ser UUID (8-4-4-4-12 hexadecimal), não o número do pedido.",
      "Só as 6 marcas do Cosmos; as sem Cosmos dão 400 \"Marca inválida\".",
      "A data de execução gravada é a de hoje no fuso de São Paulo (dd/mm/aaaa).",
      "A planilha vence: um Realizado marcado nela trava a conclusão; planilha fora do ar ou sem a linha não bloqueia.",
      "Pelo código, com o caso ainda aberto no Metabase, um Cancelado que só a planilha marca não impede a conclusão: o Realizado é enfileirado e escrito por cima na planilha.",
      "Exceção não tratada vira 500 {\"code\": \"UNKNOWN_ERROR\", \"message\": \"Erro interno. Veja o log do app.\"} (roteador); método diferente de POST, 405 METHOD_NOT_ALLOWED."
    ],
    "sources": [
      "cxhub/app/api/refund/complete/route.ts",
      "cxhub/modules/reembolsos/actions/refundManagement.ts",
      "cxhub/modules/reembolsos/actions/refundAcesso.ts",
      "cxhub/modules/reembolsos/actions/refundExecucao.ts",
      "cxhub/modules/reembolsos/actions/refundGestaoComum.ts",
      "cxhub/modules/reembolsos/actions/refundGestaoDeps.ts",
      "cxhub/modules/reembolsos/types/management.ts",
      "cxhub/shared/lib/format.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-refund-execution.test.ts",
      "cxhub/__tests__/reembolsos/refundExecucao.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/refund/sync",
    "tag": "Reembolso",
    "summary": "Leva ao Metabase o que o backoffice marcou na planilha",
    "description": "Confere o token do Cosmos, acha o caso pelo idSolicitacao (raw ou fila; REEMBOLSO da marca do corpo), lê na planilha da marca o status, a data e o responsável da execução e, se ela marca Realizado ou Cancelado diferente do Metabase, entrega isso à fila do Metabase. Não escreve na planilha; sem mudança, não enfileira nada.",
    "routeHeader": "x-cosmos-token",
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca; só as 6 do Cosmos (maiúsculas e espaços nas pontas são aceitos).",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria"
          ]
        },
        {
          "name": "idSolicitacao",
          "type": "string (UUID)",
          "required": true,
          "description": "Id do caso, como o /api/refund/submit e a lista de solicitações devolvem."
        },
        {
          "name": "handledBy",
          "type": "string",
          "required": true,
          "description": "Agente que pediu a atualização; obrigatório, mas só vai ao log (o responsável enviado é o da planilha)."
        }
      ],
      "example": {
        "brand": "lescent",
        "idSolicitacao": "6f1c0e2a-1111-4c2b-9d3e-0a1b2c3d4e5f",
        "handledBy": "Ana Souza"
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "SUCCESS: o Realizado (com data e responsável, quando a planilha tem) ou o Cancelado da planilha entrou na fila.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Acompanhamento atualizado: <Realizado|Cancelado> (execução em <data> por <responsável>) foi para a fila do Metabase.\" e o aviso do lote; os parênteses só levam o que a planilha tem."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Acompanhamento atualizado: Realizado (execução em 25/10/2026 por Bia Lima) foi para a fila do Metabase. O Metabase recebe no próximo lote (até 20 min)."
        }
      },
      {
        "status": 200,
        "description": "NO_CHANGE: a planilha não marca Realizado nem Cancelado (Pendente, vazio ou outro texto), ou o Metabase já consta com o mesmo status; nada enfileirado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "NO_CHANGE"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "A do exemplo ou \"O Metabase já consta como <Realizado|Cancelado>: nada a atualizar.\""
          }
        ],
        "example": {
          "code": "NO_CHANGE",
          "message": "A planilha ainda não marca o reembolso como Realizado nem como Cancelado: nada para levar ao Metabase."
        }
      },
      {
        "status": 400,
        "description": "INVALID_REQUEST: corpo inválido; nada foi consultado. Mensagens: \"Corpo da requisição inválido.\", \"Campo desconhecido: <campos>.\", \"Marca inválida: <marca>.\", \"Informe idSolicitacao (o id da solicitação, um UUID, como a lista devolve).\", \"Informe handledBy (agente responsável).\"",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "INVALID_REQUEST"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "O primeiro problema encontrado."
          }
        ],
        "example": {
          "code": "INVALID_REQUEST",
          "message": "Campo desconhecido: ecommerceOrderId."
        }
      },
      {
        "status": 401,
        "description": "UNAUTHORIZED: sem x-cosmos-token (\"Header Authorization ausente.\", antes de ler o corpo) ou token recusado pelo Cosmos (\"Token do Cosmos inválido ou expirado.\").",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNAUTHORIZED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Header Authorization ausente."
        }
      },
      {
        "status": 403,
        "description": "FORBIDDEN: o token não tem acesso à organização da marca no Cosmos.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "FORBIDDEN"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "FORBIDDEN",
          "message": "O token não tem acesso a esta marca no Cosmos."
        }
      },
      {
        "status": 404,
        "description": "NOT_FOUND sem reason: o id não é de um reembolso desta marca; nada alterado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "NOT_FOUND"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "NOT_FOUND",
          "message": "Nenhuma solicitação de reembolso com este id nesta marca. Nada foi alterado."
        }
      },
      {
        "status": 404,
        "description": "NOT_FOUND com reason SHEET_ROW_NOT_FOUND: o caso existe, mas a linha dele não está na planilha (pedido + carimbo a até 2 min do criado_em); nada alterado, o suporte é avisado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "NOT_FOUND"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "A linha do caso não foi achada na planilha.",
            "enum": [
              "SHEET_ROW_NOT_FOUND"
            ]
          }
        ],
        "example": {
          "code": "NOT_FOUND",
          "message": "A linha deste caso não está na planilha. Nada foi alterado.",
          "reason": "SHEET_ROW_NOT_FOUND"
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: o app está sem a URL do Cosmos (COSMOS_API_URL).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Cosmos API URL não configurada."
        }
      },
      {
        "status": 502,
        "description": "UNKNOWN_ERROR: falha ao conferir o token no Cosmos (\"Não foi possível conferir o token no Cosmos.\") ou ao consultar o caso (exemplo); nada alterado, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível consultar a solicitação. Nada foi alterado."
        }
      },
      {
        "status": 502,
        "description": "SHEETS_ERROR com reason SHEET_READ_FAILED: não deu para ler a planilha (exemplo) ou o cabeçalho não tem as colunas de status, data ou responsável (\"O cabeçalho da planilha não tem a coluna \\\"Status do reembolso\\\". Nada foi alterado.\"); nada alterado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "A planilha, que aqui é a fonte, não pôde ser lida.",
            "enum": [
              "SHEET_READ_FAILED"
            ]
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "reason": "SHEET_READ_FAILED",
          "message": "Não foi possível ler a planilha. Nada foi alterado."
        }
      },
      {
        "status": 502,
        "description": "SHEETS_ERROR sem reason: a fila recusou a alteração; nada guardado, pode repetir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SHEETS_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível registrar a alteração (<motivo da fila>).\""
          }
        ],
        "example": {
          "code": "SHEETS_ERROR",
          "message": "Não foi possível registrar a alteração (a fila respondeu HTTP 400 INVALID_REQUEST)."
        }
      },
      {
        "status": 503,
        "description": "UNKNOWN_ERROR: falta configuração do app (fila ou planilhas); nada alterado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Não foi possível atualizar o acompanhamento (<o que falta>) — nada foi alterado. Tente novamente.\""
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível atualizar o acompanhamento (a fila do Metabase não está configurada (CXHUB_FILA_URL e CXHUB_FILA_TOKEN)) — nada foi alterado. Tente novamente."
        }
      },
      {
        "status": 504,
        "description": "API_TIMEOUT: o Cosmos demorou para conferir o token (\"O Cosmos demorou para conferir o token.\") ou a entrada na fila ficou incerta (exemplo); pode repetir, repetir não duplica.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "API_TIMEOUT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "API_TIMEOUT",
          "message": "Não deu para confirmar a entrada da alteração na fila do Metabase (a fila respondeu HTTP 502). Repita a ação: repetir não duplica a alteração."
        }
      }
    ],
    "notes": [
      "O token do Cosmos vai no x-cosmos-token, com ou sem \"Bearer \"; sem ele a rota responde 401 antes de ler o corpo.",
      "Corpo estrito: só brand, idSolicitacao (UUID) e handledBy.",
      "Só as 6 marcas do Cosmos; as sem Cosmos dão 400 \"Marca inválida\".",
      "A planilha vence: Realizado ou Cancelado dela vai à fila mesmo que o Metabase diga outra coisa; Pendente e texto livre nunca vão.",
      "Com Cancelado a data não vai; com Realizado, a data só vai se a célula for data válida (dd/mm/aaaa, aaaa-mm-dd ou serial do Sheets).",
      "Esta rota não tem 422: não há trava, só NO_CHANGE.",
      "Exceção não tratada vira 500 {\"code\": \"UNKNOWN_ERROR\", \"message\": \"Erro interno. Veja o log do app.\"} (roteador); método diferente de POST, 405 METHOD_NOT_ALLOWED."
    ],
    "sources": [
      "cxhub/app/api/refund/sync/route.ts",
      "cxhub/modules/reembolsos/actions/refundManagement.ts",
      "cxhub/modules/reembolsos/actions/refundAcesso.ts",
      "cxhub/modules/reembolsos/actions/refundExecucao.ts",
      "cxhub/modules/reembolsos/actions/refundGestaoComum.ts",
      "cxhub/modules/reembolsos/actions/refundGestaoDeps.ts",
      "cxhub/modules/reembolsos/actions/refundSheetColumns.ts",
      "cxhub/modules/reembolsos/types/management.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-refund-execution.test.ts",
      "cxhub/__tests__/reembolsos/refundExecucao.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/cancellation/submit",
    "tag": "Cancelamento",
    "summary": "Registra uma solicitação de cancelamento",
    "description": "Entrega o caso CANCELAMENTO à fila do Metabase (o lote o leva à gold em até 20 min) e, só depois, grava a linha na planilha de cancelamento da marca. Sem dedup: cada chamada aceita cria um caso e uma linha novos.",
    "routeHeader": null,
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca; só as 6 do Cosmos, exatamente em minúsculas (sem normalização).",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria"
          ]
        },
        {
          "name": "data",
          "type": "object",
          "required": true,
          "description": "Os dados do cancelamento, com as chaves em português como abaixo."
        },
        {
          "name": "data.Número do pedido (Shopify)",
          "type": "string",
          "required": true,
          "description": "Número do pedido; sem ele a fila recusa o caso (500)."
        },
        {
          "name": "data.Responsável",
          "type": "string",
          "required": false,
          "description": "Agente responsável; com o valor exato \"Bot\", a tratativa vira sempre Reembolso."
        },
        {
          "name": "data.Nome do(a) cliente",
          "type": "string",
          "required": false,
          "description": "Nome do cliente; vai só para a planilha."
        },
        {
          "name": "data.Observações",
          "type": "string",
          "required": false,
          "description": "Observações; vão só para a planilha."
        },
        {
          "name": "data.Número da NF",
          "type": "string",
          "required": false,
          "description": "Número da NF do pedido."
        },
        {
          "name": "data.CD de origem",
          "type": "string",
          "required": false,
          "description": "CD de origem do pedido."
        },
        {
          "name": "data.Tratativa",
          "type": "string",
          "required": false,
          "description": "Tratativa que acompanha o cancelamento; outro valor vai só para a planilha e fica fora do caso.",
          "enum": [
            "Reenvio",
            "Reembolso"
          ]
        },
        {
          "name": "data.Status",
          "type": "string",
          "required": false,
          "description": "Aceito e ignorado: não chega à fila nem à planilha."
        },
        {
          "name": "data.Local da Tratativa",
          "type": "string",
          "required": false,
          "description": "Aceito e ignorado: não chega à fila nem à planilha."
        },
        {
          "name": "data.brand",
          "type": "string",
          "required": false,
          "description": "Ignorado: vale o brand de fora."
        }
      ],
      "example": {
        "brand": "lescent",
        "data": {
          "brand": "lescent",
          "Responsável": "Ana Souza",
          "Nome do(a) cliente": "Cliente Exemplo",
          "Número do pedido (Shopify)": "SH9000105LC",
          "Observações": "Cliente pediu o cancelamento pelo chat",
          "Número da NF": "123456",
          "CD de origem": "Unilog SP",
          "Status": "Solicitar na transportadora",
          "Local da Tratativa": "Transportador",
          "Tratativa": "Reembolso"
        }
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "SUCCESS: o caso entrou na fila e a linha na planilha. Não repita (não há dedup).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          },
          {
            "name": "idSolicitacao",
            "type": "string (UUID)",
            "required": true,
            "description": "Id do caso CANCELAMENTO entregue à fila."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "Cancelamento registrado com sucesso",
          "idSolicitacao": "3b8e2d1c-5a4f-4e6b-9c7d-2f1a0b9c8d7e"
        }
      },
      {
        "status": 200,
        "description": "UNKNOWN_ERROR com reason SHEET_WRITE_FAILED: o caso entrou (ou pode ter entrado) na fila, mas a planilha falhou; o cancelamento ESTÁ registrado, NÃO repita (o suporte é avisado).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"O cancelamento entrou na fila do Metabase, mas ...\" ou \"O cancelamento pode ter entrado na fila do Metabase (<motivo>), mas ...\", terminando em \"NÃO repita a solicitação.\""
          },
          {
            "name": "reason",
            "type": "string",
            "required": true,
            "description": "Distingue este caso (registrado) dos UNKNOWN_ERROR em que nada foi gravado.",
            "enum": [
              "SHEET_WRITE_FAILED"
            ]
          },
          {
            "name": "idSolicitacao",
            "type": "string (UUID)",
            "required": true,
            "description": "Id do caso entregue à fila."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "O cancelamento entrou na fila do Metabase, mas a planilha não foi atualizada. NÃO repita a solicitação.",
          "reason": "SHEET_WRITE_FAILED",
          "idSolicitacao": "3b8e2d1c-5a4f-4e6b-9c7d-2f1a0b9c8d7e"
        }
      },
      {
        "status": 504,
        "description": "API_TIMEOUT: a linha foi gravada na planilha, mas a entrada na fila não pôde ser confirmada; NÃO repita, avise o suporte.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "API_TIMEOUT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Explica a incerteza com o motivo da fila."
          },
          {
            "name": "idSolicitacao",
            "type": "string (UUID)",
            "required": true,
            "description": "Id do caso que pode estar na fila."
          }
        ],
        "example": {
          "code": "API_TIMEOUT",
          "message": "O cancelamento foi registrado na planilha, mas não deu para confirmar a entrada na fila do Metabase (a fila respondeu HTTP 502). NÃO repita a solicitação: avise o suporte.",
          "idSolicitacao": "3b8e2d1c-5a4f-4e6b-9c7d-2f1a0b9c8d7e"
        }
      },
      {
        "status": 400,
        "description": "UNKNOWN_ERROR: falta brand ou data (\"Missing brand or data\") ou a marca não é uma das 6 (\"Invalid brand: <valor>\"); nada registrado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Invalid brand: apice"
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: falta configuração do app (fila ou planilhas) ou a fila recusou o caso (ex.: sem número do pedido); nada foi gravado, pode repetir depois de corrigir.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"Erro ao registrar o cancelamento (<o que falta ou motivo da fila>).\""
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Erro ao registrar o cancelamento (fora do contrato da DAG: sem numero_pedido)."
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: corpo que não é JSON ou exceção inesperada antes do registro.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Resultado.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível se conectar ao sistema."
        }
      }
    ],
    "notes": [
      "Sem dedup: depois de SUCCESS, API_TIMEOUT ou SHEET_WRITE_FAILED, repetir cria outro caso e outra linha.",
      "Decida pelo code e pelo reason: o UNKNOWN_ERROR com reason SHEET_WRITE_FAILED vem com 200 e significa registrado.",
      "A rota só confere brand e data; os campos de data não são validados um a um, e o único que barra é o número do pedido (a fila recusa sem ele). Campo ausente vira célula vazia na planilha.",
      "Status e Local da Tratativa são ignorados; a planilha da Lescent recebe nessas colunas os valores fixos \"Solicitar na  transportadora\" (com espaço duplo) e \"Transportador\".",
      "Tratativa vai à fila só como Reenvio ou Reembolso (sem diferenciar maiúsculas); nome do cliente e observações nunca vão à fila.",
      "Só brand e data são lidos no topo (ex.: assincrono é ignorado); não há testMode.",
      "Pior caso calculado no código ≈ 41 s (fila até 16 s + planilha até 25 s); a rota declara maxDuration de 120 s.",
      "Método diferente de POST responde 405 {\"code\": \"METHOD_NOT_ALLOWED\", \"message\": \"Use POST nesta rota.\"} (roteador)."
    ],
    "sources": [
      "cxhub/app/api/cancellation/submit/route.ts",
      "cxhub/shared/lib/cancellation/processCancellation.ts",
      "cxhub/shared/lib/cancellation/types.ts",
      "cxhub/shared/lib/cancellation/casoDoCancelamento.ts",
      "cxhub/shared/lib/cancellation/buildCancellationRow.ts",
      "cxhub/shared/lib/cancellation/buildCancellationPayload.ts",
      "cxhub/shared/lib/backendDireto.ts",
      "cxhub/shared/lib/fila/client.ts",
      "cxhub/shared/lib/airflow/contrato.ts",
      "cxhub/shared/lib/sheets/gravarLinha.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-cancellation-submit.test.ts",
      "cxhub/__tests__/shared/processCancellation.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/logistica/submit",
    "tag": "Logística",
    "summary": "Abre um ticket de logística no worker cx-ticketcreator",
    "description": "Confere orderId, issue e brand e repassa o corpo inteiro, com callerType = \"agent\", ao worker cx-ticketcreator (POST /gogroup-tickets-clind, com o segredo do app no x-webhook-secret). Devolve só o code normalizado e a message do worker; quem cria (ou recusa) o ticket é o worker.",
    "routeHeader": null,
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "orderId",
          "type": "string",
          "required": true,
          "description": "Número do pedido como a loja o mostra (o order_name)."
        },
        {
          "name": "issue",
          "type": "string",
          "required": true,
          "description": "Problema, no vocabulário do worker (sem acento); a rota não confere o valor.",
          "enum": [
            "Pedido Atrasado",
            "Acareacao",
            "Endereco Errado",
            "barra_entrega"
          ]
        },
        {
          "name": "brand",
          "type": "string",
          "required": true,
          "description": "Marca; só as 6 do Cosmos, exatamente em minúsculas.",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria"
          ]
        },
        {
          "name": "callerType",
          "type": "string",
          "required": false,
          "description": "Ignorado: a rota sempre envia \"agent\" ao worker.",
          "enum": [
            "agent"
          ]
        },
        {
          "name": "variables",
          "type": "object",
          "required": false,
          "description": "Repassado ao worker como veio; a rota não confere, e o formulário do CX Hub sempre envia."
        },
        {
          "name": "variables.executed_by",
          "type": "string",
          "required": false,
          "description": "Quem abriu o ticket; o CX Hub envia \"<nome do agente> — CXHub\"."
        },
        {
          "name": "variables.correct_address",
          "type": "object",
          "required": "condicional",
          "description": "Endereço corrigido; o CX Hub só envia quando issue é \"Endereco Errado\"."
        },
        {
          "name": "variables.correct_address.firstname",
          "type": "string",
          "required": "condicional",
          "description": "Primeiro nome do cliente (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.lastname",
          "type": "string",
          "required": "condicional",
          "description": "Sobrenome do cliente, vazio se não houver (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.address1",
          "type": "string",
          "required": "condicional",
          "description": "Logradouro (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.address2",
          "type": "string",
          "required": "condicional",
          "description": "Número (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.address3",
          "type": "string",
          "required": "condicional",
          "description": "Complemento (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.address4",
          "type": "string",
          "required": "condicional",
          "description": "Bairro (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.phone",
          "type": "string",
          "required": "condicional",
          "description": "Telefone do cliente (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.city",
          "type": "string",
          "required": "condicional",
          "description": "Cidade (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.zipcode",
          "type": "string",
          "required": "condicional",
          "description": "CEP só com dígitos (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.country_code",
          "type": "string",
          "required": "condicional",
          "description": "Valor fixo \"31\" enviado pelo CX Hub (vai sempre que correct_address vai).",
          "enum": [
            "31"
          ]
        },
        {
          "name": "variables.correct_address.state",
          "type": "string",
          "required": "condicional",
          "description": "Nome do estado por extenso, ex.: \"São Paulo\" (vai sempre que correct_address vai)."
        },
        {
          "name": "variables.correct_address.fullAddress",
          "type": "string",
          "required": "condicional",
          "description": "Endereço legível que o worker põe no e-mail à transportadora, campos separados por vírgula (vai sempre que correct_address vai)."
        }
      ],
      "example": {
        "orderId": "SH220183BB",
        "issue": "Endereco Errado",
        "brand": "kokeshi",
        "variables": {
          "executed_by": "Ana Souza — CXHub",
          "correct_address": {
            "firstname": "Cliente",
            "lastname": "Exemplo",
            "address1": "Rua das Flores",
            "address2": "120",
            "address3": "Apto 12",
            "address4": "Centro",
            "phone": "11900000000",
            "city": "São Paulo",
            "zipcode": "01001000",
            "country_code": "31",
            "state": "São Paulo",
            "fullAddress": "Rua das Flores, 120, Apto 12, Centro, São Paulo, São Paulo, 01001000"
          }
        }
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "Ticket criado pelo worker. Não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho do worker.",
            "enum": [
              "DELAY_TICKET_CREATED",
              "INVESTIGATION_CREATED",
              "ADDRESS_TICKET_CREATED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "A message do worker, como veio (\"\" se ele não mandar)."
          }
        ],
        "example": {
          "code": "DELAY_TICKET_CREATED",
          "message": "Ticket de atraso criado para o pedido SH220183BB."
        }
      },
      {
        "status": 200,
        "description": "Informativo, sem ticket novo: já existe ticket (TICKET_EXISTS), ticket já concluído (TICKET_COMPLETED), pedido no prazo (ORDER_ON_TIME) ou pedido ainda não enviado (ORDER_NOT_SENT, que o worker escreve \"ORDER NO SENT\"). Não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho do worker.",
            "enum": [
              "TICKET_EXISTS",
              "TICKET_COMPLETED",
              "ORDER_ON_TIME",
              "ORDER_NOT_SENT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "A message do worker, como veio."
          }
        ],
        "example": {
          "code": "ORDER_NOT_SENT",
          "message": "Pedido ainda não foi enviado"
        }
      },
      {
        "status": 200,
        "description": "Rejeitado por regra de negócio do worker; repetir com o mesmo corpo dá o mesmo resultado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho do worker.",
            "enum": [
              "INVESTIGATION_INVALID",
              "AVARIA_INVALID",
              "BARRA_ENTREGA_INVALID",
              "ADDRESS_MISSING"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "A message do worker, como veio."
          }
        ],
        "example": {
          "code": "ADDRESS_MISSING",
          "message": "Informe o endereço correto para abrir o ticket."
        }
      },
      {
        "status": 200,
        "description": "Escalação para atendimento humano: DELAY_ESCALATED, INVESTIGATION_EXPIRED, CARRIER_NOT_AUTOMATED, ou TICKET_DEADLINE_EXPIRED (o ESCALATE_TO_HUMAN do worker com ticket_id). Não repita.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho do worker.",
            "enum": [
              "DELAY_ESCALATED",
              "INVESTIGATION_EXPIRED",
              "CARRIER_NOT_AUTOMATED",
              "TICKET_DEADLINE_EXPIRED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "A message do worker, como veio."
          }
        ],
        "example": {
          "code": "TICKET_DEADLINE_EXPIRED",
          "message": "agente_instructions: escalar para atendimento humano"
        }
      },
      {
        "status": 200,
        "description": "ORDER_FETCH_FAILED: o worker não achou o pedido (o ESCALATE_TO_HUMAN dele sem ticket_id); confira o orderId.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "ORDER_FETCH_FAILED"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "A message do worker, como veio."
          }
        ],
        "example": {
          "code": "ORDER_FETCH_FAILED",
          "message": "pedido não encontrado"
        }
      },
      {
        "status": 200,
        "description": "UNKNOWN_ERROR: o worker respondeu 2xx com um code que a rota não conhece; a message é a do worker.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "A message do worker, como veio."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Situação não prevista para este pedido."
        }
      },
      {
        "status": 200,
        "description": "UNKNOWN_ERROR: o worker respondeu 2xx sem corpo JSON; o status repete o do worker.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível se conectar ao sistema."
        }
      },
      {
        "status": 400,
        "description": "UNKNOWN_ERROR: falta orderId, issue ou brand (\"Missing required fields (orderId, issue, brand)\") ou a marca não é uma das 6 (\"Invalid brand: <valor>\"); o worker não foi chamado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Missing required fields (orderId, issue, brand)"
        }
      },
      {
        "status": 400,
        "description": "UNKNOWN_ERROR: o worker recusou o payload (HTTP 4xx, exceto 401, sem code conhecido; ex.: issue fora do vocabulário); o status repete o do worker, corrija o corpo.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível se conectar ao sistema."
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: o app está sem TICKETCREATOR_URL (\"Ticket creator URL not configured\") ou sem TICKETCREATOR_SECRET (\"Ticket creator secret not configured\"); conferido antes de ler o corpo.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Uma das duas mensagens."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Ticket creator URL not configured"
        }
      },
      {
        "status": 500,
        "description": "UNKNOWN_ERROR: corpo que não é JSON, falha de rede ao chamar o worker, ou erro 5xx do worker sem code conhecido (aí o status repete o do worker).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível se conectar ao sistema."
        }
      },
      {
        "status": 502,
        "description": "UNKNOWN_ERROR: o worker recusou o segredo do app (HTTP 401); é configuração do app, repetir não resolve.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "UNKNOWN_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Mensagem fixa."
          }
        ],
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível se conectar ao sistema."
        }
      },
      {
        "status": 504,
        "description": "API_TIMEOUT: o worker não respondeu dentro do TIMEOUT do app (padrão 10 s); o ticket pode ter sido criado.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Desfecho.",
            "enum": [
              "API_TIMEOUT"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Traz o timeout em segundos."
          }
        ],
        "example": {
          "code": "API_TIMEOUT",
          "message": "O sistema demorou para responder (timeout de 10s)."
        }
      }
    ],
    "notes": [
      "A resposta tem só code e message; o resto do que o worker devolve (ticket_id, data, action) é descartado.",
      "Decida pelo code: os desfechos de negócio vêm todos com 200, e um code conhecido vindo do worker com HTTP de erro também sai com 200.",
      "O corpo vai inteiro ao worker, sem reescrever o issue; campos extras passam junto e callerType é sempre sobrescrito por \"agent\".",
      "A rota só confere orderId, issue e brand (presença) e a marca; issue e variables quem valida é o worker.",
      "ESCALATE_TO_HUMAN do worker (em code ou em status) vira TICKET_DEADLINE_EXPIRED com ticket_id e ORDER_FETCH_FAILED sem ele.",
      "O formulário do CX Hub traduz os rótulos da tela: Pedido Atrasado → \"Pedido Atrasado\", Acareação → \"Acareacao\", Endereço Errado → \"Endereco Errado\", Barra Entrega → \"barra_entrega\".",
      "Não há dedup nesta rota; um comentário do código diz que o worker também aceita \"Avaria\" e \"Extravio\" e o TICKET_EXISTS sugere que ele barra duplicata, mas o worker não está neste repositório (não confirmado).",
      "Método diferente de POST responde 405 {\"code\": \"METHOD_NOT_ALLOWED\", \"message\": \"Use POST nesta rota.\"} (roteador)."
    ],
    "sources": [
      "cxhub/app/api/logistica/submit/route.ts",
      "cxhub/modules/logistica/types/logistica.ts",
      "cxhub/modules/logistica/actions/buildLogisticaPayload.ts",
      "cxhub/shared/lib/constants.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-logistica-submit.test.ts",
      "cxhub/__tests__/logistica/buildLogisticaPayload.test.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/solicitacoes",
    "tag": "Consultas",
    "summary": "Lista as solicitações de reenvio ou de reembolso, 20 por página.",
    "description": "Junta a raw de eventos (lida pelo Metabase) com os casos que ainda estão na fila e devolve uma página de 20, a mais recente primeiro. Sem pedido, cobre os últimos 30 dias; com pedido, todo o histórico dele. Só leitura: não grava nada.",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "tipo",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Tipo da solicitação, sem diferença de maiúsculas.",
        "enum": [
          "REENVIO",
          "REEMBOLSO"
        ]
      },
      {
        "name": "marca",
        "in": "query",
        "type": "string",
        "required": false,
        "description": "Filtra por marca; maiúsculas e espaços nas pontas são ignorados.",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria",
          "apice",
          "yenzah",
          "denavita",
          "gobeaute"
        ]
      },
      {
        "name": "pedido",
        "in": "query",
        "type": "string",
        "required": false,
        "description": "Número do pedido em qualquer formato (SH9000105LC, #9000105): letras, dígitos, # e -, até 40 caracteres, com ao menos um dígito; compara só os dígitos e tira a janela de 30 dias."
      },
      {
        "name": "pagina",
        "in": "query",
        "type": "integer",
        "required": false,
        "description": "Página a partir de 1 (padrão 1), até 99999."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Página lida. A lista vazia vem com message \"Nenhuma solicitação encontrada.\"; a página além da última vem vazia com \"Esta página não existe mais: a lista tem N página(s).\".",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre SUCCESS.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Vazia quando há linhas; texto explicativo quando a lista ou a página está vazia."
          },
          {
            "name": "solicitacoes",
            "type": "array",
            "required": true,
            "description": "As linhas da página, no máximo 20, a mais recente primeiro (o id desempata)."
          },
          {
            "name": "solicitacoes[].idSolicitacao",
            "type": "string",
            "required": true,
            "description": "O id_solicitacao do caso."
          },
          {
            "name": "solicitacoes[].tipo",
            "type": "string",
            "required": true,
            "description": "O tipo pedido na query.",
            "enum": [
              "REENVIO",
              "REEMBOLSO"
            ]
          },
          {
            "name": "solicitacoes[].marca",
            "type": "string",
            "required": true,
            "description": "Marca do caso, em minúsculas.",
            "enum": [
              "lescent",
              "kokeshi",
              "bysamia",
              "aua",
              "barbours",
              "rituaria",
              "apice",
              "yenzah",
              "denavita",
              "gobeaute"
            ]
          },
          {
            "name": "solicitacoes[].numeroPedido",
            "type": "string",
            "required": true,
            "description": "Número do pedido como foi registrado."
          },
          {
            "name": "solicitacoes[].dataSolicitacao",
            "type": "string",
            "required": true,
            "description": "Quando a agente enviou, aaaa-mm-ddThh:mm:ss em hora de São Paulo, sem fuso."
          },
          {
            "name": "solicitacoes[].valor",
            "type": "number | null",
            "required": true,
            "description": "Valor em reais (o texto \"R$ 1.234,56\" do caso vira número); null quando não há ou não dá para ler."
          },
          {
            "name": "solicitacoes[].motivo",
            "type": "string | null",
            "required": true,
            "description": "Motivo registrado no caso."
          },
          {
            "name": "solicitacoes[].statusExecucao",
            "type": "string | null",
            "required": true,
            "description": "Status de execução atual, já com a atualização mais recente da fila por cima; null enquanto não há execução.",
            "enum": [
              "Realizado",
              "Cancelado",
              "Pendente"
            ]
          },
          {
            "name": "solicitacoes[].responsavel",
            "type": "string | null",
            "required": true,
            "description": "Quem registrou a solicitação."
          },
          {
            "name": "solicitacoes[].maisRecenteDoPedido",
            "type": "boolean",
            "required": true,
            "description": "true na solicitação mais recente do mesmo tipo para a marca e o pedido; no reembolso, só ela pode ser alterada."
          },
          {
            "name": "solicitacoes[].criadoEm",
            "type": "string | null",
            "required": true,
            "description": "O criado_em do caso (ISO 8601), o carimbo pelo qual se acha a linha na planilha."
          },
          {
            "name": "solicitacoes[].naPlanilha",
            "type": "boolean | null",
            "required": true,
            "description": "Se a linha está na planilha da marca; null quando não deu para saber (planilha fora, Google sem configuração, marca sem planilha ou sem criado_em)."
          },
          {
            "name": "solicitacoes[].situacaoNaFila",
            "type": "string | null",
            "required": true,
            "description": "Situação na fila quando a linha veio dela e não da raw; null na linha da raw e no caso já gravado.",
            "enum": [
              "pendente",
              "enviado",
              "recusado"
            ]
          },
          {
            "name": "paginacao.pagina",
            "type": "integer",
            "required": true,
            "description": "A página devolvida, a partir de 1."
          },
          {
            "name": "paginacao.porPagina",
            "type": "integer",
            "required": true,
            "description": "Tamanho da página, sempre 20."
          },
          {
            "name": "paginacao.total",
            "type": "integer",
            "required": true,
            "description": "Quantas solicitações a lista inteira (raw + fila) tem."
          },
          {
            "name": "paginacao.totalPaginas",
            "type": "integer",
            "required": true,
            "description": "Total de páginas, nunca menos de 1."
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "",
          "solicitacoes": [
            {
              "idSolicitacao": "3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c",
              "tipo": "REEMBOLSO",
              "marca": "lescent",
              "numeroPedido": "SH9000105LC",
              "dataSolicitacao": "2026-10-28T18:55:12",
              "valor": 59.9,
              "motivo": "Extravio",
              "statusExecucao": null,
              "responsavel": "Ana",
              "maisRecenteDoPedido": true,
              "criadoEm": "2026-10-28T21:55:12.000Z",
              "naPlanilha": true,
              "situacaoNaFila": null
            }
          ],
          "paginacao": {
            "pagina": 1,
            "porPagina": 20,
            "total": 1,
            "totalPaginas": 1
          }
        }
      },
      {
        "status": 400,
        "description": "Parâmetro inválido, antes de qualquer chamada externa. Outras mensagens: \"Marca inválida: <marca>.\", \"Número do pedido inválido.\", \"pagina deve ser um número inteiro de 1 a 99999.\".",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "tipo deve ser REENVIO ou REEMBOLSO."
        }
      },
      {
        "status": 401,
        "description": "Sem token (a rota não recebeu Authorization) ou token recusado pelo Cosmos. Outra mensagem: \"Token do Cosmos inválido ou expirado.\".",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Header Authorization ausente."
        }
      },
      {
        "status": 403,
        "description": "O Cosmos diz que o token não tem acesso à organização conferida.",
        "example": {
          "code": "FORBIDDEN",
          "message": "O token não tem acesso a esta marca no Cosmos."
        }
      },
      {
        "status": 502,
        "description": "O Cosmos respondeu algo inesperado ao conferir o token (ou COSMOS_API_URL falta), ou o Metabase falhou. Outra mensagem: \"Não foi possível ler a lista de solicitações.\".",
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível conferir o token no Cosmos."
        }
      },
      {
        "status": 503,
        "description": "Metabase sem configuração no ambiente (METABASE_*) ou sem a tabela da raw. Outra mensagem: \"A base do Metabase ainda não tem a tabela de reenvio e reembolso neste ambiente.\".",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A lista lê a base do Metabase, que não está configurada neste ambiente (METABASE_*)."
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não conferiu o token a tempo, ou o Metabase não respondeu (tempo esgotado ou inalcançável). Outra mensagem: \"O Metabase não respondeu.\".",
        "example": {
          "code": "API_TIMEOUT",
          "message": "O Cosmos demorou para conferir o token."
        }
      }
    ],
    "notes": [
      "Sem o x-cosmos-token, a gdk_ do gateway é tirada do Authorization antes da rota, e ela responde 401 \"Header Authorization ausente.\".",
      "O x-cosmos-token é o credentials.token do POST /api/auth/login, com ou sem o prefixo Bearer.",
      "O token é conferido no Cosmos na organização da marca filtrada; sem marca, ou com marca sem Cosmos (apice, yenzah, denavita, gobeaute), na da Lescent.",
      "Ordem das conferências: token presente (401), parâmetros (400), token no Cosmos (401/403/502/504), configuração do Metabase (503), leitura (502/503/504).",
      "No pedido, o # precisa ir codificado na URL (%23), senão vira fragmento e não chega ao servidor.",
      "A fila é complemento: se ela não responder, a lista sai só com a raw, sem aviso na resposta.",
      "Prazos internos: Cosmos 10 s (variável TIMEOUT), Metabase 5 s por consulta, planilha 15 s.",
      "Outro método no mesmo caminho: 405 {code: \"METHOD_NOT_ALLOWED\", message: \"Use GET nesta rota.\"} com o header Allow.",
      "Exceção não tratada vira 500 {code: \"UNKNOWN_ERROR\", message: \"Erro interno. Veja o log do app.\"} no roteador; pelo código, esta rota não deixa exceção escapar.",
      "Resposta com content-type application/json."
    ],
    "sources": [
      "cxhub/app/api/solicitacoes/route.ts",
      "cxhub/shared/lib/fila/estado.ts",
      "cxhub/shared/lib/airflow/listarCasos.ts",
      "cxhub/shared/lib/solicitacoes/types.ts",
      "cxhub/shared/lib/solicitacoes/paginacao.ts",
      "cxhub/shared/lib/sheets/presencaNaPlanilha.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "cxhub/shared/lib/metabase/client.ts",
      "cxhub/shared/lib/constants.ts",
      "api/roteador.ts",
      "api/next-server.ts",
      "cxhub/__tests__/integration/api-solicitacoes.test.ts",
      "testes/api.test.ts"
    ]
  },
  {
    "method": "GET",
    "path": "/api/registro",
    "tag": "Consultas",
    "summary": "Diz onde está cada caso: gravado, aguardando ou recusado.",
    "description": "Para até 20 ids de caso, consulta a raw numa query só pelo Metabase e, para os que a raw não tem, pergunta à fila se a DAG os recusou. Só leitura: não grava nada.",
    "routeHeader": "x-cosmos-token",
    "params": [
      {
        "name": "ids",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Os id_solicitacao separados por vírgula: de 1 a 20 distintos, cada um casando com ^[A-Za-z0-9-]{1,64}$."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Estado de cada id pedido.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre SUCCESS.",
            "enum": [
              "SUCCESS"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "Sempre vazia."
          },
          {
            "name": "estados",
            "type": "object",
            "required": true,
            "description": "Um par por id pedido (sem repetição), com o id como chave."
          },
          {
            "name": "estados.<id>",
            "type": "string",
            "required": true,
            "description": "gravado: a raw tem o caso; recusado: a fila diz que a DAG o recusou; aguardando: o resto (na fila, no lote ou na réplica atrasada).",
            "enum": [
              "gravado",
              "aguardando",
              "recusado"
            ]
          }
        ],
        "example": {
          "code": "SUCCESS",
          "message": "",
          "estados": {
            "6f1c0e2a-1111-4222-8333-444455556666": "gravado",
            "7c23634b-102e-4eec-a69b-d5c6df2f5619": "aguardando"
          }
        }
      },
      {
        "status": 400,
        "description": "ids ausente, vazio, com mais de 20 ids distintos ou com algum id fora do formato; nada é chamado.",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "ids deve ter de 1 a 20 ids de solicitação, separados por vírgula."
        }
      },
      {
        "status": 401,
        "description": "Sem token (a rota não recebeu Authorization) ou token recusado pelo Cosmos. Outra mensagem: \"Token do Cosmos inválido ou expirado.\".",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "Header Authorization ausente."
        }
      },
      {
        "status": 403,
        "description": "O Cosmos diz que o token não tem acesso à organização da Lescent.",
        "example": {
          "code": "FORBIDDEN",
          "message": "O token não tem acesso a esta marca no Cosmos."
        }
      },
      {
        "status": 502,
        "description": "O Cosmos respondeu algo inesperado ao conferir o token (ou COSMOS_API_URL falta), ou o Metabase falhou. Outra mensagem: \"Não foi possível ler o registro no Metabase.\".",
        "example": {
          "code": "UNKNOWN_ERROR",
          "message": "Não foi possível conferir o token no Cosmos."
        }
      },
      {
        "status": 503,
        "description": "Metabase sem configuração no ambiente.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "O Metabase não está configurado neste ambiente (METABASE_*)."
        }
      },
      {
        "status": 504,
        "description": "O Cosmos não conferiu o token a tempo, ou o Metabase não respondeu (tempo esgotado ou inalcançável). Outra mensagem: \"O Metabase não respondeu.\".",
        "example": {
          "code": "API_TIMEOUT",
          "message": "O Cosmos demorou para conferir o token."
        }
      }
    ],
    "notes": [
      "Sem o x-cosmos-token, a gdk_ do gateway é tirada do Authorization antes da rota, e ela responde 401 \"Header Authorization ausente.\".",
      "O token é sempre conferido na organização da Lescent no Cosmos (o usuário de serviço do CX Hub tem todas as marcas).",
      "Ordem das conferências: token presente (401), ids (400), token no Cosmos (401/403/502/504), configuração do Metabase (503), leitura (502/504).",
      "A fila nunca causa erro aqui: fora do ar ou sem configuração, o caso que a raw não tem fica aguardando.",
      "Um id que nunca existiu também volta aguardando; e um caso recusado sai da fila 7 dias depois, e a partir daí volta aguardando.",
      "O CX Hub pergunta isto a cada 10 min para a tag \"Gravado no Metabase\"; o lote leva o caso à raw em até 20 min, mais o atraso da réplica.",
      "Outro método no mesmo caminho: 405 {code: \"METHOD_NOT_ALLOWED\", message: \"Use GET nesta rota.\"} com o header Allow.",
      "Exceção não tratada vira 500 {code: \"UNKNOWN_ERROR\", message: \"Erro interno. Veja o log do app.\"} no roteador; pelo código, esta rota não deixa exceção escapar."
    ],
    "sources": [
      "cxhub/app/api/registro/route.ts",
      "cxhub/shared/lib/airflow/registro.ts",
      "cxhub/shared/lib/registro/types.ts",
      "cxhub/shared/lib/fila/client.ts",
      "cxhub/shared/lib/cosmos/http.ts",
      "cxhub/shared/lib/metabase/client.ts",
      "api/roteador.ts",
      "cxhub/__tests__/integration/api-registro.test.ts",
      "testes/api.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/v1/casos",
    "tag": "Fila",
    "summary": "Entrega à fila de 1 a 10 casos novos (criação).",
    "description": "Guarda os casos no banco do app como pendente; o lote do cron os leva à DAG gobeaute_reenvio_reembolso_etl a cada 20 min. Idempotente por id_solicitacao: repetir um id não duplica nem sobrescreve. Um item inválido recusa a chamada inteira e nada é guardado.",
    "routeHeader": "x-cxhub-fila-token",
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "casos",
          "type": "array",
          "required": true,
          "description": "De 1 a 10 casos; o resto do caso (além dos campos abaixo) vai à DAG como veio."
        },
        {
          "name": "casos[].id_solicitacao",
          "type": "string",
          "required": true,
          "description": "Id único do caso, ^[A-Za-z0-9-]{1,64}$ (o CX Hub usa UUID); é a chave de idempotência."
        },
        {
          "name": "casos[].tipo",
          "type": "string",
          "required": true,
          "description": "Tipo do caso, sem diferença de maiúsculas.",
          "enum": [
            "REENVIO",
            "REEMBOLSO",
            "CANCELAMENTO"
          ]
        },
        {
          "name": "casos[].marca",
          "type": "string",
          "required": true,
          "description": "Marca do CX Hub, sem diferença de maiúsculas.",
          "enum": [
            "lescent",
            "kokeshi",
            "bysamia",
            "aua",
            "barbours",
            "rituaria",
            "apice",
            "yenzah",
            "denavita",
            "gobeaute"
          ]
        },
        {
          "name": "casos[].criado_em",
          "type": "string",
          "required": true,
          "description": "Quando a agente enviou, em ISO 8601 (aaaa-mm-ddThh:mm…); mande com fuso, como o CX Hub."
        },
        {
          "name": "casos[].numero_pedido",
          "type": "string",
          "required": true,
          "description": "Número do pedido em qualquer formato, com ao menos um dígito; as buscas comparam só os dígitos."
        },
        {
          "name": "casos[].responsavel",
          "type": "string",
          "required": false,
          "description": "Quem registrou; volta nas leituras (vazio vira null)."
        },
        {
          "name": "casos[].valor",
          "type": "number | string",
          "required": false,
          "description": "Valor como número ou texto BR (\"R$ 1.234,56\"); não conferido aqui, devolvido por GET /api/v1/casos/abertos."
        },
        {
          "name": "casos[].motivo",
          "type": "string",
          "required": false,
          "description": "Motivo da solicitação; não conferido aqui, devolvido por GET /api/v1/casos/abertos."
        }
      ],
      "example": {
        "casos": [
          {
            "id_solicitacao": "3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c",
            "tipo": "REEMBOLSO",
            "marca": "lescent",
            "criado_em": "2026-11-04T10:00:00-03:00",
            "numero_pedido": "SH9000105LC",
            "valor": 59.9,
            "motivo": "Produto avariado",
            "responsavel": "Ana"
          }
        ]
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "Casos guardados, ou já estavam na fila (mesma resposta nos dois casos).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre ENFILEIRADO.",
            "enum": [
              "ENFILEIRADO"
            ]
          },
          {
            "name": "ids",
            "type": "array",
            "required": true,
            "description": "Os id_solicitacao recebidos, sem repetição, na ordem em que vieram."
          }
        ],
        "example": {
          "code": "ENFILEIRADO",
          "ids": [
            "3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c"
          ]
        }
      },
      {
        "status": 400,
        "description": "Corpo ou item inválido; nada é guardado. Outras mensagens: \"Corpo maior que 256 KB.\", \"JSON inválido. Confira a sintaxe do corpo.\", \"O corpo precisa ser um objeto JSON.\", \"\\\"casos\\\" precisa ser uma lista.\", \"\\\"casos\\\" precisa ter de 1 a 10 itens.\", \"casos[i] precisa ser um objeto.\", \"casos[i].id_solicitacao precisa casar com ^[A-Za-z0-9-]{1,64}$.\", \"casos[i].tipo precisa ser REENVIO, REEMBOLSO, CANCELAMENTO.\", \"casos[i].marca precisa ser lescent, kokeshi, bysamia, aua, barbours, rituaria, apice, yenzah, denavita, gobeaute.\", \"casos[i].criado_em precisa ser data e hora ISO 8601.\" (i é o índice do item).",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "casos[1].numero_pedido precisa ter ao menos um dígito."
        }
      },
      {
        "status": 401,
        "description": "x-cxhub-fila-token ausente ou diferente de todos os tokens aceitos; conferido antes de ler o corpo.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "x-cxhub-fila-token ausente ou inválido."
        }
      },
      {
        "status": 503,
        "description": "O banco do app falhou ao gravar; nada fica pela metade (uma instrução só), e repetir é seguro.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A fila não conseguiu ler ou gravar agora. Repetir é seguro."
        }
      }
    ],
    "notes": [
      "A fila confere só a identidade (id_solicitacao, tipo, marca, criado_em, numero_pedido); o resto do contrato da DAG é o contrato.ts do CX Hub, e a DAG pode recusar o caso no lote (situacao recusado, visível em GET /api/v1/casos/{id} e /api/v1/estado).",
      "tipo e marca são guardados normalizados (maiúsculas e minúsculas) para as buscas; o caso vai ao conf da DAG exatamente como veio.",
      "id_solicitacao e numero_pedido também aceitam número, que vira texto.",
      "Id repetido na mesma chamada ou já na fila é ignorado sem erro: vale o primeiro guardado.",
      "Limites: corpo de até 256 KB e de 1 a 10 casos por chamada (o reembolso do Bot manda 2: o reembolso e o cancelamento).",
      "O Content-Type não é conferido; o corpo precisa ser um objeto JSON.",
      "Caminho: pendente → enviado (no lote) → gravado ou recusado; gravado e recusado ficam 7 dias e depois são apagados.",
      "Ordem das respostas da fila: caminho desconhecido (404 NOT_FOUND), token (401), método (405 METHOD_NOT_ALLOWED com Allow: GET, POST)."
    ],
    "sources": [
      "servidor/app.ts",
      "servidor/fila.ts",
      "servidor/validacao.ts",
      "servidor/http.ts",
      "servidor/banco.ts",
      "testes/fila.test.ts",
      "testes/ambiente.ts",
      "cx-hub (origin/main): docs/fila-cxhub.md"
    ]
  },
  {
    "method": "GET",
    "path": "/api/v1/casos",
    "tag": "Fila",
    "summary": "Lista os casos da fila de um tipo, marca e pedido.",
    "description": "Devolve os casos daquele tipo, marca e pedido que a fila ainda guarda, em qualquer situação, o mais novo primeiro (criado_em), no máximo 20. Só leitura; é o que o dedup de 24 h do CX Hub consulta.",
    "routeHeader": "x-cxhub-fila-token",
    "params": [
      {
        "name": "tipo",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Tipo do caso, sem diferença de maiúsculas.",
        "enum": [
          "REENVIO",
          "REEMBOLSO",
          "CANCELAMENTO"
        ]
      },
      {
        "name": "marca",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Marca, sem diferença de maiúsculas.",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria",
          "apice",
          "yenzah",
          "denavita",
          "gobeaute"
        ]
      },
      {
        "name": "pedido",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Só os dígitos do número do pedido (1 a 40 dígitos), comparados com os dígitos do numero_pedido guardado."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Casos encontrados (lista vazia quando não há nenhum).",
        "fields": [
          {
            "name": "casos",
            "type": "array",
            "required": true,
            "description": "No máximo 20, o mais novo primeiro."
          },
          {
            "name": "casos[].id_solicitacao",
            "type": "string",
            "required": true,
            "description": "Id do caso."
          },
          {
            "name": "casos[].tipo",
            "type": "string",
            "required": true,
            "description": "Tipo, em maiúsculas.",
            "enum": [
              "REENVIO",
              "REEMBOLSO",
              "CANCELAMENTO"
            ]
          },
          {
            "name": "casos[].marca",
            "type": "string",
            "required": true,
            "description": "Marca, em minúsculas."
          },
          {
            "name": "casos[].numero_pedido",
            "type": "string",
            "required": true,
            "description": "Número do pedido como veio no caso."
          },
          {
            "name": "casos[].criado_em",
            "type": "string",
            "required": true,
            "description": "O criado_em como veio no caso."
          },
          {
            "name": "casos[].responsavel",
            "type": "string | null",
            "required": true,
            "description": "Quem registrou, ou null."
          },
          {
            "name": "casos[].situacao",
            "type": "string",
            "required": true,
            "description": "Onde o caso está na fila.",
            "enum": [
              "pendente",
              "enviado",
              "gravado",
              "recusado"
            ]
          }
        ],
        "example": {
          "casos": [
            {
              "id_solicitacao": "3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c",
              "tipo": "REEMBOLSO",
              "marca": "lescent",
              "numero_pedido": "SH9000105LC",
              "criado_em": "2026-11-04T10:00:00-03:00",
              "responsavel": "Ana",
              "situacao": "pendente"
            }
          ]
        }
      },
      {
        "status": 400,
        "description": "Parâmetro ausente ou inválido. Outras mensagens: \"\\\"marca\\\" precisa ser lescent, kokeshi, bysamia, aua, barbours, rituaria, apice, yenzah, denavita, gobeaute.\", \"\\\"pedido\\\" precisa ter só dígitos.\".",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "\"tipo\" precisa ser REENVIO, REEMBOLSO, CANCELAMENTO."
        }
      },
      {
        "status": 401,
        "description": "x-cxhub-fila-token ausente ou inválido.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "x-cxhub-fila-token ausente ou inválido."
        }
      },
      {
        "status": 503,
        "description": "O banco do app falhou ao ler; repetir é seguro.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A fila não conseguiu ler ou gravar agora. Repetir é seguro."
        }
      }
    ],
    "notes": [
      "Os três parâmetros são obrigatórios; para listar sem marca ou sem pedido, use GET /api/v1/casos/abertos.",
      "pedido aceita só dígitos: SH9000105LC vira 9000105 antes de chamar.",
      "A fila só tem os casos dos últimos dias: gravado e recusado são apagados 7 dias depois do lote; o histórico completo está na raw.",
      "Outro método que não GET ou POST: 405 METHOD_NOT_ALLOWED com Allow: GET, POST."
    ],
    "sources": [
      "servidor/app.ts",
      "servidor/fila.ts",
      "servidor/validacao.ts",
      "testes/fila.test.ts",
      "cx-hub (origin/main): docs/fila-cxhub.md"
    ]
  },
  {
    "method": "GET",
    "path": "/api/v1/casos/abertos",
    "tag": "Fila",
    "summary": "Lista os casos de um tipo que a raw talvez ainda não mostre.",
    "description": "Devolve os casos pendente, enviado ou recusado e os gravados há menos de 1 h (o atraso da réplica), com valor e motivo, o mais novo primeiro, no máximo 50. É o que a lista de solicitações do CX Hub junta à raw. Só leitura.",
    "routeHeader": "x-cxhub-fila-token",
    "params": [
      {
        "name": "tipo",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Tipo do caso, sem diferença de maiúsculas.",
        "enum": [
          "REENVIO",
          "REEMBOLSO"
        ]
      },
      {
        "name": "marca",
        "in": "query",
        "type": "string",
        "required": false,
        "description": "Filtra por marca, sem diferença de maiúsculas.",
        "enum": [
          "lescent",
          "kokeshi",
          "bysamia",
          "aua",
          "barbours",
          "rituaria",
          "apice",
          "yenzah",
          "denavita",
          "gobeaute"
        ]
      },
      {
        "name": "pedido",
        "in": "query",
        "type": "string",
        "required": false,
        "description": "Filtra pelos dígitos do pedido (só dígitos, 1 a 40)."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Casos encontrados (lista vazia quando não há nenhum).",
        "fields": [
          {
            "name": "casos",
            "type": "array",
            "required": true,
            "description": "No máximo 50, o mais novo primeiro (criado_em)."
          },
          {
            "name": "casos[].id_solicitacao",
            "type": "string",
            "required": true,
            "description": "Id do caso."
          },
          {
            "name": "casos[].tipo",
            "type": "string",
            "required": true,
            "description": "Tipo, em maiúsculas.",
            "enum": [
              "REENVIO",
              "REEMBOLSO"
            ]
          },
          {
            "name": "casos[].marca",
            "type": "string",
            "required": true,
            "description": "Marca, em minúsculas."
          },
          {
            "name": "casos[].numero_pedido",
            "type": "string",
            "required": true,
            "description": "Número do pedido como veio no caso."
          },
          {
            "name": "casos[].criado_em",
            "type": "string",
            "required": true,
            "description": "O criado_em como veio no caso."
          },
          {
            "name": "casos[].responsavel",
            "type": "string | null",
            "required": true,
            "description": "Quem registrou, ou null."
          },
          {
            "name": "casos[].situacao",
            "type": "string",
            "required": true,
            "description": "Onde o caso está; gravado só aparece até 1 h depois do lote.",
            "enum": [
              "pendente",
              "enviado",
              "gravado",
              "recusado"
            ]
          },
          {
            "name": "casos[].valor",
            "type": "number | string | null",
            "required": true,
            "description": "O valor como veio no caso (número ou texto \"R$ 1.234,56\"); qualquer outra coisa vira null."
          },
          {
            "name": "casos[].motivo",
            "type": "string | null",
            "required": true,
            "description": "O motivo como veio no caso; o que não for texto vira null."
          }
        ],
        "example": {
          "casos": [
            {
              "id_solicitacao": "3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c",
              "tipo": "REEMBOLSO",
              "marca": "lescent",
              "numero_pedido": "SH9000105LC",
              "criado_em": "2026-11-04T10:00:00-03:00",
              "responsavel": "Ana",
              "situacao": "pendente",
              "valor": 59.9,
              "motivo": "Produto avariado"
            },
            {
              "id_solicitacao": "a41d7e93-2c5b-4f10-8e6a-0b9c8d7e6f5a",
              "tipo": "REEMBOLSO",
              "marca": "kokeshi",
              "numero_pedido": "SH4002871KO",
              "criado_em": "2026-11-04T09:12:00-03:00",
              "responsavel": "Bruno",
              "situacao": "enviado",
              "valor": "R$ 1.234,56",
              "motivo": "Atraso"
            }
          ]
        }
      },
      {
        "status": 400,
        "description": "tipo ausente ou fora de REENVIO/REEMBOLSO, ou marca/pedido inválidos. Outras mensagens: \"\\\"marca\\\" precisa ser lescent, kokeshi, bysamia, aua, barbours, rituaria, apice, yenzah, denavita, gobeaute.\", \"\\\"pedido\\\" precisa ter só dígitos.\".",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "\"tipo\" precisa ser REENVIO ou REEMBOLSO."
        }
      },
      {
        "status": 401,
        "description": "x-cxhub-fila-token ausente ou inválido.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "x-cxhub-fila-token ausente ou inválido."
        }
      },
      {
        "status": 503,
        "description": "O banco do app falhou ao ler; repetir é seguro.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A fila não conseguiu ler ou gravar agora. Repetir é seguro."
        }
      }
    ],
    "notes": [
      "CANCELAMENTO não é aceito aqui (as listas só mostram reenvio e reembolso).",
      "O recusado continua na lista até ser apagado, 7 dias depois do lote; o gravado sai 1 h depois do lote.",
      "Sem dado pessoal: só identidade, situação, valor e motivo.",
      "O CX Hub trata 404 desta rota como fila vazia (compatibilidade com o app antes dela existir).",
      "Outro método: 405 METHOD_NOT_ALLOWED com Allow: GET."
    ],
    "sources": [
      "servidor/app.ts",
      "servidor/fila.ts",
      "servidor/validacao.ts",
      "testes/fila.test.ts",
      "cxhub/shared/lib/fila/client.ts",
      "cx-hub (origin/main): docs/fila-cxhub.md"
    ]
  },
  {
    "method": "GET",
    "path": "/api/v1/casos/{id}",
    "tag": "Fila",
    "summary": "Lê um caso da fila pelo id_solicitacao.",
    "description": "Devolve o caso com esse id e a situação dele na fila, ou caso null quando a fila não o tem. Só leitura.",
    "routeHeader": "x-cxhub-fila-token",
    "params": [
      {
        "name": "id",
        "in": "path",
        "type": "string",
        "required": true,
        "description": "O id_solicitacao (^[A-Za-z0-9-]{1,64}$), codificado na URL se preciso."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Sempre 200 quando o id é válido: caso preenchido, ou null se a fila não tem esse id.",
        "fields": [
          {
            "name": "caso",
            "type": "object | null",
            "required": true,
            "description": "O caso, ou null quando não está na fila."
          },
          {
            "name": "caso.id_solicitacao",
            "type": "string",
            "required": "condicional",
            "description": "Id do caso (presente quando caso não é null)."
          },
          {
            "name": "caso.tipo",
            "type": "string",
            "required": "condicional",
            "description": "Tipo, em maiúsculas (presente quando caso não é null).",
            "enum": [
              "REENVIO",
              "REEMBOLSO",
              "CANCELAMENTO"
            ]
          },
          {
            "name": "caso.marca",
            "type": "string",
            "required": "condicional",
            "description": "Marca, em minúsculas (presente quando caso não é null)."
          },
          {
            "name": "caso.numero_pedido",
            "type": "string",
            "required": "condicional",
            "description": "Número do pedido como veio (presente quando caso não é null)."
          },
          {
            "name": "caso.criado_em",
            "type": "string",
            "required": "condicional",
            "description": "O criado_em como veio (presente quando caso não é null)."
          },
          {
            "name": "caso.responsavel",
            "type": "string | null",
            "required": "condicional",
            "description": "Quem registrou, ou null (presente quando caso não é null)."
          },
          {
            "name": "caso.situacao",
            "type": "string",
            "required": "condicional",
            "description": "Onde o caso está na fila (presente quando caso não é null).",
            "enum": [
              "pendente",
              "enviado",
              "gravado",
              "recusado"
            ]
          }
        ],
        "example": {
          "caso": {
            "id_solicitacao": "3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c",
            "tipo": "REEMBOLSO",
            "marca": "lescent",
            "numero_pedido": "SH9000105LC",
            "criado_em": "2026-11-04T10:00:00-03:00",
            "responsavel": "Ana",
            "situacao": "recusado"
          }
        }
      },
      {
        "status": 400,
        "description": "id fora do formato.",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "O id precisa casar com ^[A-Za-z0-9-]{1,64}$."
        }
      },
      {
        "status": 401,
        "description": "x-cxhub-fila-token ausente ou inválido.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "x-cxhub-fila-token ausente ou inválido."
        }
      },
      {
        "status": 503,
        "description": "O banco do app falhou ao ler; repetir é seguro.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A fila não conseguiu ler ou gravar agora. Repetir é seguro."
        }
      }
    ],
    "notes": [
      "Caso ausente não é 404: é 200 com {\"caso\": null}. A fila apaga gravado e recusado 7 dias depois do lote, então null não quer dizer que o caso não existe na raw.",
      "O id \"abertos\" é reservado: /api/v1/casos/abertos é outra rota.",
      "Não traz o motivo da recusa; ele aparece em recusados_recentes de GET /api/v1/estado.",
      "Outro método: 405 METHOD_NOT_ALLOWED com Allow: GET."
    ],
    "sources": [
      "servidor/app.ts",
      "servidor/fila.ts",
      "servidor/http.ts",
      "testes/fila.test.ts",
      "cx-hub (origin/main): docs/fila-cxhub.md"
    ]
  },
  {
    "method": "POST",
    "path": "/api/v1/atualizacoes",
    "tag": "Fila",
    "summary": "Entrega à fila de 1 a 10 alterações de casos.",
    "description": "Guarda as alterações (cancelar, editar, concluir, sincronizar) como pendente; o lote as leva à DAG depois dos casos, na ordem de atualizado_em. Idempotente por id_atualizacao: repetir não duplica nem sobrescreve. Um item inválido recusa a chamada inteira e nada é guardado.",
    "routeHeader": "x-cxhub-fila-token",
    "params": [],
    "requestBody": {
      "contentType": "application/json",
      "fields": [
        {
          "name": "atualizacoes",
          "type": "array",
          "required": true,
          "description": "De 1 a 10 alterações."
        },
        {
          "name": "atualizacoes[].id_atualizacao",
          "type": "string",
          "required": true,
          "description": "UUID da alteração; é a chave de idempotência."
        },
        {
          "name": "atualizacoes[].id_solicitacao",
          "type": "string",
          "required": true,
          "description": "O caso alterado (^[A-Za-z0-9-]{1,64}$); não precisa estar na fila, pode já estar só na raw."
        },
        {
          "name": "atualizacoes[].atualizado_em",
          "type": "string",
          "required": true,
          "description": "Instante em que o agente agiu, ISO 8601 com fuso (Z ou ±hh:mm); ordena as alterações do caso."
        },
        {
          "name": "atualizacoes[].campos",
          "type": "object",
          "required": true,
          "description": "As colunas que mudam (AtualizacaoCxhub); a fila só confere que é um objeto."
        },
        {
          "name": "atualizacoes[].campos.status_execucao",
          "type": "string",
          "required": false,
          "description": "Novo status de execução; não conferido pela fila.",
          "enum": [
            "Realizado",
            "Cancelado",
            "Pendente"
          ]
        },
        {
          "name": "atualizacoes[].campos.data_execucao",
          "type": "string",
          "required": false,
          "description": "Data da execução, dd/mm/aaaa ou aaaa-mm-dd; não conferida pela fila."
        },
        {
          "name": "atualizacoes[].campos.responsavel_execucao",
          "type": "string",
          "required": false,
          "description": "Quem executou ou cancelou; não conferido pela fila."
        }
      ],
      "example": {
        "atualizacoes": [
          {
            "id_atualizacao": "b8e1f0a2-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
            "id_solicitacao": "3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c",
            "atualizado_em": "2026-11-04T13:05:00.000Z",
            "campos": {
              "status_execucao": "Cancelado",
              "responsavel_execucao": "Ana"
            }
          }
        ]
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "Alterações guardadas, ou já estavam na fila (mesma resposta nos dois casos).",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre ENFILEIRADO.",
            "enum": [
              "ENFILEIRADO"
            ]
          },
          {
            "name": "ids",
            "type": "array",
            "required": true,
            "description": "Os id_atualizacao recebidos, sem repetição, na ordem em que vieram."
          }
        ],
        "example": {
          "code": "ENFILEIRADO",
          "ids": [
            "b8e1f0a2-3c4d-4e5f-8a6b-7c8d9e0f1a2b"
          ]
        }
      },
      {
        "status": 400,
        "description": "Corpo ou item inválido; nada é guardado. Outras mensagens: \"Corpo maior que 256 KB.\", \"JSON inválido. Confira a sintaxe do corpo.\", \"O corpo precisa ser um objeto JSON.\", \"\\\"atualizacoes\\\" precisa ser uma lista.\", \"\\\"atualizacoes\\\" precisa ter de 1 a 10 itens.\", \"atualizacoes[i] precisa ser um objeto.\", \"atualizacoes[i].id_atualizacao precisa ser um UUID.\", \"atualizacoes[i].id_solicitacao precisa casar com ^[A-Za-z0-9-]{1,64}$.\", \"atualizacoes[i].campos precisa ser um objeto.\" (i é o índice do item).",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "atualizacoes[0].atualizado_em precisa ser data e hora ISO 8601 com fuso."
        }
      },
      {
        "status": 401,
        "description": "x-cxhub-fila-token ausente ou inválido; conferido antes de ler o corpo.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "x-cxhub-fila-token ausente ou inválido."
        }
      },
      {
        "status": 503,
        "description": "O banco do app falhou ao gravar; nada fica pela metade, e repetir é seguro.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A fila não conseguiu ler ou gravar agora. Repetir é seguro."
        }
      }
    ],
    "notes": [
      "O conteúdo de campos é conferido pelo problemaNaAtualizacao do CX Hub antes de enfileirar, não pela fila; campo fora do contrato faz a DAG falhar o run.",
      "No conf da DAG, id_solicitacao, id_atualizacao e atualizado_em do item sobrescrevem chaves iguais dentro de campos.",
      "A alteração de um caso que ainda está pendente na fila espera o lote do caso; se o caso foi recusado, a alteração também é recusada (\"o caso foi recusado: …\").",
      "Caso inexistente (nem na raw, nem no lote) é recusado pela DAG, não por esta rota.",
      "Mande o atualizado_em real do momento (o CX Hub usa toISOString()): a DAG não aceita mais de 5 min depois do disparo do run (docs/fila-cxhub.md).",
      "Limites: corpo de até 256 KB e de 1 a 10 alterações por chamada.",
      "Outro método que não GET ou POST: 405 METHOD_NOT_ALLOWED com Allow: GET, POST."
    ],
    "sources": [
      "servidor/app.ts",
      "servidor/fila.ts",
      "servidor/validacao.ts",
      "servidor/http.ts",
      "servidor/lote.ts",
      "cxhub/shared/lib/airflow/types.ts",
      "testes/fila.test.ts",
      "testes/ambiente.ts",
      "cx-hub (origin/main): docs/fila-cxhub.md"
    ]
  },
  {
    "method": "GET",
    "path": "/api/v1/atualizacoes",
    "tag": "Fila",
    "summary": "Lista as alterações que a fila guarda para até 20 casos.",
    "description": "Devolve todas as alterações guardadas para os casos pedidos, em qualquer situação, em ordem de atualizado_em (a mais antiga primeiro). Só leitura.",
    "routeHeader": "x-cxhub-fila-token",
    "params": [
      {
        "name": "ids",
        "in": "query",
        "type": "string",
        "required": true,
        "description": "Os id_solicitacao separados por vírgula: de 1 a 20 distintos, cada um casando com ^[A-Za-z0-9-]{1,64}$."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Alterações encontradas (lista vazia quando não há nenhuma).",
        "fields": [
          {
            "name": "atualizacoes",
            "type": "array",
            "required": true,
            "description": "Todas as dos casos pedidos, sem limite de quantidade, por atualizado_em."
          },
          {
            "name": "atualizacoes[].id_atualizacao",
            "type": "string",
            "required": true,
            "description": "UUID da alteração."
          },
          {
            "name": "atualizacoes[].id_solicitacao",
            "type": "string",
            "required": true,
            "description": "O caso alterado."
          },
          {
            "name": "atualizacoes[].atualizado_em",
            "type": "string",
            "required": true,
            "description": "O atualizado_em como veio."
          },
          {
            "name": "atualizacoes[].campos",
            "type": "object",
            "required": true,
            "description": "O objeto campos como veio."
          },
          {
            "name": "atualizacoes[].situacao",
            "type": "string",
            "required": true,
            "description": "Onde a alteração está na fila.",
            "enum": [
              "pendente",
              "enviado",
              "gravado",
              "recusado"
            ]
          }
        ],
        "example": {
          "atualizacoes": [
            {
              "id_atualizacao": "b8e1f0a2-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
              "id_solicitacao": "3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c",
              "atualizado_em": "2026-11-04T13:05:00.000Z",
              "campos": {
                "status_execucao": "Cancelado",
                "responsavel_execucao": "Ana"
              },
              "situacao": "pendente"
            }
          ]
        }
      },
      {
        "status": 400,
        "description": "ids ausente, com mais de 20 ids distintos ou com algum fora do formato. Outras mensagens: \"\\\"ids\\\" aceita até 20 ids.\", \"Cada id precisa casar com ^[A-Za-z0-9-]{1,64}$.\".",
        "example": {
          "code": "INVALID_REQUEST",
          "message": "\"ids\" precisa ter ao menos um id de caso."
        }
      },
      {
        "status": 401,
        "description": "x-cxhub-fila-token ausente ou inválido.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "x-cxhub-fila-token ausente ou inválido."
        }
      },
      {
        "status": 503,
        "description": "O banco do app falhou ao ler; repetir é seguro.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A fila não conseguiu ler ou gravar agora. Repetir é seguro."
        }
      }
    ],
    "notes": [
      "Os ids são de caso (id_solicitacao), não de alteração; espaços nas pontas e repetidos são ignorados antes de contar os 20.",
      "Inclui as recusadas: quem calcula o status atual deve ignorá-las, como o CX Hub faz.",
      "Alterações gravadas e recusadas ficam 7 dias e depois são apagadas.",
      "Outro método que não GET ou POST: 405 METHOD_NOT_ALLOWED com Allow: GET, POST."
    ],
    "sources": [
      "servidor/app.ts",
      "servidor/fila.ts",
      "servidor/validacao.ts",
      "testes/fila.test.ts",
      "cxhub/shared/lib/fila/estado.ts",
      "cx-hub (origin/main): docs/fila-cxhub.md"
    ]
  },
  {
    "method": "GET",
    "path": "/api/v1/estado",
    "tag": "Fila",
    "summary": "Diagnóstico da fila: contagens, lotes, recusas e configuração.",
    "description": "Mostra quantos casos e alterações há em cada situação, o lote em andamento, o último terminado, os 10 recusados mais recentes, o resumo da última rodada do cron e a configuração, sem valor de segredo. Só leitura.",
    "routeHeader": "x-cxhub-fila-token",
    "params": [],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Estado atual da fila.",
        "fields": [
          {
            "name": "casos",
            "type": "object",
            "required": true,
            "description": "Contagem de casos por situação: pendente, enviado, gravado e recusado (sempre os quatro, com 0 quando não há)."
          },
          {
            "name": "atualizacoes",
            "type": "object",
            "required": true,
            "description": "Contagem de alterações por situação, com as mesmas quatro chaves."
          },
          {
            "name": "lote_em_andamento",
            "type": "object | null",
            "required": true,
            "description": "O lote montando ou disparado (um por vez), ou null."
          },
          {
            "name": "ultimo_lote",
            "type": "object | null",
            "required": true,
            "description": "O último lote terminado, ou null."
          },
          {
            "name": "<lote>.id",
            "type": "string",
            "required": true,
            "description": "O dag_run_id do lote, cxhub_lote__<aaaammddThhmmss> em UTC."
          },
          {
            "name": "<lote>.situacao",
            "type": "string",
            "required": true,
            "description": "Etapa do lote.",
            "enum": [
              "montando",
              "disparado",
              "terminado"
            ]
          },
          {
            "name": "<lote>.desfecho",
            "type": "string | null",
            "required": true,
            "description": "Como o lote terminou; null antes de terminar.",
            "enum": [
              "concluido",
              "falhou",
              "concluido_sem_resultado",
              "sem_resultado",
              "vazio",
              "falha_no_disparo",
              "disparo_recusado"
            ]
          },
          {
            "name": "<lote>.casos",
            "type": "integer",
            "required": true,
            "description": "Casos enviados no conf (0 até o disparo)."
          },
          {
            "name": "<lote>.atualizacoes",
            "type": "integer",
            "required": true,
            "description": "Alterações enviadas no conf (0 até o disparo)."
          },
          {
            "name": "<lote>.clears",
            "type": "integer",
            "required": true,
            "description": "Quantas vezes o run foi recolocado (no máximo 1)."
          },
          {
            "name": "<lote>.gravados",
            "type": "integer | null",
            "required": true,
            "description": "Itens gravados pela DAG; null antes de terminar."
          },
          {
            "name": "<lote>.recusados",
            "type": "integer | null",
            "required": true,
            "description": "Itens recusados; null antes de terminar."
          },
          {
            "name": "<lote>.erro",
            "type": "string | null",
            "required": true,
            "description": "Motivo da falha do lote, até 500 caracteres."
          },
          {
            "name": "<lote>.criado_em",
            "type": "string",
            "required": true,
            "description": "Quando o lote foi montado (ISO UTC)."
          },
          {
            "name": "<lote>.disparado_em",
            "type": "string | null",
            "required": true,
            "description": "Quando o Airflow aceitou o run (ISO UTC)."
          },
          {
            "name": "<lote>.terminado_em",
            "type": "string | null",
            "required": true,
            "description": "Quando o lote terminou (ISO UTC)."
          },
          {
            "name": "recusados_recentes",
            "type": "array",
            "required": true,
            "description": "Os 10 itens recusados mais recentes, casos e alterações juntos."
          },
          {
            "name": "recusados_recentes[].tipo",
            "type": "string",
            "required": true,
            "description": "Se é caso ou alteração.",
            "enum": [
              "caso",
              "atualizacao"
            ]
          },
          {
            "name": "recusados_recentes[].id",
            "type": "string",
            "required": true,
            "description": "O id_solicitacao (caso) ou o id_atualizacao (alteração)."
          },
          {
            "name": "recusados_recentes[].erro",
            "type": "string | null",
            "required": true,
            "description": "Motivo da recusa, até 500 caracteres."
          },
          {
            "name": "recusados_recentes[].terminado_em",
            "type": "string",
            "required": true,
            "description": "Quando foi recusado (ISO UTC)."
          },
          {
            "name": "ultima_rodada",
            "type": "object | null",
            "required": true,
            "description": "O resumo da última rodada do lote, no mesmo formato da resposta de POST /api/v1/interno/lote sem code e message; null antes da primeira."
          },
          {
            "name": "config.airflow",
            "type": "object | null",
            "required": true,
            "description": "dag_id, task e key do XCom lido; null quando falta AIRFLOW_BASE_URL, AIRFLOW_USER ou AIRFLOW_PASSWORD."
          },
          {
            "name": "config.lote_max",
            "type": "integer",
            "required": true,
            "description": "Máximo de itens por lote (padrão 200)."
          },
          {
            "name": "config.slack",
            "type": "boolean",
            "required": true,
            "description": "Se há um webhook https do Slack para os avisos."
          },
          {
            "name": "config.cron_chave",
            "type": "boolean",
            "required": true,
            "description": "Se a GODEPLOY_CRON_KEY está cadastrada."
          },
          {
            "name": "config.tokens",
            "type": "integer",
            "required": true,
            "description": "Quantos tokens o x-cxhub-fila-token aceita (nunca o valor)."
          },
          {
            "name": "config.problemas",
            "type": "array",
            "required": true,
            "description": "Problemas de configuração em texto, sem valor de segredo."
          }
        ],
        "example": {
          "casos": {
            "pendente": 0,
            "enviado": 3,
            "gravado": 41,
            "recusado": 1
          },
          "atualizacoes": {
            "pendente": 0,
            "enviado": 1,
            "gravado": 17,
            "recusado": 0
          },
          "lote_em_andamento": {
            "id": "cxhub_lote__20261104T132001",
            "situacao": "disparado",
            "desfecho": null,
            "casos": 3,
            "atualizacoes": 1,
            "clears": 0,
            "gravados": null,
            "recusados": null,
            "erro": null,
            "criado_em": "2026-11-04T13:20:01.204Z",
            "disparado_em": "2026-11-04T13:20:02.517Z",
            "terminado_em": null
          },
          "ultimo_lote": {
            "id": "cxhub_lote__20261104T130001",
            "situacao": "terminado",
            "desfecho": "concluido",
            "casos": 5,
            "atualizacoes": 2,
            "clears": 0,
            "gravados": 6,
            "recusados": 1,
            "erro": null,
            "criado_em": "2026-11-04T13:00:01.090Z",
            "disparado_em": "2026-11-04T13:00:02.311Z",
            "terminado_em": "2026-11-04T13:20:00.874Z"
          },
          "recusados_recentes": [
            {
              "tipo": "caso",
              "id": "c7e2b913-5a40-4d8e-9f21-3b6a5c4d2e10",
              "erro": "sem numero_pedido",
              "terminado_em": "2026-11-04T13:20:00.874Z"
            }
          ],
          "ultima_rodada": {
            "em": "2026-11-04T13:20:00.512Z",
            "andamento": {
              "lote": "cxhub_lote__20261104T130001",
              "livre": true,
              "estado": "success",
              "gravados": 6,
              "recusados": 1
            },
            "disparo": {
              "estado": "disparado",
              "lote": "cxhub_lote__20261104T132001",
              "casos": 3,
              "atualizacoes": 1
            },
            "limpeza": false,
            "avisos": 2
          },
          "config": {
            "airflow": {
              "dag_id": "gobeaute_reenvio_reembolso_etl",
              "task": "gravar",
              "key": "resultado"
            },
            "lote_max": 200,
            "slack": true,
            "cron_chave": true,
            "tokens": 2,
            "problemas": []
          }
        }
      },
      {
        "status": 401,
        "description": "x-cxhub-fila-token ausente ou inválido.",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "x-cxhub-fila-token ausente ou inválido."
        }
      },
      {
        "status": 503,
        "description": "O banco do app falhou ao ler; repetir é seguro.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A fila não conseguiu ler ou gravar agora. Repetir é seguro."
        }
      }
    ],
    "notes": [
      "Rota de diagnóstico, para quem opera a fila; o CX Hub não a usa no fluxo.",
      "Nos campos <lote>.*, <lote> é lote_em_andamento ou ultimo_lote.",
      "Exemplos de config.problemas: \"SLACK_ALERT_WEBHOOK_URL vazio: os avisos só vão para o log\", \"AIRFLOW_BASE_URL vazio: o lote não é disparado\", \"CXHUB_FILA_TOKENS vazio: toda chamada recebe 401\".",
      "O contrato em docs/fila-cxhub.md do CX Hub cita só as contagens e os lotes; recusados_recentes, ultima_rodada e config vêm do código.",
      "Outro método: 405 METHOD_NOT_ALLOWED com Allow: GET."
    ],
    "sources": [
      "servidor/app.ts",
      "servidor/fila.ts",
      "servidor/config.ts",
      "servidor/banco.ts",
      "servidor/lote.ts",
      "testes/fila.test.ts",
      "testes/aviso.test.ts"
    ]
  },
  {
    "method": "POST",
    "path": "/api/v1/interno/lote",
    "tag": "Fila",
    "summary": "Roda uma rodada do lote: acompanha o run em andamento e dispara o próximo.",
    "description": "Acompanha o lote em andamento no Airflow e aplica o resultado por item (gravado ou recusado), monta e dispara o próximo lote com os pendentes (até LOTE_MAX), apaga uma vez por hora o que terminou há mais de 7 dias e avisa no Slack o que achou. Chamada pelo cron do GoDeploy a cada 20 min ou à mão; só uma rodada por vez.",
    "routeHeader": "x-cxhub-fila-token",
    "params": [
      {
        "name": "X-Godeploy-Cron",
        "in": "header",
        "type": "string",
        "required": "condicional",
        "description": "Assinatura do cron do GoDeploy, no formato t=<10 dígitos>;sig=<64 hex>; só vale quando o x-cxhub-fila-token não vem ou não confere."
      }
    ],
    "requestBody": null,
    "responses": [
      {
        "status": 200,
        "description": "Rodada feita (code OK), mesmo que o Airflow esteja fora: o que aconteceu vai em andamento e disparo. Quando outra rodada está em curso, volta {\"code\": \"OUTRA_RODADA\", \"message\": \"Outra rodada do lote está em andamento: esta não fez nada.\"}, sem os outros campos.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "OK quando a rodada rodou; OUTRA_RODADA quando outra estava em curso.",
            "enum": [
              "OK",
              "OUTRA_RODADA"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": "condicional",
            "description": "Só no OUTRA_RODADA."
          },
          {
            "name": "em",
            "type": "string",
            "required": "condicional",
            "description": "Início da rodada (ISO UTC); ausente no OUTRA_RODADA."
          },
          {
            "name": "andamento",
            "type": "object",
            "required": "condicional",
            "description": "O que a rodada fez com o lote em andamento: lote (id ou null), livre (se dava para montar outro) e estado; ausente no OUTRA_RODADA."
          },
          {
            "name": "andamento.estado",
            "type": "string",
            "required": "condicional",
            "description": "nenhum, sem_airflow, retomado, nao_listado, sem_resposta, sem_resultado, erro, ou o estado do run no Airflow (queued, running, success, failed); conforme o caso vêm também gravados, recusados, devolvidos, sem_resultado, acao (clear ou \"clear adiado\"), erro ou disparo."
          },
          {
            "name": "disparo",
            "type": "object | null",
            "required": "condicional",
            "description": "O próximo lote: null quando o andamento não liberou; senão estado e, conforme o caso, lote, casos, atualizacoes, esperando, erro, ja_existia. Ausente no OUTRA_RODADA."
          },
          {
            "name": "disparo.estado",
            "type": "string",
            "required": "condicional",
            "description": "Desfecho do disparo.",
            "enum": [
              "disparado",
              "vazio",
              "sem_airflow",
              "sem_tempo",
              "dag_pausada",
              "sem_resposta",
              "id_repetido",
              "falha_no_disparo",
              "disparo_recusado",
              "erro"
            ]
          },
          {
            "name": "limpeza",
            "type": "boolean",
            "required": "condicional",
            "description": "Se a limpeza de hora em hora rodou nesta rodada; ausente no OUTRA_RODADA."
          },
          {
            "name": "avisos",
            "type": "integer",
            "required": "condicional",
            "description": "Quantas linhas de aviso a rodada mandou ao Slack (ou ao log); ausente no OUTRA_RODADA."
          }
        ],
        "example": {
          "code": "OK",
          "em": "2026-11-04T13:20:00.512Z",
          "andamento": {
            "lote": null,
            "livre": true,
            "estado": "nenhum"
          },
          "disparo": {
            "estado": "disparado",
            "lote": "cxhub_lote__20261104T132000",
            "casos": 2,
            "atualizacoes": 1
          },
          "limpeza": true,
          "avisos": 0
        }
      },
      {
        "status": 401,
        "description": "Sem x-cxhub-fila-token válido e sem X-Godeploy-Cron aceito (ausente, fora do formato ou com t a mais de 5 min do relógio).",
        "example": {
          "code": "UNAUTHORIZED",
          "message": "x-cxhub-fila-token ausente ou inválido."
        }
      },
      {
        "status": 405,
        "description": "Método diferente de POST; conferido antes da autenticação. Vem com o header Allow: POST.",
        "example": {
          "code": "METHOD_NOT_ALLOWED",
          "message": "Use POST nesta rota."
        }
      },
      {
        "status": 429,
        "description": "X-Godeploy-Cron no formato certo, mas sem a assinatura conferida, a menos de 30 s da anterior aceita assim. Vem com o header retry-after: 30.",
        "example": {
          "code": "TOO_MANY_REQUESTS",
          "message": "Rodada recente: sem a assinatura conferida, o cron roda no máximo uma vez a cada 30 s."
        }
      },
      {
        "status": 500,
        "description": "Alguma etapa da rodada falhou (andamento, disparo ou limpeza): o corpo traz o mesmo resumo do 200 e a lista falhas; as outras etapas rodaram.",
        "fields": [
          {
            "name": "code",
            "type": "string",
            "required": true,
            "description": "Sempre INTERNAL_ERROR.",
            "enum": [
              "INTERNAL_ERROR"
            ]
          },
          {
            "name": "message",
            "type": "string",
            "required": true,
            "description": "\"A rodada falhou em: <etapas>.\""
          },
          {
            "name": "falhas",
            "type": "array",
            "required": true,
            "description": "As etapas que falharam.",
            "enum": [
              "andamento",
              "disparo",
              "limpeza"
            ]
          }
        ],
        "example": {
          "code": "INTERNAL_ERROR",
          "message": "A rodada falhou em: disparo.",
          "em": "2026-11-04T13:20:00.512Z",
          "andamento": {
            "lote": null,
            "livre": true,
            "estado": "nenhum"
          },
          "disparo": {
            "estado": "erro"
          },
          "limpeza": false,
          "avisos": 0,
          "falhas": [
            "disparo"
          ]
        }
      },
      {
        "status": 503,
        "description": "O banco do app falhou antes da rodada começar (esquema, a vez da rodada ou a trava do cron); repetir é seguro.",
        "example": {
          "code": "UNAVAILABLE",
          "message": "A fila não conseguiu ler ou gravar agora. Repetir é seguro."
        }
      }
    ],
    "notes": [
      "Duas formas de entrar: o x-cxhub-fila-token (chamada à mão) ou o X-Godeploy-Cron do cron do GoDeploy (agendado */20 * * * *, conforme docs/fila-cxhub.md).",
      "A assinatura do X-Godeploy-Cron é conferida com a GODEPLOY_CRON_KEY contra vários esquemas candidatos, porque a plataforma não documenta o dela; sem conferir, o cabeçalho passa só pelo formato, pela janela de 5 min e pelo limite de uma rodada a cada 30 s.",
      "O corpo é ignorado (só é lido, até 64 KB, para a conferência da assinatura do cron).",
      "Só uma rodada por vez: a vez dura até 2 min e é devolvida no fim; a rodada não começa a montar nem a disparar depois de 25 s.",
      "Nunca há dois lotes ao mesmo tempo: enquanto o run anterior está queued ou running, disparo vem null.",
      "Lote vazio nunca é disparado, nem com a DAG pausada; o dag_run_id é cxhub_lote__<aaaammddThhmmss> (UTC), e 409 do Airflow conta como disparado (ja_existia: true).",
      "Os avisos vão ao Slack (SLACK_ALERT_WEBHOOK_URL), um por rodada; o docs/fila-cxhub.md do CX Hub ainda diz Google Chat, mas o código (v4) usa o Slack.",
      "O resumo de cada rodada também fica em ultima_rodada de GET /api/v1/estado."
    ],
    "sources": [
      "servidor/app.ts",
      "servidor/cron.ts",
      "servidor/lote.ts",
      "servidor/airflow.ts",
      "servidor/aviso.ts",
      "servidor/banco.ts",
      "servidor/http.ts",
      "servidor/tempo.ts",
      "servidor/config.ts",
      "testes/aviso.test.ts",
      "testes/ambiente.ts",
      "cx-hub (origin/main): docs/fila-cxhub.md"
    ]
  }
];
