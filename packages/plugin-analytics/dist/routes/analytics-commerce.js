import {
  fetchCommerceOverview
} from "../chunk-AADP2ZAZ.js";
import {
  parsePeriod
} from "../chunk-MS4TVUJ4.js";

// src/routes/analytics-commerce.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
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
    const data = await fetchCommerceOverview(db, days, adminBase, productCollection?.slug || "products");
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
