# CX Hub no GoDeploy (app `cx-hub`)

Este repositório é o código do app GoDeploy `cx-hub` (id `66edd698`, https://cx-hub.devgogroup.com, visibilidade
`authenticated`). É um Cloudflare Worker com estas partes:

| Caminho | O que é | Código |
|---|---|---|
| `/api/v1/*` | A fila de registro. Guarda casos e atualizações do CX Hub no `env.DB` e manda tudo em lote ao Airflow. | `servidor/` (código deste app) |
| `/api/backoffice/*` | O backoffice de reenvio e reembolso: a lista da gold + raw (+ os casos ainda na fila) e as edições, que sobem no lote da fila | `backoffice/` (cópia do app `backoffice-hub`) |
| `/api/interno/rota-dados` | A rodada do cron que renova a cache da rota dados no `env.DB` | `api/cacheDaRotaDados.ts` |
| `/api/*` (o resto) | As 23 rotas que o CX Hub tinha na Vercel, nos mesmos caminhos, métodos e corpos | `cxhub/` (cópia do CX Hub) + `api/` (cola com o Worker) |
| `/docs` | A página da API para quem integra | `api/docs.ts` + `api/docsRotas.ts` |

O CX Hub (o site, a tela) continua no repositório `rpaiagogroup/cx-hub`. Lá estão as regras de negócio das rotas (o
`CLAUDE.md` e os ADRs de lá). Este repositório (`albertoneto-dev/cx-hub-godeploy` no GitHub) registra o que foi
publicado no GoDeploy.

## Mapa

- `worker.ts`: a entrada. Manda `/docs` para `api/docs.ts`, `/api/v1/*` para `servidor/app.ts` e o resto para
  `api/roteador.ts`.
- `servidor/`: a fila. `validacao.ts` (o que entra), `fila.ts` (as rotas), `lote.ts` (a rodada do cron), `airflow.ts`,
  `cron.ts` (quem pode chamar o lote), `aviso.ts` (o Slack) e `config.ts` (os segredos).
- `cxhub/`: a cópia do backend do CX Hub. A origem está em `cxhub/ORIGEM.md` (o commit, o que foi adaptado à mão e por
  quê, e o roteiro para atualizar).
- `backoffice/`: a cópia do backend do app `backoffice-hub` (`servidor/`, `shared/`, `testes/`). A origem, as
  adaptações e o que ainda falta estão em `backoffice/ORIGEM.md`. Usa o mesmo `env.DB` da fila, com as tabelas `bo_*`
  dele; o Airflow, o cron e o Slack são os da fila (fila única). `backoffice/servidor/fila.ts` é o que fala com a fila, e
  `conferencia.ts` é a etapa dele na rodada do cron da fila.
- `api/cacheDaRotaDados.ts`: a cache das listas da rota dados no `env.DB` e a rota do cron que a renova.
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
- **Lote:** o cron do GoDeploy chama `POST /api/v1/interno/lote` a cada 10 min (era 20 até a v9). Cada rodada:
  1. trata **um** lote por vez, de até `LOTE_MAX` itens (padrão 200), com os casos pendentes antes das atualizações;
  2. dispara a DAG `gobeaute_reenvio_reembolso_etl` com `dag_run_id = cxhub_lote__<aaaammddThhmmss>`;
  3. lê o resultado de cada item no XCom da task `gravar`;
  4. se o run falhou sem XCom, recoloca-o uma vez;
  5. não dispara lote vazio nem com a DAG pausada;
  6. uma vez por hora, apaga o que foi gravado ou recusado há mais de 7 dias;
  7. roda a etapa do backoffice (`posRodada`): a conferência das edições gravadas na raw;
  8. manda um único aviso no Slack com o que a rodada encontrou.
- **Fila única (decisão de 2026-11-11):** as edições do backoffice são atualizações desta fila, na mesma tabela das do
  CX Hub. O caso recém-chegado já se edita, e o lote leva a criação antes da alteração (a atualização de um caso que
  está num lote em andamento espera o resultado dele; a de um caso recusado é recusada).
- **Por que os passos são gravados um a um:** o lote passa por montando → disparado → terminado, cada passo gravado. Se
  uma rodada cair no meio, a seguinte retoma com o mesmo `dag_run_id` (o 409 do Airflow vale como "disparado").
- **Quem pode chamar o lote:** o cron do GoDeploy assina com `X-Godeploy-Cron`. O `servidor/cron.ts` foi escrito
  quando a plataforma não documentava a assinatura: ele tenta esquemas adivinhados, e nenhum confere (o log diz
  "nenhum esquema conferiu"). Por isso valem três travas: o formato exato do cabeçalho, o `t` a menos de 5 min do
  relógio e no máximo uma rodada a cada 30 s. À mão, a chamada usa o `x-cxhub-fila-token`.
- **O esquema documentado** (na descrição da ferramenta `createCronJob`, vista em 2026-11-12) é o HMAC-SHA256 de
  `JSON.stringify(["v1", appId, MÉTODO, url.pathname, t])`, com `t` como número e `appId` = `cx-hub` (o primeiro rótulo
  do host). A chave são os bytes UTF-8 da `GODEPLOY_CRON_KEY`. Conferir por ele ainda não foi feito: pede uma versão
  nova.
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

### O backoffice (`/api/backoffice`)

As regras vieram do app `backoffice-hub` sem mudança (`backoffice/ORIGEM.md` lista as adaptações, que são de
infraestrutura e de acesso, não de negócio).

**O que se lê**
- **A lista** é a `gold.fct_reenvio_reembolso_gobeaute` com os casos do CX Hub que a raw já mudou e a gold ainda não
  mostra, remontados da raw com **as mesmas regras do dbt** (`backoffice/servidor/raw.ts`). Mudou uma regra no dbt,
  mude lá.
- **A paginação é por cursor** (`data_solicitacao desc, chave_unica desc`), porque o Metabase não pagina SQL nativo, e
  OFFSET num filtro que muda pula ou repete linha.
- **O caso que ainda está na fila** (pendente, enviado, ou gravado há menos de 1 h e fora da réplica) entra na consulta
  como uma "raw virtual" (`backoffice/servidor/gold.ts`), montado pelo mesmo SQL do dbt: aparece, filtra, conta e se
  edita antes de o lote levá-lo à raw.
- **Por cima da linha** vem o que a fila ainda guarda: as atualizações do CX Hub pendentes ou no lote (autor `CX Hub`) e
  as edições do backoffice até a raw mostrá-las.

**O que se edita** (`editabilidade`, em `backoffice/servidor/edicoes.ts`). Uma linha só se edita quando **todas** as
regras abaixo valem; senão, `422 NOT_EDITABLE`:
1. É caso do CX Hub (`chave_unica` = `cxhub|<id>`).
2. É reenvio ou reembolso.
3. Foi solicitado há até 30 dias.
4. Não está cancelado.
5. Se é reembolso, não está `Realizado`.
6. Se é reenvio, o Cosmos ainda não o registrou (`automacao = true` na criação).

As regras 4 e 5 olham o caso **com as edições guardadas por cima**: marcar Cancelado aqui já trava a linha.

**Como cada campo se edita**
- **Campos:** a lista é fechada no contrato da DAG (`backoffice/shared/campos.ts`); campo fora dele faz a DAG recusar.
- **Motivo:** só um da lista da rota dados.
- **SKUs:** nunca se digitam. Saem dos itens do pedido no Data Mart; do kit, sempre os itens.
- **Valor do reembolso:** sai dos mesmos itens e nunca passa do total do pedido. Só se digita com exceção à política.
- **Mimo:** só do catálogo da marca, de 1 a 10 unidades.
- **Dados do cliente** do reenvio: ficam **só** no `env.DB` (`bo_clientes`), porque o Metabase não guarda dado pessoal.

**A edição na fila** (`backoffice/servidor/edicoes.ts`, `fila.ts` e `conferencia.ts`):
- salvar grava quem editou em `bo_autoria` e enfileira a atualização na fila; o lote dela a leva à DAG, com as do CX Hub,
  na ordem do `atualizado_em` (a mais nova vence);
- a gravada deixa de ser aplicada por cima quando a conferência (na rodada da fila) a vê na raw; se não aparecer em
  6 h, sai da tela com aviso;
- na segunda falha sem resultado, a edição é recusada (regra da fila); a recusada fica 7 dias, para quem editou ver
  o motivo;
- desfazer só vale para a edição do backoffice, pendente ou recusada: a atualização do CX Hub responde 403.

**Quem chama:** o autor é o `x-usuario-email` (a pessoa na tela de quem chama). Sem ele, vale o e-mail do gateway.

### A cache da rota dados

As listas da rota dados (marcas, responsáveis, motivos, transportadoras) ficam no `env.DB`. O motivo é que cada chamada
a outro app do GoDeploy paga o gateway de novo, cerca de 0,8 s medidos em 2026-11-11.

| Situação | O que acontece |
|---|---|
| Cache com menos de 15 min | Vale a cache |
| Cache mais velha | Busca ao vivo e guarda |
| Rota dados fora | Vale a última resposta boa até 24 h |
| Cron | Renova a cache a cada 5 min, para quem lê quase sempre acertar |

### Os crons

| Rota | Agenda |
|---|---|
| `POST /api/v1/interno/lote` (a fila e as edições do backoffice) | `*/10 * * * *` |
| `POST /api/interno/rota-dados` (a cache) | `*/5 * * * *` |

O backoffice não tem cron próprio (fila única). A cada 10 min, o Airflow recebe no máximo 6 runs por hora, e só quando há
o que mandar: o lote vazio não dispara, e nunca há dois ao mesmo tempo.

O app ainda não confere a assinatura do cron (veja "Quem pode chamar o lote"), então vale a trava de 30 s. Ela é **uma
por rota**, porque os horários coincidem. Criar ou mudar cron é mudar o GoDeploy: só quando o usuário pedir.

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
2. Ninguém publicou desde a última versão: confira `version` e `updatedAt` no `getApp`. O código no ar é o do último
   commit: compare os tamanhos do `getApp` com `include: ["manifest"]` com os de `git cat-file -s HEAD:<caminho>`.
3. Envie para o upload: `worker.ts`, `servidor/`, `api/`, `cxhub/**/*.ts` sem `cxhub/__tests__`, e
   `backoffice/servidor/` e `backoffice/shared/` (178 arquivos na v10). A lista sai do comando abaixo. Contra a lista
   da versão anterior, só podem mudar os arquivos que a mudança criou ou apagou.

   ```bash
   { echo worker.ts; find servidor api backoffice/servidor backoffice/shared -type f; find cxhub -type f -name '*.ts' -not -path 'cxhub/__tests__/*'; } | LC_ALL=C sort
   ```

   Use `getUploadToken` e depois, pelo Git Bash, um único `curl` com um `-F "<caminho>=@./<caminho>"` por arquivo e
   `-H "Authorization: Bearer <uploadToken>"`. Os 4 caminhos com `[id]` passam como estão. Um `internal_error` avulso
   do upload foi passageiro: tente de novo com um token novo.
4. Rode `updateApp` com o `uploadId`, `entrypoint: "worker.ts"` e a descrição revista para o que mudou.
5. Confira: a `version` nova no `getApp`, e no `getAppLogs` a fila com 200 e a rodada seguinte do cron sem erro.

**Não sobem:** `docs/`, `testes/`, `ferramentas/`, `tipos-do-worker/`, `.env*`, `package.json`, os `tsconfig*`,
`vitest.config.ts`, `cxhub/__tests__`, `cxhub/ORIGEM.md`, `backoffice/testes/`, `backoffice/ORIGEM.md` e este arquivo.
O que a página `/docs` precisa mostrar mora em `api/`, por isso.

## Git

- O remoto `origin` é `git@github.com:albertoneto-dev/cx-hub-godeploy.git`. A `main` espelha as versões publicadas:
  **um commit por versão** (`feat(fila): … (v5)`), e só quando o usuário pedir.
- Quando o usuário pede, o trabalho vai num branch: a v9 e a v10 foram feitas no `feat/melhorias-cx-godeploy`. Quando
  ele pede o merge, a `main` avança por fast-forward, sem commit de merge.
- **Push só quando o usuário pedir**, nunca com `--force`, e **pelo WSL**, porque a chave SSH do GitHub só funciona lá.
  Use um script `.sh` com `cd /mnt/c/Users/Notebook/Documents/cx-hub-godeploy && git push origin main`, chamado com
  `wsl.exe -d Ubuntu-24.04 -- bash <script>.sh`.
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
- **Regra obrigatória: a página `https://cx-hub.devgogroup.com/docs` reflete sempre o estado atual da API.** Toda
  mudança numa rota atualiza a página **na mesma mudança**:
  - rota adicionada, removida ou renomeada;
  - parâmetro, header, corpo, resposta ou status que mudou;
  - mudança de lógica no funcionamento da rota (o que ela grava, quando recusa, prazos, regras de edição, cache, cron).

  O que atualizar:
  - a especificação em `api/docsRotas.ts`, com exemplos fictícios;
  - os textos do guia em `api/docs.ts`, quando a regra aparece lá (autenticação, crons, backoffice).

  O `testes/docs.test.ts` exige que as rotas da página e as que o app atende sejam as mesmas, mas não confere a lógica:
  essa parte é responsabilidade de quem muda. Mudança de rota sem a página atualizada não está pronta para publicar.
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
- **Mudou qualquer rota (adição, remoção, edição ou lógica): atualize a página `/docs` na mesma mudança**, como diz a
  seção "A página `/docs`". Ela é o contrato que quem integra lê, e tem de mostrar o estado atual da API.
