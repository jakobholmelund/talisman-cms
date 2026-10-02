import type { APIRoute } from 'astro';
import type { TalismanEnv } from '../../client';
import {
  MEDIA_CACHE_CONTROL,
  MEDIA_EDGE_CACHE_CONTROL,
  MEDIA_FALLBACK_CACHE_CONTROL,
  mediaDeletionKey,
  MEDIA_IMAGE_WIDTHS,
  mediaCacheKey,
  notModifiedResponse,
  secureMediaResponse
} from '../../db/media-policy';

export const GET: APIRoute = async ({ request, params, locals }) => {
  const { env: workerEnv } = await import('cloudflare:workers');
  const env = workerEnv as unknown as TalismanEnv;

  // We expect this route to be mounted at /api/media/[id]
  const id = params.route || new URL(request.url).pathname.split('/').pop();

  if (!id) {
    return new Response('Missing media ID', { status: 400 });
  }
  if (!/^media_[A-Za-z0-9_-]+$/.test(id)) {
    return new Response('Media record not found', { status: 404 });
  }
  const widthParam = new URL(request.url).searchParams.get('w');
  const width = widthParam === null ? undefined : Number(widthParam);
  if (widthParam !== null && (String(width) !== widthParam || !(MEDIA_IMAGE_WIDTHS as readonly number[]).includes(width!))) {
    return new Response('Unsupported image width', { status: 400 });
  }
  const cacheKey = mediaCacheKey(new URL(request.url).origin, id, width);

  try {
    if (env.STORAGE) {
      const cache = typeof caches === 'undefined'
        ? undefined
        : (caches as CacheStorage & { default?: Cache }).default;
      // R2 is strongly consistent; never cache a negative tombstone lookup.
      if (await env.STORAGE.head(mediaDeletionKey(id))) {
        return new Response('Media record not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      }
      const cached = await cache?.match(cacheKey);
      if (cached) {
        const response = secureMediaResponse(cached);
        return notModifiedResponse(request, response) ?? response;
      }

      // R2 is the source of truth for public bytes; a D1 lookup here adds latency to every image.
      // Deleting a media record deletes its object, so a deleted file is not found here.
      const object = await env.STORAGE.get(id);

      if (object === null) {
        return new Response('Object not found in bucket', { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('Cache-Control', MEDIA_CACHE_CONTROL);

      const canTransform = width !== undefined && env.IMAGES &&
        ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(headers.get('Content-Type') || '');
      let response: Response;
      let edgeCacheControl = MEDIA_EDGE_CACHE_CONTROL;
      if (canTransform) {
        try {
          const transformed = (await env.IMAGES!.input(object.body)
            .transform({ width, fit: 'scale-down' })
            .output({ format: 'image/webp', quality: 80 }))
            .response({ headers: {
              'Content-Type': 'image/webp',
              'Cache-Control': MEDIA_CACHE_CONTROL,
              ETag: `W/"${object.etag}-w${width}"`,
            } });
          if (!transformed.ok) throw new Error('Image transform failed');
          response = secureMediaResponse(transformed);
        } catch (error) {
          console.warn('[talisman-cms] Image transform failed; serving original', error);
          // The transformer may have consumed the body. Re-read rather than buffering every upload.
          const original = await env.STORAGE.get(id);
          if (!original) return new Response('Object not found in bucket', { status: 404 });
          original.writeHttpMetadata(headers);
          headers.set('ETag', original.httpEtag);
          edgeCacheControl = MEDIA_FALLBACK_CACHE_CONTROL;
          response = secureMediaResponse(new Response(original.body, { headers }));
        }
      } else {
        response = secureMediaResponse(new Response(object.body, { headers }));
      }
      const cfContext = (locals as typeof locals & { cfContext?: ExecutionContext }).cfContext;
      if (cache && cfContext) {
        // Cache bytes internally, but require all browsers/upstream caches to reach the marker check.
        const cacheHeaders = new Headers(response.headers);
        cacheHeaders.set('Cache-Control', edgeCacheControl);
        cfContext.waitUntil(cache.put(cacheKey, new Response(response.clone().body, { headers: cacheHeaders })));
      }
      return notModifiedResponse(request, response) ?? response;

    } else {
      // In local dev without R2, we fallback to just telling them it's not configured
      return new Response('Storage bucket not configured', { status: 501 });
    }

  } catch (error: any) {
    console.error('Media serve error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
