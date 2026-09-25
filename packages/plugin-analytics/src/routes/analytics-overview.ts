import type { APIRoute } from 'astro';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { fetchTrafficOverview, parsePeriod, type TrafficOverview } from '../cloudflare';

const cache = new Map<string, { expires: number; promise: Promise<TrafficOverview> }>();

export const GET: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) return authorization.response;
  const headers = { 'Cache-Control': 'private, max-age=120' };
  const days = parsePeriod(new URL(request.url).searchParams.get('days'));
  try {
    const { env } = await import('cloudflare:workers');
    const bindings = env as Record<string, unknown>;
    const key = `${bindings.CLOUDFLARE_ANALYTICS_ACCOUNT_ID}:${bindings.CLOUDFLARE_ANALYTICS_SITE_TAG}:${days}`;
    const cached = cache.get(key);
    let promise: Promise<TrafficOverview>;
    if (cached && cached.expires > Date.now()) promise = cached.promise;
    else {
      promise = fetchTrafficOverview(bindings, days);
      cache.set(key, { expires: Date.now() + 120_000, promise });
    }
    const result = await promise;
    if (bindings.DB) {
      const paths = result.pages.filter(page => /^\/[a-z0-9_-]+\/?$/i.test(page.path));
      if (paths.length) {
        const db = bindings.DB as D1Database;
        const slugs = [...new Set(paths.map(page => page.path.replace(/^\//, '').replace(/\/$/, '')))];
        try {
          const placeholders = slugs.map(() => '?').join(',');
          const entries = await db.prepare(`SELECT e.id, e.slug FROM galaxy_entries e
            JOIN galaxy_collections c ON c.id = e.collection_id
            WHERE c.slug = 'pages' AND e.status = 'published' AND e.slug IN (${placeholders})`)
            .bind(...slugs).all<{ id: string; slug: string }>();
          const bySlug = new Map((entries.results || []).map(entry => [entry.slug, entry.id]));
          const adminBase = new URL(request.url).pathname.split('/api/analytics/')[0];
          return Response.json({ ...result, pages: result.pages.map(page => {
            const id = bySlug.get(page.path.replace(/^\//, '').replace(/\/$/, ''));
            return id ? { ...page, editHref: `${adminBase}/collections/pages/${encodeURIComponent(id)}` } : page;
          }) }, { headers });
        } catch {
          // Traffic remains available when the optional CMS page lookup is unavailable.
        }
      }
    }
    return Response.json(result, { headers });
  } catch (error) {
    cache.clear();
    return Response.json({ error: error instanceof Error ? error.message : 'Analytics unavailable' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
};
