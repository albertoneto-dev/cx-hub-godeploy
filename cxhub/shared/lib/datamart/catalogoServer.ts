import { consultarDataMart, literalSql } from '../metabase/index';
import { montarCatalogo, type CatalogoItem, type LinhaDoDataMart, type LinhaDoTiny, type MarcaDoCatalogo } from './catalogo';

/**
 * A leitura do catálogo das marcas sem Cosmos no Data Mart, pelo Metabase (ADR-016), com cache em memória por marca.
 *
 * ⚠️ **Server-only** (lê `METABASE_API_KEY` pelo cliente do Metabase): fora do barrel de propósito. Importe por
 * `@shared/lib/datamart/catalogoServer`.
 */

/** Quanto o catálogo de uma marca fica guardado: o cadastro muda pouco, e a tela o pede a cada reenvio. */
export const VALIDADE_DO_CATALOGO_MS = 6 * 60 * 60 * 1000;

/** O `/api/dataset` do Metabase corta a consulta avulsa em 2.000 linhas, sem erro. */
const LIMITE_DE_LINHAS_DO_METABASE = 2000;

/** Os avulsos da marca, ordenados pelo SKU (a ordem desempata a deduplicação). */
export function sqlDoCatalogo(marca: MarcaDoCatalogo): string {
    return `select sku, nome, ativo, codigo_shopify, preco_loja_ref
from gold.dim_produto_gobeauty
where marca = ${literalSql(marca)} and is_kit = false
order by sku collate "C"`;
}

/**
 * Os códigos numéricos do Tiny da Ápice, um por linha: o nome da linha ativa mais recente (pela `data_criacao`, que é
 * texto `dd/mm/aaaa hh:mm:ss`) e se o código está ativo em alguma empresa. Só os numéricos, porque o SKU da Ápice no
 * catálogo é sempre numérico.
 */
export const SQL_DO_TINY_DA_APICE = `select distinct on (codigo) codigo, nome,
  bool_or(coalesce(situacao, '') <> 'I') over (partition by codigo) as ativo
from api.vw_tiny_cadastro_produtos
where empresa like 'AP COSMETICS%' and codigo ~ '^[0-9]+$'
order by codigo,
  (coalesce(situacao, '') <> 'I') desc,
  case when data_criacao ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
    then to_timestamp(data_criacao, 'DD/MM/YYYY HH24:MI:SS') end desc nulls last,
  empresa, id`;

const texto = (valor: unknown): string => (valor === null || valor === undefined ? '' : String(valor));

function linhaDoDataMart([sku, nome, ativo, codigoShopify, preco]: unknown[]): LinhaDoDataMart {
    return {
        sku: texto(sku),
        nome: texto(nome),
        ativo: ativo === true,
        codigoShopify: codigoShopify === null || codigoShopify === undefined ? null : String(codigoShopify),
        preco: typeof preco === 'number' || typeof preco === 'string' ? preco : null,
    };
}

function linhaDoTiny([codigo, nome, ativo]: unknown[]): LinhaDoTiny {
    return { codigo: texto(codigo), nome: texto(nome), ativo: ativo === true };
}

async function consultar(sql: string, oQue: string): Promise<unknown[][]> {
    const linhas = await consultarDataMart(sql);
    if (linhas.length >= LIMITE_DE_LINHAS_DO_METABASE) {
        console.warn(`[Catálogo] ${oQue}: ${linhas.length} linhas, o limite do Metabase — o catálogo pode ter vindo cortado`);
    }
    return linhas;
}

const guardados = new Map<MarcaDoCatalogo, { validoAte: number; produtos: CatalogoItem[] }>();

/**
 * O catálogo da marca: do cache, se foi lido há menos de `VALIDADE_DO_CATALOGO_MS`, ou do Data Mart (a Ápice lê também o
 * Tiny). Falha do Metabase sobe como `MetabaseError` e nada é guardado.
 */
export async function catalogoDaMarca(marca: MarcaDoCatalogo, agora: number = Date.now()): Promise<CatalogoItem[]> {
    const guardado = guardados.get(marca);
    if (guardado && guardado.validoAte > agora) return guardado.produtos;

    const [linhas, tiny] = await Promise.all([
        consultar(sqlDoCatalogo(marca), `catálogo da ${marca}`),
        marca === 'apice' ? consultar(SQL_DO_TINY_DA_APICE, 'Tiny da Ápice') : Promise.resolve([]),
    ]);
    const produtos = montarCatalogo(marca, linhas.map(linhaDoDataMart), tiny.map(linhaDoTiny));
    guardados.set(marca, { validoAte: agora + VALIDADE_DO_CATALOGO_MS, produtos });
    return produtos;
}

/** Esvazia o cache (testes). */
export function esquecerCatalogos(): void {
    guardados.clear();
}
