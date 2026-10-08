import { useEffect, useRef, useState } from 'react';
import { mediaSearchParams, validateMediaSearch, type MediaSearch } from './media-search';

export type MediaPage = { docs: any[]; nextCursor: string | null };

export async function fetchMediaPage(basePath: string, search: MediaSearch, limit: number, cursor?: string | null, signal?: AbortSignal): Promise<MediaPage> {
  const response = await fetch(`${basePath}/api/collections/media/entries?${mediaSearchParams(search, limit, cursor)}`, { signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(response.status === 401 ? 'Your session has expired. Sign in again in another tab, then retry.' : payload.error || `Failed to load media library (HTTP ${response.status}).`);
  }
  const payload = await response.json() as { docs?: unknown; nextCursor?: unknown };
  if (!Array.isArray(payload.docs)) throw new Error('Failed to load media library: the server sent an unexpected response.');
  return { docs: payload.docs, nextCursor: typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null };
}

/** Shared cursor paging. A new search aborts the old read; it never changes the selected field. */
export function useMediaResults(basePath: string, limit: number, initialSearch: MediaSearch = {}, initialPage?: MediaPage, initialError = '') {
  const [search, setSearch] = useState(initialSearch);
  const [page, setPage] = useState<MediaPage>(initialPage || { docs: [], nextCursor: null });
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState<'refresh' | 'more' | null>(null);
  const searchRef = useRef(initialSearch);
  const pageRef = useRef(page);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => { controllerRef.current?.abort(); controllerRef.current = null; }, []);
  const initialRef = useRef({ page: initialPage, error: initialError, q: initialSearch.q, type: initialSearch.type });
  useEffect(() => {
    const previous = initialRef.current;
    if (previous.page === initialPage && previous.error === initialError && previous.q === initialSearch.q && previous.type === initialSearch.type) return;
    initialRef.current = { page: initialPage, error: initialError, q: initialSearch.q, type: initialSearch.type };
    if (!initialPage) return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    searchRef.current = initialSearch;
    pageRef.current = initialPage;
    setSearch(initialSearch);
    setPage(initialPage);
    setError(initialError);
    setBusy(null);
  }, [initialPage, initialError, initialSearch.q, initialSearch.type]);

  const read = async (nextSearch: MediaSearch, append: boolean) => {
    if (append && (controllerRef.current || !pageRef.current.nextCursor)) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const state = validateMediaSearch(nextSearch);
    const changed = state.q !== searchRef.current.q || state.type !== searchRef.current.type;
    searchRef.current = state;
    setSearch(state);
    if (changed) { pageRef.current = { docs: [], nextCursor: null }; setPage(pageRef.current); }
    setBusy(append ? 'more' : 'refresh');
    if (changed) setError('');
    try {
      const result = await fetchMediaPage(basePath, state, limit, append ? pageRef.current.nextCursor : null, controller.signal);
      if (controller.signal.aborted) return;
      pageRef.current = append ? { ...result, docs: [...pageRef.current.docs, ...result.docs] } : result;
      setPage(pageRef.current);
      setError('');
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Failed to load media library');
    } finally {
      if (controllerRef.current === controller) { controllerRef.current = null; setBusy(null); }
    }
  };
  const remove = (id: string) => { pageRef.current = { ...pageRef.current, docs: pageRef.current.docs.filter(doc => doc.id !== id) }; setPage(pageRef.current); };
  return { search, page, error, busy, refresh: (nextSearch = searchRef.current) => read(nextSearch, false), loadMore: () => read(searchRef.current, true), remove };
}
