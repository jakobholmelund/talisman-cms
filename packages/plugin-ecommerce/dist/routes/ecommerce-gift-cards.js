import {
  readBoundedJson
} from "../chunk-6KSBZ7AT.js";
import {
  runtimePaymentAdapters
} from "../chunk-AVWDMCNG.js";
import "../chunk-IN4CG7W7.js";
import {
  GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR,
  GiftCardRefusal,
  StoreSettingsError,
  claimGiftCardCode,
  getGiftCardBalance,
  reportStoreSettingsError,
  shopperFailure,
  startGiftCardPurchase
} from "../chunk-PVGGIHJ5.js";
import "../chunk-IC3XDWQU.js";
import "../chunk-GNU6N22K.js";
import {
  clientOverLimit
} from "../chunk-PMYARYOQ.js";
import "../chunk-SXQHVX4E.js";
import "../chunk-PLAJXKV3.js";
import {
  giftCardAccessCookie
} from "../chunk-NQUBOBQT.js";
import "../chunk-AQNK3BKB.js";
import "../chunk-HNDRZISR.js";

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
    const body = await readBoundedJson(request);
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
    if (error instanceof GiftCardRefusal) return Response.json({ error: "Gift card purchases are unavailable" }, { status: 409, headers });
    const failure = shopperFailure(error);
    return Response.json({ error: failure.error, code: failure.code }, { status: failure.status, headers });
  }
};
export {
  POST
};
