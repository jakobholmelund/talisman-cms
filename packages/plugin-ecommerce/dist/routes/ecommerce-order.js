import {
  runtimePaymentAdapters
} from "../chunk-DQ2SJLJ6.js";
import "../chunk-6L7TQXAW.js";
import {
  PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS,
  ProviderCheckLimitedError,
  bindCommerceApi,
  mayAskPaymentProvider,
  providerCheckLimitResponse
} from "../chunk-2HRMHYMK.js";
import "../chunk-TPW5F2YY.js";
import "../chunk-SWPC7XQH.js";
import "../chunk-BGDJXEM5.js";
import {
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-6CXRXC6K.js";
import {
  reconcileFailure
} from "../chunk-HOPUAWN7.js";
import "../chunk-2XVZABM5.js";
import "../chunk-GNU6N22K.js";
import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "../chunk-2WZJA37J.js";
import "../chunk-DUYAQ7V4.js";
import "../chunk-NKJTK7MK.js";
import "../chunk-NMGICNSV.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-order.ts
var ALL = async ({ request, cookies }) => {
  const sessionToken = readCartSessionToken(cookies);
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403 });
  }
  try {
    const orderId = request.method === "GET" ? new URL(request.url).searchParams.get("order") : (await request.json()).orderId;
    if (!orderId || typeof orderId !== "string") {
      return Response.json({ error: "Order ID is required" }, { status: 400 });
    }
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    const customer = await findCustomerSession(runtimeEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    if (!sessionToken && !customer) return Response.json({ error: "Order not found" }, { status: 404 });
    const paymentAdapters = runtimePaymentAdapters(runtimeEnv);
    const api = bindCommerceApi({ env: runtimeEnv, paymentAdapters });
    let order = await api.orders.findForSession(orderId, sessionToken, customer?.id);
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
    if (request.method === "POST") {
      try {
        const cancelled = await api.orders.cancel(order.id, { limitProviderChecks: true });
        return Response.json({ orderId: order.id, status: cancelled?.status });
      } catch (error) {
        if (error instanceof ProviderCheckLimitedError) return providerCheckLimitResponse();
        throw error;
      }
    }
    if (order.status === "pending" && !order.reconcileReviewAt && await mayAskPaymentProvider(
      runtimeEnv,
      order,
      paymentAdapters,
      { minOrderAgeSeconds: PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS }
    )) {
      try {
        await api.orders.reconcilePending(order.id);
      } catch (error) {
        console.warn("[commerce] Order status check failed", { code: reconcileFailure(error).code });
      }
      order = await api.orders.findForSession(orderId, sessionToken, customer?.id);
      if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
    }
    return Response.json({
      orderId: order.id,
      status: order.status,
      paymentUnderReview: order.status === "pending" && order.reconcileReviewAt !== null,
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
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Order request failed" }, { status: 409 });
  }
};
export {
  ALL
};
