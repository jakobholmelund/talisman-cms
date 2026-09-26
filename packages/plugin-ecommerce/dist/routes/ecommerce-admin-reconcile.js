import {
  runtimePaymentAdapters
} from "../chunk-R7FZZLF2.js";
import "../chunk-C2SYF4CS.js";
import {
  reconcileCommerce
} from "../chunk-GDYU3454.js";
import "../chunk-HAO6IOX2.js";
import "../chunk-BGDJXEM5.js";
import "../chunk-63W5IYCB.js";
import "../chunk-3I33VHHD.js";
import "../chunk-2UYSCNNW.js";
import "../chunk-6773WH54.js";
import "../chunk-AASKNEFP.js";
import "../chunk-U2UUCKVF.js";

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
