// List state is carried through entry URLs so Back to collection can restore the same view.
export type CollectionListSearch = { q?: string; status?: string; sort?: string; page?: number };
export const COLLECTION_PAGE_SIZE = 50;
export const COLLECTION_MAX_PAGE = 201; // The shared query API caps offsets at 10,000.

export function validateCollectionListSearch(search: Record<string, unknown>): CollectionListSearch {
  const result: CollectionListSearch = {};
  if (typeof search.q === 'string' && search.q.trim()) result.q = search.q.trim().slice(0, 200);
  if (typeof search.status === 'string' && search.status.length <= 100) result.status = search.status || undefined;
  if (['oldest', 'updated', 'name', 'name-desc'].includes(String(search.sort))) result.sort = String(search.sort);
  const page = Number(search.page);
  if (Number.isSafeInteger(page) && page > 1 && page <= COLLECTION_MAX_PAGE) result.page = page;
  return result;
}

export function getCollectionListOptions(collection: any) {
  const fields: any[] = collection?.fields || [];
  const textFields = fields.filter(field => ['text', 'textarea'].includes(field.type) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name));
  const searchField = ['title', 'name', 'label', 'filename', 'email', 'code', 'value']
    .map(name => textFields.find(field => field.name === name)).find(Boolean) || textFields[0];
  const native = Boolean(collection?.nativeSchemaMapping);
  const statusField = fields.find(field => field.name === 'status' && field.type === 'select');
  const statuses: { value: string; label: string }[] = native
    ? (statusField?.options || []).map((option: any) => typeof option === 'string' ? { value: option, label: option.replaceAll('_', ' ') } : option)
      .filter((option: any) => typeof option?.value === 'string' && option.value.length > 0)
    : ['draft', 'published', 'archived'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
  const sorts = [{ value: '', label: 'Newest first' }];
  if (!native || fields.some(field => field.name === 'createdAt')) sorts.push({ value: 'oldest', label: 'Oldest first' });
  if (!native || fields.some(field => field.name === 'updatedAt')) sorts.push({ value: 'updated', label: 'Recently updated' });
  if (searchField) sorts.push({ value: 'name', label: `${searchField.label || searchField.name}: A–Z` }, { value: 'name-desc', label: `${searchField.label || searchField.name}: Z–A` });
  return { searchField, statuses, sorts };
}

export function normalizeCollectionListSearch(collection: any, search: CollectionListSearch): CollectionListSearch {
  const result = validateCollectionListSearch(search);
  const options = getCollectionListOptions(collection);
  if (!options.searchField) delete result.q;
  if (!options.statuses.some(option => option.value === result.status)) delete result.status;
  if (!options.sorts.some(option => option.value === result.sort)) delete result.sort;
  return result;
}

/** Fetch one extra result to detect the next offset page without guessing from nextCursor. */
export function collectionListParams(collection: any, search: CollectionListSearch) {
  const state = normalizeCollectionListSearch(collection, search);
  const { searchField } = getCollectionListOptions(collection);
  const params = new URLSearchParams({ limit: String(COLLECTION_PAGE_SIZE + 1), offset: String(((state.page || 1) - 1) * COLLECTION_PAGE_SIZE) });
  if (state.q && searchField) params.set(`where[${searchField.name}][text]`, state.q);
  if (state.status) params.set('where[status]', state.status);
  const sort = state.sort === 'oldest' ? 'createdAt' : state.sort === 'updated' ? '-updatedAt' : state.sort === 'name' ? searchField?.name : state.sort === 'name-desc' ? `-${searchField?.name}` : undefined;
  if (sort) {
    // Native rows do not share the core's implicit ID tie-breaker.
    const idColumn = collection?.nativeSchemaMapping?.idColumn || 'id';
    params.set('sort', collection?.nativeSchemaMapping ? `${sort},${idColumn}` : sort);
  }
  return params;
}
