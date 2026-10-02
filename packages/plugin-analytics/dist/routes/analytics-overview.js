import {
  privateJson,
  reportCache,
  scopeKey
} from "../chunk-FJDZK7OY.js";
import {
  AnalyticsSetupError,
  fetchTrafficOverview,
  parsePeriod
} from "../chunk-LADA2ONX.js";

// src/routes/analytics-overview.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
var cachedReport = reportCache();
var GET = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) {
    authorization.response.headers.set("Cache-Control", "no-store");
    return authorization.response;
  }
  const headers = { "Cache-Control": "private, no-store" };
  const adminBase = new URL(request.url).pathname.split("/api/analytics/")[0];
  const days = parsePeriod(new URL(request.url).searchParams.get("days"));
  try {
    const { env } = await import("cloudflare:workers");
    const bindings = env;
    const result = await cachedReport(
      `${scopeKey(bindings, adminBase)}:${days}`,
      () => fetchTrafficOverview(bindings, days, fetch, /* @__PURE__ */ new Date(), adminBase)
    );
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
          const adminBase2 = new URL(request.url).pathname.split("/api/analytics/")[0];
          return Response.json({ ...result, pages: result.pages.map((page) => {
            const id = bySlug.get(page.path.replace(/^\//, "").replace(/\/$/, ""));
            return id ? { ...page, editHref: `${adminBase2}/collections/pages/${encodeURIComponent(id)}` } : page;
          }) }, { headers });
        } catch {
        }
      }
    }
    return Response.json(result, { headers });
  } catch (error) {
    const setup = error instanceof AnalyticsSetupError;
    return privateJson({ error: setup ? error.message : "Traffic analytics are unavailable. Please try again later." }, setup ? 503 : 502);
  }
};
export {
  GET
};
