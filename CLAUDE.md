# CX Hub no GoDeploy (app `cx-hub`)

Este repositório é o código do app GoDeploy `cx-hub` (id `66edd698`, https://cx-hub.devgogroup.com, visibilidade
`authenticated`). É um Cloudflare Worker com três partes:

| Caminho | O que é | Código |
|---|---|---|
| `/api/v1/*` | A fila de registro. Guarda casos e atualizações do CX Hub no `env.DB` e manda tudo em lote ao Airflow. | `servidor/` (código deste app) |
| `/api/*` (o resto) | As 23 rotas que o CX Hub tinha na Vercel, nos mesmos caminhos, métodos e corpos | `cxhub/` (cópia do CX Hub) + `api/` (cola com o Worker) |
| `/docs` | A página da API para quem integra | `api/docs.ts` + `api/docsRotas.ts` |

O CX Hub (o site, a tela) continua no repositório `rpaiagogroup/cx-hub`. Lá estão as regras de negócio das rotas (o
`CLAUDE.md` e os ADRs de lá). Este repositório não tem remoto: ele só registra o que foi publicado no GoDeploy.

## Mapa

- `worker.ts`: a entrada. Manda `/docs` para `api/docs.ts`, `/api/v1/*` para `servidor/app.ts` e o resto para
  `api/roteador.ts`.
- `servidor/`: a fila. `validacao.ts` (o que entra), `fila.ts` (as rotas), `lote.ts` (a rodada do cron), `airflow.ts`,
  `cron.ts` (quem pode chamar o lote), `aviso.ts` (o Slack) e `config.ts` (os segredos).
- `cxhub/`: a cópia do backend do CX Hub. A origem está em `cxhub/ORIGEM.md` (o commit, o que foi adaptado à mão e por
  quê, e o roteiro para atualizar).
- `api/`: a cola com o Worker. `roteador.ts` (as 23 rotas), `next-server.ts` (o pouco do Next que as rotas usam),
  `ambiente.ts` (o `process.env` montado dos segredos), `filaNoWorker.ts` (as rotas falam com a fila sem rede) e a
  página `/docs`.
- `testes/`: os testes da fila, da cola e da página. `cxhub/__tests__`: os testes portados do CX Hub.
- `ferramentas/`: `portar-do-cxhub.mjs` (gera a cópia do CX Hub) e `workerd/conferir.mjs` (roda o Worker empacotado no
  workerd).
- `docs/api.md`: a referência técnica para quem mantém o app. `.env.example`: todos os segredos, com o motivo de cada um.

## Regras de negócio

### A fila (`/api/v1`)

- **Tipos:** `REENVIO`, `REEMBOLSO` e `CANCELAMENTO`.
- **Marcas:** a única lista é `MARCAS`, em `servidor/validacao.ts`. São as 6 do Cosmos (lescent, kokeshi, bysamia, aua,
  barbours, rituaria), as 3 sem Cosmos (apice, yenzah, denavita: ADR-013 do CX Hub) e `gobeaute`, o site multimarca, que
  é registrado como marca própria (ADR-014). Marca nova entra ali, ou a fila recusa o caso.
- **Entrada:** cada chamada aceita de 1 a 10 itens, e um item inválido recusa a chamada inteira. O `id_solicitacao`
  segue `^[A-Za-z0-9-]{1,64}$`. Na atualização, o `id_atualizacao` é um UUID e o `atualizado_em` precisa ter fuso.
- **Escrita idempotente:** um `INSERT … ON CONFLICT DO NOTHING` por chamada. Repetir o mesmo id não duplica nem
  sobrescreve, e uma falha no meio não deixa metade gravada. Por isso o 503 da fila diz "repetir é seguro".
- **Lote:** o cron do GoDeploy chama `POST /api/v1/interno/lote` a cada 20 min. Cada rodada:
  1. trata **um** lote por vez, de até `LOTE_MAX` itens (padrão 200), com os casos pendentes antes das atualizações;
  2. dispara a DAG `gobeaute_reenvio_reembolso_etl` com `dag_run_id = cxhub_lote__<aaaammddThhmmss>`;
  3. lê o resultado de cada item no XCom da task `gravar`;
  4. se o run falhou sem XCom, recoloca-o uma vez;
  5. não dispara lote vazio nem com a DAG pausada;
  6. uma vez por hora, apaga o que foi gravado ou recusado há mais de 7 dias;
  7. manda um único aviso no Slack com o que a rodada encontrou.
- **Por que os passos são gravados um a um:** o lote passa por montando → disparado → terminado, cada passo gravado. Se
  uma rodada cair no meio, a seguinte retoma com o mesmo `dag_run_id` (o 409 do Airflow vale como "disparado").
- **Quem pode chamar o lote:** o cron do GoDeploy assina com `X-Godeploy-Cron`, mas a plataforma não documenta o
  esquema da assinatura. Por isso, além da conferência, há três travas: o formato exato do cabeçalho, o `t` a menos de
  5 min do relógio e no máximo uma rodada a cada 30 s. À mão, a chamada usa o `x-cxhub-fila-token`.
- **Airflow em http:** o Airflow de produção só responde em http (decisão de 18/09/2026), então o app aceita http.

### As rotas do CX Hub

O contrato é o da Vercel: os mesmos caminhos, métodos, corpos e respostas de sucesso. As regras que pesam para quem chama:

- **200 com `code` de erro** (`SHEETS_ERROR`, `UNKNOWN_ERROR`) quer dizer "registrado, não repita". Os chamadores
  dependem disso.
- **`testMode: true`** não grava nada. É o jeito de ensaiar, porque o `COSMOS_RESEND_SIMULADO` da Vercel não vale aqui:
  este app é a produção.
- **Duplicatas:** o `/api/sheets/append` e o `/api/refund/submit` bloqueiam a mesma solicitação dentro de 24 h.
- **Planilha junto da fila:** cada registro grava a linha na planilha da marca junto com a fila (ADR-010).
- **Marcas sem Cosmos:** Ápice, Yenzah e Denavita leem a Shopify pelo integrations-gateway, que só enxerga os últimos 60
  dias. A Gobeaute registra só na fila. As marcas que o bot aceita vêm da rota dados (ADR-015).
- **Rituária (decisão deste app, 2026-11-10):** no `/api/shopify/orders`, o pedido dela vem pelo integrations-gateway,
  porque o app não tem o `SHOPIFY_TOKEN_RITUARIA`. Em todo o resto, inclusive no bot, ela continua no Cosmos.
- **Bot de reenvio (`/api/reenvio/bot`):**
  - pede a `gdk_` **e** o `x-bot-secret`. O login do GoDeploy deixa entrar qualquer pessoa do grupo, e esta rota cria
    pedido no Cosmos;
  - falha fechada: sem `BOT_RESEND_SECRET` cadastrado, responde 503 para tudo;
  - os valores do `reason` são contrato com o Typebot, que decide a resposta à cliente por eles. Não renomeie;
  - organiza o trabalho para caber em 150 s;
  - `BOT_RESEND_EXECUTE=off` desliga a execução no Cosmos sem deploy, e a linha continua sendo registrada.
- **Avisos (ADR-005): avisam sistema quebrado, não dado errado da cliente.** Vão ao Slack (`SLACK_ALERT_WEBHOOK_URL`), e
  a mesma causa sai no máximo uma vez a cada 15 min. Um aviso nunca muda o desfecho da chamada. Sem o webhook, vão só
  ao log. Em 2026-11-11 o webhook ainda não estava cadastrado.

### Autenticação

O app é `authenticated`: o gateway do GoDeploy confere a chave `gdk_` (emitida **para este app**; a de outro app leva
403) ou a sessão do navegador. Sem nenhuma das duas, responde 302 para o login.

Como o `Authorization` passou a ser do gateway, a credencial de cada rota foi para outro header:

| Rota | Header |
|---|---|
| Rotas que usam o token do Cosmos | `x-cosmos-token` (o roteador o põe no `Authorization` só para a rota) |
| Bot | `x-bot-secret` |
| Fila | `x-cxhub-fila-token` |

A `gdk_` é tirada antes da rota e nunca chega ao Cosmos.

## Como rodar os testes

Não há Node no Windows desta máquina. Tudo roda no WSL `Ubuntu-24.04`, com o Node v24 do nvm (os testes usam
`node:sqlite`, que exige Node ≥ 22). Rode sempre por um script `.sh`, e não por `bash -c`: o Git Bash estraga os
caminhos `/mnt/...` e o `wsl.exe` divide de novo os argumentos.

```bash
# script.sh, chamado com: wsl.exe -d Ubuntu-24.04 -- bash /mnt/c/.../script.sh
export PATH=/home/ubuntu-24/.nvm/versions/node/v24.20.0/bin:$PATH
rsync -a --delete --exclude node_modules --exclude .git --exclude .env /mnt/c/Users/Notebook/Documents/cx-hub-godeploy/ ~/cxfila/
cd ~/cxfila && [ -d node_modules ] || npm install
npm run checar   # tsc com os tipos do Node, e tsc do Worker sem eles
npm test         # a fila, a cola, a página /docs e os testes do CX Hub
npm run workerd  # o worker.ts empacotado no workerd, sem nodejs_compat
```

O `npm run workerd` usa o miniflare e o esbuild de `~/cx-workerd` (fora do repositório: `npm install miniflare@4
esbuild@0.25`). Os três precisam passar antes de publicar.

**O Worker roda sem `nodejs_compat`.** Por isso, no código que sobe:
- não use `Buffer`, `node:crypto` nem `process` na carga do módulo (o env é lido na chamada);
- não use `cache: 'no-store'` no `fetch`.

## Como publicar

Publicar é mexer em produção: só quando o usuário pedir.

1. Os três checks passaram.
2. Ninguém publicou desde a última versão: confira `version` e `updatedAt` no `getApp`. O código no ar é o do disco:
   confira com o `getApp` com `include: ["manifest"]` (caminho e tamanho de cada arquivo).
3. Envie para o upload: `worker.ts`, `servidor/`, `api/` e `cxhub/**/*.ts` sem `cxhub/__tests__` (156 arquivos na v8).
   Use `getUploadToken` e depois `curl -F "<caminho>=@./<caminho>"` para cada arquivo, com
   `-H "Authorization: Bearer <uploadToken>"`. Os 4 caminhos com `[id]` passam como estão. Um `internal_error` avulso
   do upload foi passageiro: tente de novo com um token novo.
4. Rode `updateApp` com o `uploadId`, `entrypoint: "worker.ts"` e a descrição revista para o que mudou.
5. Confira: a `version` nova no `getApp`, e no `getAppLogs` a fila com 200 e a rodada seguinte do cron sem erro.

**Não sobem:** `docs/`, `testes/`, `ferramentas/`, `tipos-do-worker/`, `.env*`, `package.json`, os `tsconfig*`,
`vitest.config.ts`, `cxhub/__tests__`, `cxhub/ORIGEM.md` e este arquivo. O que a página `/docs` precisa mostrar mora em
`api/`, por isso.

## Git

- Repositório só local, branch `main`, sem remoto. Ele espelha as versões publicadas: **um commit por versão**
  (`feat(fila): … (v5)`), e só quando o usuário pedir.
- `core.autocrlf=false` de propósito: os arquivos ficam em LF.

## Atualizar a partir do CX Hub

O `cxhub/` é a cópia de um commit do CX Hub (o commit está em `cxhub/ORIGEM.md`). Não edite esses arquivos sem
registrar a adaptação no `ORIGEM.md`: é ele que separa o que veio do CX Hub do que foi mudado aqui.

- **Ver se o CX Hub mudou:** rode `git fetch` no clone `C:\Users\Notebook\Documents\cx-hub` **pelo WSL** (a chave SSH
  do GitHub só funciona lá). Compare o `origin/main` com o commit do `ORIGEM.md`. Para ter certeza, regere a cópia crua
  (`node ferramentas/portar-do-cxhub.mjs --cxhub <clone> --rev origin/main --saida <pasta vazia>`) e rode
  `diff -rq <pasta>/cxhub cxhub`. As diferenças precisam ser exatamente as adaptações listadas no `ORIGEM.md`.
- **Trazer um commit novo:** siga o roteiro "Atualizar para um commit novo do CX Hub" do `ORIGEM.md` (mescla em 3
  vias). Rota nova entra em `api/roteador.ts`, em `docs/api.md` e na página `/docs`; env nova entra no `.env.example`.

## Segredos

- Todo segredo que o código lê ou que é criado entra no `.env.example`, com o motivo dele e o que acontece sem ele. Só
  os valores de configuração que não são segredo vão preenchidos.
- O `.gitignore` barra `.env` e `.env.*` e deixa passar o `.env.example`.
- Quem cadastra os valores no console do GoDeploy é o usuário. Passe a ele a lista de nomes, em ordem, e confirme
  depois com `listAppSecrets`, que mostra só os nomes. Nunca leia um `.env` para dentro da conversa nem ponha um valor
  em log, mensagem, commit ou ticket.

## A página `/docs`

- **Arquivos:** `api/docsRotas.ts` tem a especificação de cada endpoint (headers, parâmetros, corpo, respostas por status
  e exemplos), levantada do código das rotas. `api/docs.ts` a transforma em HTML e soma o guia da migração.
- **Mudou rota, header ou resposta:** atualize a especificação. O `testes/docs.test.ts` exige que toda rota do roteador
  e da fila esteja nela, com o método certo.
- **Visual:** o da marca Gogroup (azul `#2659a5` como cor principal, acento lima `#d7d900`, Poppins, cantos
  arredondados, blocos de cor chapada).
- **Sem logos:** o usuário decidiu em 2026-11-11 que eles não sobem ao GoDeploy. Não escreva "Gogroup" estilizado no
  lugar do logo.
- **Sem script:** a CSP só libera a Poppins do Google Fonts.
- **Exemplos fictícios:** nada de dado de cliente, token ou segredo.

## Como trabalhar neste repositório

- **Subagentes:** só depois de perguntar ao usuário e ele aprovar. Diga quantos, o que cada um faria e por que é melhor
  que fazer direto. Aprovado, rode em **Sonnet** (`model: "sonnet"`), nunca em Opus: quem orquestra já é o modelo
  principal, e vários Opus abaixo dele só multiplicam o custo. O `fork` herda o modelo principal, então não serve:
  use um agente `general-purpose` com `model: "sonnet"`. Por padrão, faça o trabalho direto.
- **Idioma:** português do Brasil no código, nos comentários, nas mensagens de erro e na documentação. Os comentários
  explicam o porquê; o quê, o código já mostra.
- **Mudança de comportamento** em relação ao CX Hub entra no `cxhub/ORIGEM.md` ("Decisões deste app") e em
  `docs/api.md`.
