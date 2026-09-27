import {
  createAskReport
} from "../chunk-4XBMGPMK.js";
import "../chunk-C3YWJ6OH.js";
import "../chunk-MS4TVUJ4.js";

// src/routes/analytics-ask.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
import { readSetting } from "talisman-cms/env";
import { collections } from "virtual:talisman-cms/config";
var POST = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    return Response.json({ error: "Expected a JSON request." }, { status: 415 });
  }
  if (Number(request.headers.get("Content-Length") || 0) > 1024) {
    return Response.json({ error: "Question is too long." }, { status: 413 });
  }
  try {
    const body = await request.json();
    if (typeof body.question !== "string" || body.question.trim().length < 5 || body.question.length > 300) {
      return Response.json({ error: "Enter a question between 5 and 300 characters." }, { status: 400 });
    }
    const { env } = await import("cloudflare:workers");
    const bindings = env;
    if (!bindings.AI) return Response.json({ error: "A Cloudflare Workers AI binding is required for Ask Analytics." }, { status: 503 });
    if (!bindings.DB) return Response.json({ error: "D1 binding DB is required for Ask Analytics." }, { status: 503 });
    const adminBase = url.pathname.split("/api/analytics/")[0];
    const productCollection = collections.find(
      (collection) => collection.nativeSchemaMapping?.schemaPath === "@talisman-cms/plugin-ecommerce/schema" && collection.nativeSchemaMapping?.exportName === "products"
    );
    const stripeMode = readSetting(env, "COMMERCE_STRIPE_MODE") === "live" ? "live" : "test";
    const report = await createAskReport(
      body.question,
      bindings.AI,
      bindings.DB,
      env,
      adminBase,
      productCollection?.slug || "products",
      stripeMode
    );
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create the report.";
    const known = message.startsWith("Could not understand") || message.startsWith("That question needs data") || message.startsWith("Enter a question");
    if (!known) console.error("Ask Analytics failed:", message);
    return Response.json(
      { error: known ? message : "Could not create the report. Please try again." },
      { status: known ? 400 : 502, headers: { "Cache-Control": "no-store" } }
    );
  }
};
export {
  POST
};
