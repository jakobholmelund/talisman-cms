import {
  fetchCommerceOverview
} from "../chunk-FESX4VX6.js";
import {
  parsePeriod
} from "../chunk-MS4TVUJ4.js";

// src/routes/analytics-commerce.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
import { readSetting } from "talisman-cms/env";
import { collections } from "virtual:talisman-cms/config";
var GET = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  try {
    const { env } = await import("cloudflare:workers");
    const db = env.DB;
    if (!db) return Response.json({ error: "D1 binding DB is required for Commerce analytics." }, { status: 503 });
    const days = parsePeriod(new URL(request.url).searchParams.get("days"));
    const adminBase = new URL(request.url).pathname.split("/api/analytics/")[0];
    const productCollection = collections.find(
      (collection) => collection.nativeSchemaMapping?.schemaPath === "@talisman-cms/plugin-ecommerce/schema" && collection.nativeSchemaMapping?.exportName === "products"
    );
    const stripeMode = readSetting(env, "COMMERCE_STRIPE_MODE") === "live" ? "live" : "test";
    const data = await fetchCommerceOverview(db, days, adminBase, productCollection?.slug || "products", stripeMode);
    return Response.json(data, { headers: { "Cache-Control": "private, max-age=120" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Commerce analytics unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
};
export {
  GET
};
