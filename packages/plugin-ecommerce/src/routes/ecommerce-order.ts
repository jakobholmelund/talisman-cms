import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { bindCommerceApi } from '../api';
import { runtimePaymentAdapters } from '../runtime';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '../accounts';
import { readCartSessionToken } from '../cookies';
import { PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS, ProviderCheckLimitedError, mayAskPaymentProvider,
  providerCheckLimitResponse } from '../provider-checks';
import { reconcileFailure } from '../reconcile';

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
    const paymentAdapters = runtimePaymentAdapters(runtimeEnv);
    const api = bindCommerceApi({ env: runtimeEnv, paymentAdapters });
    let order = await api.orders.findForSession(orderId, sessionToken, customer?.id);
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });

    if (request.method === 'POST') {
      // A release asks the provider about the session first, so it shares the order's slot too.
      try {
        const cancelled = await api.orders.cancel(order.id, { limitProviderChecks: true });
        return Response.json({ orderId: order.id, status: cancelled?.status });
      } catch (error) {
        if (error instanceof ProviderCheckLimitedError) return providerCheckLimitResponse();
        throw error;
      }
    }
    // The provider is asked at most once per order per interval, and not before the order is a minute
    // old, which the webhook normally settles; any other request returns the stored status. An order
    // parked for review waits for an administrator and is never checked from here.
    if (order.status === 'pending' && !order.reconcileReviewAt && await mayAskPaymentProvider(runtimeEnv, order,
      paymentAdapters, { minOrderAgeSeconds: PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS })) {
      try {
        await api.orders.reconcilePending(order.id);
      } catch (error) {
        // The shopper gets the stored status. Scheduled reconciliation records the failure, backs off
        // and parks a permanent one.
        console.warn('[commerce] Order status check failed', { code: reconcileFailure(error).code });
      }
      order = await api.orders.findForSession(orderId, sessionToken, customer?.id);
      if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    }
    return Response.json({
      orderId: order.id,
      status: order.status,
      paymentUnderReview: order.status === 'pending' && order.reconcileReviewAt !== null,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentProvider: order.paymentProvider,
      accountCreatedByOrder: order.userId === `acct_${order.id}`,
      accountLinked: Boolean(order.userId),
      totalAmount: order.totalAmount,
      subtotalAmount: order.subtotalAmount,
      shippingAmount: order.shippingAmount,
      shippingLabel: order.shippingLabel,
      taxAmount: order.taxAmount,
      taxBehavior: order.taxBehavior,
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
