// The rows the product editor's Options & stock panel reads for one product, scoped to that product:
// its variant groups by productId, their values by group id, and the stock and variant component
// rows by value id, through the entries API's `where` filter. The option definitions and shared
// components are small definition tables and come in full. Nothing here touches React, so a test
// can pass its own reader and check the queries.
import { fetchAllEntries, fetchEntriesWhere } from 'talisman-cms/ui/lib/admin-api';

/** The definition tables the panel lists in full: option families and shared components. */
export const PRODUCT_DEFINITION_SLUGS = ['_ecommerce_variants', '_ecommerce_components'] as const;

/** The product's own rows, by the column that points at the level above (the product, a group or a value). */
export const PRODUCT_FLOW_FILTERS = {
  _ecommerce_product_variants: 'productId',
  _ecommerce_product_variant_values: 'productVariantId',
  _ecommerce_stocks: 'productVariantValueId',
  _ecommerce_variant_components: 'productVariantValueId',
} as const;

/** Every collection the panel reads; the result of loadProductRows has each of these keys. */
export const PRODUCT_ROW_SLUGS = [...PRODUCT_DEFINITION_SLUGS, ...Object.keys(PRODUCT_FLOW_FILTERS)];

/** The loaded rows by collection slug, every slug of PRODUCT_ROW_SLUGS present. */
export type ProductRows = Record<string, any[]>;

/** A filter the loader asks for: a column equal to one id, or in a list of ids. */
export type ProductRowsWhere = Record<string, string | string[]>;

/**
 * Reads one collection's rows: every row without a filter, or the rows the filter matches, in table
 * order. It must reject when the read is refused, so the panel never takes a refused read for an
 * empty product. The panel reads through the entries API; a test passes its own reader.
 */
export type ProductRowsReader = (basePath: string, slug: string, where: ProductRowsWhere | null) => Promise<any[]>;

/**
 * The reader over the entries API. `strict` makes a refused first page reject instead of reading
 * as empty; `oldestFirst` gives the table order the drafts and option lists are built around.
 */
export const readProductRowsFromApi: ProductRowsReader = (basePath, slug, where) => (
  where
    ? fetchEntriesWhere(basePath, slug, where, { strict: true, oldestFirst: true })
    : fetchAllEntries(basePath, slug, { strict: true, oldestFirst: true })
);

/**
 * Ids per `in` request. The API binds at most 90 values in one query, and a page's limit and cursor
 * bind a few of them, so a longer list is read in several requests.
 */
export const IDS_PER_REQUEST = 80;

/** The rows whose `column` is one of `ids`: nothing for no ids, since the API refuses an empty `in`. */
async function readByIds(read: ProductRowsReader, basePath: string, slug: string, column: string, ids: string[]) {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += IDS_PER_REQUEST) chunks.push(ids.slice(start, start + IDS_PER_REQUEST));
  const lists = await Promise.all(chunks.map((chunk) => read(basePath, slug, { [column]: chunk })));
  return lists.flat();
}

const idsOf = (rows: any[]) => rows.map((row) => String(row?.id ?? '')).filter(Boolean);

/** The product's groups, then their values, then the stock and component rows of those values. */
async function readProductFlow(read: ProductRowsReader, basePath: string, productId: string) {
  const groups = await read(basePath, '_ecommerce_product_variants', { [PRODUCT_FLOW_FILTERS._ecommerce_product_variants]: productId });
  const values = await readByIds(read, basePath, '_ecommerce_product_variant_values', PRODUCT_FLOW_FILTERS._ecommerce_product_variant_values, idsOf(groups));
  const valueIds = idsOf(values);
  const [stocks, components] = await Promise.all([
    readByIds(read, basePath, '_ecommerce_stocks', PRODUCT_FLOW_FILTERS._ecommerce_stocks, valueIds),
    readByIds(read, basePath, '_ecommerce_variant_components', PRODUCT_FLOW_FILTERS._ecommerce_variant_components, valueIds),
  ]);
  return {
    _ecommerce_product_variants: groups,
    _ecommerce_product_variant_values: values,
    _ecommerce_stocks: stocks,
    _ecommerce_variant_components: components,
  };
}

/**
 * Loads one product's rows, keyed by collection slug. An empty product id, a product not saved yet,
 * reads only the definition tables and gives the flow tables as empty lists. Rejects with the
 * reader's error when any read is refused, for example after the session expired; the panel then
 * shows the error, or keeps the rows it has, instead of an empty product. Call it again to refresh
 * the rows after a change.
 */
export async function loadProductRows(basePath: string, productId: string, read: ProductRowsReader = readProductRowsFromApi): Promise<ProductRows> {
  const [definitions, flow] = await Promise.all([
    Promise.all(PRODUCT_DEFINITION_SLUGS.map((slug) => read(basePath, slug, null))),
    productId
      ? readProductFlow(read, basePath, productId)
      : Promise.resolve(Object.fromEntries(Object.keys(PRODUCT_FLOW_FILTERS).map((slug) => [slug, [] as any[]]))),
  ]);
  return {
    ...Object.fromEntries(PRODUCT_DEFINITION_SLUGS.map((slug, index) => [slug, definitions[index]])),
    ...flow,
  };
}
