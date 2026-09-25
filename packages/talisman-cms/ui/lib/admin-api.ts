/** Largest page the entries API serves (MAX_PAGE_SIZE in src/api/handler.ts). */
export const ENTRIES_API_MAX_PAGE_SIZE = 200;

// Collection configs change only with a deploy, so screens that just need one collection's config
// reuse a recent answer instead of asking again on every navigation.
const COLLECTIONS_CACHE_MS = 60_000;
const collectionsCache = new Map<string, { at: number; request: Promise<any[]> }>();

/**
 * GET /api/collections. Loaders that only look up a collection's config pass nothing and may get
 * a copy up to a minute old; screens that show item counts pass `fresh` to ask the server again.
 */
export function fetchCollectionConfigs(basePath: string, { fresh = false }: { fresh?: boolean } = {}): Promise<any[]> {
  const cached = collectionsCache.get(basePath);
  if (!fresh && cached && Date.now() - cached.at < COLLECTIONS_CACHE_MS) return cached.request;

  const request = fetch(`${basePath}/api/collections`).then(async (res) => {
    if (!res.ok) throw new Error('Failed to fetch collections');
    const collections = await res.json();
    return Array.isArray(collections) ? collections : [];
  });
  collectionsCache.set(basePath, { at: Date.now(), request });
  // A failed request is not kept, so the next navigation asks again.
  request.catch(() => {
    if (collectionsCache.get(basePath)?.request === request) collectionsCache.delete(basePath);
  });
  return request;
}

export function isNativeCollectionConfig(collection: any) {
  return Boolean(collection?.nativeSchemaMapping);
}

/**
 * Every entry of a collection, read one bounded page at a time so no single request makes the
 * Worker load a whole table. Pages of native tables come newest first; `oldestFirst` restores the
 * table order the unpaged list used, which option lists and the variant editor are built around.
 * A refused first page (for example a collection this user may not read) gives an empty list, as
 * before; a later page that fails throws, because a partial list would look complete.
 */
export async function fetchAllEntries(
  basePath: string,
  slug: string,
  { oldestFirst = false, pageSize = ENTRIES_API_MAX_PAGE_SIZE }: { oldestFirst?: boolean; pageSize?: number } = {}
): Promise<any[]> {
  const entries: any[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${basePath}/api/collections/${slug}/entries?${params}`);
    if (!res.ok) {
      if (entries.length === 0 && cursor === null) return [];
      throw new Error(`Failed to load every ${slug} record (HTTP ${res.status}). Reload the page to try again.`);
    }

    const page = await res.json() as { docs?: unknown; nextCursor?: unknown };
    entries.push(...(Array.isArray(page?.docs) ? page.docs : []));
    cursor = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
  } while (cursor);

  return oldestFirst ? entries.reverse() : entries;
}

/** Loads several collections' entries in parallel, keyed by collection slug. */
export async function fetchEntriesBySlug(basePath: string, slugs: string[], collections: any[]): Promise<Record<string, any[]>> {
  const nativeSlugs = new Set(collections.filter(isNativeCollectionConfig).map((collection) => collection.slug));
  const lists = await Promise.all(
    slugs.map((slug) => fetchAllEntries(basePath, slug, { oldestFirst: nativeSlugs.has(slug) }))
  );
  return Object.fromEntries(slugs.map((slug, index) => [slug, lists[index]]));
}
