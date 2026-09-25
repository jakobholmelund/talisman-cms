import {
  runtimePaymentAdapters
} from "./chunk-WXEFSKPU.js";
import "./chunk-FK3KKBW6.js";
import "./chunk-6LYWG22B.js";
import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "./chunk-OM7CZNWS.js";
import {
  bindCommerceApi
} from "./chunk-4B5ROQI2.js";
import "./chunk-MQPA2QMJ.js";
import {
  REFERRAL_COOKIE
} from "./chunk-PRGHPNDB.js";
import {
  ensureCartSession
} from "./chunk-MDTTSWBR.js";
import "./chunk-AGAY2N6E.js";
import "./chunk-U46CR236.js";
import "./chunk-6RT3KMIV.js";

// src/actions.ts
import { defineAction, ActionError } from "astro:actions";
import { z } from "astro/zod";
function getOrCreateCartSession(context) {
  if (!context.cookies) return `anon_${crypto.randomUUID()}`;
  return ensureCartSession(context.cookies, context.url?.protocol === "https:");
}
var ecommerceActions = {
  getCart: defineAction({
    handler: async (_input, context) => {
      const sessionToken = getOrCreateCartSession(context);
      try {
        const { env } = await import("cloudflare:workers");
        const api = bindCommerceApi({ env });
        const customer = await findCustomerSession(env, context.cookies?.get?.(CUSTOMER_SESSION_COOKIE)?.value);
        const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
        return { success: true, cart };
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
      productId: z.string(),
      quantity: z.number().int().positive().default(1),
      variantId: z.string().optional()
    }),
    handler: async (input, context) => {
      const sessionToken = getOrCreateCartSession(context);
      try {
        const { env } = await import("cloudflare:workers");
        const api = bindCommerceApi({ env });
        const customer = await findCustomerSession(env, context.cookies?.get?.(CUSTOMER_SESSION_COOKIE)?.value);
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
      const sessionToken = getOrCreateCartSession(context);
      try {
        const { env } = await import("cloudflare:workers");
        const api = bindCommerceApi({ env });
        const customer = await findCustomerSession(env, context.cookies?.get?.(CUSTOMER_SESSION_COOKIE)?.value);
        const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
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
      }).passthrough().optional()
    }),
    handler: async (input, context) => {
      const sessionToken = getOrCreateCartSession(context);
      try {
        const { env } = await import("cloudflare:workers");
        if (env.GALAXY_COMMERCE_CHECKOUT_ENABLED !== "true") {
          throw new ActionError({ code: "FORBIDDEN", message: "Checkout is disabled" });
        }
        const api = bindCommerceApi({
          env,
          paymentAdapters: runtimePaymentAdapters(env)
        });
        const customer = await findCustomerSession(env, context.cookies?.get?.(CUSTOMER_SESSION_COOKIE)?.value);
        const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
        if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
          throw new ActionError({
            code: "BAD_REQUEST",
            message: "Cart is empty or not found"
          });
        }
        if (cart.checkoutSessionId) {
          const resumed = await api.orders.resumeFromCart(cart.id);
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
        const result = await api.orders.createFromCart(cart.id, {
          customerEmail: input.customerEmail,
          providerId: "stripe",
          discountCode: input.discountCode,
          giftCardCode: input.giftCardCode,
          referralCode: context.cookies?.get?.(REFERRAL_COOKIE)?.value,
          shippingAddress: input.shippingAddress,
          billingAddress: input.billingAddress,
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
