import {
  fulfillCommerceOrder,
  listCommerceOrdersAdmin
} from "../chunk-AGAY2N6E.js";
import "../chunk-6RT3KMIV.js";

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
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    if (request.method === "GET") return Response.json(await listCommerceOrdersAdmin(runtimeEnv), { headers });
    const result = await fulfillCommerceOrder(runtimeEnv, String(authorization.user?.id ?? ""), await request.json());
    return Response.json({ result }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Order fulfillment failed" },
      { status: 409, headers }
    );
  }
};
export {
  ALL
};
