import {
  fetchTrafficOverview,
  parsePeriod
} from "../chunk-MS4TVUJ4.js";

// src/routes/analytics-overview.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
var cache = /* @__PURE__ */ new Map();
var GET = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) return authorization.response;
  const headers = { "Cache-Control": "private, max-age=120" };
  const days = parsePeriod(new URL(request.url).searchParams.get("days"));
  try {
    const { env } = await import("cloudflare:workers");
    const bindings = env;
    const key = `${bindings.CLOUDFLARE_ANALYTICS_ACCOUNT_ID}:${bindings.CLOUDFLARE_ANALYTICS_SITE_TAG}:${days}`;
    const cached = cache.get(key);
    let promise;
    if (cached && cached.expires > Date.now()) promise = cached.promise;
    else {
      promise = fetchTrafficOverview(bindings, days);
      cache.set(key, { expires: Date.now() + 12e4, promise });
    }
    const result = await promise;
    if (bindings.DB) {
      const paths = result.pages.filter((page) => /^\/[a-z0-9_-]+\/?$/i.test(page.path));
      if (paths.length) {
        const db = bindings.DB;
        const slugs = [...new Set(paths.map((page) => page.path.replace(/^\//, "").replace(/\/$/, "")))];
        try {
          const placeholders = slugs.map(() => "?").join(",");
          const entries = await db.prepare(`SELECT e.id, e.slug FROM galaxy_entries e
            JOIN galaxy_collections c ON c.id = e.collection_id
            WHERE c.slug = 'pages' AND e.status = 'published' AND e.slug IN (${placeholders})`).bind(...slugs).all();
          const bySlug = new Map((entries.results || []).map((entry) => [entry.slug, entry.id]));
          const adminBase = new URL(request.url).pathname.split("/api/analytics/")[0];
          return Response.json({ ...result, pages: result.pages.map((page) => {
            const id = bySlug.get(page.path.replace(/^\//, "").replace(/\/$/, ""));
            return id ? { ...page, editHref: `${adminBase}/collections/pages/${encodeURIComponent(id)}` } : page;
          }) }, { headers });
        } catch {
        }
      }
    }
    return Response.json(result, { headers });
  } catch (error) {
    cache.clear();
    return Response.json(
      { error: error instanceof Error ? error.message : "Analytics unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
};
export {
  GET
};
