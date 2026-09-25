import {
  runtimePaymentAdapters
} from "../chunk-CP2YO37X.js";
import "../chunk-6LYWG22B.js";
import {
  reconcileCommerce
} from "../chunk-V63N6CZ5.js";
import "../chunk-QMKGVIUH.js";
import "../chunk-LDDVV7H7.js";
import "../chunk-NTGZYO6Q.js";
import "../chunk-YXNRHYNN.js";
import "../chunk-4AHWGSV4.js";
import "../chunk-CLEUXV3O.js";

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
