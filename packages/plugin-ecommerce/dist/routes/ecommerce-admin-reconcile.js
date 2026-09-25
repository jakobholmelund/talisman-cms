import {
  runtimePaymentAdapters
} from "../chunk-WXEFSKPU.js";
import "../chunk-FK3KKBW6.js";
import "../chunk-6LYWG22B.js";
import {
  reconcileCommerce
} from "../chunk-4B5ROQI2.js";
import "../chunk-MQPA2QMJ.js";
import "../chunk-PRGHPNDB.js";
import "../chunk-AGAY2N6E.js";
import "../chunk-U46CR236.js";
import "../chunk-6RT3KMIV.js";

// src/routes/ecommerce-admin-reconcile.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
var POST = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403 });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    const results = await reconcileCommerce({
      env: runtimeEnv,
      paymentAdapters: runtimePaymentAdapters(runtimeEnv)
    });
    return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Reconciliation failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
};
export {
  POST
};
