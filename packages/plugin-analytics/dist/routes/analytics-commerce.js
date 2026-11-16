import {
  privateJson,
  reportCache,
  scopeKey
} from "../chunk-FJDZK7OY.js";
import {
  fetchCommerceOverview
} from "../chunk-36KO32RJ.js";
import {
  parsePeriod
} from "../chunk-LADA2ONX.js";

// src/routes/analytics-commerce.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
import { readSetting } from "talisman-cms/env";
import { collections } from "virtual:talisman-cms/config";
var cachedReport = reportCache();
var GET = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) {
    authorization.response.headers.set("Cache-Control", "no-store");
    return authorization.response;
  }
  try {
    const { env } = await import("cloudflare:workers");
    const db = env.DB;
    if (!db) return privateJson({ error: "D1 binding DB is required for Commerce analytics." }, 503);
    const days = parsePeriod(new URL(request.url).searchParams.get("days"));
    const adminBase = new URL(request.url).pathname.split("/api/analytics/")[0];
    const productCollection = collections.find(
      (collection) => collection.nativeSchemaMapping?.schemaPath === "@talisman-cms/plugin-ecommerce/schema" && collection.nativeSchemaMapping?.exportName === "products"
    );
    const stripeMode = readSetting(env, "COMMERCE_STRIPE_MODE") === "live" ? "live" : "test";
    const data = await cachedReport(
      JSON.stringify([scopeKey(env, adminBase), productCollection?.slug, days]),
      () => fetchCommerceOverview(db, days, adminBase, productCollection?.slug || "products", stripeMode)
    );
    return Response.json(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return privateJson({ error: "Commerce analytics are unavailable. Check ecommerce migrations or try again later." }, 502);
  }
};
export {
  GET
};
