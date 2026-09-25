import type { APIRoute } from 'astro';
import { bindCommerceApi } from '../api';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '../accounts';
import { runtimePaymentAdapters } from '../runtime';
import type { TalismanEnv } from 'talisman-cms/client';
import { checkoutSchema } from '../checkout-input';
import { REFERRAL_COOKIE } from '../referrals';

export const POST: APIRoute = async ({ request, cookies }) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403 });
  }
  const sessionToken = cookies.get('talisman-cart')?.value;
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: 'No cart session found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const parsed = checkoutSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: 'Invalid checkout details' }, { status: 400 });
    const body = parsed.data;
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
    if (runtimeEnv.GALAXY_COMMERCE_CHECKOUT_ENABLED !== 'true') {
      return Response.json({ error: 'Checkout is disabled' }, { status: 503 });
    }
    const api = bindCommerceApi({
      env: runtimeEnv,
      paymentAdapters: runtimePaymentAdapters(runtimeEnv)
    });
    const customer = await findCustomerSession(runtimeEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);

    const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
    if (!cart || cart.items.length === 0) {
      return new Response(JSON.stringify({ error: 'Cart is empty' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (cart.checkoutSessionId) {
      const resumed = await api.orders.resumeFromCart(cart.id);
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

    const { order, paymentUrl } = await api.orders.createFromCart(cart.id, {
      customerEmail,
      providerId: 'stripe',
      shippingAddress: body.shippingAddress,
      billingAddress: body.billingAddress,
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
    const status = (
      error.message === 'Cart is empty or not found' ||
      error.message === 'Cart is closed' ||
      error.message === 'Checkout already started for this cart' ||
      error.message?.startsWith('Insufficient stock for ') ||
      error.message?.startsWith('Insufficient stock or checkout') ||
      error.message?.startsWith('Product is not available') ||
      error.message?.startsWith('A positive price is required') ||
      error.message?.startsWith('Insufficient shared component stock') ||
      error.message === 'Shipping address is required for physical products' ||
      error.message === 'Discount code is no longer available' ||
      error.message === 'Gift card is no longer available' ||
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
