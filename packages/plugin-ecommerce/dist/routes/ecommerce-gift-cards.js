import {
  runtimePaymentAdapters
} from "../chunk-VVBLCUTQ.js";
import "../chunk-FK3KKBW6.js";
import "../chunk-6LYWG22B.js";
import {
  giftCardAccessCookie
} from "../chunk-MDTTSWBR.js";
import {
  getGiftCardBalance,
  startGiftCardPurchase
} from "../chunk-4DBNSZO2.js";
import "../chunk-6RT3KMIV.js";

// src/routes/ecommerce-gift-cards.ts
import { readSetting } from "talisman-cms/env";
var POST = async ({ request, cookies }) => {
  const headers = { "Cache-Control": "no-store" };
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    const body = await request.json();
    if (body && typeof body === "object" && body.action === "balance" && typeof body.code === "string") {
      return Response.json(await getGiftCardBalance(runtimeEnv, body.code), { headers });
    }
    if (readSetting(runtimeEnv, "COMMERCE_CHECKOUT_ENABLED") !== "true" || readSetting(runtimeEnv, "COMMERCE_GIFT_CARDS_ENABLED") !== "true") {
      return Response.json({ error: "Gift card purchases are unavailable" }, { status: 503, headers });
    }
    const adapter = runtimePaymentAdapters(runtimeEnv).find((provider) => provider.providerId === "stripe");
    if (!adapter) return Response.json({ error: "Stripe is not configured" }, { status: 503, headers });
    const origin = new URL(request.url).origin;
    const purchase = await startGiftCardPurchase(runtimeEnv, adapter, body, {
      successUrl: `${origin}/gift-cards/success?purchase={PURCHASE_ID}`,
      cancelUrl: `${origin}/gift-cards?cancelled=1`
    });
    cookies.set(giftCardAccessCookie(purchase.id), purchase.accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      path: "/gift-cards",
      maxAge: 7 * 24 * 60 * 60
    });
    return Response.json({ purchaseId: purchase.id, redirectUrl: purchase.paymentUrl }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not start gift card purchase" },
      { status: 400, headers }
    );
  }
};
export {
  POST
};
