import { collectionListParams, COLLECTION_PAGE_SIZE, normalizeCollectionListSearch, type CollectionListSearch } from './collection-list';
import { fetchCollectionConfigs } from './admin-api';

export async function loadCollectionEntriesData(basePath: string, slug: string, search: CollectionListSearch = {}, signal?: AbortSignal) {
  const collections = await fetchCollectionConfigs(basePath);
  const collection = collections.find((item: any) => item.slug === slug);
  const listSearch = normalizeCollectionListSearch(collection, search);
  if (!collection) return { collection, entries: [], hasNextPage: false, listSearch, listError: '' };
  try {
    const params = collectionListParams(collection, listSearch);
    const res = await fetch(`${basePath}/api/collections/${slug}/entries?${params}`, { signal });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || 'Failed to fetch entries');
    }
    const page = await res.json() as { docs: any[] };
    return { collection, entries: page.docs.slice(0, COLLECTION_PAGE_SIZE), hasNextPage: page.docs.length > COLLECTION_PAGE_SIZE, listSearch, listError: '' };
  } catch (error: any) {
    if (signal?.aborted) throw error;
    return { collection, entries: [], hasNextPage: false, listSearch, listError: error.message || 'Failed to fetch entries' };
  }
}

