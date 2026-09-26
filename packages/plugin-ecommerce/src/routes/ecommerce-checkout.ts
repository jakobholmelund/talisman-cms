import type { APIRoute } from 'astro';
import { bindCommerceApi } from '../api';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '../accounts';
import { runtimePaymentAdapters } from '../runtime';
import type { TalismanEnv } from 'talisman-cms/client';
import { readSetting } from 'talisman-cms/env';
import { checkoutInputError, checkoutSchema, isCheckoutDetailsError } from '../checkout-input';
import { REFERRAL_COOKIE } from '../referrals';
import { readCartSessionToken } from '../cookies';
import { codeRefusalBody } from '../promotions';
import { CODE_CHECK_LIMIT_MESSAGE, codeChecksOverBasketLimit, codeChecksOverNetworkLimit } from '../code-check-limits';
import { providerCheckLimitResponse } from '../provider-checks';
import { StoreSettingsError, readStoreSettings, reportStoreSettingsError } from '../store-settings';
import { TaxCalculationError } from '../tax';

export const POST: APIRoute = async ({ request, cookies }) => {
  const { env } = await import('cloudflare:workers');
  const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
  // Checked before anything else: a disabled checkout reads no basket and writes nothing.
  if (readSetting(runtimeEnv, 'COMMERCE_CHECKOUT_ENABLED') !== 'true') {
    return Response.json({ error: 'Checkout is disabled' }, { status: 503 });
  }
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403 });
  }
  const sessionToken = readCartSessionToken(cookies);
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: 'No cart session found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Invalid store settings stop checkout before the basket is read or written.
    readStoreSettings(runtimeEnv);
    const parsed = checkoutSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: checkoutInputError(parsed.error) }, { status: 400 });
    const body = parsed.data;
    const api = bindCommerceApi({
      env: runtimeEnv,
      paymentAdapters: runtimePaymentAdapters(runtimeEnv)
    });
    const customer = await findCustomerSession(runtimeEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);

    // Checkout needs an open basket and never creates one.
    const cart = (customer?.id ? await api.carts.claim(sessionToken, customer.id) : null) ??
      await api.carts.find(sessionToken, customer?.id);
    if (!cart || cart.items.length === 0) {
      return new Response(JSON.stringify({ error: 'Cart is empty' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (cart.checkoutSessionId) {
      const resumed = await api.orders.resumeFromCart(cart.id, { limitProviderChecks: true });
      if (resumed?.providerCheckLimited) return providerCheckLimitResponse();
      if (resumed?.paymentUrl) {
        return Response.json({ orderId: resumed.order.id, redirectUrl: resumed.paymentUrl, mode: 'redirect' });
      }
      const current = await api.carts.find(sessionToken, customer?.id);
      if (current?.checkoutSessionId) {
        return Response.json({ error: 'Payment is being prepared or confirmed. Please try again shortly.' }, { status: 409 });
      }
    }

    const origin = new URL(request.url).origin;
    const customerEmail = body.customerEmail?.trim();
    if (!customerEmail) {
      return new Response(JSON.stringify({ error: 'A valid customer email is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // A checkout that carries a code is a code check and shares the discount preview's limits.
    if (body.discountCode || body.giftCardCode) {
      const now = Math.floor(Date.now() / 1000);
      if (await codeChecksOverNetworkLimit(runtimeEnv, request.headers.get('cf-connecting-ip'), now) ||
          await codeChecksOverBasketLimit(runtimeEnv, cart.id, now)) {
        return Response.json({ error: CODE_CHECK_LIMIT_MESSAGE }, { status: 429 });
      }
    }

    const { order, paymentUrl } = await api.orders.createFromCart(cart.id, {
      customerEmail,
      providerId: 'stripe',
      shippingAddress: body.shippingAddress,
      billingAddress: body.billingAddress,
      shippingRateId: body.shippingRateId,
      discountCode: body.discountCode,
      giftCardCode: body.giftCardCode,
      referralCode: cookies.get(REFERRAL_COOKIE)?.value,
      successUrl: `${origin}/checkout/success?order={ORDER_ID}`,
      cancelUrl: `${origin}/checkout/cancel?order={ORDER_ID}`
    });
    if (!order) {
      throw new Error('Failed to create order');
    }

    return new Response(JSON.stringify({
      orderId: order.id,
      redirectUrl: paymentUrl,
      mode: 'redirect'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    if (error instanceof StoreSettingsError) {
      return Response.json({ error: reportStoreSettingsError(error) }, { status: 503 });
    }
    // The cause is already in the Worker log.
    if (error instanceof TaxCalculationError) return Response.json({ error: error.message }, { status: 503 });
    // A refused discount or gift card code gets one answer, whatever the reason.
    const refusal = codeRefusalBody(error);
    if (refusal) return Response.json(refusal, { status: 409 });
    if (isCheckoutDetailsError(error)) return Response.json({ error: error.message }, { status: 400 });
    const status = (
      error.message === 'Cart is empty or not found' ||
      error.message === 'Cart is closed' ||
      error.message === 'Checkout already started for this cart' ||
      error.message?.startsWith('Insufficient stock for ') ||
      error.message?.startsWith('Insufficient stock or checkout') ||
      error.message?.startsWith('Product is not available') ||
      error.message?.startsWith('Select an option for ') ||
      error.message?.startsWith('A positive price is required') ||
      error.message?.startsWith('Insufficient shared component stock') ||
      error.message === 'Shipping address is required for physical products' ||
      error.message === 'Store credit changed during checkout; please try again' ||
      error.message?.startsWith('Discount code') ||
      error.message?.startsWith('Gift card') ||
      error.message === 'A payment provider must be selected and configured before checkout'
    ) ? 409 : 500;

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
