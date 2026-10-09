import {
  runtimePaymentAdapters
} from "../chunk-M4D42HVD.js";
import "../chunk-DR67UJVQ.js";
import {
  ReconcileInputError,
  attachGiftPurchaseSession,
  listParkedCommerce,
  reconcileCommerce,
  recoverTaxSync,
  releaseParkedCommerce,
  retryParkedCommerce
} from "../chunk-OPKAELJD.js";
import "../chunk-KQ3MMFVN.js";
import "../chunk-YHPWUIBV.js";
import "../chunk-BGDJXEM5.js";
import "../chunk-MPRBGWGN.js";
import "../chunk-OZACQY4G.js";
import "../chunk-IUC5ZIOJ.js";
import "../chunk-UJ6XROUG.js";
import "../chunk-GNU6N22K.js";
import "../chunk-LF4NCC75.js";
import "../chunk-4WYWYY7J.js";
import "../chunk-OMZRKOH6.js";
import "../chunk-NQUBOBQT.js";
import "../chunk-SPRRFCF5.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-admin-reconcile.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
import { z } from "zod";
var ALL = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  }
  if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  let action;
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    if (request.method === "GET") return Response.json(await listParkedCommerce(runtimeEnv), { headers });
    const text = await request.text();
    const body = text.trim() ? JSON.parse(text) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid reconciliation action" }, { status: 400, headers });
    }
    const { action: requested, ...input } = body;
    action = requested;
    const paymentAdapters = runtimePaymentAdapters(runtimeEnv);
    if (action === void 0) {
      const results = await reconcileCommerce({ env: runtimeEnv, paymentAdapters });
      return Response.json({ results }, { headers });
    }
    const actor = String(authorization.user?.id ?? "");
    let result;
    if (action === "tax") result = await recoverTaxSync(runtimeEnv, paymentAdapters, actor, input);
    else if (action === "attach-session") result = await attachGiftPurchaseSession({ env: runtimeEnv, paymentAdapters }, actor, input);
    else if (action === "retry") result = await retryParkedCommerce(runtimeEnv, actor, input);
    else if (action === "release") result = await releaseParkedCommerce({ env: runtimeEnv, paymentAdapters }, actor, input);
    else return Response.json({ error: "Invalid reconciliation action" }, { status: 400, headers });
    return Response.json({ result }, { headers });
  } catch (error) {
    const invalid = error instanceof ReconcileInputError || error instanceof SyntaxError || error instanceof z.ZodError;
    const fallback = request.method === "GET" ? "Parked records could not be listed" : "Reconciliation failed";
    return Response.json(
      { error: error instanceof Error ? error.message : fallback },
      { status: invalid ? 400 : request.method === "GET" || action === void 0 ? 500 : 409, headers }
    );
  }
};
export {
  ALL
};
