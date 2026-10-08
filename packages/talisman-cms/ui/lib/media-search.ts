export type MediaSearch = { q?: string; type?: string };
export type MediaReturnSearch = { from?: 'media'; mediaQ?: string; mediaType?: string };

// Matches the formats the upload endpoint accepts; other assets remain visible in All file types.
export const MEDIA_FILE_TYPES = [
  { value: 'jpeg', label: 'JPEG', mimeType: 'image/jpeg' },
  { value: 'png', label: 'PNG', mimeType: 'image/png' },
  { value: 'gif', label: 'GIF', mimeType: 'image/gif' },
  { value: 'webp', label: 'WebP', mimeType: 'image/webp' },
  { value: 'avif', label: 'AVIF', mimeType: 'image/avif' },
];

export function validateMediaSearch(search: Record<string, unknown>): MediaSearch {
  const result: MediaSearch = {};
  if (typeof search.q === 'string' && search.q.trim()) result.q = search.q.trim().slice(0, 200);
  if (MEDIA_FILE_TYPES.some(option => option.value === search.type)) result.type = String(search.type);
  return result;
}

export function mediaSearchParams(search: MediaSearch, limit: number, cursor?: string | null) {
  const state = validateMediaSearch(search);
  const params = new URLSearchParams({ limit: String(limit) });
  if (state.q) params.set('where[filename][text]', state.q);
  const type = MEDIA_FILE_TYPES.find(option => option.value === state.type);
  if (type) params.set('where[mimeType]', type.mimeType);
  if (cursor) params.set('cursor', cursor);
  return params;
}

/** A fixed return destination, rather than an arbitrary redirect URL. */
export function validateMediaReturnSearch(search: Record<string, unknown>): MediaReturnSearch {
  if (search.from !== 'media') return {};
  const state = validateMediaSearch({ q: search.mediaQ, type: search.mediaType });
  return { from: 'media', ...(state.q ? { mediaQ: state.q } : {}), ...(state.type ? { mediaType: state.type } : {}) };
}

export function mediaEntrySearch(search: MediaSearch): MediaReturnSearch {
  return validateMediaReturnSearch({ from: 'media', mediaQ: search.q, mediaType: search.type });
}
