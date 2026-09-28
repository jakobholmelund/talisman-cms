import {
  runtimePaymentAdapters
} from "../chunk-DQ2SJLJ6.js";
import "../chunk-6L7TQXAW.js";
import "../chunk-BGDJXEM5.js";
import {
  giftCardAccessCookie
} from "../chunk-MDTTSWBR.js";
import {
  GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR,
  StoreSettingsError,
  claimGiftCardCode,
  getGiftCardBalance,
  reportStoreSettingsError,
  startGiftCardPurchase
} from "../chunk-EY3DVH22.js";
import "../chunk-4P4GRAPP.js";
import "../chunk-GNU6N22K.js";
import {
  clientOverLimit
} from "../chunk-CDRJWRSQ.js";
import "../chunk-K4FWMXR2.js";
import "../chunk-NMGICNSV.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-gift-cards.ts
import { readSetting } from "talisman-cms/env";
var INVALID_CLAIM_LINK = "This gift card link has already been used or has expired. Ask the store to send a new one.";
var CLAIM_WINDOW_SECONDS = 60 * 60;
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
    if (body && typeof body === "object" && body.action === "claim") {
      if (await clientOverLimit(
        runtimeEnv,
        "gift-card-claim",
        request.headers.get("cf-connecting-ip"),
        { limit: GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR, windowSeconds: CLAIM_WINDOW_SECONDS }
      )) {
        return Response.json(
          { error: "Too many requests. Please try again later." },
          { status: 429, headers: { ...headers, "Retry-After": String(CLAIM_WINDOW_SECONDS) } }
        );
      }
      try {
        const claimed = await claimGiftCardCode(runtimeEnv, body.token);
        if (!claimed) return Response.json({ error: INVALID_CLAIM_LINK }, { status: 400, headers });
        return Response.json(claimed, { headers });
      } catch (error) {
        console.error("[commerce] Gift card claim failed", { name: error instanceof Error ? error.name : typeof error });
        return Response.json(
          { error: "The gift card code cannot be shown right now. Please try again later." },
          { status: 503, headers }
        );
      }
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
    if (error instanceof StoreSettingsError) {
      return Response.json({ error: reportStoreSettingsError(error) }, { status: 503, headers });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not start gift card purchase" },
      { status: 400, headers }
    );
  }
};
export {
  POST
};
