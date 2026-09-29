import {
  VariantChangeError,
  runVariantChange
} from "../chunk-JHRVUXXO.js";
import "../chunk-ZI5IJOR6.js";
import "../chunk-NKJTK7MK.js";

// src/routes/ecommerce-admin-variants.ts
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
    return Response.json({ error: "Invalid variant change" }, { status: 400, headers });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const result = await runVariantChange(env, body);
    return Response.json({ result }, { headers });
  } catch (error) {
    if (error instanceof VariantChangeError) {
      return Response.json(
        { error: error.message, ...error.code ? { code: error.code } : {} },
        { status: error.status, headers }
      );
    }
    console.error("[commerce] Variant change failed", error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error });
    return Response.json(
      { error: "The variant change could not be saved. Check the server logs for details." },
      { status: 500, headers }
    );
  }
};
export {
  ALL
};
