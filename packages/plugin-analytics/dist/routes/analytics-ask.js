import {
  ReportInputError,
  createAskReport
} from "../chunk-23N42HXK.js";
import "../chunk-36KO32RJ.js";
import {
  allowQuestion,
  privateJson,
  questionBody,
  reportCache,
  scopeKey
} from "../chunk-FJDZK7OY.js";
import {
  AnalyticsSetupError
} from "../chunk-LADA2ONX.js";

// src/routes/analytics-ask.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
import { readSetting } from "talisman-cms/env";
import { collections } from "virtual:talisman-cms/config";
var cachedReport = reportCache();
var POST = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) {
    authorization.response.headers.set("Cache-Control", "no-store");
    return authorization.response;
  }
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") return privateJson({ error: "Invalid request origin." }, 403);
  try {
    const body = await questionBody(request);
    if (typeof body.question !== "string" || body.question.trim().length < 5 || body.question.length > 300) {
      return privateJson({ error: "Enter a question between 5 and 300 characters." }, 400);
    }
    const { env } = await import("cloudflare:workers");
    const bindings = env;
    if (!bindings.AI) return privateJson({ error: "A Cloudflare Workers AI binding is required for Ask Analytics." }, 503);
    if (!bindings.DB) return privateJson({ error: "D1 binding DB is required for Ask Analytics." }, 503);
    const adminBase = url.pathname.split("/api/analytics/")[0];
    const productCollection = collections.find(
      (collection) => collection.nativeSchemaMapping?.schemaPath === "@talisman-cms/plugin-ecommerce/schema" && collection.nativeSchemaMapping?.exportName === "products"
    );
    const stripeMode = readSetting(env, "COMMERCE_STRIPE_MODE") === "live" ? "live" : "test";
    const scope = scopeKey(env, adminBase);
    const userKey = `${scope}:${authorization.user.id}`;
    if (!allowQuestion(userKey)) return privateJson({ error: "Too many questions. Try again in a minute." }, 429, { "Retry-After": "60" });
    const question = body.question.trim();
    const report = await cachedReport(
      JSON.stringify([scope, authorization.user.id, productCollection?.slug, (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), question]),
      () => createAskReport(
        question,
        bindings.AI,
        bindings.DB,
        env,
        adminBase,
        productCollection?.slug || "products",
        stripeMode
      ),
      (report2) => !report2.notes.some((note) => note.includes("is unavailable"))
    );
    return privateJson(report);
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof AnalyticsSetupError) return privateJson({ error: error.message }, 503);
    const message = error instanceof Error ? error.message : "Could not create the report.";
    const known = error instanceof ReportInputError;
    if (!known) console.error("Ask Analytics failed");
    return Response.json(
      { error: known ? message : "Could not create the report. Please try again." },
      { status: known ? 400 : 502, headers: { "Cache-Control": "no-store" } }
    );
  }
};
export {
  POST
};
