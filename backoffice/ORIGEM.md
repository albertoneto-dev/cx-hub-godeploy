# Origem desta pasta

Cópia do backend do app GoDeploy `backoffice-hub` (id `0cfbc06e`, `https://backoffice-reenvio-reembolso.devgogroup.com`),
repositório local `C:\Users\Notebook\Documents\backoffice-hub`, commit `40041c1` ("caso cancelado, reembolso efetuado e
reenvio no Cosmos não se editam", publicado lá como versão 7 em 2026-11-11). Ele deixa de existir e vira uma página da
Central de Tickets, que chama este backend.

O que veio (por `git archive 40041c1 servidor shared testes`):

- `servidor/` (20 arquivos): as rotas, as regras de edição, o SQL da gold + raw, o pedido e o catálogo do Data Mart, o
  lote para a DAG e a infraestrutura (banco, Airflow, cron, Slack), que é a mesma da fila deste app (`servidor/` da raiz).
- `shared/` (4 arquivos): os campos editáveis, os itens do pedido, as marcas e os tipos da API.
- `testes/` (7 arquivos): os testes de lá, com o Data Mart num Postgres em WASM (PGlite).

O que não veio, porque aqui é só o backend: a tela (`src/`, `index.html`, `vite.config.ts`, `dist/`), o `worker.ts` de lá
(a cola está no `worker.ts` da raiz) e o `scripts/conferir-dist.mjs`.

As regras de negócio estão no `CLAUDE.md` e no `README.md` de lá, e continuam valendo como estão.

## Adaptações ao app cx-hub

- **Rotas em `/api/backoffice`** (`servidor/app.ts`). O `/api/solicitacoes` já é uma rota do CX Hub neste app. Por
  dentro, o caminho continua o de lá (`/api/backoffice/eu` vira `/api/eu`), então o resto do roteamento não mudou. O
  que não é do backoffice responde 404: não há tela para servir. O log mostra o caminho com o prefixo.
- **Tabelas com prefixo `bo_`** (`bo_edicoes`, `bo_lotes`, `bo_clientes`, `bo_controle`, e os índices) em todo SQL do
  `env.DB`. O banco é o mesmo da fila, que já tem `lotes` e `controle`, e as duas partes usam as vezes `rodada` e
  `limpeza` em `controle`. O SQL que vai ao Metabase (gold e raw) não mudou.
- **`dag_run_id` = `cxhub_backoffice__<aaaammddThhmmss>`** (`servidor/lote.ts`); lá era `backoffice_lote__`. Enquanto o
  app de origem estiver no ar, os dois crons (a cada 10 min) disparariam no mesmo segundo com o mesmo id. O Airflow
  responderia 409 a um deles, que tomaria o run do outro como seu.
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
  - a leitura das edições usa `bo_edicoes`.
- `testes/api.test.ts`:
  - "o que não é /api é a tela" virou "o que não é rota do backoffice é 404";
  - o teste da proteção de escrita manda `Origin`, e ganhou o caso da chamada de servidor, que passa.
- `testes/lote.test.ts`:
  - o `dag_run_id` esperado é `cxhub_backoffice__…`;
  - o lote "à mão" confere o navegador (com `Origin`, sem a proteção ⇒ 403) e o servidor (sem `Origin` ⇒ 200).
- Novo: `testes/cxhub.test.ts`. Cobre o prefixo, o autor pelo `x-usuario-email` (precedência, minúsculas e 400) e os
  motivos pela fonte de fora.
- Novo, na raiz: `testes/backoffice.test.ts`. Cobre o backoffice pelo `worker.fetch` e as tabelas `bo_*` convivendo
  com as da fila, sem uma vez travar a outra.

## O que o app de origem fazia e este backend ainda não faz

- **A tela.** Ela vai ser uma página da Central de Tickets.
- **O cron do lote.** O app de origem tem o `2tr8d04x0j3z` (`*/10 * * * *` em `POST /api/interno/lote`). Aqui a rota
  é `POST /api/backoffice/interno/lote`, e o cron precisa ser criado no GoDeploy (`createCronJob`).
- **Os dados que estão no `env.DB` de lá:**
  - os **dados do cliente** dos reenvios (`clientes`), que o Metabase não guarda e só existem lá;
  - as **edições** ainda pendentes ou recusadas.

  O GoDeploy não lê o `env.DB` de outro app, e o de origem não tem rota de exportação. Antes de desligá-lo, é preciso
  publicar nele uma rota que exporte essas linhas e importá-las aqui. As edições pendentes, se o app de origem rodar o
  cron até zerá-las, não precisam vir.

## Atualizar a partir do backoffice-hub

Se o app de origem mudar antes de sair do ar, regere a cópia com `git archive <commit> servidor shared testes` numa pasta
vazia e faça a mescla em 3 vias (`git merge-file`), como no `cxhub/ORIGEM.md`, refazendo as adaptações acima.
