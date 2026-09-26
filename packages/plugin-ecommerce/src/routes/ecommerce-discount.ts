import type { APIRoute } from 'astro';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { readSetting } from 'talisman-cms/env';
import { bindCommerceApi } from '../api';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '../accounts';
import { codeRefusalBody, evaluateDiscountCode } from '../promotions';
import { evaluateGiftCard } from '../gift-cards';
import { readCartSessionToken } from '../cookies';
import { CODE_CHECK_LIMIT_MESSAGE, codeChecksOverBasketLimit, codeChecksOverNetworkLimit } from '../code-check-limits';
import { minimumChargeAmount } from '../money';
import { StoreSettingsError, readStoreSettings, reportStoreSettingsError } from '../store-settings';

// `customerEmail` is still accepted in any form so existing storefronts keep working, but the preview
// ignores it: it decides only from the basket and the signed-in shopper's own account. The code
// lengths only bound the body; a code of the wrong shape gets the same refusal as any other.
const previewSchema = z.object({ code: z.string().trim().max(200).optional(),
  giftCardCode: z.string().trim().max(200).optional(),
  customerEmail: z.unknown().optional() }).strict();

export const POST: APIRoute = async ({ request, cookies }) => {
  const headers = { 'Cache-Control': 'no-store' };
  const { env } = await import('cloudflare:workers');
  const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
  // Checked before anything else, as in the checkout route: while checkout is disabled the preview
  // reads no basket, account, discount code or gift card.
  if (readSetting(runtimeEnv, 'COMMERCE_CHECKOUT_ENABLED') !== 'true') {
    return Response.json({ error: 'Checkout is disabled' }, { status: 503, headers });
  }
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403, headers });
  }
  const parsed = previewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !(parsed.data.code || parsed.data.giftCardCode)) {
    return Response.json({ error: 'Enter a discount or gift card code' }, { status: 400, headers });
  }
  const tooMany = () => Response.json({ error: CODE_CHECK_LIMIT_MESSAGE }, { status: 429, headers });
  const now = Math.floor(Date.now() / 1000);
  // Every preview that passes the request checks counts, before any basket or code is read.
  if (await codeChecksOverNetworkLimit(runtimeEnv, request.headers.get('cf-connecting-ip'), now)) return tooMany();
  const token = readCartSessionToken(cookies);
  if (!token) return Response.json({ error: 'Basket not found' }, { status: 404, headers });
  try {
    // Invalid store settings stop the preview before the basket or account is read.
    readStoreSettings(runtimeEnv);
    const account = await findCustomerSession(runtimeEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    const api = bindCommerceApi({ env: runtimeEnv });
    // Links the browser basket to a signed-in account like the cart route, but never creates a basket.
    const cart = (account ? await api.carts.claim(token, account.id) : null) ??
      await api.carts.find(token, account?.id);
    if (cart && await codeChecksOverBasketLimit(runtimeEnv, cart.id, now)) return tooMany();
    if (!cart?.items.length || cart.checkoutSessionId) throw new Error('Basket is not available for discounts');
    const quote = await api.carts.quote(cart.id);
    // Order-history rules are checked against a signed-in account only. A guest has no verified
    // address here, so first-order and per-customer rules wait for checkout and its email.
    const promotion = parsed.data.code ? await evaluateDiscountCode(runtimeEnv, {
      code: parsed.data.code, customerEmail: '', accountId: account?.id,
      checkShopperHistory: Boolean(account), subtotal: quote.totalAmount,
      lines: quote.lines.map(line => ({ productId: line.productId,
        quantity: line.quantity, priceAtPurchase: line.unitAmount }))
    }) : null;
    const creditApplied = Math.min(Math.max(0, account?.creditBalance ?? 0),
      Math.max(0, quote.totalAmount - (promotion?.amount ?? 0) - minimumChargeAmount(quote.currency)));
    const afterCredit = quote.totalAmount - (promotion?.amount ?? 0) - creditApplied;
    const giftCard = parsed.data.giftCardCode
      ? await evaluateGiftCard(runtimeEnv, parsed.data.giftCardCode, afterCredit) : null;
    return Response.json({ code: promotion?.code ?? null, type: promotion?.type ?? null,
      discountAmount: promotion?.amount ?? 0, creditApplied,
      giftCardApplied: giftCard?.amount ?? 0, giftCardSuffix: giftCard?.codeSuffix ?? null,
      cardAmount: afterCredit - (giftCard?.amount ?? 0) }, { headers });
  } catch (error) {
    if (error instanceof StoreSettingsError) {
      return Response.json({ error: reportStoreSettingsError(error) }, { status: 503, headers });
    }
    // Every refusal of an entered code gets one answer; basket problems keep their own.
    const refusal = codeRefusalBody(error);
    if (refusal) return Response.json(refusal, { status: 409, headers });
    return Response.json({ error: error instanceof Error ? error.message : 'Discount unavailable' },
      { status: 409, headers });
  }
};
