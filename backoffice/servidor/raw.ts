// A raw de eventos do CX Hub (raw.cxhub_reenvio_reembolso_eventos) remontada no formato da gold, com as MESMAS regras
// do dbt (repo do Airflow, dbt/gobeaute_reenvio_reembolso): a limpeza de cada campo é a de macros/rr_limpeza.sql
// (como o stg_cxhub_reenvio_reembolso_eventos a aplica) e o estado do caso é o do int_reenvio_reembolso_gobeaute:
//   - identidade (tipo, marca, data, pedido) vem da criação mais recente; sem criação, o caso não existe;
//   - em cada outro campo vale o evento mais recente que trouxe o campo: atualização vence criação, e entre
//     atualizações vale o disparo mais recente (no empate, a posição maior no array do conf).
// Por que: a gold só é montada de hora em hora (gobeaute_reenvio_reembolso_dbt, no minuto :20), e a raw recebe o caso
// e a atualização no fim de cada lote. Assim, o que a lista mostra agora é o que a gold vai mostrar depois do dbt.
// MUDOU UMA REGRA NO DBT, MUDE AQUI (e o teste em testes/raw.test.ts).
//
// Nada de "?" fora de literal: o JDBC do Metabase lê "?" como parâmetro (por isso `(payload -> 'x') is not null` no
// lugar de `payload ? 'x'`, como o CX Hub faz em shared/lib/airflow/raw.ts).

// ─── As macros de rr_limpeza.sql, como expressões SQL ───────────────────────

const semAcento = (x: string) => `translate(lower(${x}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;

// '', '-', '--' e 'empty' viram ''.
const textoCampo = (x: string) =>
  `(case when btrim(coalesce(${x}, '')) in ('', '-', '--') or lower(btrim(${x})) = 'empty' then '' else btrim(${x}) end)`;

// Espaços colapsados; marcador de vazio vira NULL.
const textoSimples = (x: string) =>
  `(case when lower(regexp_replace(btrim(coalesce(${x}, '')), '\\s+', ' ', 'g')) in ('', '-', '--', '---', '_', '__', '___', 'n/a', 'na', '#n/a', 'empty', 'null', 'undefined') `
  + `then null else regexp_replace(btrim(${x}), '\\s+', ' ', 'g') end)`;

const nomePessoa = (x: string) => `initcap(${textoSimples(x)})`;

// Número do JSON, ou texto em reais ('R$ 1.234,56', '129,9', '129.9').
const valor = (j: string, campo: string) =>
  `(case jsonb_typeof(${j} -> '${campo}') when 'number' then round((${j} ->> '${campo}')::numeric, 2) `
  + `when 'string' then (select case when t ~ '^-?[0-9]+(\\.[0-9]+)?$' then round(t::numeric, 2) end `
  + `from (select case when s !~ ',' then s else replace(replace(regexp_replace(s, ',(?=.*,)', '', 'g'), '.', ''), ',', '.') end as t `
  + `from (select replace(replace(btrim(${j} ->> '${campo}'), 'R$', ''), ' ', '') as s) a) b) end)`;

// SKUs separados por ';' (vírgula e ' / ' também separam); vazio é '-'.
const sku = (x: string) =>
  `coalesce(nullif(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(btrim(coalesce(${x}, '')), `
  + `'\\s*;\\s*', ';', 'g'), '\\s*,\\s*', ';', 'g'), '\\s+/\\s+', ';', 'g'), '\\s+', ' ', 'g')), ''), '-')`;

const pedidoCompleto = (x: string) =>
  `(case when ${textoCampo(x)} = '' then '' when ${semAcento(x)} like '%total%' or ${semAcento(x)} like '%sim%' then 'Sim' `
  + `when ${semAcento(x)} like '%parcial%' or ${semAcento(x)} like '%nao%' then 'Não' else ${textoCampo(x)} end)`;

// Booleano do CX Hub -> Sim/Não; texto passa pelo pedidoCompleto; ausente é NULL.
const simNao = (j: string, campo: string) =>
  `(case jsonb_typeof(${j} -> '${campo}') when 'boolean' then case when (${j} ->> '${campo}')::boolean then 'Sim' else 'Não' end `
  + `else nullif(${pedidoCompleto(`${j} ->> '${campo}'`)}, '') end)`;

const erp = (x: string) =>
  `(case when ${textoCampo(x)} = '' or lower(btrim(${x})) = 'na' then '' when lower(${x}) like '%tiny%' then 'Tiny' `
  + `when lower(${x}) like '%protheus%' then 'Protheus' else ${textoCampo(x)} end)`;

const opcao = (x: string, opcoes: string[]) =>
  `(case lower(${textoSimples(x)}) ${opcoes.map(o => `when '${o.toLowerCase()}' then '${o}'`).join(" ")} else ${textoSimples(x)} end)`;

const statusExecucao = (x: string) =>
  `(case lower(${textoSimples(x)}) when 'realizado' then 'Realizado' when 'cancelado' then 'Cancelado' when 'pendente' then 'Pendente' else ${textoSimples(x)} end)`;

const idAtendimento = (x: string) =>
  `coalesce((regexp_match(${textoSimples(x)}, 'conversations/(\\d+)'))[1], (regexp_match(${textoSimples(x)}, '^#?\\s*(\\d+)$'))[1])`;

// dd/mm/aaaa, aaaa-mm-dd, dd-mm-aa(aa) ou o número serial do Sheets -> date; impossível ou fora de 2024..ano+1 é NULL.
const data = (x: string) =>
  `(select case when serial is not null then case when extract(year from date '1899-12-30' + serial) between 2024 and extract(year from current_date) + 1 then date '1899-12-30' + serial end `
  + `when a is null or a < 2024 or a > extract(year from current_date)::int + 1 then null when m < 1 or m > 12 or d < 1 then null `
  + `when d > extract(day from (make_date(a, m, 1) + interval '1 month - 1 day'))::int then null else make_date(a, m, d) end `
  + `from (select coalesce(br[3], iso[1], case when length(dma[3]) = 2 then '20' || dma[3] else dma[3] end)::int as a, `
  + `coalesce(br[2], iso[2], dma[2])::int as m, coalesce(br[1], iso[3], dma[1])::int as d, (regexp_match(s, '^(\\d{5})(\\.\\d+)?$'))[1]::int as serial `
  + `from (select regexp_match(s, '^(\\d{1,2})/(\\d{1,2})/(\\d{4})') as br, regexp_match(s, '^(\\d{4})-(\\d{1,2})-(\\d{1,2})') as iso, `
  + `regexp_match(s, '^(\\d{1,2})-(\\d{1,2})-(\\d{2}|\\d{4})$') as dma, s from (select btrim(${x}) as s) s0) x) y)`;

// ISO 8601 do CX Hub -> hora de Fortaleza sem fuso, no segundo. Sem offset já é Fortaleza.
const criadoEm = (x: string) =>
  `date_trunc('second', case when btrim(${x}) ~ '(Z|[+-]\\d{2}(:?\\d{2})?)$' then (btrim(${x})::timestamptz at time zone 'America/Fortaleza') else btrim(${x})::timestamp end)`;

const codigoMarca = (x: string) => `regexp_replace(${semAcento(x)}, '[^a-z]', '', 'g')`;

const marca = (codigo: string) =>
  `(case ${codigo} when 'lescent' then 'Lescent' when 'kokeshi' then 'Kokeshi' when 'bysamia' then 'By Samia' when 'aua' then 'Auá' `
  + `when 'barbours' then 'Barbour''s' when 'rituaria' then 'Rituária' when 'apice' then 'Ápice' when 'yenzah' then 'Yenzah' `
  + `when 'denavita' then 'Denavita' when 'gobeaute' then 'Gobeaute' end)`;

const sigla = (codigo: string) =>
  `(case ${codigo} when 'lescent' then 'LE' when 'kokeshi' then 'KO' when 'bysamia' then 'BS' when 'aua' then 'AU' when 'barbours' then 'BB' `
  + `when 'rituaria' then 'RT' when 'apice' then 'AP' when 'yenzah' then 'YE' when 'denavita' then 'DV' when 'gobeaute' then 'GB' end)`;

const erpSemCosmos = (codigo: string) =>
  `(case ${codigo} when 'apice' then 'Tiny' when 'yenzah' then 'Protheus' when 'denavita' then 'Protheus' when 'gobeaute' then 'Bling' end)`;

const ehVendah = (x: string) => `(${semAcento(`coalesce(${x}, '')`)} ~ 'vend?ah')`;

// A chave_unica que o dbt dá ao caso do CX Hub.
export const chaveDoCaso = (id: string) => `'cxhub|' || btrim(regexp_replace(${semAcento(id)}, '\\s+', ' ', 'g'))`;

// ─── Os campos do caso: coluna da gold, chave no payload e a limpeza do stg ────

const P = "e.payload";
const campo = (chave: string) => `${P} ->> '${chave}'`;

type CampoDoEvento = { coluna: string; chave: string; expr: string };

export const CAMPOS_DO_EVENTO: readonly CampoDoEvento[] = [
  { coluna: "cod_nf_original", chave: "nf", expr: textoCampo(campo("nf")) },
  { coluna: "chave_nf", chave: "chave_nf", expr: textoCampo(campo("chave_nf")) },
  { coluna: "valor_nf_tratado", chave: "valor", expr: valor(P, "valor") },
  { coluna: "sku_produto_problema", chave: "skus", expr: sku(campo("skus")) },
  { coluna: "uf_destino", chave: "uf", expr: textoCampo(campo("uf")) },
  { coluna: "uf_origem", chave: "cd_origem", expr: textoCampo(campo("cd_origem")) },
  { coluna: "status_ocorrencia", chave: "status_pedido", expr: textoCampo(campo("status_pedido")) },
  { coluna: "transportadora", chave: "transportadora", expr: textoCampo(campo("transportadora")) },
  { coluna: "lote", chave: "lote", expr: textoCampo(campo("lote")) },
  { coluna: "erp", chave: "erp", expr: erp(campo("erp")) },
  { coluna: "parcial_completo", chave: "pedido_completo", expr: simNao(P, "pedido_completo") },
  { coluna: "pedido_devolvido_operacao", chave: "devolucao", expr: simNao(P, "devolucao") },
  { coluna: "responsavel_atendimento", chave: "responsavel", expr: nomePessoa(campo("responsavel")) },
  { coluna: "origem_solicitacao", chave: "origem", expr: textoSimples(campo("origem")) },
  { coluna: "id_atendimento", chave: "id_atendimento", expr: idAtendimento(campo("id_atendimento")) },
  { coluna: "data_pedido_original_coorte", chave: "data_pedido", expr: data(campo("data_pedido")) },
  { coluna: "motivo", chave: "motivo", expr: `btrim(coalesce(${campo("motivo")}, ''))` },
  { coluna: "status_execucao", chave: "status_execucao", expr: statusExecucao(campo("status_execucao")) },
  { coluna: "data_execucao", chave: "data_execucao", expr: data(campo("data_execucao")) },
  // O reenvio que o CX Hub mandou ao Cosmos pela automação já nasce com o responsável (regra do int).
  {
    coluna: "responsavel_execucao",
    chave: "responsavel_execucao",
    expr: `(case when e.tipo_evento = 'caso' then case when upper(btrim(${campo("tipo")})) = 'REENVIO' and jsonb_typeof(${P} -> 'automacao') = 'boolean' `
      + `and (${campo("automacao")})::boolean then 'Automação' end else ${nomePessoa(campo("responsavel_execucao"))} end)`,
  },
  { coluna: "cod_nfd", chave: "cod_nfd", expr: textoCampo(campo("cod_nfd")) },
  { coluna: "produtos_reenvio", chave: "produtos_reenvio", expr: textoSimples(campo("produtos_reenvio")) },
  { coluna: "transportadora_reenvio", chave: "transportadora_reenvio", expr: textoSimples(campo("transportadora_reenvio")) },
  { coluna: "tipo_solicitacao", chave: "tipo_solicitacao", expr: opcao(campo("tipo_solicitacao"), ["Reenvio", "Cashback"]) },
  { coluna: "escopo_reembolso", chave: "escopo_reembolso", expr: textoSimples(campo("escopo_reembolso")) },
  { coluna: "excecao_politica", chave: "excecao_politica", expr: `(case when jsonb_typeof(${P} -> 'excecao_politica') = 'boolean' then (${campo("excecao_politica")})::boolean end)` },
  { coluna: "ticket_transportadora", chave: "ticket_transportadora", expr: textoSimples(campo("ticket_transportadora")) },
];

// A ordem do int: atualização vence criação; depois o disparo mais recente; no empate, a posição maior no conf.
const ORDEM = "(tipo_evento = 'atualizacao') desc, disparado_em desc, posicao desc nulls last, evento_id desc";

// Colunas que só a gold calcula (área pelo de-para do motivo, prazo, chave da NFD): para o caso fresco, as da gold.
const SO_DA_GOLD = ["area", "prazo_execucao", "chave_nfd"];

// Regra por tipo do int: cada campo vale no seu tipo (o SKU com problema, fora do reenvio, é '-').
const SO_NO_TIPO: Record<string, { tipos: string[]; senao: string }> = {
  sku_produto_problema: { tipos: ["REENVIO"], senao: "'-'" },
  produtos_reenvio: { tipos: ["REENVIO"], senao: "null" },
  transportadora_reenvio: { tipos: ["REENVIO"], senao: "null" },
  tipo_solicitacao: { tipos: ["REENVIO"], senao: "null" },
  escopo_reembolso: { tipos: ["REEMBOLSO"], senao: "null" },
  excecao_politica: { tipos: ["REEMBOLSO"], senao: "null" },
  ticket_transportadora: { tipos: ["REENVIO", "REEMBOLSO"], senao: "null" },
};

export type Escopo = { tabelaGold: string; tabelaRaw: string; idSolicitacao?: string | null; literal: (s: string) => string };

// As CTEs "pendentes" e "frescos". pendentes: os casos do CX Hub com evento que a gold ainda não mostra (o maior
// _loaded_at dos eventos passou o da linha na gold, ou a gold nem tem o caso) e que têm criação na raw. frescos: esses
// casos como o próximo dbt os montará, coluna a coluna: o valor da raw vale quando o evento que o definiu é mais novo
// que a linha da gold; senão, o da gold (que guarda o que só ela calcula, como o status do reenvio vindo do Cosmos).
// Com idSolicitacao, só aquele caso (a leitura de um caso); sem ele, os eventos do último dia antes do último dbt em
// diante (o que pode não estar na gold).
export function ctesDosCasosFrescos(o: Escopo): string {
  const g = o.tabelaGold;
  const raw = o.tabelaRaw;
  const recorte = o.idSolicitacao
    ? `e.id_solicitacao = ${o.literal(o.idSolicitacao)}`
    : `e._loaded_at > (select coalesce(max(_loaded_at), '-infinity'::timestamptz) - interval '1 day' from ${g} where sistema_origem = 'CX Hub')`;
  const valores = CAMPOS_DO_EVENTO.map(c => `${c.expr} as ${c.coluna}`).join(",\n    ");
  const filtro = (c: CampoDoEvento) => `filter (where tipo_evento = 'caso' or (payload -> '${c.chave}') is not null)`;
  const agregados = CAMPOS_DO_EVENTO.map(c =>
    `(array_agg(${c.coluna} order by ${ORDEM}) ${filtro(c)})[1] as x_${c.coluna},\n    (array_agg(_loaded_at order by ${ORDEM}) ${filtro(c)})[1] as l_${c.coluna}`,
  ).join(",\n    ");
  const mais = (c: string) => `(case when s.l_${c} > coalesce(g._loaded_at, '-infinity'::timestamptz) then s.x_${c} else g.${c} end)`;
  const porTipo = (c: string, expr: string) => {
    const r = SO_NO_TIPO[c];
    return r ? `(case when c.tipo in (${r.tipos.map(t => `'${t}'`).join(", ")}) then ${expr} else ${r.senao} end)` : expr;
  };
  const colunas = CAMPOS_DO_EVENTO.map(c => {
    let expr = porTipo(c.coluna, mais(c.coluna));
    if (c.coluna === "erp") expr = `coalesce(nullif(${expr}, ''), ${erpSemCosmos("c.marca_codigo")}, ${expr})`;
    // Sem a data do pedido no payload, a gold usa a criação do pedido na Shopify (coorte): vale a dela.
    if (c.coluna === "data_pedido_original_coorte") expr = `coalesce(${expr}, g.data_pedido_original_coorte)`;
    // Cancelado não tem data de execução.
    if (c.coluna === "data_execucao") expr = `(case when ${mais("status_execucao")} = 'Cancelado' then null else ${expr} end)`;
    return `${expr} as ${c.coluna}`;
  }).join(",\n    ");

  return `recentes as (
  select e.id_solicitacao, max(e._loaded_at) as carregado
  from ${raw} e
  where ${recorte}
  group by e.id_solicitacao
),
pendentes as (
  select r.id_solicitacao, ${chaveDoCaso("r.id_solicitacao")} as chave
  from recentes r
  left join ${g} g on g.chave_unica = ${chaveDoCaso("r.id_solicitacao")}
  where r.carregado > coalesce(g._loaded_at, '-infinity'::timestamptz)
    and exists (select 1 from ${raw} k where k.id_solicitacao = r.id_solicitacao and k.tipo_evento = 'caso')
),
eventos as (
  select e.id_solicitacao, p.chave, e.tipo_evento, e.disparado_em, e.evento_id, e._loaded_at, e.payload,
    (regexp_match(e.evento_id, ':(\\d+)$'))[1]::int as posicao,
    upper(btrim(${campo("tipo")})) as tipo,
    ${codigoMarca(campo("marca"))} as marca_codigo,
    case when (${P} -> 'criado_em') is not null then ${criadoEm(campo("criado_em"))} end as data_solicitacao,
    ${textoCampo(campo("numero_pedido"))} as numero_pedido,
    ${valores}
  from ${raw} e
  join pendentes p on p.id_solicitacao = e.id_solicitacao
),
criacao as (
  select distinct on (id_solicitacao) id_solicitacao, chave, tipo, marca_codigo, data_solicitacao, numero_pedido
  from eventos
  where tipo_evento = 'caso'
  order by id_solicitacao, disparado_em desc, posicao desc nulls last, evento_id desc
),
estado as (
  select id_solicitacao,
    ${agregados},
    max(_loaded_at) as carregado
  from eventos
  group by id_solicitacao
),
frescos as (
  select
    c.data_solicitacao, c.tipo, ${marca("c.marca_codigo")} as marca, ${sigla("c.marca_codigo")} as sigla,
    'CX Hub'::text as sistema_origem, c.chave as chave_unica, c.numero_pedido,
    ${colunas},
    ${SO_DA_GOLD.map(x => `g.${x}`).join(", ")},
    greatest(s.carregado, g._loaded_at) as _loaded_at
  from criacao c
  join estado s on s.id_solicitacao = c.id_solicitacao
  left join ${g} g on g.chave_unica = c.chave
  where not ${ehVendah(porTipo("origem_solicitacao", mais("origem_solicitacao")))}
)`;
}
