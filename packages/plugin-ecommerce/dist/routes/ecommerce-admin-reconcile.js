import {
  runtimePaymentAdapters
} from "../chunk-K47ZHGKG.js";
import "../chunk-YXG3523I.js";
import {
  reconcileCommerce
} from "../chunk-ZCEC33U7.js";
import "../chunk-BCWAVKQF.js";
import "../chunk-YXNRHYNN.js";
import "../chunk-2RLPKBNT.js";
import "../chunk-MS53KKKY.js";
import "../chunk-NITAPJVN.js";
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
