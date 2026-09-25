import {
  getGiftCardsAdmin,
  issueAdminGiftCard,
  refundGiftCardOnlyOrder,
  refundGiftCardTender,
  setGiftCardActive
} from "../chunk-53CI56PJ.js";
import "../chunk-XLYDGTBP.js";

// src/routes/ecommerce-admin-gift-cards.ts
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
    if (request.method === "GET") return Response.json({ cards: await getGiftCardsAdmin(runtimeEnv) }, { headers });
    const body = await request.json();
    const actor = String(authorization.user?.id ?? "");
    let result;
    if (body.action === "issue") result = await issueAdminGiftCard(runtimeEnv, actor, body.data);
    else if (body.action === "setActive" && typeof body.id === "string") {
      result = await setGiftCardActive(runtimeEnv, body.id, body.active);
    } else if (body.action === "refundTender") result = await refundGiftCardTender(runtimeEnv, actor, body.data);
    else if (body.action === "refundGiftOnlyOrder") result = await refundGiftCardOnlyOrder(runtimeEnv, actor, body.data);
    else return Response.json({ error: "Invalid gift card action" }, { status: 400, headers });
    return Response.json({ result }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Gift card action failed" },
      { status: 400, headers }
    );
  }
};
export {
  ALL
};
