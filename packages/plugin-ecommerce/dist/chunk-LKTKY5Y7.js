import {
  evaluateDiscountCode
} from "./chunk-K2FMPEG6.js";
import {
  findReferralCode,
  getReferralPolicy
} from "./chunk-5JBBAHBQ.js";
import {
  fulfillCommerceOrder
} from "./chunk-AGAY2N6E.js";
import {
  confirmGiftCardPurchase,
  evaluateGiftCard,
  expireGiftCardPurchase,
  reconcileGiftCardPurchase,
  recordGiftCardPurchaseRefund
} from "./chunk-4DBNSZO2.js";
import {
  carts,
  componentReservations,
  components,
  customerAccounts,
  inventoryReservations,
  orders,
  productVariantValues,
  productVariants,
  products,
  stocks,
  variantComponents,
  variants
} from "./chunk-6RT3KMIV.js";

// src/api.ts
import { createDbClient } from "talisman-cms/client";
import { and, eq, isNull, sql } from "drizzle-orm";
function aggregateComponentDemand(items) {
  const demand = /* @__PURE__ */ new Map();
  for (const item of items) {
    for (const component of item.components) {
      const current = demand.get(component.id);
      demand.set(component.id, {
        name: component.name,
        quantity: (current?.quantity ?? 0) + item.quantity * component.quantity,
        available: component.available
      });
    }
  }
  return demand;
}
function bindCommerceApi(options) {
  const { env, paymentAdapters = [] } = options;
  const db = createDbClient(env);
  async function resolveSelectedVariant(product, variantId) {
    const variantValue = await db.select().from(productVariantValues).where(eq(productVariantValues.id, variantId)).get();
    if (variantValue) {
      const productVariant = await db.select().from(productVariants).where(eq(productVariants.id, variantValue.productVariantId)).get();
      if (!productVariant || productVariant.productId !== product.id) {
        throw new Error(`Variant value not found or mismatch: ${variantId}`);
      }
      const stock = await db.select().from(stocks).where(eq(stocks.productVariantValueId, variantValue.id)).get();
      const variantDefinition = productVariant.variantId ? await db.select().from(variants).where(eq(variants.id, productVariant.variantId)).get() : null;
      const requirements = await db.select().from(variantComponents).where(eq(variantComponents.productVariantValueId, variantValue.id));
      const components2 = [];
      for (const requirement of requirements) {
        const component = await db.select().from(components).where(eq(components.id, requirement.componentId)).get();
        if (!component) throw new Error(`Component not found: ${requirement.componentId}`);
        components2.push({
          id: component.id,
          name: component.name,
          quantity: requirement.quantity,
          available: component.quantity
        });
      }
      return {
        price: variantValue.priceOverride ?? productVariant.priceOverride ?? product.basePrice,
        name: `${product.name} - ${variantDefinition?.name ?? productVariant.name}: ${variantValue.value}`,
        availableQuantity: components2.length ? Math.min(...components2.map((component) => Math.floor(component.available / component.quantity))) : stock?.quantity ?? productVariant.inventoryQuantity,
        stockRecordId: stock?.id,
        inventoryTarget: components2.length ? null : stock ? { type: "stock", id: stock.id } : { type: "variant", id: productVariant.id },
        components: components2
      };
    }
    const legacyVariant = await db.select().from(productVariants).where(eq(productVariants.id, variantId)).get();
    if (!legacyVariant || legacyVariant.productId !== product.id) {
      throw new Error(`Variant not found or mismatch: ${variantId}`);
    }
    return {
      price: legacyVariant.priceOverride ?? product.basePrice,
      name: `${product.name} - ${legacyVariant.name}`,
      availableQuantity: legacyVariant.inventoryQuantity,
      stockRecordId: null,
      inventoryTarget: { type: "variant", id: legacyVariant.id },
      components: []
    };
  }
  async function finalizeOrderPayment(params) {
    const order = await db.select().from(orders).where(eq(orders.id, params.orderId)).get();
    if (!order) {
      throw new Error(`Order not found: ${params.orderId}`);
    }
    if (params.paymentStatus !== "success") {
      throw new Error("Payment has not succeeded");
    }
    if (order.checkoutSessionId !== params.providerId || (order.paymentProvider ?? "stripe") !== params.provider) {
      throw new Error("Payment provider or session does not match order");
    }
    if (params.amount !== void 0 && params.amount !== order.totalAmount) {
      throw new Error("Payment amount does not match order total");
    }
    if (params.currency && params.currency.toLowerCase() !== order.currency.toLowerCase()) {
      throw new Error("Payment currency does not match order");
    }
    if (["paid", "fulfilled", "partially_refunded", "refunded"].includes(order.status)) {
      return { success: true, orderId: params.orderId, status: order.status, duplicate: true };
    }
    if (order.status === "cancelled") {
      throw new Error("Cancelled order cannot be paid");
    }
    const timestamp = Math.floor(Date.now() / 1e3);
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const providerEmail = params.customerEmail?.trim() ?? "";
    const email = emailPattern.test(providerEmail) ? providerEmail : (order.customerEmail || "").trim();
    const normalizedEmail = email.toLowerCase();
    const newAccountId = !order.userId && params.provider !== "admin_test" && emailPattern.test(normalizedEmail) ? `acct_${order.id}` : null;
    const accountName = typeof order.shippingAddress?.name === "string" ? order.shippingAddress.name.trim().slice(0, 160) : null;
    const statements = [
      env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'paid', updated_at = ?, customer_email = ?, payment_intent_id = ?
        WHERE id = ? AND status = 'pending' AND checkout_session_id = ? AND total_amount = ?`).bind(timestamp, email, params.paymentIntentId ?? null, params.orderId, params.providerId, order.totalAmount)
    ];
    if (newAccountId) {
      statements.push(env.DB.prepare(`INSERT INTO _ecommerce_customer_accounts
        (id, email, email_normalized, name, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ? FROM _ecommerce_orders
        WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
        ON CONFLICT(email_normalized) DO NOTHING`).bind(newAccountId, email, normalizedEmail, accountName, timestamp, timestamp, params.orderId, params.providerId));
      statements.push(env.DB.prepare(`UPDATE _ecommerce_orders
        SET user_id = (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized = ?)
        WHERE id = ? AND status = 'paid' AND user_id IS NULL`).bind(normalizedEmail, params.orderId));
      if (order.referralCode && order.referralRewardCents > 0 && params.provider !== "admin_test") {
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_referrals
          (id, code, referrer_account_id, referred_account_id, order_id, reward_cents, currency, status, created_at, updated_at)
          SELECT ?, rc.code, rc.account_id, o.user_id, o.id, ?, o.currency, 'approved', ?, ?
          FROM _ecommerce_orders o
          JOIN _ecommerce_referral_codes rc ON rc.code = o.referral_code
          JOIN _ecommerce_customer_accounts referrer ON referrer.id = rc.account_id
          WHERE o.id = ? AND o.status = 'paid' AND o.user_id = ?
            AND referrer.email_normalized <> ? AND rc.account_id <> o.user_id
          ON CONFLICT DO NOTHING`).bind(
          `ref_${order.id}`,
          order.referralRewardCents,
          timestamp,
          timestamp,
          params.orderId,
          newAccountId,
          normalizedEmail
        ));
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
          (id, account_id, order_id, kind, amount_cents, created_at)
          SELECT ?, referrer_account_id, order_id, 'referral_award', reward_cents, ?
          FROM _ecommerce_referrals WHERE order_id = ? AND status = 'approved'
          ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_ref_${order.id}`, timestamp, params.orderId));
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
          (id, account_id, order_id, kind, amount_cents, created_at)
          SELECT ?, referred_account_id, order_id, 'welcome_award', reward_cents, ?
          FROM _ecommerce_referrals WHERE order_id = ? AND status = 'approved'
          ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_welcome_${order.id}`, timestamp, params.orderId));
      }
    }
    statements.push(
      env.DB.prepare(`UPDATE _ecommerce_discount_redemptions SET status = 'confirmed', updated_at = ?
        WHERE order_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid')`).bind(timestamp, params.orderId, params.orderId),
      env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions SET status = 'confirmed', updated_at = ?
        WHERE order_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid')`).bind(timestamp, params.orderId, params.orderId),
      env.DB.prepare(`UPDATE _ecommerce_carts SET closed = 1, closed_at = ?, updated_at = ?,
        user_id = COALESCE(user_id, (SELECT user_id FROM _ecommerce_orders WHERE id = ?))
        WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_orders
          WHERE id = ? AND status = 'paid' AND checkout_session_id = ?)`).bind(timestamp, timestamp, params.orderId, order.cartId, params.orderId, params.providerId),
      env.DB.prepare(`INSERT INTO _ecommerce_payments
        (id, order_id, provider, provider_id, status, amount, created_at)
        SELECT ?, id, ?, ?, 'success', total_amount, ? FROM _ecommerce_orders
        WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
        ON CONFLICT(provider, provider_id) DO NOTHING`).bind(`pay_${crypto.randomUUID()}`, params.provider, params.providerId, timestamp, params.orderId, params.providerId)
    );
    await env.DB.batch(statements);
    const current = await db.select().from(orders).where(eq(orders.id, params.orderId)).get();
    if (current?.status !== "paid") throw new Error("Order is no longer pending");
    return { success: true, orderId: params.orderId, status: "paid" };
  }
  async function recordProviderRefund(params) {
    const order = await db.select().from(orders).where(eq(orders.paymentIntentId, params.paymentIntentId)).get();
    if (!order) throw new Error("Refund payment is not linked to a confirmed order");
    if (order.paymentProvider !== "stripe" || order.totalAmount !== params.amount || order.currency.toLowerCase() !== params.currency.toLowerCase() || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > order.totalAmount) {
      throw new Error("Refund does not match order payment");
    }
    if (params.amountRefunded <= order.providerRefundedCents) {
      return { success: true, orderId: order.id, duplicate: true };
    }
    const now = Math.floor(Date.now() / 1e3);
    const full = params.amountRefunded === order.totalAmount;
    const statements = [
      env.DB.prepare(`UPDATE _ecommerce_orders
        SET provider_refunded_cents = ?, status = ?, updated_at = ?
        WHERE id = ? AND payment_intent_id = ? AND provider_refunded_cents < ?
          AND status IN ('paid', 'fulfilled', 'partially_refunded')`).bind(
        params.amountRefunded,
        full ? "refunded" : "partially_refunded",
        now,
        order.id,
        params.paymentIntentId,
        params.amountRefunded
      ),
      env.DB.prepare(`UPDATE _ecommerce_payments
        SET status = (SELECT status FROM _ecommerce_orders WHERE id = ?)
        WHERE order_id = ? AND provider = 'stripe'`).bind(order.id, order.id)
    ];
    if (full) {
      statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions
        SET status = 'refunded', updated_at = ?
        WHERE order_id = ? AND status = 'confirmed'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`).bind(now, order.id, order.id));
      statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions
        SET status = 'refunded', updated_at = ?
        WHERE order_id = ? AND status = 'confirmed'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`).bind(now, order.id, order.id));
      statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
        (id, account_id, order_id, kind, amount_cents, created_at)
        SELECT ?, user_id, id, 'purchase_credit_refund', credit_applied, ?
        FROM _ecommerce_orders WHERE id = ? AND status = 'refunded'
          AND credit_applied > 0 AND user_id IS NOT NULL
        ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_refund_${order.id}`, now, order.id));
      for (const [awardKind, reversalKind] of [
        ["referral_award", "referral_reversal"],
        ["welcome_award", "welcome_reversal"]
      ]) {
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
          (id, account_id, order_id, kind, amount_cents, created_at)
          SELECT ?, l.account_id, l.order_id, ?, -l.amount_cents, ?
          FROM _ecommerce_credit_ledger l
          JOIN _ecommerce_orders o ON o.id = l.order_id AND o.status = 'refunded'
          WHERE l.order_id = ? AND l.kind = ?
          ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_${reversalKind}_${order.id}`, reversalKind, now, order.id, awardKind));
      }
      statements.push(env.DB.prepare(`UPDATE _ecommerce_referrals SET status = 'void', updated_at = ?
        WHERE order_id = ? AND EXISTS
          (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`).bind(now, order.id, order.id));
    }
    await env.DB.batch(statements);
    return { success: true, orderId: order.id, status: full ? "refunded" : "partially_refunded" };
  }
  return {
    carts: {
      async quote(cartId) {
        const cart = await db.select().from(carts).where(eq(carts.id, cartId)).get();
        if (!cart) throw new Error("Cart not found");
        const lines = [];
        let totalAmount = 0;
        let requiresShipping = false;
        const componentItems = [];
        for (const item of cart.items) {
          const product = await db.select().from(products).where(eq(products.id, item.productId)).get();
          if (!product || product.status !== "active") throw new Error(`Product is not available: ${item.productId}`);
          const variant = item.variantId ? await resolveSelectedVariant(product, item.variantId) : null;
          const unitAmount = variant?.price ?? product.basePrice;
          const name = variant?.name ?? product.name;
          if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
            throw new Error(`A positive price is required for ${name}`);
          }
          if (product.type === "standard" && (variant?.availableQuantity ?? product.inventoryQuantity) < item.quantity) {
            throw new Error(`Insufficient stock for ${name}`);
          }
          if (product.type === "standard" && variant?.components.length) {
            componentItems.push({ quantity: item.quantity, components: variant.components });
          }
          const lineTotal = unitAmount * item.quantity;
          totalAmount += lineTotal;
          requiresShipping ||= product.isPhysical;
          lines.push({ productId: item.productId, variantId: item.variantId, name, quantity: item.quantity, unitAmount, lineTotal });
        }
        for (const demand of aggregateComponentDemand(componentItems).values()) {
          if (demand.available < demand.quantity) throw new Error(`Insufficient stock for component ${demand.name}`);
        }
        if (!Number.isSafeInteger(totalAmount)) throw new Error("Order total is too large");
        return { lines, totalAmount, currency: "usd", requiresShipping, locked: Boolean(cart.checkoutSessionId) };
      },
      async find(sessionToken, userId) {
        if (!sessionToken && !userId) return null;
        const conditions = [eq(carts.closed, false)];
        if (userId) {
          conditions.push(eq(carts.userId, userId));
        } else if (sessionToken) {
          conditions.push(eq(carts.sessionToken, sessionToken));
          conditions.push(isNull(carts.userId));
        }
        return await db.select().from(carts).where(and(...conditions)).get();
      },
      /** Attach the current browser basket to an authenticated shopper account. */
      async claim(sessionToken, userId, choice) {
        const account = await db.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.id, userId)).get();
        if (!account) throw new Error("Customer account not found");
        const guest = await db.select().from(carts).where(and(eq(carts.sessionToken, sessionToken), eq(carts.closed, false))).get();
        const owned = await db.select().from(carts).where(and(eq(carts.userId, userId), eq(carts.closed, false))).get();
        if (guest?.userId === userId) return guest;
        if (guest?.userId) throw new Error("Basket belongs to another account");
        if (guest?.checkoutSessionId) throw new Error("Checkout already started for this cart");
        if (guest && owned && guest.id !== owned.id) {
          if (guest.items.length && owned.items.length) {
            if (!choice) throw new Error("Both baskets have items; choose which basket to keep before linking this session");
          }
          if (owned.checkoutSessionId) throw new Error("Checkout already started for this cart");
          if (guest.items.length && choice !== "account") {
            const released = await db.update(carts).set({ userId: null, updatedAt: /* @__PURE__ */ new Date() }).where(and(
              eq(carts.id, owned.id),
              eq(carts.userId, userId),
              eq(carts.version, owned.version),
              eq(carts.closed, false)
            )).returning({ id: carts.id });
            if (!released.length) throw new Error("Basket changed during account upgrade; reload and try again");
          } else {
            const released = await db.update(carts).set({ sessionToken: null, updatedAt: /* @__PURE__ */ new Date() }).where(and(
              eq(carts.id, guest.id),
              eq(carts.sessionToken, sessionToken),
              eq(carts.version, guest.version),
              eq(carts.closed, false)
            )).returning({ id: carts.id });
            if (!released.length) throw new Error("Basket changed during account upgrade; reload and try again");
          }
        }
        const target = choice === "account" && owned ? owned : guest?.items.length ? guest : owned ?? guest;
        if (target) {
          if (!guest) {
            await env.DB.prepare(`UPDATE _ecommerce_carts SET session_token = NULL
              WHERE session_token = ? AND closed = 1`).bind(sessionToken).run();
          }
          const updated = await db.update(carts).set({ userId, sessionToken, updatedAt: /* @__PURE__ */ new Date(), version: sql`${carts.version} + 1` }).where(and(
            eq(carts.id, target.id),
            eq(carts.closed, false),
            isNull(carts.checkoutSessionId),
            eq(carts.version, target.version)
          )).returning({ id: carts.id });
          if (!updated.length) throw new Error("Basket changed during account upgrade; reload and try again");
          return await db.select().from(carts).where(eq(carts.id, target.id)).get();
        }
        return null;
      },
      async getOrCreate(sessionToken, userId) {
        if (userId) {
          const claimed = await this.claim(sessionToken, userId);
          if (claimed) return claimed;
        }
        let cart = await this.find(sessionToken, userId);
        if (!cart) {
          if (!userId) {
            await env.DB.prepare(`UPDATE _ecommerce_carts SET session_token = NULL
               WHERE session_token = ? AND closed = 0 AND user_id IS NOT NULL`).bind(sessionToken).run();
          }
          await env.DB.prepare(`UPDATE _ecommerce_carts SET session_token = NULL
             WHERE session_token = ? AND closed = 1`).bind(sessionToken).run();
          const cartId = `cart_${crypto.randomUUID()}`;
          const now = /* @__PURE__ */ new Date();
          await db.insert(carts).values({
            id: cartId,
            sessionToken,
            userId,
            checkoutSessionId: null,
            items: [],
            closed: false,
            closedAt: null,
            createdAt: now,
            updatedAt: now
          });
          cart = await this.find(sessionToken, userId);
        }
        return cart;
      },
      async updateItems(cartId, items) {
        if (!Array.isArray(items) || items.length > 100 || items.some(
          (item) => !item || typeof item.productId !== "string" || !item.productId.trim() || item.productId.length > 128 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 99 || item.variantId !== void 0 && (typeof item.variantId !== "string" || item.variantId.length > 128)
        )) {
          throw new Error("Cart items must have a product and a positive integer quantity");
        }
        const itemKeys = items.map((item) => `${item.productId}\0${item.variantId || ""}`);
        if (new Set(itemKeys).size !== itemKeys.length) {
          throw new Error("Duplicate cart items are not allowed");
        }
        const cart = await db.select().from(carts).where(eq(carts.id, cartId)).get();
        if (!cart) {
          throw new Error("Cart not found");
        }
        if (cart.closed) {
          throw new Error("Cart is closed");
        }
        if (cart.checkoutSessionId) {
          throw new Error("Checkout already started for this cart");
        }
        const updated = await db.update(carts).set({ items, updatedAt: /* @__PURE__ */ new Date(), version: sql`${carts.version} + 1` }).where(and(
          eq(carts.id, cartId),
          eq(carts.closed, false),
          isNull(carts.checkoutSessionId),
          eq(carts.version, cart.version)
        )).returning({ id: carts.id });
        if (!updated.length) throw new Error("Basket changed or checkout already started; reload and try again");
        return await db.select().from(carts).where(eq(carts.id, cartId)).get();
      }
    },
    orders: {
      async resumeFromCart(cartId) {
        const cart = await db.select().from(carts).where(eq(carts.id, cartId)).get();
        if (!cart?.checkoutSessionId) return null;
        if (cart.checkoutSessionId.startsWith("preparing:")) {
          const cutoff = Math.floor(Date.now() / 1e3) - 35 * 60;
          await env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = NULL,
            updated_at = ?, version = version + 1 WHERE id = ? AND checkout_session_id = ?
            AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders
              WHERE cart_id = _ecommerce_carts.id AND status = 'pending')`).bind(Math.floor(Date.now() / 1e3), cartId, cart.checkoutSessionId, cutoff).run();
          return null;
        }
        const order = await db.select().from(orders).where(eq(orders.checkoutSessionId, cart.checkoutSessionId)).get();
        if (!order || order.status !== "pending") return null;
        if (order.paymentProvider === "gift_card" && order.totalAmount === 0) {
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "gift_card",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: 0,
            customerEmail: order.customerEmail ?? void 0
          });
          return { order: await this.find(order.id), paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
        }
        const reconciled = await this.reconcilePending(order.id);
        if (reconciled?.status === "paid") {
          return { order: await this.find(order.id), paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
        }
        if (reconciled?.status === "cancelled") return null;
        return { order, paymentUrl: reconciled?.paymentUrl ?? null };
      },
      async reconcilePending(id) {
        const order = await this.find(id);
        if (!order || order.status !== "pending" || !order.checkoutSessionId) return null;
        if (order.paymentProvider === "gift_card") {
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "gift_card",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: 0,
            customerEmail: order.customerEmail ?? void 0
          });
          return { status: "paid", paymentUrl: null };
        }
        if (order.paymentProvider === "admin_test") {
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "admin_test",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: order.totalAmount,
            currency: order.currency
          });
          return { status: "paid", paymentUrl: null };
        }
        const adapter = paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe"));
        if (!adapter?.getCheckoutSession) throw new Error("Payment provider cannot reconcile checkout");
        const session = await adapter.getCheckoutSession(order.checkoutSessionId);
        if (session.status === "expired") {
          await this.cancel(id, { sessionExpired: true });
          return { status: "cancelled", paymentUrl: null };
        }
        if (session.status === "complete" && session.paymentStatus === "paid") {
          if (session.amountTotal !== order.totalAmount || session.currency?.toLowerCase() !== order.currency.toLowerCase() || (order.paymentProvider ?? "stripe") === "stripe" && !session.paymentIntentId) {
            throw new Error("Completed payment does not match pending order");
          }
          await finalizeOrderPayment({
            orderId: id,
            provider: order.paymentProvider ?? "stripe",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: session.amountTotal,
            currency: session.currency,
            paymentIntentId: session.paymentIntentId ?? void 0,
            customerEmail: session.customerEmail ?? void 0
          });
          return { status: "paid", paymentUrl: null };
        }
        return { status: "pending", paymentUrl: session.status === "open" ? session.url : null };
      },
      async createFromCart(cartId, options2) {
        const cart = await db.select().from(carts).where(eq(carts.id, cartId)).get();
        if (!cart || cart.items.length === 0) {
          throw new Error("Cart is empty or not found");
        }
        if (cart.closed) {
          throw new Error("Cart is closed");
        }
        if (cart.checkoutSessionId) {
          throw new Error("Checkout already started for this cart");
        }
        const defaultAdapter = options2.providerId ? paymentAdapters.find((adapter) => adapter.providerId === options2.providerId) : paymentAdapters.length === 1 ? paymentAdapters[0] : void 0;
        if (!defaultAdapter) throw new Error("A payment provider must be selected and configured before checkout");
        let requiresShipping = false;
        let totalAmount = 0;
        const orderItems = [];
        const componentItems = [];
        const inventoryDemand = /* @__PURE__ */ new Map();
        for (const item of cart.items) {
          const product = await db.select().from(products).where(eq(products.id, item.productId)).get();
          if (!product) {
            throw new Error(`Product not found: ${item.productId}`);
          }
          if (product.status !== "active") {
            throw new Error(`Product is not available: ${item.productId}`);
          }
          let price = product.basePrice;
          let finalName = product.name;
          let availableQuantity = product.inventoryQuantity;
          let requiredComponents = [];
          let inventoryTarget = { type: "product", id: product.id };
          if (item.variantId) {
            const selectedVariant = await resolveSelectedVariant(product, item.variantId);
            price = selectedVariant.price;
            finalName = selectedVariant.name;
            availableQuantity = selectedVariant.availableQuantity;
            requiredComponents = selectedVariant.components;
            inventoryTarget = selectedVariant.inventoryTarget;
          }
          if (product.isPhysical) {
            requiresShipping = true;
          }
          const tracksInventory = product.type === "standard";
          if (tracksInventory && availableQuantity < item.quantity) {
            throw new Error(`Insufficient stock for ${finalName}`);
          }
          if (tracksInventory && requiredComponents.length) {
            componentItems.push({ quantity: item.quantity, components: requiredComponents });
          } else if (tracksInventory && inventoryTarget) {
            const key = `${inventoryTarget.type}:${inventoryTarget.id}`;
            const existing = inventoryDemand.get(key);
            inventoryDemand.set(key, { ...inventoryTarget, quantity: (existing?.quantity ?? 0) + item.quantity });
          }
          if (!Number.isSafeInteger(price) || price <= 0) {
            throw new Error(`A positive price is required for ${finalName}`);
          }
          totalAmount += price * item.quantity;
          if (!Number.isSafeInteger(totalAmount)) throw new Error("Order total is too large");
          orderItems.push({
            ...item,
            priceAtPurchase: price,
            name: finalName,
            usesComponents: tracksInventory && requiredComponents.length > 0
          });
        }
        const componentDemand = aggregateComponentDemand(componentItems);
        for (const component of componentDemand.values()) {
          if (component.available < component.quantity) {
            throw new Error(`Insufficient stock for component ${component.name}`);
          }
        }
        if (requiresShipping && (!options2.shippingAddress || !["name", "line1", "city", "postalCode", "country"].every((key) => typeof options2.shippingAddress[key] === "string" && options2.shippingAddress[key].trim()))) {
          throw new Error("Shipping address is required for physical products");
        }
        const orderId = `ord_${crypto.randomUUID()}`;
        const referralsPolicy = await getReferralPolicy(env);
        const subtotalAmount = totalAmount;
        const discount = options2.discountCode && defaultAdapter.providerId === "stripe" ? await evaluateDiscountCode(env, {
          code: options2.discountCode,
          customerEmail: options2.customerEmail,
          accountId: cart.userId,
          lines: orderItems,
          subtotal: subtotalAmount
        }) : null;
        const discountAmount = discount?.amount ?? 0;
        let creditApplied = 0;
        if (cart.userId && defaultAdapter.providerId === "stripe") {
          const owner = await db.select({ creditBalance: customerAccounts.creditBalance }).from(customerAccounts).where(eq(customerAccounts.id, cart.userId)).get();
          creditApplied = Math.min(
            Math.max(0, owner?.creditBalance ?? 0),
            Math.max(0, subtotalAmount - discountAmount - 50)
          );
        }
        totalAmount = subtotalAmount - discountAmount - creditApplied;
        const giftCard = options2.giftCardCode && defaultAdapter.providerId === "stripe" ? await evaluateGiftCard(env, options2.giftCardCode, totalAmount) : null;
        const giftCardApplied = giftCard?.amount ?? 0;
        totalAmount -= giftCardApplied;
        const internallyPaid = Boolean(giftCard && totalAmount === 0);
        let referralCode = null;
        if (referralsPolicy.enabled && !cart.userId && options2.referralCode && defaultAdapter.providerId === "stripe" && !internallyPaid) {
          const referral = await findReferralCode(env, options2.referralCode);
          if (referral && subtotalAmount >= referralsPolicy.minOrderCents && referral.emailNormalized !== options2.customerEmail.trim().toLowerCase()) {
            referralCode = referral.code;
          }
        }
        if (!defaultAdapter.expireCheckoutSession) {
          throw new Error("Payment provider must support checkout session expiry");
        }
        const successUrl = options2.successUrl.replaceAll("{ORDER_ID}", orderId);
        const cancelUrl = options2.cancelUrl.replaceAll("{ORDER_ID}", orderId);
        const now = /* @__PURE__ */ new Date();
        const timestamp = Math.floor(now.getTime() / 1e3);
        const preparationLock = `preparing:${orderId}`;
        const snapshot = JSON.stringify(cart.items);
        const lock = await env.DB.prepare(`UPDATE _ecommerce_carts
           SET checkout_session_id = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND closed = 0 AND checkout_session_id IS NULL AND items = ? AND version = ? RETURNING id`).bind(preparationLock, timestamp, cartId, snapshot, cart.version).all();
        if (!lock.results?.length) throw new Error("Checkout already started for this cart");
        let session;
        let committed = false;
        try {
          session = internallyPaid ? { providerSessionId: `internal:${orderId}`, url: successUrl } : await defaultAdapter.createCheckoutSession({
            orderId,
            items: orderItems.map((i) => ({
              name: i.name,
              priceCents: i.priceAtPurchase,
              quantity: i.quantity
            })),
            customerEmail: options2.customerEmail,
            creditApplied,
            discountApplied: discountAmount,
            giftCardApplied,
            metadata: {
              giftCardApplied: String(giftCardApplied),
              storeCreditApplied: String(creditApplied),
              promotionDiscount: String(discountAmount)
            },
            successUrl,
            cancelUrl
          });
          if (!session.providerSessionId || !session.url) throw new Error("Payment provider did not return a checkout session");
          const checkoutSessionId = session.providerSessionId;
          const statements = [
            env.DB.prepare(`INSERT INTO _ecommerce_orders
             (id, cart_id, user_id, checkout_session_id, payment_provider, status, items, total_amount, subtotal_amount, credit_applied, discount_code, discount_amount, gift_card_id, gift_card_applied, referral_code, referral_reward_cents, currency,
              customer_email, shipping_address, billing_address, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?) `).bind(
              orderId,
              cartId,
              cart.userId,
              checkoutSessionId,
              internallyPaid ? "gift_card" : defaultAdapter.providerId,
              JSON.stringify(orderItems.map(({ name, ...rest }) => rest)),
              totalAmount,
              subtotalAmount,
              creditApplied,
              discount?.code ?? null,
              discountAmount,
              giftCard?.id ?? null,
              giftCardApplied,
              referralCode,
              referralCode ? referralsPolicy.rewardCents : 0,
              options2.customerEmail,
              options2.shippingAddress ? JSON.stringify(options2.shippingAddress) : null,
              options2.billingAddress ? JSON.stringify(options2.billingAddress) : null,
              timestamp,
              timestamp
            )
          ];
          if (discount) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_discount_redemptions
             (id, code, order_id, account_id, email_normalized, amount_cents, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).bind(
              `dred_${orderId}`,
              discount.code,
              orderId,
              cart.userId,
              discount.emailNormalized,
              discount.amount,
              timestamp,
              timestamp
            ));
          }
          if (giftCard) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_redemptions
             (id,card_id,order_id,amount_cents,status,created_at,updated_at)
             VALUES (?,?,?,?,'reserved',?,?)`).bind(`gcr_${orderId}`, giftCard.id, orderId, giftCardApplied, timestamp, timestamp));
          }
          if (creditApplied && cart.userId) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
             (id, account_id, order_id, kind, amount_cents, created_at)
             VALUES (?, ?, ?, 'checkout_reserve', ?, ?)`).bind(`credit_hold_${orderId}`, cart.userId, orderId, -creditApplied, timestamp));
          }
          for (const [componentId, demand] of defaultAdapter.reservesInventory === false ? [] : componentDemand) {
            statements.push(env.DB.prepare(`UPDATE _ecommerce_components
             SET quantity = quantity - ?, updated_at = ? WHERE id = ?`).bind(demand.quantity, timestamp, componentId));
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_component_reservations
             (id, order_id, component_id, quantity) VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), orderId, componentId, demand.quantity));
          }
          for (const demand of defaultAdapter.reservesInventory === false ? [] : inventoryDemand.values()) {
            const table = demand.type === "product" ? "_ecommerce_products" : demand.type === "variant" ? "_ecommerce_product_variants" : "_ecommerce_stocks";
            const column = demand.type === "stock" ? "quantity" : "inventory_quantity";
            statements.push(env.DB.prepare(`UPDATE ${table} SET ${column} = ${column} - ?, updated_at = ? WHERE id = ?`).bind(demand.quantity, timestamp, demand.id));
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_inventory_reservations
             (id, order_id, target_type, target_id, quantity) VALUES (?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), orderId, demand.type, demand.id, demand.quantity));
          }
          statements.push(env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = ?, updated_at = ?
           WHERE id = ? AND checkout_session_id = ?`).bind(checkoutSessionId, timestamp, cartId, preparationLock));
          try {
            await env.DB.batch(statements);
            committed = true;
          } catch (cause) {
            if (cause instanceof Error && cause.message.includes("Discount code is no longer available")) {
              throw new Error("Discount code is no longer available", { cause });
            }
            if (cause instanceof Error && cause.message.includes("Insufficient store credit")) {
              throw new Error("Store credit changed during checkout; please try again", { cause });
            }
            if (cause instanceof Error && cause.message.includes("Gift card is no longer available")) {
              throw new Error("Gift card is no longer available", { cause });
            }
            throw new Error("Insufficient stock or checkout already started", { cause });
          }
          const order = await this.find(orderId);
          if (!order) throw new Error("Checkout was created but the order could not be loaded");
          if (internallyPaid) {
            await finalizeOrderPayment({
              orderId,
              provider: "gift_card",
              providerId: checkoutSessionId,
              paymentStatus: "success",
              amount: 0,
              customerEmail: options2.customerEmail
            });
            return { order: await this.find(orderId), paymentUrl: session.url };
          }
          return { order, paymentUrl: session.url };
        } catch (error) {
          if (committed) throw error;
          if (session?.providerSessionId && !internallyPaid) {
            await defaultAdapter.expireCheckoutSession(session.providerSessionId);
          }
          await env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = NULL
             WHERE id = ? AND checkout_session_id = ?`).bind(cartId, preparationLock).run();
          throw error;
        }
      },
      async create(data) {
        const orderId = data.id || `ord_${Date.now()}`;
        const now = /* @__PURE__ */ new Date();
        await db.insert(orders).values({
          id: orderId,
          cartId: data.cartId,
          userId: data.userId,
          checkoutSessionId: data.checkoutSessionId,
          paymentProvider: null,
          status: data.status || "draft",
          totalAmount: data.totalAmount,
          currency: data.currency || "usd",
          customerEmail: data.customerEmail,
          items: data.items,
          shippingAddress: data.shippingAddress,
          billingAddress: data.billingAddress,
          createdAt: now,
          updatedAt: now
        });
        return await this.find(orderId);
      },
      async find(id) {
        const order = await db.select().from(orders).where(eq(orders.id, id)).get();
        if (!order) return null;
        return order;
      },
      async findForSession(id, sessionToken, customerId) {
        const order = await this.find(id);
        if (!order?.cartId) return null;
        if (customerId && order.userId === customerId) return order;
        if (!sessionToken) return null;
        const cart = await db.select().from(carts).where(eq(carts.id, order.cartId)).get();
        return cart?.sessionToken === sessionToken ? order : null;
      },
      async updateStatus(id, status, fulfillment) {
        if (status !== "fulfilled") throw new Error("Use the payment or cancellation workflow to change order status");
        const order = await this.find(id);
        if (order?.paymentProvider === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
        if (!fulfillment) throw new Error("Audited fulfillment details are required");
        await fulfillCommerceOrder(env, fulfillment.actor, {
          orderId: id,
          carrier: fulfillment.carrier,
          trackingNumber: fulfillment.trackingNumber,
          note: fulfillment.note
        });
        return await this.find(id);
      },
      async finalizePayment(id, options2) {
        return finalizeOrderPayment({
          orderId: id,
          provider: options2.provider,
          providerId: options2.providerId,
          paymentIntentId: options2.paymentIntentId,
          paymentStatus: options2.paymentStatus,
          amount: options2.amount,
          currency: options2.currency,
          customerEmail: options2.customerEmail
        });
      },
      async cancel(id, options2 = {}) {
        const order = await db.select().from(orders).where(eq(orders.id, id)).get();
        if (!order) return null;
        if (["paid", "fulfilled", "partially_refunded", "refunded"].includes(order.status)) return order;
        const timestamp = Math.floor(Date.now() / 1e3);
        if (order.status === "cancelled") return order;
        const reservations = await db.select().from(componentReservations).where(eq(componentReservations.orderId, id));
        const inventoryReservations2 = await db.select().from(inventoryReservations).where(eq(inventoryReservations.orderId, id));
        if (order.checkoutSessionId && !options2.sessionExpired) {
          const adapter = paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe"));
          if (!adapter?.expireCheckoutSession) {
            throw new Error("Payment provider must expire the checkout session before stock can be released");
          }
          const session = await adapter.getCheckoutSession?.(order.checkoutSessionId);
          if (session?.status === "complete") {
            throw new Error("Payment has completed; wait for confirmation before changing the basket");
          }
          if (session?.status !== "expired") {
            await adapter.expireCheckoutSession(order.checkoutSessionId);
          }
        }
        const statements = [
          env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'cancelled', updated_at = ?
            WHERE id = ? AND status NOT IN ('paid', 'fulfilled')`).bind(timestamp, id)
        ];
        statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions
          SET status = 'cancelled', updated_at = ?
          WHERE order_id = ? AND status = 'reserved'
            AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, id, id));
        statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions
          SET status = 'cancelled', updated_at = ?
          WHERE order_id = ? AND status = 'reserved'
            AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, id, id));
        if (order.creditApplied > 0) {
          statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
            (id, account_id, order_id, kind, amount_cents, created_at)
            SELECT ?, user_id, id, 'checkout_release', credit_applied, ?
            FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled' AND user_id IS NOT NULL
            ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_release_${id}`, timestamp, id));
        }
        for (const reservation of reservations) {
          statements.push(env.DB.prepare(`UPDATE _ecommerce_components
            SET quantity = quantity + (SELECT quantity FROM _ecommerce_component_reservations
              WHERE id = ? AND released_at IS NULL), updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_component_reservations
              WHERE id = ? AND released_at IS NULL)
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(reservation.id, timestamp, reservation.componentId, reservation.id, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_component_reservations SET released_at = ?
            WHERE id = ? AND released_at IS NULL
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, reservation.id, id));
        }
        for (const reservation of inventoryReservations2) {
          const table = reservation.targetType === "product" ? "_ecommerce_products" : reservation.targetType === "variant" ? "_ecommerce_product_variants" : "_ecommerce_stocks";
          const column = reservation.targetType === "stock" ? "quantity" : "inventory_quantity";
          statements.push(env.DB.prepare(`UPDATE ${table}
            SET ${column} = ${column} + (SELECT quantity FROM _ecommerce_inventory_reservations
              WHERE id = ? AND released_at IS NULL), updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_inventory_reservations
              WHERE id = ? AND released_at IS NULL)
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(reservation.id, timestamp, reservation.targetId, reservation.id, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_inventory_reservations SET released_at = ?
            WHERE id = ? AND released_at IS NULL
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, reservation.id, id));
        }
        if (order.cartId) {
          statements.push(env.DB.prepare(`UPDATE _ecommerce_carts
            SET checkout_session_id = NULL, updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, order.cartId, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_orders SET cart_id = NULL
            WHERE id = ? AND status = 'cancelled'`).bind(id));
        }
        await env.DB.batch(statements);
        return await this.find(id);
      }
    },
    webhooks: {
      async handleStripe(payload, signature, secret) {
        const stripeAdapter = paymentAdapters.find((a) => a.providerId === "stripe");
        if (!stripeAdapter?.validateWebhook) {
          throw new Error("Stripe adapter not configured options.paymentAdapters");
        }
        const event = await stripeAdapter.validateWebhook(payload, signature, secret || "");
        if (event.type === "checkout.session.completed") {
          const session = event.data;
          if (session.metadata?.giftCardPurchaseId) {
            return confirmGiftCardPurchase(env, session);
          }
          const orderId = session.metadata?.orderId || session.client_reference_id;
          if (session.payment_status !== "paid") {
            return { success: true, event: event.type, ignored: true };
          }
          if (orderId) {
            return finalizeOrderPayment({
              orderId,
              provider: "stripe",
              providerId: session.id,
              paymentStatus: session.payment_status === "paid" ? "success" : "pending",
              amount: session.amount_total || 0,
              currency: session.currency,
              paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : void 0,
              customerEmail: session.customer_details?.email || session.customer_email
            });
          }
        }
        if (event.type === "checkout.session.expired") {
          const session = event.data;
          if (session.metadata?.giftCardPurchaseId) {
            await expireGiftCardPurchase(env, session.metadata.giftCardPurchaseId, session.id);
            return { success: true, event: event.type };
          }
          const orderId = session.metadata?.orderId || session.client_reference_id;
          if (orderId) {
            const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
            if (order?.checkoutSessionId === session.id) {
              const cancelled = await bindCommerceApi(options).orders.cancel(orderId, { sessionExpired: true });
              return { success: true, event: event.type, cancelled: cancelled?.status === "cancelled" };
            }
          }
        }
        if (event.type === "charge.refunded") {
          const charge = event.data;
          if (typeof charge.payment_intent !== "string") {
            return { success: true, event: event.type, ignored: true };
          }
          const giftPurchaseRefund = await recordGiftCardPurchaseRefund(env, {
            paymentIntentId: charge.payment_intent,
            amount: charge.amount,
            amountRefunded: charge.amount_refunded,
            currency: charge.currency
          });
          if (giftPurchaseRefund) return giftPurchaseRefund;
          return recordProviderRefund({
            paymentIntentId: charge.payment_intent,
            amount: charge.amount,
            amountRefunded: charge.amount_refunded,
            currency: charge.currency
          });
        }
        return { success: true, event: event.type, ignored: true };
      }
    },
    // Stub for DO binding
    inventory: {
      async reserve(productId, variantId, quantity) {
        if (!env["INVENTORY_DO"]) {
          console.warn("[Talisman Commerce] INVENTORY_DO binding not found. Falling back to optimistic reservation.");
          return { success: true, reserved: quantity, pessimistic: false };
        }
        return { success: true, reserved: quantity, pessimistic: true };
      }
    }
  };
}
async function reconcileCommerce(options, limit = 10) {
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  const { env } = options;
  const api = bindCommerceApi(options);
  const now = Math.floor(Date.now() / 1e3);
  const preparations = await env.DB.prepare(`SELECT id FROM _ecommerce_carts
    WHERE checkout_session_id LIKE 'preparing:%' AND updated_at < ?
    ORDER BY updated_at LIMIT ?`).bind(now - 35 * 60, count).all();
  const pending = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ?`).bind(now - 15 * 60, count).all();
  const giftPurchases = await env.DB.prepare(`SELECT id FROM _ecommerce_gift_card_purchases
    WHERE status = 'pending' AND provider_session_id IS NOT NULL AND created_at < ?
    ORDER BY created_at LIMIT ?`).bind(now - 15 * 60, count).all();
  const results = [];
  for (const row of preparations.results ?? []) {
    try {
      await api.orders.resumeFromCart(row.id);
      results.push({ id: row.id, status: "preparation_checked" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  for (const row of pending.results ?? []) {
    try {
      const result = await api.orders.reconcilePending(row.id);
      results.push({ id: row.id, status: result?.status ?? "unchanged" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  const stripe = options.paymentAdapters?.find((adapter) => adapter.providerId === "stripe");
  for (const row of giftPurchases.results ?? []) {
    try {
      if (!stripe) throw new Error("Stripe adapter is unavailable");
      const result = await reconcileGiftCardPurchase(env, stripe, row.id);
      results.push({ id: row.id, status: result?.status ?? "unchanged" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  await env.DB.prepare(`DELETE FROM _ecommerce_customer_sessions
    WHERE (purpose = 'email_challenge' AND expires_at < ?)
      OR (purpose = 'session' AND expires_at < ?)`).bind(now - 24 * 60 * 60, now - 30 * 24 * 60 * 60).run();
  return results;
}
var PURGE_MAX_BATCHES = 20;
async function purgeStaleCommerceData(options) {
  const { env } = options;
  const batchSize = Math.max(1, Math.min(1e3, Math.floor(options.batchSize ?? 500)));
  const now = Math.floor((options.now ?? /* @__PURE__ */ new Date()).getTime() / 1e3);
  const day = 24 * 60 * 60;
  const deleted = { carts: 0, customerSessions: 0, authSessions: 0, authRateLimits: 0 };
  const steps = [
    // Guest baskets untouched for 30 days. Account, checked-out and locked baskets stay.
    ["carts", `DELETE FROM _ecommerce_carts WHERE id IN (SELECT id FROM _ecommerce_carts
      WHERE user_id IS NULL AND closed = 0 AND checkout_session_id IS NULL AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE cart_id = _ecommerce_carts.id)
      LIMIT ?)`, [now - 30 * day]],
    // Shopper sessions and email sign-in links a day after they expired, were used or signed out.
    ["customerSessions", `DELETE FROM _ecommerce_customer_sessions WHERE id IN (SELECT id
      FROM _ecommerce_customer_sessions WHERE expires_at < ? OR revoked_at < ? LIMIT ?)`, [now - day, now - day]],
    ["authSessions", `DELETE FROM galaxy_auth_session WHERE id IN (SELECT id FROM galaxy_auth_session
      WHERE expires_at < ? LIMIT ?)`, [now]],
    // better-auth records milliseconds; the shopper sign-in limiter records seconds.
    ["authRateLimits", `DELETE FROM galaxy_auth_rate_limit WHERE id IN (SELECT id FROM galaxy_auth_rate_limit
      WHERE CASE WHEN last_request >= 100000000000 THEN last_request / 1000 ELSE last_request END < ?
      LIMIT ?)`, [now - day]]
  ];
  const failures = [];
  for (const [table, query, params] of steps) {
    try {
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
        const result = await env.DB.prepare(query).bind(...params, batchSize).run();
        const changes = Number(result.meta?.changes ?? 0);
        deleted[table] += changes;
        if (changes < batchSize) break;
      }
    } catch (error) {
      failures.push(`${table}: ${error instanceof Error ? error.message : "cleanup failed"}`);
    }
  }
  if (failures.length) throw new Error(`Commerce data cleanup failed (${failures.join("; ")})`);
  return deleted;
}

export {
  aggregateComponentDemand,
  bindCommerceApi,
  reconcileCommerce,
  purgeStaleCommerceData
};
