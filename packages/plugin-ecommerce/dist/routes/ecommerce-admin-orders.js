import {
  OrderAdjustmentInputError,
  OrderAdjustmentRefusedError,
  getOrderAdjustmentsAdmin,
  restockOrder
} from "../chunk-IK22DR6W.js";
import "../chunk-WP5KVMJI.js";

// src/routes/ecommerce-admin-orders.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
var ALL = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid order action" }, { status: 400, headers });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid order action" }, { status: 400, headers });
  }
  const { action, ...input } = body;
  if (action !== "list" && action !== "restock") {
    return Response.json({ error: "Invalid order action" }, { status: 400, headers });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    if (action === "list") return Response.json(await getOrderAdjustmentsAdmin(runtimeEnv, input), { headers });
    const result = await restockOrder(runtimeEnv, String(authorization.user?.id ?? ""), input);
    return Response.json({ result }, { headers });
  } catch (error) {
    if (error instanceof OrderAdjustmentInputError) {
      return Response.json({ error: error.message }, { status: 400, headers });
    }
    if (error instanceof OrderAdjustmentRefusedError) {
      return Response.json({ error: error.message }, { status: 409, headers });
    }
    const reading = action === "list";
    console.error(
      reading ? "[commerce] Order adjustments could not be read" : "[commerce] Restock failed",
      error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error }
    );
    return Response.json({ error: reading ? "The orders could not be read. Check the server logs for details." : "The restock failed. Check the server logs for details." }, { status: 500, headers });
  }
};
export {
  ALL
};
