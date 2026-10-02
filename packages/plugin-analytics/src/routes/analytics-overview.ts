import type { APIRoute } from 'astro';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { AnalyticsSetupError, fetchTrafficOverview, parsePeriod, type TrafficOverview } from '../cloudflare';

import { privateJson, reportCache, scopeKey } from './support';
const cachedReport = reportCache<TrafficOverview>();

export const GET: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) { authorization.response.headers.set('Cache-Control', 'no-store'); return authorization.response; }
  const headers = { 'Cache-Control': 'private, no-store' };
  const adminBase = new URL(request.url).pathname.split('/api/analytics/')[0];
  const days = parsePeriod(new URL(request.url).searchParams.get('days'));
  try {
    const { env } = await import('cloudflare:workers');
    const bindings = env as Record<string, unknown>;
    const result = await cachedReport(`${scopeKey(bindings, adminBase)}:${days}`,
      () => fetchTrafficOverview(bindings, days, fetch, new Date(), adminBase));
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
    const setup = error instanceof AnalyticsSetupError;
    return privateJson({ error: setup ? (error as Error).message : 'Traffic analytics are unavailable. Please try again later.' }, setup ? 503 : 502);
  }
};
