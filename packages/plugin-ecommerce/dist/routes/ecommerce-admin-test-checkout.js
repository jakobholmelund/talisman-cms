import {
  checkoutSchema
} from "../chunk-WVDCIW2W.js";
import {
  AdminTestPaymentAdapter
} from "../chunk-FK3KKBW6.js";
import {
  runtimePaymentAdapters
} from "../chunk-K47ZHGKG.js";
import "../chunk-YXG3523I.js";
import {
  bindCommerceApi
} from "../chunk-ZCEC33U7.js";
import "../chunk-BCWAVKQF.js";
import {
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-YXNRHYNN.js";
import "../chunk-2RLPKBNT.js";
import "../chunk-MS53KKKY.js";
import "../chunk-NITAPJVN.js";
import "../chunk-CLEUXV3O.js";

// src/routes/ecommerce-admin-test-checkout.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
var ALL = async ({ request, cookies }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403 });
  }
  try {
    const sessionToken = readCartSessionToken(cookies);
    const { env } = await import("cloudflare:workers");
    const api = bindCommerceApi({
      env,
      // The simulated provider is registered here only, never for public routes.
      paymentAdapters: [...runtimePaymentAdapters(env), new AdminTestPaymentAdapter()]
    });
    const cart = sessionToken ? await api.carts.find(sessionToken) : null;
    if (request.method === "GET") {
      let quote = null;
      let quoteError = null;
      if (cart?.items.length && !cart.checkoutSessionId) {
        try {
          quote = await api.carts.quote(cart.id);
        } catch (error) {
          quoteError = error instanceof Error ? error.message : "Basket cannot be quoted";
        }
      }
      return Response.json(
        { cart, quote, quoteError, adminEmail: authorization.user.email },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (!sessionToken) return Response.json({ error: "No basket session found" }, { status: 400 });
    const parsed = checkoutSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Invalid checkout details" }, { status: 400 });
    if (!cart?.items.length) return Response.json({ error: "Basket is empty" }, { status: 400 });
    let order;
    if (cart.checkoutSessionId) {
      if (!cart.checkoutSessionId.startsWith("admin_test:")) {
        return Response.json({ error: "Another checkout is already open for this basket" }, { status: 409 });
      }
      order = await api.orders.find(cart.checkoutSessionId.slice("admin_test:".length));
      if (!order || order.checkoutSessionId !== cart.checkoutSessionId || order.cartId !== cart.id || order.paymentProvider !== "admin_test") {
        return Response.json({ error: "Admin test checkout is still being prepared" }, { status: 409 });
      }
    } else {
      const origin = new URL(request.url).origin;
      const created = await api.orders.createFromCart(cart.id, {
        providerId: "admin_test",
        customerEmail: parsed.data.customerEmail || authorization.user.email,
        shippingAddress: parsed.data.shippingAddress,
        billingAddress: parsed.data.billingAddress,
        successUrl: `${origin}/checkout/success?order={ORDER_ID}`,
        cancelUrl: `${origin}/checkout/cancel?order={ORDER_ID}`
      });
      order = created.order;
    }
    if (!order) throw new Error("Admin test order was not created");
    await api.orders.finalizePayment(order.id, {
      provider: "admin_test",
      providerId: order.checkoutSessionId,
      paymentStatus: "success",
      amount: order.totalAmount,
      currency: order.currency
    });
    return Response.json({
      orderId: order.id,
      status: "paid",
      paymentProvider: "admin_test",
      redirectUrl: `/checkout/success?order=${encodeURIComponent(order.id)}`
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Admin test checkout failed" }, { status: 409 });
  }
};
export {
  ALL
};
