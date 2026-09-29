import {
  FulfillmentInputError,
  correctCommerceFulfillment,
  fulfillCommerceOrder,
  listCommerceOrdersAdmin
} from "../chunk-FFJXPA3V.js";
import "../chunk-4LBJN5LU.js";
import "../chunk-NTFJG6BA.js";
import "../chunk-GNU6N22K.js";
import "../chunk-IAWGIRUS.js";
import "../chunk-ZI5IJOR6.js";
import "../chunk-NKJTK7MK.js";
import "../chunk-NMGICNSV.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-admin-fulfillment.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
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
  let reading = request.method === "GET";
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    if (request.method === "GET") {
      const params = new URL(request.url).searchParams;
      const limit = params.get("limit");
      return Response.json(await listCommerceOrdersAdmin(runtimeEnv, {
        view: params.get("view") || void 0,
        cursor: params.get("cursor") || void 0,
        limit: limit ? Number(limit) : void 0,
        query: params.get("query") || void 0
      }), { headers });
    }
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid fulfillment action" }, { status: 400, headers });
    }
    const { action, ...input } = body;
    if (action === "list") {
      reading = true;
      return Response.json(await listCommerceOrdersAdmin(runtimeEnv, input), { headers });
    }
    const actor = String(authorization.user?.id ?? "");
    let result;
    if (action === "ship" || action === void 0 && "orderId" in input) {
      result = await fulfillCommerceOrder(runtimeEnv, actor, input);
    } else if (action === "correct") result = await correctCommerceFulfillment(runtimeEnv, actor, input);
    else return Response.json({ error: "Invalid fulfillment action" }, { status: 400, headers });
    return Response.json({ result }, { headers });
  } catch (error) {
    const invalid = error instanceof FulfillmentInputError || error instanceof SyntaxError;
    return Response.json(
      { error: error instanceof Error ? error.message : "Order fulfillment failed" },
      { status: invalid ? 400 : reading ? 500 : 409, headers }
    );
  }
};
export {
  ALL
};
