import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "../chunk-2S5ZQZIQ.js";
import {
  bindCommerceApi
} from "../chunk-LKTKY5Y7.js";
import {
  evaluateDiscountCode
} from "../chunk-K2FMPEG6.js";
import "../chunk-5JBBAHBQ.js";
import {
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-AGAY2N6E.js";
import {
  evaluateGiftCard
} from "../chunk-4DBNSZO2.js";
import "../chunk-6RT3KMIV.js";

// src/routes/ecommerce-discount.ts
import { z } from "zod";
var previewSchema = z.object({
  code: z.string().trim().max(32).optional(),
  giftCardCode: z.string().trim().max(37).optional(),
  customerEmail: z.string().trim().email().max(254).optional()
}).strict();
var POST = async ({ request, cookies }) => {
  const headers = { "Cache-Control": "no-store" };
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  const parsed = previewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !(parsed.data.code || parsed.data.giftCardCode)) {
    return Response.json({ error: "Enter a discount or gift card code" }, { status: 400, headers });
  }
  const token = readCartSessionToken(cookies);
  if (!token) return Response.json({ error: "Basket not found" }, { status: 404, headers });
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    const account = await findCustomerSession(runtimeEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    const api = bindCommerceApi({ env: runtimeEnv });
    const cart = account ? await api.carts.getOrCreate(token, account.id) : await api.carts.find(token);
    if (!cart?.items.length || cart.checkoutSessionId) throw new Error("Basket is not available for discounts");
    const quote = await api.carts.quote(cart.id);
    const promotion = parsed.data.code ? await evaluateDiscountCode(runtimeEnv, {
      code: parsed.data.code,
      customerEmail: parsed.data.customerEmail || account?.email || "",
      accountId: account?.id,
      subtotal: quote.totalAmount,
      lines: quote.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        priceAtPurchase: line.unitAmount
      }))
    }) : null;
    const creditApplied = Math.min(
      Math.max(0, account?.creditBalance ?? 0),
      Math.max(0, quote.totalAmount - (promotion?.amount ?? 0) - 50)
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
    return Response.json(
      { error: error instanceof Error ? error.message : "Discount unavailable" },
      { status: 409, headers }
    );
  }
};
export {
  POST
};
