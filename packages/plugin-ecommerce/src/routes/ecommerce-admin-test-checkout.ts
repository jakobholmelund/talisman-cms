import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { bindCommerceApi } from '../api';
import { checkoutSchema } from '../checkout-input';
import { runtimePaymentAdapters } from '../runtime';
import { readCartSessionToken } from '../cookies';

export const ALL: APIRoute = async ({ request, cookies }) => {
  const authorization = await authorizeCmsRequest(request, 'admin');
  if (authorization.response) return authorization.response;
  if (request.method !== 'GET' && request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403 });
  }

  try {
    const sessionToken = readCartSessionToken(cookies);
    const { env } = await import('cloudflare:workers');
    const api = bindCommerceApi({
      env: env as unknown as TalismanEnv,
      paymentAdapters: runtimePaymentAdapters(env as Record<string, unknown>)
    });
    const cart = sessionToken ? await api.carts.find(sessionToken) : null;
    if (request.method === 'GET') {
      let quote = null;
      let quoteError: string | null = null;
      if (cart?.items.length && !cart.checkoutSessionId) {
        try {
          quote = await api.carts.quote(cart.id);
        } catch (error) {
          quoteError = error instanceof Error ? error.message : 'Basket cannot be quoted';
        }
      }
      return Response.json({ cart, quote, quoteError, adminEmail: authorization.user.email },
        { headers: { 'Cache-Control': 'no-store' } });
    }
    if (!sessionToken) return Response.json({ error: 'No basket session found' }, { status: 400 });
    const parsed = checkoutSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: 'Invalid checkout details' }, { status: 400 });
    if (!cart?.items.length) return Response.json({ error: 'Basket is empty' }, { status: 400 });

    let order;
    if (cart.checkoutSessionId) {
      if (!cart.checkoutSessionId.startsWith('admin_test:')) {
        return Response.json({ error: 'Another checkout is already open for this basket' }, { status: 409 });
      }
      order = await api.orders.find(cart.checkoutSessionId.slice('admin_test:'.length));
      if (!order || order.checkoutSessionId !== cart.checkoutSessionId || order.cartId !== cart.id || order.paymentProvider !== 'admin_test') {
        return Response.json({ error: 'Admin test checkout is still being prepared' }, { status: 409 });
      }
    } else {
      const origin = new URL(request.url).origin;
      const created = await api.orders.createFromCart(cart.id, {
        providerId: 'admin_test',
        customerEmail: parsed.data.customerEmail || authorization.user.email,
        shippingAddress: parsed.data.shippingAddress,
        billingAddress: parsed.data.billingAddress,
        successUrl: `${origin}/checkout/success?order={ORDER_ID}`,
        cancelUrl: `${origin}/checkout/cancel?order={ORDER_ID}`
      });
      order = created.order;
    }
    if (!order) throw new Error('Admin test order was not created');
    await api.orders.finalizePayment(order.id, {
      provider: 'admin_test',
      providerId: order.checkoutSessionId!,
      paymentStatus: 'success',
      amount: order.totalAmount,
      currency: order.currency
    });
    return Response.json({
      orderId: order.id,
      status: 'paid',
      paymentProvider: 'admin_test',
      redirectUrl: `/checkout/success?order=${encodeURIComponent(order.id)}`
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Admin test checkout failed' }, { status: 409 });
  }
};
