import {
  CODE_CHECK_LIMIT_MESSAGE,
  codeChecksOverBasketLimit,
  codeChecksOverNetworkLimit
} from "../chunk-ST7AWJEK.js";
import {
  bindCommerceApi
} from "../chunk-WCXILCO6.js";
import "../chunk-WVV2IFQ2.js";
import {
  codeRefusalBody,
  evaluateDiscountCode
} from "../chunk-5NSVUOZJ.js";
import "../chunk-BGDJXEM5.js";
import {
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-P54WYMS4.js";
import "../chunk-WP5KVMJI.js";
import {
  StoreSettingsError,
  evaluateGiftCard,
  readStoreSettings,
  reportStoreSettingsError
} from "../chunk-EY3DVH22.js";
import "../chunk-4P4GRAPP.js";
import "../chunk-GNU6N22K.js";
import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "../chunk-CDRJWRSQ.js";
import "../chunk-K4FWMXR2.js";
import "../chunk-NMGICNSV.js";
import {
  minimumChargeAmount
} from "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-discount.ts
import { z } from "zod";
import { readSetting } from "talisman-cms/env";
var previewSchema = z.object({
  code: z.string().trim().max(200).optional(),
  giftCardCode: z.string().trim().max(200).optional(),
  customerEmail: z.unknown().optional()
}).strict();
var POST = async ({ request, cookies }) => {
  const headers = { "Cache-Control": "no-store" };
  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env;
  if (readSetting(runtimeEnv, "COMMERCE_CHECKOUT_ENABLED") !== "true") {
    return Response.json({ error: "Checkout is disabled" }, { status: 503, headers });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  const parsed = previewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !(parsed.data.code || parsed.data.giftCardCode)) {
    return Response.json({ error: "Enter a discount or gift card code" }, { status: 400, headers });
  }
  const tooMany = () => Response.json({ error: CODE_CHECK_LIMIT_MESSAGE }, { status: 429, headers });
  const now = Math.floor(Date.now() / 1e3);
  if (await codeChecksOverNetworkLimit(runtimeEnv, request.headers.get("cf-connecting-ip"), now)) return tooMany();
  const token = readCartSessionToken(cookies);
  if (!token) return Response.json({ error: "Basket not found" }, { status: 404, headers });
  try {
    readStoreSettings(runtimeEnv);
    const account = await findCustomerSession(runtimeEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    const api = bindCommerceApi({ env: runtimeEnv });
    const cart = (account ? await api.carts.claim(token, account.id) : null) ?? await api.carts.find(token, account?.id);
    if (cart && await codeChecksOverBasketLimit(runtimeEnv, cart.id, now)) return tooMany();
    if (!cart?.items.length || cart.checkoutSessionId) throw new Error("Basket is not available for discounts");
    const quote = await api.carts.quote(cart.id);
    const promotion = parsed.data.code ? await evaluateDiscountCode(runtimeEnv, {
      code: parsed.data.code,
      customerEmail: "",
      accountId: account?.id,
      checkShopperHistory: Boolean(account),
      subtotal: quote.totalAmount,
      lines: quote.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        priceAtPurchase: line.unitAmount
      }))
    }) : null;
    const creditApplied = Math.min(
      Math.max(0, account?.creditBalance ?? 0),
      Math.max(0, quote.totalAmount - (promotion?.amount ?? 0) - minimumChargeAmount(quote.currency))
    );
    const afterCredit = quote.totalAmount - (promotion?.amount ?? 0) - creditApplied;
    const giftCard = parsed.data.giftCardCode ? await evaluateGiftCard(runtimeEnv, parsed.data.giftCardCode, afterCredit) : null;
    return Response.json({
      code: promotion?.code ?? null,
      type: promotion?.type ?? null,
      discountAmount: promotion?.amount ?? 0,
      creditApplied,
      giftCardApplied: giftCard?.amount ?? 0,
      giftCardSuffix: giftCard?.codeSuffix ?? null,
      cardAmount: afterCredit - (giftCard?.amount ?? 0)
    }, { headers });
  } catch (error) {
    if (error instanceof StoreSettingsError) {
      return Response.json({ error: reportStoreSettingsError(error) }, { status: 503, headers });
    }
    const refusal = codeRefusalBody(error);
    if (refusal) return Response.json(refusal, { status: 409, headers });
    return Response.json(
      { error: error instanceof Error ? error.message : "Discount unavailable" },
      { status: 409, headers }
    );
  }
};
export {
  POST
};
