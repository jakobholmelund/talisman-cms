export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** The widths media-serve resizes images to (with an IMAGES binding) for `?w=`. */
export const MEDIA_IMAGE_WIDTHS = [320, 640, 960, 1280, 1920] as const;

/**
 * Browsers and the edge cache keep a file for an hour and then revalidate it with its ETag, so a
 * deleted file stops being served everywhere within the hour.
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=3600';

// Part of every edge-cache key. Responses cached under the old keys were marked immutable for a
// year; new keys leave them unused, so a deletion also applies to files cached before this change.
const MEDIA_CACHE_KEY_VERSION = '2';

/** The public path of an uploaded file: media-serve answers at `/api/media/<id>`. */
export function mediaPath(id: string) {
  return `/api/media/${id}`;
}

/** The edge-cache key media-serve uses for one file, as the original or at one resize width. */
export function mediaCacheKey(origin: string, id: string, width?: number) {
  const url = new URL(mediaPath(id), origin);
  url.searchParams.set('v', MEDIA_CACHE_KEY_VERSION);
  if (width !== undefined) url.searchParams.set('w', String(width));
  return url.toString();
}

type MediaStorageEnv = { STORAGE?: Pick<R2Bucket, 'delete'> };

/**
 * Removes a deleted media record's file from R2, then evicts its cached copies (the original and every
 * width) from this data center's edge cache. Other data centers drop theirs when they expire, which
 * MEDIA_CACHE_CONTROL keeps to an hour; a zone-wide purge needs Cloudflare's purge API.
 */
export async function deleteStoredMedia(env: MediaStorageEnv, id: string, origin?: string) {
  await env.STORAGE?.delete(id);
  if (!origin) return;

  const cache = typeof caches === 'undefined' ? undefined : (caches as CacheStorage & { default?: Cache }).default;
  if (!cache) return;
  const keys = [undefined, ...MEDIA_IMAGE_WIDTHS].map((width) => mediaCacheKey(origin, id, width));
  await Promise.all(keys.map(async (key) => {
    try {
      await cache.delete(key);
    } catch (error) {
      // The file is gone from R2, so a copy left in the cache still expires within MEDIA_CACHE_CONTROL.
      console.warn(`[talisman-cms] Could not evict ${key} from the edge cache`, error);
    }
  }));
}

/**
 * Answers a conditional request with 304 when the client already holds the response's version, so an
 * expired copy is revalidated without sending the file again.
 */
export function notModifiedResponse(request: Request, response: Response): Response | null {
  const etag = response.headers.get('ETag');
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (!etag || !ifNoneMatch || response.status !== 200) return null;

  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const matches = ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === opaque(etag));
  if (!matches) return null;

  const headers = new Headers();
  for (const name of ['ETag', 'Cache-Control', 'Content-Type', 'X-Content-Type-Options', 'Content-Security-Policy']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(null, { status: 304, headers });
}

const safeImageTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
]);

/** Determine the stored type from bytes rather than the browser supplied MIME type. */
export function rasterImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a') return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' &&
      ['avif', 'avis'].includes(String.fromCharCode(...bytes.slice(8, 12)))) return 'image/avif';
  return null;
}

/** Protect both newly uploaded files and objects cached before upload validation existed. */
export function secureMediaResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const type = headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() || '';
  if (safeImageTypes.has(type)) {
    headers.set('Content-Type', type);
    headers.delete('Content-Disposition');
  } else {
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment');
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', 'sandbox');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
