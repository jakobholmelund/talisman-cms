import type { APIRoute } from 'astro';
import type { TalismanEnv } from '../../client';
import { secureMediaResponse } from '../../db/media-policy';

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
  if (widthParam !== null && (String(width) !== widthParam || ![320, 640, 960, 1280, 1920].includes(width!))) {
    return new Response('Unsupported image width', { status: 400 });
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.search = width === undefined ? '' : `?w=${width}`;

  try {
    if (env.STORAGE) {
      const cache = typeof caches === 'undefined'
        ? undefined
        : (caches as CacheStorage & { default?: Cache }).default;
      const cached = await cache?.match(cacheUrl.toString());
      if (cached) return secureMediaResponse(cached);

      // Uploaded media uses unique, immutable object keys. R2 is the source of
      // truth for public bytes; a D1 lookup here adds latency to every image.
      const object = await env.STORAGE.get(id);

      if (object === null) {
        return new Response('Object not found in bucket', { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');

      const canTransform = width !== undefined && env.IMAGES &&
        ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(headers.get('Content-Type') || '');
      const response = secureMediaResponse(canTransform
        ? (await env.IMAGES!.input(object.body)
            .transform({ width, fit: 'scale-down' })
            .output({ format: 'image/webp', quality: 80 }))
            .response({ headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' } })
        : new Response(object.body, { headers }));
      const cfContext = (locals as typeof locals & { cfContext?: ExecutionContext }).cfContext;
      if (cache && cfContext) {
        cfContext.waitUntil(cache.put(cacheUrl.toString(), response.clone()));
      }
      return response;

    } else {
      // In local dev without R2, we fallback to just telling them it's not configured
      return new Response('Storage bucket not configured', { status: 501 });
    }

  } catch (error: any) {
    console.error('Media serve error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
