# Origem desta pasta

Cópia do backend do app GoDeploy `backoffice-hub` (id `0cfbc06e`, `https://backoffice-reenvio-reembolso.devgogroup.com`),
repositório local `C:\Users\Notebook\Documents\backoffice-hub`, commit `40041c1` ("caso cancelado, reembolso efetuado e
reenvio no Cosmos não se editam", publicado lá como versão 7 em 2026-11-11). Ele deixa de existir e vira uma página da
Central de Tickets, que chama este backend.

O que veio (por `git archive 40041c1 servidor shared testes`):

- `servidor/` (20 arquivos): as rotas, as regras de edição, o SQL da gold + raw, o pedido e o catálogo do Data Mart, o
  lote para a DAG e a infraestrutura (banco, Airflow, cron, Slack). O lote, o Airflow, o cron e o Slack saíram depois
  (fila única, abaixo): quem os faz é a fila deste app (`servidor/` da raiz).
- `shared/` (4 arquivos): os campos editáveis, os itens do pedido, as marcas e os tipos da API.
- `testes/` (7 arquivos): os testes de lá, com o Data Mart num Postgres em WASM (PGlite).

O que não veio, porque aqui é só o backend: a tela (`src/`, `index.html`, `vite.config.ts`, `dist/`), o `worker.ts` de lá
(a cola está no `worker.ts` da raiz) e o `scripts/conferir-dist.mjs`.

As regras de negócio estão no `CLAUDE.md` e no `README.md` de lá, e continuam valendo como estão.

## Adaptações ao app cx-hub

- **Rotas em `/api/backoffice`** (`servidor/app.ts`). O `/api/solicitacoes` já é uma rota do CX Hub neste app. Por
  dentro, o caminho continua o de lá (`/api/backoffice/eu` vira `/api/eu`), então o resto do roteamento não mudou. O
  que não é do backoffice responde 404: não há tela para servir. O log mostra o caminho com o prefixo.
- **Tabelas com prefixo `bo_`** em todo SQL do `env.DB`. O banco é o mesmo da fila, que já tem `lotes` e `controle`.
- **Fila única** (decisão de 2026-11-11, esquema 2 do `env.DB`). Lá, a edição ia para uma fila e um lote próprios
  (`edicoes`, `lotes`, `servidor/lote.ts`, com cron a cada 10 min). Aqui ela é uma atualização da fila do app (a tabela
  `atualizacoes`, a mesma das que o CX Hub manda) e sobe no lote dela. Motivo: o caso que o CX Hub acabou de registrar
  ainda está na fila, antes da raw; com a edição na mesma fila, ele já se edita, e o lote leva a criação antes da
  alteração (se o caso está num lote em andamento, a edição espera o resultado dele). O que mudou:
  - `servidor/banco.ts`: o esquema 2 apaga `bo_edicoes` e `bo_lotes` e cria `bo_autoria` (quem fez cada edição e a
    conferência dela na raw). `bo_clientes` e `bo_controle` ficam. O esquema da fila é garantido antes;
  - `servidor/edicoes.ts`: salvar grava a autoria e enfileira a atualização (`servidor/fila.ts`). O que se aplica por
    cima da linha vem da fila: as atualizações do CX Hub pendentes ou no lote (autor `CX Hub`) e as edições do backoffice
    até a raw mostrá-las. `EdicaoVisivel` ganhou `doBackoffice`. Desfazer só vale para a edição do backoffice (a do CX
    Hub responde 403) e apaga a linha da fila;
  - `servidor/gold.ts` e `servidor/fila.ts`: o caso que ainda está na fila (pendente, enviado, ou gravado há menos de
    1 h e ainda fora da réplica) entra na consulta como uma "raw virtual" (`fila_raw`): o mesmo SQL das regras do dbt
    monta a linha, e filtro, busca, contagem e cursor valem para ela;
  - `servidor/conferencia.ts` (novo): a conferência na raw das edições gravadas (6 h, com aviso) e a limpeza da
    autoria. Roda como etapa da rodada da fila (`posRodada`, ligada no `worker.ts`). Lá, a conferência apagava a edição
    do `env.DB`; aqui só marca a autoria, e a fila apaga a linha 7 dias depois, como as dela;
  - saíram `servidor/lote.ts`, `airflow.ts`, `aviso.ts`, `cron.ts` e `cripto.ts`, a rota `POST /api/interno/lote` e,
    do `servidor/config.ts`, o Airflow, o Slack, o `LOTE_MAX` e a chave do cron;
  - `GET /api/estado` mostra as edições pela fila, a fila inteira, o lote e a rodada da fila;
  - o `dag_run_id` é o da fila (`cxhub_lote__…`). O `cxhub_backoffice__…` do lote próprio deixou de existir.
- **Quem chama** (`servidor/acesso.ts`). Lá só o navegador chamava, e o autor era o `x-godeploy-user-email` que o
  gateway põe. Aqui quem chama é sobretudo outro servidor (a Central de Tickets, com a `gdk_` deste app), e o gateway
  poria no cabeçalho o dono da chave. Por isso:
  - o autor é o `x-usuario-email` que quem chama manda, e só sem ele vale o e-mail do gateway;
  - fora do formato de e-mail, a chamada leva 400, em vez de cair no dono da chave em silêncio;
  - a proteção de escrita do navegador (`x-backoffice: 1` e a origem do app) vale só quando há `Origin`. O navegador
    sempre manda `Origin` em POST e DELETE; a chamada de servidor não manda e não carrega a sessão que a proteção
    defende.
- **Motivos pela cache da rota dados** (`servidor/rotaDados.ts`): `usarFonteDaRotaDados`. No app, o corpo do
  `GET /api/v1/form-data` vem da cache do `env.DB` (`api/cacheDaRotaDados.ts`, renovada pelo cron a cada 5 min), a
  mesma que o formulário e o bot do CX Hub usam. Sem fonte, a busca é a de lá. A validação da lista e os 5 min em
  memória ficaram iguais.

## Testes

- `testes/ambiente.ts`:
  - o `node:sqlite` vem pelo `createRequire`, como no `testes/ambiente.ts` da raiz, porque o `@types/node` deste repo (20)
    não tem os tipos dele;
  - o `chamar` leva o caminho de lá (`/api/...`) para `/api/backoffice/...`;
  - a fila do app roda no mesmo banco: o `cron()` é a rodada dela (`POST /api/v1/interno/lote`, com o token e a etapa do
    backoffice ligada como no `worker.ts`), o `fila()` chama a fila como o CX Hub, e o `edicoes()` lê as edições pela
    fila com a autoria;
  - a DAG falsa grava também os casos do conf na raw.
- `testes/api.test.ts`:
  - "o que não é /api é a tela" virou "o que não é rota do backoffice é 404";
  - o teste da proteção de escrita manda `Origin`, e ganhou o caso da chamada de servidor, que passa.
- `testes/lote.test.ts`: reescrito sobre a rodada da fila (o `dag_run_id`, o conf com `casos` e `atualizacoes`, a
  conferência em `backoffice`), com os casos novos: o caso que ainda está na fila aparece, se edita e sobe no mesmo
  lote, depois do caso; o caso recusado pela DAG sai da lista e recusa a edição; a atualização do CX Hub aparece por
  cima e não se desfaz aqui (403); as duas sobem na ordem do `atualizado_em`.
- Novo: `testes/cxhub.test.ts`. Cobre o prefixo, o autor pelo `x-usuario-email` (precedência, minúsculas e 400) e os
  motivos pela fonte de fora.
- Novo, na raiz: `testes/backoffice.test.ts`. Cobre o backoffice pelo `worker.fetch`, a etapa dele na rodada da fila,
  as tabelas `bo_*` convivendo com as da fila e a subida do banco da v9 para o esquema 2.

## O que o app de origem fazia e este backend ainda não faz

- **A tela.** Ela vai ser uma página da Central de Tickets.
- **O cron do lote** não é mais preciso: o da fila (`POST /api/v1/interno/lote`, que passa a `*/10 * * * *`) leva as
  edições e roda a conferência. O app de origem tem o dele (`2tr8d04x0j3z`, `*/10` em `POST /api/interno/lote`), que
  segue até ele sair do ar.
- **Os dados que estão no `env.DB` de lá:**
  - os **dados do cliente** dos reenvios (`clientes`), que o Metabase não guarda e só existem lá;
  - as **edições** ainda pendentes ou recusadas.

  O GoDeploy não lê o `env.DB` de outro app, e o de origem não tem rota de exportação. Antes de desligá-lo, é preciso
  publicar nele uma rota que exporte essas linhas e importá-las aqui. As edições pendentes, se o app de origem rodar o
  cron até zerá-las, não precisam vir.

## Atualizar a partir do backoffice-hub

Se o app de origem mudar antes de sair do ar, regere a cópia com `git archive <commit> servidor shared testes` numa pasta
vazia e faça a mescla em 3 vias (`git merge-file`), como no `cxhub/ORIGEM.md`, refazendo as adaptações acima.
