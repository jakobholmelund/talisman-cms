import {
  runtimePaymentAdapters
} from "../chunk-VVBLCUTQ.js";
import "../chunk-FK3KKBW6.js";
import "../chunk-6LYWG22B.js";
import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "../chunk-2S5ZQZIQ.js";
import {
  bindCommerceApi
} from "../chunk-LKTKY5Y7.js";
import "../chunk-K2FMPEG6.js";
import "../chunk-5JBBAHBQ.js";
import {
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-AGAY2N6E.js";
import "../chunk-4DBNSZO2.js";
import "../chunk-6RT3KMIV.js";

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
    const api = bindCommerceApi({ env: runtimeEnv, paymentAdapters: runtimePaymentAdapters(runtimeEnv) });
    let order = await api.orders.findForSession(orderId, sessionToken, customer?.id);
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
    if (request.method === "POST") {
      const cancelled = await api.orders.cancel(order.id);
      return Response.json({ orderId: order.id, status: cancelled?.status });
    }
    if (order.status === "pending") {
      await api.orders.reconcilePending(order.id);
      order = await api.orders.findForSession(orderId, sessionToken, customer?.id);
      if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
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
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Order request failed" }, { status: 409 });
  }
};
export {
  ALL
};
