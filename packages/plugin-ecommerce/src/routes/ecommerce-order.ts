import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { bindCommerceApi } from '../api';
import { runtimePaymentAdapters } from '../runtime';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '../accounts';
import { readCartSessionToken } from '../cookies';

export const ALL: APIRoute = async ({ request, cookies }) => {
  const sessionToken = readCartSessionToken(cookies);
  if (request.method !== 'GET' && request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403 });
  }

  try {
    const orderId = request.method === 'GET'
      ? new URL(request.url).searchParams.get('order')
      : ((await request.json()) as { orderId?: string }).orderId;
    if (!orderId || typeof orderId !== 'string') {
      return Response.json({ error: 'Order ID is required' }, { status: 400 });
    }
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
    const customer = await findCustomerSession(runtimeEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    if (!sessionToken && !customer) return Response.json({ error: 'Order not found' }, { status: 404 });
    const api = bindCommerceApi({ env: runtimeEnv, paymentAdapters: runtimePaymentAdapters(runtimeEnv) });
    let order = await api.orders.findForSession(orderId, sessionToken, customer?.id);
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });

    if (request.method === 'POST') {
      const cancelled = await api.orders.cancel(order.id);
      return Response.json({ orderId: order.id, status: cancelled?.status });
    }
    if (order.status === 'pending') {
      await api.orders.reconcilePending(order.id);
      order = await api.orders.findForSession(orderId, sessionToken, customer?.id);
      if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    }
    return Response.json({
      orderId: order.id,
      status: order.status,
      paymentProvider: order.paymentProvider,
      accountCreatedByOrder: order.userId === `acct_${order.id}`,
      accountLinked: Boolean(order.userId),
      totalAmount: order.totalAmount,
      subtotalAmount: order.subtotalAmount,
      creditApplied: order.creditApplied,
      discountCode: order.discountCode,
      discountAmount: order.discountAmount,
      giftCardApplied: order.giftCardApplied,
      giftCardRefundedCents: order.giftCardRefundedCents,
      providerRefundedCents: order.providerRefundedCents,
      currency: order.currency
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Order request failed' }, { status: 409 });
  }
};
