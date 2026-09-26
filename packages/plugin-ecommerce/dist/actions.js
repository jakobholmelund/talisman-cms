import {
  BASKET_LIMIT_MESSAGE,
  basketCreationOverLimit
} from "./chunk-GYJAI2DT.js";
import {
  CODE_CHECK_LIMIT_MESSAGE,
  codeChecksOverBasketLimit,
  codeChecksOverNetworkLimit
} from "./chunk-6HILOGQM.js";
import {
  runtimePaymentAdapters
} from "./chunk-R7FZZLF2.js";
import "./chunk-C2SYF4CS.js";
import {
  CART_MAX_LINE_QUANTITY,
  PROVIDER_CHECK_RETRY_MESSAGE,
  TaxCalculationError,
  bindCommerceApi
} from "./chunk-GDYU3454.js";
import {
  codeRefusalBody
} from "./chunk-HAO6IOX2.js";
import "./chunk-BGDJXEM5.js";
import {
  ensureCartSession,
  readCartSessionToken
} from "./chunk-MDTTSWBR.js";
import "./chunk-63W5IYCB.js";
import {
  StoreSettingsError,
  readStoreSettings,
  reportStoreSettingsError
} from "./chunk-3I33VHHD.js";
import "./chunk-2UYSCNNW.js";
import {
  REFERRAL_COOKIE
} from "./chunk-6773WH54.js";
import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "./chunk-AASKNEFP.js";
import "./chunk-U2UUCKVF.js";

// src/actions.ts
import { defineAction, ActionError } from "astro:actions";
import { z } from "astro/zod";
import { readSetting } from "talisman-cms/env";
function getOrCreateCartSession(context) {
  if (!context.cookies) return `anon_${crypto.randomUUID()}`;
  return ensureCartSession(context.cookies, context.url?.protocol === "https:");
}
async function currentCart(api, context, customerId) {
  const sessionToken = context.cookies ? readCartSessionToken(context.cookies) : void 0;
  return (customerId && sessionToken ? await api.carts.claim(sessionToken, customerId) : null) ?? await api.carts.find(sessionToken, customerId);
}
var ecommerceActions = {
  getCart: defineAction({
    handler: async (_input, context) => {
      try {
        const { env } = await import("cloudflare:workers");
        const api = bindCommerceApi({ env });
        const customer = await findCustomerSession(env, context.cookies?.get?.(CUSTOMER_SESSION_COOKIE)?.value);
        const cart = await currentCart(api, context, customer?.id);
        return { success: true, cart: cart ?? null };
      } catch (error) {
        throw new ActionError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message || "Failed to retrieve cart"
        });
      }
    }
  }),
  addToCart: defineAction({
    input: z.object({
      productId: z.string().max(128),
      quantity: z.number().int().positive().max(CART_MAX_LINE_QUANTITY).default(1),
      variantId: z.string().max(128).optional()
    }),
    handler: async (input, context) => {
      try {
        const { env } = await import("cloudflare:workers");
        const api = bindCommerceApi({ env });
        await api.carts.validateItems([{ productId: input.productId, variantId: input.variantId, quantity: input.quantity }]);
        const customer = await findCustomerSession(env, context.cookies?.get?.(CUSTOMER_SESSION_COOKIE)?.value);
        if (!await currentCart(api, context, customer?.id) && await basketCreationOverLimit(env, context.request?.headers?.get?.("cf-connecting-ip"))) {
          throw new ActionError({ code: "TOO_MANY_REQUESTS", message: BASKET_LIMIT_MESSAGE });
        }
        const sessionToken = getOrCreateCartSession(context);
        const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
        if (!cart) {
          throw new ActionError({
            code: "NOT_FOUND",
            message: "Failed to locate or create cart"
          });
        }
        const existingItems = Array.isArray(cart.items) ? [...cart.items] : [];
        const index = existingItems.findIndex(
          (i) => i.productId === input.productId && (input.variantId ? i.variantId === input.variantId : !i.variantId)
        );
        if (index >= 0) {
          existingItems[index].quantity += input.quantity;
        } else {
          existingItems.push({
            productId: input.productId,
            variantId: input.variantId,
            quantity: input.quantity
          });
        }
        const updated = await api.carts.updateItems(cart.id, existingItems);
        return { success: true, cart: updated };
      } catch (error) {
        if (error instanceof ActionError) throw error;
        throw new ActionError({
          code: "BAD_REQUEST",
          message: error.message || "Failed to add item to cart"
        });
      }
    }
  }),
  clearCart: defineAction({
    handler: async (_input, context) => {
      try {
        const { env } = await import("cloudflare:workers");
        const api = bindCommerceApi({ env });
        const customer = await findCustomerSession(env, context.cookies?.get?.(CUSTOMER_SESSION_COOKIE)?.value);
        const cart = await currentCart(api, context, customer?.id);
        if (cart) {
          const updated = await api.carts.updateItems(cart.id, []);
          return { success: true, cart: updated };
        }
        return { success: true, cart: null };
      } catch (error) {
        if (error instanceof ActionError) throw error;
        throw new ActionError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message || "Failed to clear cart"
        });
      }
    }
  }),
  checkout: defineAction({
    input: z.object({
      customerEmail: z.string().email(),
      discountCode: z.string().trim().max(32).optional(),
      giftCardCode: z.string().trim().max(37).optional(),
      shippingAddress: z.object({
        name: z.string().optional(),
        line1: z.string().optional(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional()
      }).passthrough().optional(),
      billingAddress: z.object({
        name: z.string().optional(),
        line1: z.string().optional(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional()
      }).passthrough().optional(),
      shippingRateId: z.string().trim().max(40).optional()
    }),
    handler: async (input, context) => {
      const { env } = await import("cloudflare:workers");
      if (readSetting(env, "COMMERCE_CHECKOUT_ENABLED") !== "true") {
        throw new ActionError({ code: "FORBIDDEN", message: "Checkout is disabled" });
      }
      const sessionToken = context.cookies ? readCartSessionToken(context.cookies) : void 0;
      try {
        readStoreSettings(env);
        const api = bindCommerceApi({
          env,
          paymentAdapters: runtimePaymentAdapters(env)
        });
        const customer = await findCustomerSession(env, context.cookies?.get?.(CUSTOMER_SESSION_COOKIE)?.value);
        const cart = await currentCart(api, context, customer?.id);
        if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
          throw new ActionError({
            code: "BAD_REQUEST",
            message: "Cart is empty or not found"
          });
        }
        if (cart.checkoutSessionId) {
          const resumed = await api.orders.resumeFromCart(cart.id, { limitProviderChecks: true });
          if (resumed?.providerCheckLimited) {
            throw new ActionError({ code: "TOO_MANY_REQUESTS", message: PROVIDER_CHECK_RETRY_MESSAGE });
          }
          if (resumed?.paymentUrl) {
            return { success: true, redirectUrl: resumed.paymentUrl, mode: "redirect", orderId: resumed.order.id };
          }
          const current = await api.carts.find(sessionToken, customer?.id);
          if (current?.checkoutSessionId) {
            throw new ActionError({ code: "CONFLICT", message: "Payment is being prepared or confirmed. Please try again shortly." });
          }
        }
        const siteUrl = (context.url ? context.url.origin : "") || "http://localhost:4321";
        const successUrl = `${siteUrl}/checkout/success?order={ORDER_ID}`;
        const cancelUrl = `${siteUrl}/checkout/cancel?order={ORDER_ID}`;
        if (input.discountCode || input.giftCardCode) {
          const now = Math.floor(Date.now() / 1e3);
          const sourceIp = context.request?.headers?.get?.("cf-connecting-ip");
          if (await codeChecksOverNetworkLimit(env, sourceIp, now) || await codeChecksOverBasketLimit(env, cart.id, now)) {
            throw new ActionError({ code: "TOO_MANY_REQUESTS", message: CODE_CHECK_LIMIT_MESSAGE });
          }
        }
        const result = await api.orders.createFromCart(cart.id, {
          customerEmail: input.customerEmail,
          providerId: "stripe",
          discountCode: input.discountCode,
          giftCardCode: input.giftCardCode,
          referralCode: context.cookies?.get?.(REFERRAL_COOKIE)?.value,
          shippingAddress: input.shippingAddress,
          billingAddress: input.billingAddress,
          shippingRateId: input.shippingRateId,
          successUrl,
          cancelUrl
        });
        return {
          success: true,
          redirectUrl: result.paymentUrl,
          mode: "redirect",
          orderId: result.order.id
        };
      } catch (error) {
        if (error instanceof ActionError) throw error;
        if (error instanceof StoreSettingsError) {
          throw new ActionError({ code: "SERVICE_UNAVAILABLE", message: reportStoreSettingsError(error) });
        }
        if (error instanceof TaxCalculationError) {
          throw new ActionError({ code: "SERVICE_UNAVAILABLE", message: error.message });
        }
        const refusal = codeRefusalBody(error);
        if (refusal) throw new ActionError({ code: "CONFLICT", message: refusal.error });
        throw new ActionError({
          code: "BAD_REQUEST",
          message: error.message || "Failed to complete checkout"
        });
      }
    }
  })
};
export {
  ecommerceActions
};
