import {
  CODE_CHECK_LIMIT_MESSAGE,
  codeChecksOverBasketLimit,
  codeChecksOverNetworkLimit
} from "../chunk-ST7AWJEK.js";
import {
  runtimePaymentAdapters
} from "../chunk-DQ2SJLJ6.js";
import "../chunk-6L7TQXAW.js";
import {
  PARKED_CHECKOUT_MESSAGE,
  TaxCalculationError,
  bindCommerceApi,
  checkoutInputError,
  checkoutSchema,
  isCheckoutDetailsError,
  providerCheckLimitResponse
} from "../chunk-WCXILCO6.js";
import "../chunk-WVV2IFQ2.js";
import {
  codeRefusalBody
} from "../chunk-5NSVUOZJ.js";
import "../chunk-BGDJXEM5.js";
import {
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-P54WYMS4.js";
import "../chunk-WP5KVMJI.js";
import {
  StoreSettingsError,
  readStoreSettings,
  reportStoreSettingsError
} from "../chunk-EY3DVH22.js";
import {
  REFERRAL_COOKIE
} from "../chunk-4P4GRAPP.js";
import "../chunk-GNU6N22K.js";
import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "../chunk-CDRJWRSQ.js";
import "../chunk-K4FWMXR2.js";
import "../chunk-NMGICNSV.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-checkout.ts
import { readSetting } from "talisman-cms/env";
var POST = async ({ request, cookies }) => {
  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env;
  if (readSetting(runtimeEnv, "COMMERCE_CHECKOUT_ENABLED") !== "true") {
    return Response.json({ error: "Checkout is disabled" }, { status: 503 });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403 });
  }
  const sessionToken = readCartSessionToken(cookies);
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "No cart session found" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    readStoreSettings(runtimeEnv);
    const parsed = checkoutSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: checkoutInputError(parsed.error) }, { status: 400 });
    const body = parsed.data;
    const api = bindCommerceApi({
      env: runtimeEnv,
      paymentAdapters: runtimePaymentAdapters(runtimeEnv)
    });
    const customer = await findCustomerSession(runtimeEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    const cart = (customer?.id ? await api.carts.claim(sessionToken, customer.id) : null) ?? await api.carts.find(sessionToken, customer?.id);
    if (!cart || cart.items.length === 0) {
      return new Response(JSON.stringify({ error: "Cart is empty" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (cart.checkoutSessionId) {
      const resumed = await api.orders.resumeFromCart(cart.id, { limitProviderChecks: true });
      if (resumed?.providerCheckLimited) return providerCheckLimitResponse();
      if (resumed?.review) return Response.json({ error: PARKED_CHECKOUT_MESSAGE }, { status: 409 });
      if (resumed?.paymentUrl) {
        return Response.json({ orderId: resumed.order.id, redirectUrl: resumed.paymentUrl, mode: "redirect" });
      }
      const current = await api.carts.find(sessionToken, customer?.id);
      if (current?.checkoutSessionId) {
        return Response.json({ error: "Payment is being prepared or confirmed. Please try again shortly." }, { status: 409 });
      }
    }
    const origin = new URL(request.url).origin;
    const customerEmail = body.customerEmail?.trim();
    if (!customerEmail) {
      return new Response(JSON.stringify({ error: "A valid customer email is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (body.discountCode || body.giftCardCode) {
      const now = Math.floor(Date.now() / 1e3);
      if (await codeChecksOverNetworkLimit(runtimeEnv, request.headers.get("cf-connecting-ip"), now) || await codeChecksOverBasketLimit(runtimeEnv, cart.id, now)) {
        return Response.json({ error: CODE_CHECK_LIMIT_MESSAGE }, { status: 429 });
      }
    }
    const { order, paymentUrl } = await api.orders.createFromCart(cart.id, {
      customerEmail,
      providerId: "stripe",
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
      throw new Error("Failed to create order");
    }
    return new Response(JSON.stringify({
      orderId: order.id,
      redirectUrl: paymentUrl,
      mode: "redirect"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    if (error instanceof StoreSettingsError) {
      return Response.json({ error: reportStoreSettingsError(error) }, { status: 503 });
    }
    if (error instanceof TaxCalculationError) return Response.json({ error: error.message }, { status: 503 });
    const refusal = codeRefusalBody(error);
    if (refusal) return Response.json(refusal, { status: 409 });
    if (isCheckoutDetailsError(error)) return Response.json({ error: error.message }, { status: 400 });
    const status = error.message === "Cart is empty or not found" || error.message === "Cart is closed" || error.message === "Checkout already started for this cart" || error.message?.startsWith("Insufficient stock for ") || error.message?.startsWith("Insufficient stock or checkout") || error.message?.startsWith("Product is not available") || error.message?.startsWith("Select an option for ") || error.message?.startsWith("A positive price is required") || error.message?.startsWith("Insufficient shared component stock") || error.message === "Shipping address is required for physical products" || error.message === "Store credit changed during checkout; please try again" || error.message?.startsWith("Discount code") || error.message?.startsWith("Gift card") || error.message === "A payment provider must be selected and configured before checkout" ? 409 : 500;
    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }
};
export {
  POST
};
