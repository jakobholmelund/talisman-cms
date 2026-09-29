import {
  INVENTORY_COLUMNS,
  fullRefundStatements
} from "./chunk-K6SXWFZP.js";
import {
  evaluateDiscountCode
} from "./chunk-4DUQOBXB.js";
import {
  TaxAddressError
} from "./chunk-BGDJXEM5.js";
import {
  deliverCommerceEmail,
  deliverPendingCommerceEmails,
  fulfillCommerceOrder
} from "./chunk-TMMXEXF2.js";
import {
  RECONCILE_DUE,
  RECONCILE_ORDER,
  ReconcileFailure,
  WebhookMismatchError,
  WebhookRetryLaterError,
  WebhookSignatureError,
  assertStoreStripeMode,
  backoffSql,
  commerceEmailStatement,
  completedCheckoutReturn,
  confirmGiftCardPurchase,
  decisionInsert,
  evaluateGiftCard,
  expireGiftCardPurchase,
  giftCardPurchaseChargebackStatements,
  giftCardPurchaseHoldStatements,
  giftCardPurchaseReleaseStatements,
  isCountryCode,
  isMissingSessionError,
  isOtherStripeModeSession,
  readStoreSettings,
  reconcileAttempt,
  reconcileFailure,
  reconcileGiftCardPurchase,
  recordGiftCardPurchaseRefund,
  sessionLookupFailure,
  uncheckedSessionRefusal
} from "./chunk-46DBWAED.js";
import {
  canonicalEmail,
  canonicalEmailSql,
  canonicalEmails,
  canonicalPurchase,
  findReferralCode,
  getReferralPolicy,
  hasCanonicalPurchase,
  referralReversalStatements,
  releaseReferralAwards
} from "./chunk-7PQWN42E.js";
import {
  PURCHASED_ORDER_STATUSES,
  claimInterval,
  hasPurchaseHistory
} from "./chunk-OPQXEAZM.js";
import {
  batchGroups,
  chunked,
  commerceDb,
  commitBatch,
  errorText,
  runStatements
} from "./chunk-ZI5IJOR6.js";
import {
  carts,
  componentReservations,
  creditLedger,
  customerAccounts,
  customerSessions,
  discountRedemptions,
  giftCardPurchases,
  giftCardRedemptions,
  inventoryReservations,
  orders,
  productVariantValues,
  productVariants,
  products,
  referralCodes,
  taxReversals
} from "./chunk-NKJTK7MK.js";
import {
  minimumChargeAmount
} from "./chunk-2UYSCNNW.js";

// src/commerce-context.ts
function commerceContext(options) {
  return { env: options.env, db: commerceDb(options.env), adapters: options.paymentAdapters ?? [] };
}

// src/basket.ts
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
var CART_MAX_LINES = 50;
var CART_MAX_LINE_QUANTITY = 99;
var CART_ID_MAX_LENGTH = 128;
var cartItemKey = (item) => `${item.productId}\0${item.variantId || ""}`;
function assertCartItems(items) {
  if (!Array.isArray(items)) throw new Error("Cart items must be an array");
  if (items.length > CART_MAX_LINES) throw new Error(`Cart items must not exceed ${CART_MAX_LINES} lines`);
  if (items.some(
    (item) => !item || typeof item.productId !== "string" || !item.productId.trim() || item.productId.length > CART_ID_MAX_LENGTH || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > CART_MAX_LINE_QUANTITY || item.variantId !== void 0 && (typeof item.variantId !== "string" || item.variantId.length > CART_ID_MAX_LENGTH)
  )) {
    throw new Error(`Cart items must have a product and a whole-number quantity from 1 to ${CART_MAX_LINE_QUANTITY}`);
  }
  const itemKeys = items.map(cartItemKey);
  if (new Set(itemKeys).size !== itemKeys.length) {
    throw new Error("Duplicate cart items are not allowed");
  }
}
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
async function loadBasketCatalog(ctx, items) {
  const { db } = ctx;
  const productIds = [...new Set(items.map((item) => String(item.productId)))];
  const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [String(item.variantId)] : []))];
  const rows = await batchGroups(db, {
    // Each product with its variant groups, and each group with the name of its definition.
    products: chunked(productIds).map((ids) => db.query.products.findMany({
      columns: { id: true, name: true, status: true, type: true, basePrice: true, inventoryQuantity: true, isPhysical: true },
      where: { id: { in: ids } },
      with: { variants: {
        columns: { id: true, productId: true, name: true, priceOverride: true, inventoryQuantity: true },
        with: { variant: { columns: { name: true } } }
      } }
    })),
    // Each value with its stock row and its bill of materials, in component id order.
    values: chunked(variantIds).map((ids) => db.query.productVariantValues.findMany({
      columns: { id: true, productVariantId: true, value: true, priceOverride: true },
      where: { id: { in: ids } },
      with: {
        stock: { columns: { id: true, quantity: true } },
        requirements: {
          columns: { componentId: true, quantity: true },
          orderBy: { componentId: "asc" },
          with: { component: { columns: { id: true, name: true, quantity: true } } }
        }
      }
    })),
    // A line's variant id may name a legacy group instead of a value; such a group must have no values.
    groupsWithValues: chunked(variantIds).map((ids) => db.query.productVariants.findMany({
      columns: { id: true },
      where: { id: { in: ids }, values: true }
    }))
  });
  const catalog = {
    products: /* @__PURE__ */ new Map(),
    groups: /* @__PURE__ */ new Map(),
    productsWithGroups: /* @__PURE__ */ new Set(),
    groupsWithValues: /* @__PURE__ */ new Set(),
    values: /* @__PURE__ */ new Map(),
    requirements: /* @__PURE__ */ new Map()
  };
  for (const product of rows.products) {
    catalog.products.set(product.id, {
      id: product.id,
      name: product.name,
      status: product.status,
      type: product.type,
      basePrice: product.basePrice,
      inventoryQuantity: product.inventoryQuantity,
      isPhysical: product.isPhysical
    });
    for (const group of product.variants) {
      catalog.groups.set(group.id, {
        id: group.id,
        productId: group.productId,
        name: group.name,
        definitionName: group.variant?.name ?? null,
        priceOverride: group.priceOverride,
        inventoryQuantity: group.inventoryQuantity
      });
      catalog.productsWithGroups.add(group.productId);
    }
  }
  for (const value of rows.values) {
    catalog.values.set(value.id, {
      id: value.id,
      groupId: value.productVariantId,
      value: value.value,
      priceOverride: value.priceOverride,
      stock: value.stock && { id: value.stock.id, quantity: value.stock.quantity }
    });
    catalog.requirements.set(value.id, value.requirements.map((requirement) => ({
      componentId: requirement.componentId,
      quantity: requirement.quantity,
      component: requirement.component
    })));
  }
  for (const group of rows.groupsWithValues) catalog.groupsWithValues.add(group.id);
  return catalog;
}
function resolveSelectedVariant(catalog, product, variantId) {
  const variantValue = catalog.values.get(String(variantId));
  if (variantValue) {
    const productVariant = catalog.groups.get(variantValue.groupId);
    if (!productVariant || productVariant.productId !== product.id) {
      throw new Error(`Variant value not found or mismatch: ${variantId}`);
    }
    const stock = variantValue.stock;
    const components = [];
    for (const requirement of catalog.requirements.get(variantValue.id) ?? []) {
      const component = requirement.component;
      if (!component) throw new Error(`Component not found: ${requirement.componentId}`);
      components.push({
        id: component.id,
        name: component.name,
        quantity: requirement.quantity,
        available: component.quantity
      });
    }
    return {
      price: variantValue.priceOverride ?? productVariant.priceOverride ?? product.basePrice,
      name: `${product.name} - ${productVariant.definitionName ?? productVariant.name}: ${variantValue.value}`,
      availableQuantity: components.length ? Math.min(...components.map((component) => Math.floor(component.available / component.quantity))) : stock?.quantity ?? productVariant.inventoryQuantity,
      inventoryTarget: components.length ? null : stock ? { type: "stock", id: stock.id } : { type: "variant", id: productVariant.id },
      components
    };
  }
  const legacyVariant = catalog.groups.get(String(variantId));
  if (!legacyVariant || legacyVariant.productId !== product.id) {
    throw new Error(`Variant not found or mismatch: ${variantId}`);
  }
  if (catalog.groupsWithValues.has(legacyVariant.id)) throw new Error(`Select an option for ${product.name}`);
  return {
    price: legacyVariant.priceOverride ?? product.basePrice,
    name: `${product.name} - ${legacyVariant.name}`,
    availableQuantity: legacyVariant.inventoryQuantity,
    inventoryTarget: { type: "variant", id: legacyVariant.id },
    components: []
  };
}
function requireVariantChoice(catalog, product, variantId) {
  if (variantId) return;
  if (catalog.productsWithGroups.has(product.id)) throw new Error(`Select an option for ${product.name}`);
}
async function checkCartItems(ctx, items, current = []) {
  const { db } = ctx;
  assertCartItems(items);
  const currentKeys = new Set(current.map(cartItemKey));
  const added = items.filter((item) => !currentKeys.has(cartItemKey(item)));
  const productIds = [...new Set(added.map((item) => item.productId))];
  const available = new Set(productIds.length ? (await db.select({ id: products.id, status: products.status }).from(products).where(inArray(products.id, productIds))).filter((product) => product.status !== "archived").map((product) => product.id) : []);
  const unknownProduct = added.find((item) => !available.has(item.productId));
  if (unknownProduct) throw new Error(`Cart items must be catalog products; ${unknownProduct.productId} is not available`);
  const variantIds = [...new Set(added.flatMap((item) => item.variantId ? [item.variantId] : []))];
  if (variantIds.length) {
    const groups = await db.select({ id: productVariants.id, productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.id, variantIds));
    const groupsWithValues = new Set(groups.length ? (await db.selectDistinct({ id: productVariantValues.productVariantId }).from(productVariantValues).where(inArray(productVariantValues.productVariantId, groups.map((group) => group.id)))).map((value) => value.id) : []);
    const owners = new Map(groups.filter((group) => !groupsWithValues.has(group.id)).map((group) => [group.id, group.productId]));
    const choices = new Map(groups.filter((group) => groupsWithValues.has(group.id)).map((group) => [group.id, group.productId]));
    for (const value of await db.select({ id: productVariantValues.id, productId: productVariants.productId }).from(productVariantValues).innerJoin(productVariants, eq(productVariants.id, productVariantValues.productVariantId)).where(inArray(productVariantValues.id, variantIds))) {
      owners.set(value.id, value.productId);
    }
    const unchosenGroup = added.find((item) => item.variantId && choices.get(item.variantId) === item.productId);
    if (unchosenGroup) throw new Error(`Cart items must choose one of the variants of ${unchosenGroup.productId}`);
    const unknownVariant = added.find((item) => item.variantId && owners.get(item.variantId) !== item.productId);
    if (unknownVariant) throw new Error(`Cart items must use a variant of their product; ${unknownVariant.variantId} is not available`);
  }
  const withoutVariant = [...new Set(added.flatMap((item) => item.variantId ? [] : [item.productId]))];
  if (withoutVariant.length) {
    const withGroups = new Set((await db.selectDistinct({ productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.productId, withoutVariant))).map((variant) => variant.productId));
    const unchosen = added.find((item) => !item.variantId && withGroups.has(item.productId));
    if (unchosen) throw new Error(`Cart items must choose one of the variants of ${unchosen.productId}`);
  }
  return items.map(({ productId, variantId, quantity }) => variantId ? { productId, variantId, quantity } : { productId, quantity });
}
async function quoteCart(ctx, cartId) {
  const { env, db } = ctx;
  const { currency } = readStoreSettings(env);
  const cart = await db.select().from(carts).where(eq(carts.id, cartId)).get();
  if (!cart) throw new Error("Cart not found");
  const catalog = await loadBasketCatalog(ctx, cart.items);
  const lines = [];
  let totalAmount = 0;
  let requiresShipping = false;
  const componentItems = [];
  for (const item of cart.items) {
    const product = catalog.products.get(String(item.productId));
    if (!product || product.status !== "active") throw new Error(`Product is not available: ${item.productId}`);
    requireVariantChoice(catalog, product, item.variantId);
    const variant = item.variantId ? resolveSelectedVariant(catalog, product, item.variantId) : null;
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
  return { lines, totalAmount, currency, requiresShipping, locked: Boolean(cart.checkoutSessionId) };
}
async function findCart(ctx, sessionToken, userId) {
  const { db } = ctx;
  if (!sessionToken && !userId) return null;
  const conditions = [eq(carts.closed, false)];
  if (userId) {
    conditions.push(eq(carts.userId, userId));
  } else if (sessionToken) {
    conditions.push(eq(carts.sessionToken, sessionToken));
    conditions.push(isNull(carts.userId));
  }
  return await db.select().from(carts).where(and(...conditions)).get();
}
async function claimCart(ctx, sessionToken, userId, choice) {
  const { db } = ctx;
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
      await db.update(carts).set({ sessionToken: null }).where(and(eq(carts.sessionToken, sessionToken), eq(carts.closed, true)));
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
}
async function getOrCreateCart(ctx, sessionToken, userId) {
  const { db } = ctx;
  if (userId) {
    const claimed = await claimCart(ctx, sessionToken, userId);
    if (claimed) return claimed;
  }
  let cart = await findCart(ctx, sessionToken, userId);
  if (!cart) {
    if (!userId) {
      await db.update(carts).set({ sessionToken: null }).where(and(
        eq(carts.sessionToken, sessionToken),
        eq(carts.closed, false),
        isNotNull(carts.userId)
      ));
    }
    await db.update(carts).set({ sessionToken: null }).where(and(eq(carts.sessionToken, sessionToken), eq(carts.closed, true)));
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
    cart = await findCart(ctx, sessionToken, userId);
  }
  return cart;
}
async function updateCartItems(ctx, cartId, items) {
  const { db } = ctx;
  assertCartItems(items);
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
  const checked = await checkCartItems(ctx, items, cart.items);
  const updated = await db.update(carts).set({ items: checked, updatedAt: /* @__PURE__ */ new Date(), version: sql`${carts.version} + 1` }).where(and(
    eq(carts.id, cartId),
    eq(carts.closed, false),
    isNull(carts.checkoutSessionId),
    eq(carts.version, cart.version)
  )).returning({ id: carts.id });
  if (!updated.length) throw new Error("Basket changed or checkout already started; reload and try again");
  return await db.select().from(carts).where(eq(carts.id, cartId)).get();
}

// src/checkout.ts
import { and as and4, eq as eq4, isNull as isNull4, lt, notExists, sql as sql3 } from "drizzle-orm";

// src/checkout-input.ts
import { z } from "zod";
var INVALID_COUNTRY = "Enter a valid country code";
var UNDELIVERABLE_COUNTRY = "We do not deliver to this country";
var SHIPPING_OPTION_UNAVAILABLE = "This shipping option is not available for your country";
var TAX_ADDRESS_REQUIRED = "A billing address is required to calculate tax";
var TAX_ADDRESS_UNUSABLE = "Tax cannot be calculated for this address. Check it and try again.";
var TAX_UNAVAILABLE = "Tax could not be calculated. Please try again.";
var correctableRefusals = /* @__PURE__ */ new Set([
  INVALID_COUNTRY,
  UNDELIVERABLE_COUNTRY,
  SHIPPING_OPTION_UNAVAILABLE,
  TAX_ADDRESS_REQUIRED,
  TAX_ADDRESS_UNUSABLE
]);
function isCheckoutDetailsError(error) {
  return error instanceof Error && correctableRefusals.has(error.message);
}
function withCountryCode(address) {
  const country = address?.country;
  if (country === void 0 || country === null) return address;
  const code = typeof country === "string" ? country.trim().toUpperCase() : null;
  if (code === null || code && !isCountryCode(code)) throw new Error(INVALID_COUNTRY);
  return { ...address, country: code };
}
var addressSchema = z.object({
  name: z.string().trim().max(200).optional(),
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(30).optional(),
  // Any case. Only officially assigned codes pass, so a mistyped "UK" is refused rather than stored.
  country: z.string().trim().toUpperCase().refine(isCountryCode, INVALID_COUNTRY).optional()
});
var checkoutSchema = z.object({
  customerEmail: z.string().trim().email().max(254).optional(),
  discountCode: z.string().trim().max(32).optional(),
  giftCardCode: z.string().trim().max(37).optional(),
  shippingAddress: addressSchema.optional(),
  billingAddress: addressSchema.optional(),
  // A rate id from the store's shipping rates. Left out or blank, checkout uses the first rate that
  // serves the country.
  shippingRateId: z.string().trim().max(40).optional()
});
function checkoutInputError(error) {
  return error.issues.some((issue) => issue.path.at(-1) === "country") ? INVALID_COUNTRY : "Invalid checkout details";
}

// src/orders.ts
import { and as and3, eq as eq3, exists, isNull as isNull3, notInArray, sql as sql2 } from "drizzle-orm";

// src/provider-checks.ts
var PROVIDER_CHECK_INTERVAL_SECONDS = 15;
var PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS = 60;
var PROVIDER_CHECK_RETRY_MESSAGE = "The payment session was checked moments ago. Please try again in 15 seconds.";
var ProviderCheckLimitedError = class extends Error {
  name = "ProviderCheckLimitedError";
  constructor() {
    super(PROVIDER_CHECK_RETRY_MESSAGE);
  }
};
function providerCheckLimitResponse() {
  return Response.json({ error: PROVIDER_CHECK_RETRY_MESSAGE }, {
    status: 429,
    headers: { "Retry-After": String(PROVIDER_CHECK_INTERVAL_SECONDS), "Cache-Control": "no-store" }
  });
}
async function mayAskPaymentProvider(env, order, paymentAdapters, { minOrderAgeSeconds = 0, now = Math.floor(Date.now() / 1e3) } = {}) {
  const provider = order.paymentProvider ?? "stripe";
  if (!paymentAdapters.some((adapter) => adapter.providerId === provider)) return true;
  if (now - Math.floor(order.createdAt.getTime() / 1e3) < minOrderAgeSeconds) return false;
  return claimInterval(env, `order-status:${order.id}`, PROVIDER_CHECK_INTERVAL_SECONDS, now);
}

// src/tax.ts
import { and as and2, eq as eq2, isNotNull as isNotNull2, isNull as isNull2 } from "drizzle-orm";
var SHIPPING_TAX_CODE = "txcd_92010001";
var TaxCalculationError = class extends Error {
  constructor(options) {
    super(TAX_UNAVAILABLE, options);
    this.name = "TaxCalculationError";
  }
};
var describe = (error) => error instanceof Error ? error.message : String(error);
function allocateProportionally(amount, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const parts = weights.map((weight, index) => {
    const product = BigInt(amount) * BigInt(weight);
    return { index, share: Number(product / BigInt(total)), remainder: product % BigInt(total) };
  });
  let left = amount - parts.reduce((sum, part) => sum + part.share, 0);
  const byRemainder = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const part of byRemainder) {
    if (left <= 0) break;
    part.share += 1;
    left -= 1;
  }
  return parts.map((part) => part.share);
}
function taxableLines(lines, discount, creditApplied) {
  const totals = lines.map((line) => line.priceAtPurchase * line.quantity);
  const discounts = allocateProportionally(discount.amount, totals.map((total, index) => !discount.productIds.length || discount.productIds.includes(lines[index].productId) ? total : 0));
  const afterDiscount = totals.map((total, index) => total - discounts[index]);
  const credits = allocateProportionally(creditApplied, afterDiscount);
  return lines.map((line, index) => ({
    // Unique within the order, and names the product in the provider's tax reports.
    reference: `L${index + 1}:${line.productId}${line.variantId ? `:${line.variantId}` : ""}`,
    amount: afterDiscount[index] - credits[index],
    quantity: line.quantity
  }));
}
function taxAddressFor(requiresShipping, shippingAddress, billingAddress) {
  const given = requiresShipping ? shippingAddress : billingAddress;
  if (!given || typeof given.country !== "string" || !given.country) throw new Error(TAX_ADDRESS_REQUIRED);
  const address = { country: given.country };
  for (const key of ["line1", "line2", "city", "state", "postalCode"]) {
    const value = given[key];
    if (typeof value === "string" && value.trim()) address[key] = value.trim();
  }
  return { address, addressSource: requiresShipping ? "shipping" : "billing" };
}
async function calculateOrderTax(adapter, input) {
  const charged = input.lines.filter((line) => line.amount > 0);
  const shippingOnly = !charged.length && input.shippingAmount > 0;
  const params = {
    currency: input.currency,
    behavior: input.behavior,
    taxCode: input.settings.taxCode,
    lines: shippingOnly ? [{ reference: "shipping", amount: input.shippingAmount, quantity: 1, taxCode: SHIPPING_TAX_CODE }] : charged.length ? charged : input.lines.slice(0, 1),
    shippingAmount: shippingOnly ? 0 : input.shippingAmount,
    address: input.address,
    addressSource: input.addressSource,
    shipFromCountry: input.settings.shipFromCountry
  };
  const failed = (reason, cause) => {
    console.error(`[Commerce] Tax could not be calculated for basket ${input.cartId}: ${reason}`);
    return new TaxCalculationError(cause === void 0 ? void 0 : { cause });
  };
  if (!adapter.calculateTax || !adapter.recordTaxTransaction || !adapter.reverseTaxTransaction) {
    throw failed(`payment provider ${adapter.providerId} cannot calculate, record and reverse tax`);
  }
  let calculation;
  try {
    calculation = await adapter.calculateTax(params);
  } catch (cause) {
    if (cause instanceof TaxAddressError) throw new Error(TAX_ADDRESS_UNUSABLE, { cause });
    throw failed(describe(cause), cause);
  }
  const exclusive = input.behavior === "exclusive";
  const amount = exclusive ? calculation.taxAmountExclusive : calculation.taxAmountInclusive;
  const other = exclusive ? calculation.taxAmountInclusive : calculation.taxAmountExclusive;
  const base = params.lines.reduce((sum, line) => sum + line.amount, 0) + params.shippingAmount;
  if (typeof calculation.id !== "string" || !calculation.id || !Number.isSafeInteger(amount) || amount < 0 || other !== 0 || calculation.amountTotal !== base + (exclusive ? amount : 0) || !exclusive && amount > base) {
    throw failed(`calculation ${calculation.id} totals ${calculation.amountTotal} with ${amount} tax ${input.behavior}, where the order expects ${base}${exclusive ? " plus the tax" : ""}`);
  }
  return { calculationId: calculation.id, amount, behavior: input.behavior };
}
function taxProvider(adapters, paymentProvider) {
  const providerId = paymentProvider === "gift_card" ? "stripe" : paymentProvider ?? "stripe";
  return adapters.find((adapter) => adapter.providerId === providerId);
}
var PAID_STATUSES = ["paid", "fulfilled", "partially_refunded", "refunded", "disputed"];
var TAX_SYNC_CLEARED = { taxSyncAttempts: 0, taxSyncLastAt: null, taxSyncLastError: null };
var ORDER_TAX_BACKOFF = backoffSql("tax_sync");
var unixNow = () => Math.floor(Date.now() / 1e3);
async function countTaxFailure(env, table, where, key, error, now) {
  try {
    await env.DB.prepare(`UPDATE ${table} SET tax_sync_attempts = tax_sync_attempts + 1, tax_sync_last_at = ?,
      tax_sync_last_error = ? WHERE ${where}`).bind(now, reconcileFailure(error).code, key).run();
  } catch {
  }
}
async function recordOrderTax(env, adapters, orderId, now = unixNow()) {
  const order = await env.DB.prepare(`SELECT id, status, payment_provider, tax_calculation_id, tax_transaction_id,
      (SELECT MIN(created_at) FROM _ecommerce_payments WHERE order_id = o.id) AS paid_at
    FROM _ecommerce_orders o WHERE id = ?`).bind(orderId).first();
  if (!order?.tax_calculation_id || order.tax_transaction_id || !PAID_STATUSES.includes(order.status)) return false;
  try {
    const adapter = taxProvider(adapters, order.payment_provider);
    if (!adapter?.recordTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot record tax");
    }
    const late = order.paid_at !== null && order.paid_at < Math.floor(Date.now() / 1e3) - 300;
    const { transactionId } = await adapter.recordTaxTransaction({
      orderId: order.id,
      calculationId: order.tax_calculation_id,
      ...late ? { postedAt: order.paid_at } : {}
    });
    const stored = await commerceDb(env).update(orders).set({ taxTransactionId: transactionId, ...TAX_SYNC_CLEARED }).where(and2(eq2(orders.id, order.id), isNull2(orders.taxTransactionId))).run();
    return Number(stored.meta?.changes ?? 0) > 0;
  } catch (error) {
    await countTaxFailure(env, "_ecommerce_orders", "id = ? AND tax_transaction_id IS NULL", order.id, error, now);
    throw error;
  }
}
async function recordConfirmedOrderTax(env, adapters, orderId) {
  try {
    await recordOrderTax(env, adapters, orderId);
  } catch (error) {
    console.error(`[Commerce] The tax transaction of order ${orderId} was not recorded: ${describe(error)}`);
  }
}
var REVERSAL_TARGET = `CASE WHEN o.status = 'refunded' THEN o.gift_card_applied + o.total_amount
  ELSE MIN(o.gift_card_applied + o.total_amount, o.provider_refunded_cents + o.gift_card_refunded_cents) END`;
var REVERSED = "(SELECT COALESCE(SUM(r.amount), 0) FROM _ecommerce_tax_reversals r WHERE r.order_id = o.id)";
async function recordTaxReversal(env, adapters, orderId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await env.DB.prepare(`SELECT o.id, o.payment_provider, o.tax_transaction_id,
        ${REVERSAL_TARGET} AS target, ${REVERSED} AS reversed
      FROM _ecommerce_orders o WHERE o.id = ?`).bind(orderId).first();
    if (!order?.tax_transaction_id || order.target <= order.reversed) return null;
    const adapter = taxProvider(adapters, order.payment_provider);
    if (!adapter?.reverseTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot reverse tax");
    }
    const reversal = {
      orderId: order.id,
      transactionId: order.tax_transaction_id,
      reference: `${order.id}:reversal:${order.target}`,
      amount: order.target - order.reversed
    };
    const recorded = await env.DB.prepare(`INSERT INTO _ecommerce_tax_reversals
      (id, order_id, reference, amount, provider_reversal_id, created_at)
      SELECT ?, ?, ?, ?, '', ? WHERE (SELECT COALESCE(SUM(amount), 0) FROM _ecommerce_tax_reversals
        WHERE order_id = ?) = ?
      ON CONFLICT(reference) DO NOTHING`).bind(
      `taxrev_${crypto.randomUUID()}`,
      order.id,
      reversal.reference,
      reversal.amount,
      Math.floor(Date.now() / 1e3),
      order.id,
      order.reversed
    ).run();
    if (Number(recorded.meta?.changes ?? 0) > 0) return { adapter, reversal };
  }
  return null;
}
async function reverseOrderTax(env, adapters, orderId, now = unixNow()) {
  let recorded;
  try {
    recorded = await recordTaxReversal(env, adapters, orderId);
  } catch (error) {
    await countTaxFailure(env, "_ecommerce_orders", "id = ?", orderId, error, now);
    throw error;
  }
  if (!recorded) return null;
  try {
    await commerceDb(env).update(orders).set(TAX_SYNC_CLEARED).where(and2(eq2(orders.id, orderId), isNotNull2(orders.taxSyncLastAt)));
  } catch {
  }
  await sendTaxReversal(env, recorded.adapter, recorded.reversal, now);
  return { reference: recorded.reversal.reference, amount: recorded.reversal.amount };
}
async function sendTaxReversal(env, adapter, reversal, now) {
  try {
    if (!adapter?.reverseTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot reverse tax");
    }
    const { reversalId } = await adapter.reverseTaxTransaction(reversal);
    await commerceDb(env).update(taxReversals).set({ providerReversalId: reversalId, ...TAX_SYNC_CLEARED }).where(and2(eq2(taxReversals.reference, reversal.reference), eq2(taxReversals.providerReversalId, "")));
  } catch (error) {
    await countTaxFailure(
      env,
      "_ecommerce_tax_reversals",
      `reference = ? AND provider_reversal_id = ''`,
      reversal.reference,
      error,
      now
    );
    throw error;
  }
}
async function reverseRefundedOrderTax(env, adapters, orderId) {
  try {
    await reverseOrderTax(env, adapters, orderId);
  } catch (error) {
    console.error(`[Commerce] The tax reversal of order ${orderId} was not recorded: ${describe(error)}`);
  }
}
async function attemptEach(rows, orderOf, attempt) {
  const results = [];
  for (const row of rows) {
    try {
      results.push({ id: orderOf(row), status: await attempt(row) });
    } catch (error) {
      const failure = reconcileFailure(error);
      results.push({ id: orderOf(row), status: "error", error: failure.message, code: failure.code });
    }
  }
  return results;
}
async function recordMissingTaxTransactions(env, adapters, now, limit) {
  const rows = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status IN (${PAID_STATUSES.map((status) => `'${status}'`).join(", ")})
      AND tax_calculation_id IS NOT NULL AND tax_transaction_id IS NULL AND ${ORDER_TAX_BACKOFF.due}
    ORDER BY ${ORDER_TAX_BACKOFF.order} LIMIT ?`).bind(now, limit).all();
  return attemptEach(
    rows.results ?? [],
    (row) => row.id,
    async (row) => await recordOrderTax(env, adapters, row.id, now) ? "tax_recorded" : "unchanged"
  );
}
var REVERSAL_IN_FLIGHT_SECONDS = 5 * 60;
var REVERSAL_BACKOFF = backoffSql("tax_sync", "r");
async function resendPendingTaxReversals(env, adapters, now, limit) {
  const pending = await env.DB.prepare(`SELECT r.order_id, r.reference, r.amount, o.payment_provider,
      o.tax_transaction_id FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id
    WHERE r.provider_reversal_id = '' AND r.created_at < ? AND ${REVERSAL_BACKOFF.due}
    ORDER BY ${REVERSAL_BACKOFF.order} LIMIT ?`).bind(now - REVERSAL_IN_FLIGHT_SECONDS, now, limit).all();
  return attemptEach(pending.results ?? [], (row) => row.order_id, async (row) => {
    await sendTaxReversal(env, taxProvider(adapters, row.payment_provider), {
      orderId: row.order_id,
      transactionId: row.tax_transaction_id,
      reference: row.reference,
      amount: row.amount
    }, now);
    return "tax_reversed";
  });
}
var REFUNDED_ORDER_TAX_BACKOFF = backoffSql("tax_sync", "o");
async function reverseUnreversedTax(env, adapters, now, limit) {
  const rows = await env.DB.prepare(`SELECT o.id FROM _ecommerce_orders o
    WHERE o.status IN ('partially_refunded', 'refunded') AND o.tax_transaction_id IS NOT NULL
      AND ${REVERSAL_TARGET} > ${REVERSED} AND ${REFUNDED_ORDER_TAX_BACKOFF.due}
    ORDER BY ${REFUNDED_ORDER_TAX_BACKOFF.order} LIMIT ?`).bind(now, limit).all();
  return attemptEach(
    rows.results ?? [],
    (row) => row.id,
    async (row) => await reverseOrderTax(env, adapters, row.id, now) ? "tax_reversed" : "unchanged"
  );
}

// src/orders.ts
var at = (seconds) => new Date(seconds * 1e3);
var orderIn = (db, id, status) => exists(db.select({ one: sql2`1` }).from(orders).where(and3(eq3(orders.id, id), eq3(orders.status, status))));
var PARKED_CHECKOUT_MESSAGE = "The store is reviewing the payment for this checkout. Contact the store to release it.";
async function discardCheckoutDiscount(adapter, orderId) {
  if (!adapter?.discardCheckoutDiscount) return;
  try {
    await adapter.discardCheckoutDiscount(orderId);
  } catch (error) {
    console.warn("[commerce] Checkout discount could not be discarded", {
      provider: adapter.providerId,
      name: error instanceof Error ? error.name : typeof error,
      code: typeof error?.code === "string" ? error.code : void 0
    });
  }
}
async function findOrder(ctx, id) {
  const { db } = ctx;
  const order = await db.select().from(orders).where(eq3(orders.id, id)).get();
  if (!order) return null;
  return order;
}
async function findOrderForSession(ctx, id, sessionToken, customerId) {
  const { db } = ctx;
  const order = await findOrder(ctx, id);
  if (!order?.cartId) return null;
  if (customerId && order.userId === customerId) return order;
  if (!sessionToken) return null;
  const cart = await db.select().from(carts).where(eq3(carts.id, order.cartId)).get();
  return cart?.sessionToken === sessionToken ? order : null;
}
async function createOrder(ctx, data) {
  const { env, db } = ctx;
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
    currency: data.currency || readStoreSettings(env).currency,
    customerEmail: data.customerEmail,
    items: data.items,
    shippingAddress: data.shippingAddress,
    billingAddress: data.billingAddress,
    createdAt: now,
    updatedAt: now
  });
  return await findOrder(ctx, orderId);
}
async function updateOrderStatus(ctx, id, status, fulfillment) {
  const { env } = ctx;
  if (status !== "fulfilled") throw new Error("Use the payment or cancellation workflow to change order status");
  const order = await findOrder(ctx, id);
  if (order?.paymentProvider === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  if (!fulfillment) throw new Error("Audited fulfillment details are required");
  await fulfillCommerceOrder(env, fulfillment.actor, {
    orderId: id,
    carrier: fulfillment.carrier,
    trackingNumber: fulfillment.trackingNumber,
    note: fulfillment.note
  });
  return await findOrder(ctx, id);
}
async function finalizeOrderPayment(ctx, params) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const order = await db.select().from(orders).where(eq3(orders.id, params.orderId)).get();
  if (!order) {
    throw new Error(`Order not found: ${params.orderId}`);
  }
  if (params.paymentStatus !== "success") {
    throw new Error("Payment has not succeeded");
  }
  if (order.checkoutSessionId !== params.providerId || (order.paymentProvider ?? "stripe") !== params.provider) {
    throw new WebhookMismatchError("session_mismatch", "Payment provider or session does not match order");
  }
  if (params.amount !== void 0 && params.amount !== order.totalAmount) {
    throw new WebhookMismatchError("amount_mismatch", "Payment amount does not match order total");
  }
  if (params.currency && params.currency.toLowerCase() !== order.currency.toLowerCase()) {
    throw new WebhookMismatchError("currency_mismatch", "Payment currency does not match order");
  }
  if (PURCHASED_ORDER_STATUSES.includes(order.status)) {
    return { success: true, orderId: params.orderId, status: order.status, duplicate: true };
  }
  if (order.status === "cancelled") {
    throw new WebhookMismatchError("order_cancelled", "Cancelled order cannot be paid");
  }
  const timestamp = Math.floor(Date.now() / 1e3);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const providerEmail = params.customerEmail?.trim() ?? "";
  const email = emailPattern.test(providerEmail) ? providerEmail : (order.customerEmail || "").trim();
  const normalizedEmail = email.toLowerCase();
  const newAccountId = !order.userId && params.provider !== "admin_test" && emailPattern.test(normalizedEmail) ? `acct_${order.id}` : null;
  const accountName = typeof order.shippingAddress?.name === "string" ? order.shippingAddress.name.trim().slice(0, 160) : null;
  const paid = orderIn(db, params.orderId, "paid");
  const paidBySession = exists(db.select({ one: sql2`1` }).from(orders).where(and3(
    eq3(orders.id, params.orderId),
    eq3(orders.status, "paid"),
    eq3(orders.checkoutSessionId, params.providerId)
  )));
  const statements = [
    db.update(orders).set({ status: "paid", updatedAt: at(timestamp), customerEmail: email, paymentIntentId: params.paymentIntentId ?? null }).where(and3(
      eq3(orders.id, params.orderId),
      eq3(orders.status, "pending"),
      eq3(orders.checkoutSessionId, params.providerId),
      eq3(orders.totalAmount, order.totalAmount)
    ))
  ];
  if (newAccountId) {
    statements.push(db.run(sql2`INSERT INTO _ecommerce_customer_accounts
      (id, email, email_normalized, name, created_at, updated_at)
      SELECT ${newAccountId}, ${email}, ${normalizedEmail}, ${accountName}, ${timestamp}, ${timestamp} FROM _ecommerce_orders
      WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
      ON CONFLICT(email_normalized) DO NOTHING`));
    const accountId = db.select({ id: customerAccounts.id }).from(customerAccounts).where(eq3(customerAccounts.emailNormalized, normalizedEmail));
    statements.push(db.update(orders).set({ userId: sql2`(${accountId})` }).where(and3(eq3(orders.id, params.orderId), eq3(orders.status, "paid"), isNull3(orders.userId))));
  }
  if (order.referralCode && order.referralRewardCents > 0 && params.provider !== "admin_test") {
    const policy = await getReferralPolicy(env);
    const referrer = await db.select({ emailNormalized: customerAccounts.emailNormalized }).from(referralCodes).innerJoin(customerAccounts, eq3(customerAccounts.id, referralCodes.accountId)).where(eq3(referralCodes.code, order.referralCode)).get();
    const buyerAccount = order.userId ? await db.select({ emailNormalized: customerAccounts.emailNormalized }).from(customerAccounts).where(eq3(customerAccounts.id, order.userId)).get() : void 0;
    const checkoutEmail = (order.customerEmail || "").trim().toLowerCase();
    const buyerCanonicals = canonicalEmails([checkoutEmail, normalizedEmail, buyerAccount?.emailNormalized]);
    const referrerCanonical = canonicalEmail(referrer?.emailNormalized);
    if (referrerCanonical && buyerCanonicals.length && !buyerCanonicals.includes(referrerCanonical)) {
      const purchased = sql2.raw(PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(", "));
      statements.push(db.run(sql2`INSERT INTO _ecommerce_referrals
        (id, code, referrer_account_id, referred_account_id, order_id, reward_cents, currency, status, created_at, updated_at)
        SELECT ${`ref_${order.id}`}, rc.code, rc.account_id, o.user_id, o.id, ${order.referralRewardCents}, o.currency, 'approved', ${timestamp}, ${timestamp}
        FROM _ecommerce_orders o
        JOIN _ecommerce_referral_codes rc ON rc.code = o.referral_code
        JOIN _ecommerce_customer_accounts referrer ON referrer.id = rc.account_id
        JOIN _ecommerce_customer_accounts buyer ON buyer.id = o.user_id
        WHERE o.id = ${params.orderId} AND o.status = 'paid' AND rc.account_id <> o.user_id
          AND referrer.email_normalized NOT IN (${normalizedEmail}, ${checkoutEmail}, buyer.email_normalized)
          AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders prior
            WHERE prior.id <> o.id AND prior.status IN (${purchased})
              AND COALESCE(prior.payment_provider, 'stripe') <> 'admin_test'
              AND (prior.user_id = o.user_id OR lower(prior.customer_email) IN (${normalizedEmail}, ${checkoutEmail}, buyer.email_normalized)
                OR prior.user_id IN (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized IN (${normalizedEmail}, ${checkoutEmail}))))
          AND NOT ${canonicalPurchase(buyerCanonicals, params.orderId)}
          AND (SELECT COUNT(*) FROM _ecommerce_referrals recent
            JOIN _ecommerce_customer_accounts recent_referrer ON recent_referrer.id = recent.referrer_account_id
            WHERE recent.status = 'approved' AND recent.created_at > ${timestamp - policy.periodDays * 24 * 60 * 60}
              AND (recent.referrer_account_id = rc.account_id
                OR ${sql2.raw(canonicalEmailSql("recent_referrer.email_normalized"))} = ${referrerCanonical})) < ${policy.maxPerPeriod}
        ON CONFLICT DO NOTHING`));
    }
  }
  statements.push(
    db.update(discountRedemptions).set({ status: "confirmed", updatedAt: at(timestamp) }).where(and3(eq3(discountRedemptions.orderId, params.orderId), eq3(discountRedemptions.status, "reserved"), paid)),
    db.update(giftCardRedemptions).set({ status: "confirmed", updatedAt: at(timestamp) }).where(and3(eq3(giftCardRedemptions.orderId, params.orderId), eq3(giftCardRedemptions.status, "reserved"), paid)),
    db.run(sql2`INSERT INTO _ecommerce_payments
      (id, order_id, provider, provider_id, status, amount, created_at)
      SELECT ${`pay_${crypto.randomUUID()}`}, id, ${params.provider}, ${params.providerId}, 'success', total_amount, ${timestamp} FROM _ecommerce_orders
      WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
      ON CONFLICT(provider, provider_id) DO NOTHING`)
  );
  if (order.cartId) {
    const buyer = db.select({ userId: orders.userId }).from(orders).where(eq3(orders.id, params.orderId));
    statements.push(db.update(carts).set({ closed: true, closedAt: at(timestamp), updatedAt: at(timestamp), userId: sql2`COALESCE(${carts.userId}, (${buyer}))` }).where(and3(eq3(carts.id, order.cartId), paidBySession)));
  }
  const confirms = params.provider !== "admin_test";
  if (confirms) {
    statements.push(db.run(commerceEmailStatement(
      "order_confirmation",
      params.orderId,
      timestamp,
      sql2`EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
        AND COALESCE(payment_provider, 'stripe') <> 'admin_test')`
    )));
  }
  await commitBatch(db, statements);
  const current = await db.select().from(orders).where(eq3(orders.id, params.orderId)).get();
  if (current?.status !== "paid") throw new Error("Order is no longer pending");
  if (current.taxCalculationId && !current.taxTransactionId) {
    await recordConfirmedOrderTax(env, paymentAdapters, params.orderId);
  }
  if (confirms) await deliverCommerceEmail(env, "order_confirmation", params.orderId);
  return { success: true, orderId: params.orderId, status: "paid" };
}
async function recordProviderRefund(ctx, params) {
  const { env, db } = ctx;
  const order = await db.select().from(orders).where(eq3(orders.paymentIntentId, params.paymentIntentId)).get();
  if (!order) return null;
  if (order.paymentProvider !== "stripe" || order.totalAmount !== params.amount || order.currency.toLowerCase() !== String(params.currency).toLowerCase() || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > order.totalAmount) {
    throw new WebhookMismatchError("refund_mismatch", "Refund does not match order payment");
  }
  if (params.amountRefunded <= order.providerRefundedCents) {
    return { success: true, orderId: order.id, duplicate: true };
  }
  const now = Math.floor(Date.now() / 1e3);
  const full = params.amountRefunded === order.totalAmount;
  const referralPolicy = order.referralCode ? await getReferralPolicy(env) : null;
  const refundable = sql2`id = ${order.id} AND payment_intent_id = ${params.paymentIntentId} AND provider_refunded_cents < ${params.amountRefunded}
    AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')`;
  const statements = [
    // First the part of the total that this event adds, read from the stored total under the guard
    // of the update below: a retried or out-of-order event adds no row, and the rows add up to the total.
    db.run(sql2`INSERT INTO _ecommerce_provider_refunds
      (id, order_id, provider, provider_refund_id, amount_cents, created_at)
      SELECT ${`prf_${order.id}_${params.amountRefunded}`}, id, 'stripe', ${params.providerRefundId ?? null}, ${params.amountRefunded} - provider_refunded_cents, ${params.refundedAt ?? now}
      FROM _ecommerce_orders WHERE ${refundable}
      ON CONFLICT(id) DO NOTHING`),
    // A dispute keeps the order disputed; closing it applies the refund status.
    db.update(orders).set({
      providerRefundedCents: params.amountRefunded,
      updatedAt: at(now),
      status: sql2`CASE WHEN ${orders.status} = 'disputed' THEN ${orders.status} ELSE ${full ? "refunded" : "partially_refunded"} END`
    }).where(refundable),
    // The payment shows the refund, taken from the amounts while the order is disputed.
    db.run(sql2`UPDATE _ecommerce_payments
      SET status = COALESCE((SELECT CASE WHEN o.status IN ('partially_refunded', 'refunded') THEN o.status
          WHEN o.provider_refunded_cents >= o.total_amount THEN 'refunded'
          WHEN o.provider_refunded_cents > 0 THEN 'partially_refunded' END
        FROM _ecommerce_orders o WHERE o.id = ${order.id}), status)
      WHERE order_id = ${order.id} AND provider = 'stripe'`)
  ];
  if (full) statements.push(...fullRefundStatements(order.id, now).map((statement) => db.run(statement)));
  if (referralPolicy) {
    statements.push(...referralReversalStatements(order.id, { minOrderCents: referralPolicy.minOrderCents, now }).map((statement) => db.run(statement)));
  }
  await commitBatch(db, statements);
  return {
    success: true,
    orderId: order.id,
    status: order.status === "disputed" ? "disputed" : full ? "refunded" : "partially_refunded"
  };
}
async function cancelOrder(ctx, id, options = {}) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const order = await db.select().from(orders).where(eq3(orders.id, id)).get();
  if (!order) return null;
  if (PURCHASED_ORDER_STATUSES.includes(order.status)) return order;
  const timestamp = Math.floor(Date.now() / 1e3);
  if (order.status === "cancelled") return order;
  if (order.reconcileReviewAt && !options.sessionExpired && !options.reviewRelease) {
    throw new Error(PARKED_CHECKOUT_MESSAGE);
  }
  const reservations = await db.select().from(componentReservations).where(eq3(componentReservations.orderId, id));
  const inventoryReservations2 = await db.select().from(inventoryReservations).where(eq3(inventoryReservations.orderId, id));
  const otherModeSession = (order.paymentProvider ?? "stripe") === "stripe" && isOtherStripeModeSession(env, order.checkoutSessionId);
  let paymentReturned = null;
  if (order.checkoutSessionId && !options.sessionExpired && order.paymentProvider !== "admin_test") {
    const adapter = paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe"));
    if (!adapter?.expireCheckoutSession) {
      throw new Error("Payment provider must expire the checkout session before stock can be released");
    }
    if (otherModeSession && !options.reviewRelease) throw new Error(PARKED_CHECKOUT_MESSAGE);
    const refuseUnchecked = () => {
      const refusal = uncheckedSessionRefusal(Math.floor(order.createdAt.getTime() / 1e3));
      if (refusal) throw refusal;
    };
    if (otherModeSession) refuseUnchecked();
    if (!otherModeSession) {
      if (options.limitProviderChecks && !await mayAskPaymentProvider(env, order, paymentAdapters)) {
        throw new ProviderCheckLimitedError();
      }
      let session;
      let missing = false;
      try {
        session = await adapter.getCheckoutSession?.(order.checkoutSessionId);
      } catch (error) {
        if (!options.reviewRelease || !isMissingSessionError(error)) throw error;
        missing = true;
        refuseUnchecked();
      }
      if (session?.status === "complete") {
        if (!options.reviewRelease) {
          throw new Error("Payment has completed; wait for confirmation before changing the basket");
        }
        paymentReturned = await completedCheckoutReturn(adapter, session, options.reviewRelease.confirmPaymentReturned);
      } else if (!missing && session?.status !== "expired") {
        await adapter.expireCheckoutSession(order.checkoutSessionId);
      }
    }
  }
  const released = orderIn(db, id, "cancelled");
  const statements = [
    db.update(orders).set({ status: "cancelled", updatedAt: at(timestamp) }).where(and3(eq3(orders.id, id), notInArray(orders.status, [...PURCHASED_ORDER_STATUSES]))),
    db.update(discountRedemptions).set({ status: "cancelled", updatedAt: at(timestamp) }).where(and3(eq3(discountRedemptions.orderId, id), eq3(discountRedemptions.status, "reserved"), released)),
    db.update(giftCardRedemptions).set({ status: "cancelled", updatedAt: at(timestamp) }).where(and3(eq3(giftCardRedemptions.orderId, id), eq3(giftCardRedemptions.status, "reserved"), released))
  ];
  if (order.creditApplied > 0) {
    statements.push(db.run(sql2`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ${`credit_release_${id}`}, user_id, id, 'checkout_release', credit_applied, ${timestamp}
      FROM _ecommerce_orders WHERE id = ${id} AND status = 'cancelled' AND user_id IS NOT NULL
      ON CONFLICT(order_id, kind) DO NOTHING`));
  }
  for (const reservation of reservations) {
    statements.push(db.run(sql2`UPDATE _ecommerce_components
      SET quantity = quantity + (SELECT quantity FROM _ecommerce_component_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL), updated_at = MAX(updated_at + 1, ${timestamp})
      WHERE id = ${reservation.componentId} AND EXISTS (SELECT 1 FROM _ecommerce_component_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL)
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${id} AND status = 'cancelled')`));
    statements.push(db.update(componentReservations).set({ releasedAt: at(timestamp) }).where(and3(eq3(componentReservations.id, reservation.id), isNull3(componentReservations.releasedAt), released)));
  }
  for (const reservation of inventoryReservations2) {
    const [table, column] = INVENTORY_COLUMNS[reservation.targetType];
    statements.push(db.run(sql2`UPDATE ${sql2.raw(table)}
      SET ${sql2.raw(column)} = ${sql2.raw(column)} + (SELECT quantity FROM _ecommerce_inventory_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL), updated_at = MAX(updated_at + 1, ${timestamp})
      WHERE id = ${reservation.targetId} AND EXISTS (SELECT 1 FROM _ecommerce_inventory_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL)
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${id} AND status = 'cancelled')`));
    statements.push(db.update(inventoryReservations).set({ releasedAt: at(timestamp) }).where(and3(eq3(inventoryReservations.id, reservation.id), isNull3(inventoryReservations.releasedAt), released)));
  }
  if (order.cartId) {
    statements.push(db.update(carts).set({ checkoutSessionId: null, updatedAt: at(timestamp) }).where(and3(eq3(carts.id, order.cartId), released)));
    statements.push(db.update(orders).set({ cartId: null }).where(and3(eq3(orders.id, id), eq3(orders.status, "cancelled"))));
  }
  if (options.reviewRelease) {
    const { decision } = options.reviewRelease;
    statements.push(db.run(decisionInsert(
      "order",
      "release",
      sql2`status = 'cancelled'`,
      { id: decision.id, paymentReturned, actor: decision.actor, reason: decision.reason, at: timestamp, recordId: id }
    )));
  }
  await commitBatch(db, statements);
  const cancelled = await findOrder(ctx, id);
  if (cancelled?.status === "cancelled" && !otherModeSession && order.creditApplied + order.discountAmount + order.giftCardApplied > 0) {
    await discardCheckoutDiscount(
      paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe")),
      id
    );
  }
  return cancelled;
}

// src/shipping.ts
function shippingOptionsFor(settings, country, itemsAmount) {
  return ratesServing(settings, country).map((rate) => ({
    id: rate.id,
    label: rate.label,
    amount: shippingCharge(rate, itemsAmount),
    description: deliveryEstimate(rate),
    freeOver: rate.freeOver,
    minDays: rate.minDays,
    maxDays: rate.maxDays
  }));
}
function ratesServing(settings, country) {
  const code = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (!isCountryCode(code) || settings.deliveryCountries && !settings.deliveryCountries.includes(code)) return [];
  return settings.shippingRates.filter((rate) => !rate.countries || rate.countries.includes(code));
}
function chooseShippingRate(settings, country, chosenId) {
  const serving = ratesServing(settings, country);
  if (!serving.length) throw new Error(UNDELIVERABLE_COUNTRY);
  const chosen = chosenId?.trim();
  const rate = chosen ? serving.find((candidate) => candidate.id === chosen) : serving[0];
  if (!rate) throw new Error(SHIPPING_OPTION_UNAVAILABLE);
  return rate;
}
function shippingCharge(rate, itemsAmount) {
  return rate.freeOver !== null && itemsAmount >= rate.freeOver ? 0 : rate.amount;
}
function deliveryEstimate(rate) {
  const days = (count) => `${count} business day${count === 1 ? "" : "s"}`;
  const { minDays, maxDays } = rate;
  if (minDays !== null && maxDays !== null) {
    return `Delivery in ${minDays === maxDays ? days(maxDays) : `${minDays}\u2013${days(maxDays)}`}`;
  }
  if (maxDays !== null) return `Delivery in up to ${days(maxDays)}`;
  if (minDays !== null) return `Delivery in at least ${days(minDays)}`;
  return null;
}

// src/checkout.ts
var reservationRows = (list) => sql3`SELECT json_extract(value, '$.target') AS target, json_extract(value, '$.amount') AS amount
  FROM json_each(${list})`;
async function createOrderFromCart(ctx, cartId, options) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const settings = readStoreSettings(env);
  const { currency, deliveryCountries } = settings;
  const cart = await db.select().from(carts).where(eq4(carts.id, cartId)).get();
  if (!cart || cart.items.length === 0) {
    throw new Error("Cart is empty or not found");
  }
  if (cart.closed) {
    throw new Error("Cart is closed");
  }
  if (cart.checkoutSessionId) {
    throw new Error("Checkout already started for this cart");
  }
  const defaultAdapter = options.providerId ? paymentAdapters.find((adapter) => adapter.providerId === options.providerId) : paymentAdapters.length === 1 && paymentAdapters[0].providerId !== "admin_test" ? paymentAdapters[0] : void 0;
  if (!defaultAdapter) throw new Error("A payment provider must be selected and configured before checkout");
  let requiresShipping = false;
  let totalAmount = 0;
  const orderItems = [];
  const componentItems = [];
  const inventoryDemand = /* @__PURE__ */ new Map();
  const catalog = await loadBasketCatalog(ctx, cart.items);
  for (const item of cart.items) {
    const product = catalog.products.get(String(item.productId));
    if (!product) {
      throw new Error(`Product not found: ${item.productId}`);
    }
    if (product.status !== "active") {
      throw new Error(`Product is not available: ${item.productId}`);
    }
    requireVariantChoice(catalog, product, item.variantId);
    let price = product.basePrice;
    let finalName = product.name;
    let availableQuantity = product.inventoryQuantity;
    let requiredComponents = [];
    let inventoryTarget = { type: "product", id: product.id };
    if (item.variantId) {
      const selectedVariant = resolveSelectedVariant(catalog, product, item.variantId);
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
  if (requiresShipping && (!options.shippingAddress || !["name", "line1", "city", "postalCode", "country"].every((key) => typeof options.shippingAddress[key] === "string" && options.shippingAddress[key].trim()))) {
    throw new Error("Shipping address is required for physical products");
  }
  const shippingAddress = withCountryCode(options.shippingAddress);
  const billingAddress = withCountryCode(options.billingAddress);
  if (requiresShipping && deliveryCountries && !deliveryCountries.includes(shippingAddress.country)) {
    throw new Error(UNDELIVERABLE_COUNTRY);
  }
  const shippingRate = requiresShipping && settings.shippingRates.length ? chooseShippingRate(settings, shippingAddress.country, options.shippingRateId) : null;
  const taxBehavior = settings.tax.mode === "none" || defaultAdapter.providerId === "admin_test" ? null : settings.tax.mode === "stripe-inclusive" ? "inclusive" : "exclusive";
  const taxAddress = taxBehavior ? taxAddressFor(requiresShipping, shippingAddress, billingAddress) : null;
  const orderId = `ord_${crypto.randomUUID()}`;
  const referralsPolicy = await getReferralPolicy(env);
  const subtotalAmount = totalAmount;
  const discount = options.discountCode && defaultAdapter.providerId === "stripe" ? await evaluateDiscountCode(env, {
    code: options.discountCode,
    customerEmail: options.customerEmail,
    accountId: cart.userId,
    lines: orderItems,
    subtotal: subtotalAmount
  }) : null;
  const discountAmount = discount?.amount ?? 0;
  const merchandise = subtotalAmount - discountAmount;
  const shippingAmount = shippingRate ? shippingCharge(shippingRate, merchandise) : 0;
  let creditApplied = 0;
  const owner = cart.userId ? await db.select({
    creditBalance: customerAccounts.creditBalance,
    emailNormalized: customerAccounts.emailNormalized
  }).from(customerAccounts).where(eq4(customerAccounts.id, cart.userId)).get() : void 0;
  if (owner && defaultAdapter.providerId === "stripe") {
    creditApplied = Math.min(
      Math.max(0, owner.creditBalance),
      merchandise,
      Math.max(0, merchandise + shippingAmount - minimumChargeAmount(currency))
    );
  }
  const tax = taxBehavior && taxAddress ? await calculateOrderTax(defaultAdapter, {
    cartId,
    currency,
    behavior: taxBehavior,
    settings: settings.tax,
    shippingAmount,
    ...taxAddress,
    lines: taxableLines(
      orderItems,
      { amount: discountAmount, productIds: discount?.eligibleProductIds ?? [] },
      creditApplied
    )
  }) : null;
  const exclusiveTax = tax?.behavior === "exclusive" ? tax.amount : 0;
  const amountDue = merchandise - creditApplied + shippingAmount + exclusiveTax;
  if (!Number.isSafeInteger(amountDue)) throw new Error("Order total is too large");
  const giftCard = options.giftCardCode && defaultAdapter.providerId === "stripe" ? await evaluateGiftCard(env, options.giftCardCode, amountDue) : null;
  const giftCardApplied = giftCard?.amount ?? 0;
  totalAmount = amountDue - giftCardApplied;
  const internallyPaid = Boolean(giftCard && totalAmount === 0);
  let referralCode = null;
  if (referralsPolicy.enabled && options.referralCode && defaultAdapter.providerId === "stripe" && !internallyPaid && subtotalAmount - discountAmount >= referralsPolicy.minOrderCents) {
    const referral = await findReferralCode(env, options.referralCode);
    const buyerEmails = [options.customerEmail.trim().toLowerCase(), owner?.emailNormalized];
    const referrerCanonical = canonicalEmail(referral?.emailNormalized);
    if (referral && referrerCanonical && referral.accountId !== cart.userId && !buyerEmails.includes(referral.emailNormalized) && !canonicalEmails(buyerEmails).includes(referrerCanonical) && !await hasPurchaseHistory(env, { emails: buyerEmails, accountIds: [cart.userId] }) && !await hasCanonicalPurchase(env, buyerEmails)) {
      referralCode = referral.code;
    }
  }
  if (!defaultAdapter.expireCheckoutSession) {
    throw new Error("Payment provider must support checkout session expiry");
  }
  const successUrl = options.successUrl.replaceAll("{ORDER_ID}", orderId);
  const cancelUrl = options.cancelUrl.replaceAll("{ORDER_ID}", orderId);
  const now = /* @__PURE__ */ new Date();
  const timestamp = Math.floor(now.getTime() / 1e3);
  const preparationLock = `preparing:${orderId}`;
  const lock = await db.update(carts).set({ checkoutSessionId: preparationLock, updatedAt: now, version: sql3`${carts.version} + 1` }).where(and4(
    eq4(carts.id, cartId),
    eq4(carts.closed, false),
    isNull4(carts.checkoutSessionId),
    eq4(carts.items, cart.items),
    eq4(carts.version, cart.version)
  )).returning({ id: carts.id });
  if (!lock.length) throw new Error("Checkout already started for this cart");
  let session;
  let committed = false;
  let providerDiscount = false;
  try {
    providerDiscount = !internallyPaid && creditApplied + discountAmount + giftCardApplied > 0;
    session = internallyPaid ? { providerSessionId: `internal:${orderId}`, url: successUrl } : await defaultAdapter.createCheckoutSession({
      orderId,
      currency,
      items: orderItems.map((i) => ({
        name: i.name,
        priceCents: i.priceAtPurchase,
        quantity: i.quantity
      })),
      customerEmail: options.customerEmail,
      creditApplied,
      discountApplied: discountAmount,
      giftCardApplied,
      shipping: shippingRate ? {
        label: shippingRate.label,
        amount: shippingAmount,
        description: deliveryEstimate(shippingRate) ?? void 0
      } : void 0,
      tax: exclusiveTax > 0 ? { amount: exclusiveTax } : void 0,
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
      db.insert(orders).values({
        id: orderId,
        cartId,
        userId: cart.userId,
        checkoutSessionId,
        paymentProvider: internallyPaid ? "gift_card" : defaultAdapter.providerId,
        status: "pending",
        items: orderItems.map(({ name, ...rest }) => rest),
        totalAmount,
        subtotalAmount,
        creditApplied,
        discountCode: discount?.code ?? null,
        discountAmount,
        giftCardId: giftCard?.id ?? null,
        giftCardApplied,
        referralCode,
        referralRewardCents: referralCode ? referralsPolicy.rewardCents : 0,
        currency,
        shippingAmount,
        shippingRateId: shippingRate?.id ?? null,
        shippingLabel: shippingRate?.label ?? null,
        taxAmount: tax?.amount ?? 0,
        taxBehavior: tax?.behavior ?? null,
        taxCalculationId: tax?.calculationId ?? null,
        customerEmail: options.customerEmail,
        shippingAddress: shippingAddress ?? null,
        billingAddress: billingAddress ?? null,
        createdAt: now,
        updatedAt: now
      })
    ];
    if (discount) {
      statements.push(db.insert(discountRedemptions).values({
        id: `dred_${orderId}`,
        code: discount.code,
        orderId,
        accountId: cart.userId,
        emailNormalized: discount.emailNormalized,
        amountCents: discount.amount,
        status: "reserved",
        createdAt: now,
        updatedAt: now
      }));
    }
    if (giftCard) {
      statements.push(db.insert(giftCardRedemptions).values({
        id: `gcr_${orderId}`,
        cardId: giftCard.id,
        orderId,
        amountCents: giftCardApplied,
        status: "reserved",
        createdAt: now,
        updatedAt: now
      }));
    }
    if (creditApplied && cart.userId) {
      statements.push(db.insert(creditLedger).values({
        id: `credit_hold_${orderId}`,
        accountId: cart.userId,
        orderId,
        kind: "checkout_reserve",
        amountCents: -creditApplied,
        createdAt: now
      }));
    }
    const reserves = defaultAdapter.reservesInventory !== false;
    const componentReservations2 = reserves ? [...componentDemand].map(([target, demand]) => ({ id: crypto.randomUUID(), target, amount: demand.quantity })) : [];
    if (componentReservations2.length) {
      const list = JSON.stringify(componentReservations2);
      statements.push(db.run(sql3`UPDATE _ecommerce_components
      SET quantity = quantity - demand.amount, updated_at = MAX(updated_at + 1, ${timestamp})
      FROM (${reservationRows(list)}) AS demand WHERE _ecommerce_components.id = demand.target`));
      statements.push(db.run(sql3`INSERT INTO _ecommerce_component_reservations
      (id, order_id, component_id, quantity)
      SELECT json_extract(value, '$.id'), ${orderId}, json_extract(value, '$.target'), json_extract(value, '$.amount')
      FROM json_each(${list})`));
    }
    const inventoryReservations2 = reserves ? [...inventoryDemand.values()].map((demand) => ({ id: crypto.randomUUID(), type: demand.type, target: demand.id, amount: demand.quantity })) : [];
    for (const [type, [table, column]] of Object.entries(INVENTORY_COLUMNS)) {
      const list = inventoryReservations2.filter((reservation) => reservation.type === type);
      if (!list.length) continue;
      statements.push(db.run(sql3`UPDATE ${sql3.raw(table)}
      SET ${sql3.raw(column)} = ${sql3.raw(column)} - demand.amount, updated_at = MAX(updated_at + 1, ${timestamp})
      FROM (${reservationRows(JSON.stringify(list))}) AS demand WHERE ${sql3.raw(table)}.id = demand.target`));
    }
    if (inventoryReservations2.length) {
      statements.push(db.run(sql3`INSERT INTO _ecommerce_inventory_reservations
      (id, order_id, target_type, target_id, quantity)
      SELECT json_extract(value, '$.id'), ${orderId}, json_extract(value, '$.type'), json_extract(value, '$.target'),
        json_extract(value, '$.amount')
      FROM json_each(${JSON.stringify(inventoryReservations2)})`));
    }
    statements.push(db.update(carts).set({ checkoutSessionId, updatedAt: now }).where(and4(eq4(carts.id, cartId), eq4(carts.checkoutSessionId, preparationLock))));
    try {
      await commitBatch(db, statements);
      committed = true;
    } catch (cause) {
      const refused = errorText(cause);
      if (refused.includes("Discount code is no longer available")) {
        throw new Error("Discount code is no longer available", { cause });
      }
      if (refused.includes("Insufficient store credit")) {
        throw new Error("Store credit changed during checkout; please try again", { cause });
      }
      if (refused.includes("Gift card is no longer available")) {
        throw new Error("Gift card is no longer available", { cause });
      }
      throw new Error("Insufficient stock or checkout already started", { cause });
    }
    const order = await findOrder(ctx, orderId);
    if (!order) throw new Error("Checkout was created but the order could not be loaded");
    if (internallyPaid) {
      await finalizeOrderPayment(ctx, {
        orderId,
        provider: "gift_card",
        providerId: checkoutSessionId,
        paymentStatus: "success",
        amount: 0,
        customerEmail: options.customerEmail
      });
      return { order: await findOrder(ctx, orderId), paymentUrl: session.url };
    }
    return { order, paymentUrl: session.url };
  } catch (error) {
    if (committed) throw error;
    try {
      if (session?.providerSessionId && !internallyPaid) {
        await defaultAdapter.expireCheckoutSession(session.providerSessionId);
      }
    } finally {
      if (providerDiscount) await discardCheckoutDiscount(defaultAdapter, orderId);
    }
    await db.update(carts).set({ checkoutSessionId: null }).where(and4(eq4(carts.id, cartId), eq4(carts.checkoutSessionId, preparationLock)));
    throw error;
  }
}
async function resumeCheckout(ctx, cartId, options = {}) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const cart = await db.select().from(carts).where(eq4(carts.id, cartId)).get();
  if (!cart?.checkoutSessionId) return null;
  if (cart.checkoutSessionId.startsWith("preparing:")) {
    const nowSeconds = Math.floor(Date.now() / 1e3);
    const cutoff = nowSeconds - 35 * 60;
    const pendingOrder = db.select({ one: sql3`1` }).from(orders).where(and4(eq4(orders.cartId, carts.id), eq4(orders.status, "pending")));
    await db.update(carts).set({ checkoutSessionId: null, updatedAt: new Date(nowSeconds * 1e3), version: sql3`${carts.version} + 1` }).where(and4(
      eq4(carts.id, cartId),
      eq4(carts.checkoutSessionId, cart.checkoutSessionId),
      lt(carts.updatedAt, new Date(cutoff * 1e3)),
      notExists(pendingOrder)
    ));
    return null;
  }
  const order = await db.select().from(orders).where(eq4(orders.checkoutSessionId, cart.checkoutSessionId)).get();
  if (!order || order.status !== "pending") return null;
  if (order.paymentProvider === "gift_card" && order.totalAmount === 0) {
    await finalizeOrderPayment(ctx, {
      orderId: order.id,
      provider: "gift_card",
      providerId: order.checkoutSessionId,
      paymentStatus: "success",
      amount: 0,
      customerEmail: order.customerEmail ?? void 0
    });
    return { order: await findOrder(ctx, order.id), paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
  }
  if (order.reconcileReviewAt) return { order, paymentUrl: null, review: true };
  if (options.limitProviderChecks && !await mayAskPaymentProvider(env, order, paymentAdapters)) {
    return { order, paymentUrl: null, providerCheckLimited: true };
  }
  let reconciled;
  try {
    reconciled = await reconcilePendingOrder(ctx, order.id);
  } catch (error) {
    if (reconcileFailure(error).permanent) return { order, paymentUrl: null, review: true };
    throw error;
  }
  if (reconciled?.status === "paid") {
    return { order: await findOrder(ctx, order.id), paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
  }
  if (reconciled?.status === "cancelled") return null;
  return { order, paymentUrl: reconciled?.paymentUrl ?? null };
}
async function reconcilePendingOrder(ctx, id) {
  const { env, adapters: paymentAdapters } = ctx;
  const order = await findOrder(ctx, id);
  if (!order || order.status !== "pending" || !order.checkoutSessionId) return null;
  if (order.paymentProvider === "gift_card") {
    await finalizeOrderPayment(ctx, {
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
    if (!paymentAdapters.some((candidate) => candidate.providerId === "admin_test")) {
      return { status: "pending", paymentUrl: null };
    }
    await finalizeOrderPayment(ctx, {
      orderId: order.id,
      provider: "admin_test",
      providerId: order.checkoutSessionId,
      paymentStatus: "success",
      amount: order.totalAmount,
      currency: order.currency
    });
    return { status: "paid", paymentUrl: null };
  }
  if (order.reconcileReviewAt) return { status: "pending", paymentUrl: null, review: true };
  const provider = order.paymentProvider ?? "stripe";
  const adapter = paymentAdapters.find((candidate) => candidate.providerId === provider);
  if (!adapter?.getCheckoutSession) {
    throw new ReconcileFailure("provider_not_configured", "Payment provider cannot reconcile checkout");
  }
  if (provider === "stripe") assertStoreStripeMode(env, order.checkoutSessionId);
  const session = await adapter.getCheckoutSession(order.checkoutSessionId).catch((error) => {
    throw sessionLookupFailure(error);
  });
  if (session.status === "expired") {
    await cancelOrder(ctx, id, { sessionExpired: true });
    return { status: "cancelled", paymentUrl: null };
  }
  if (session.status === "complete" && session.paymentStatus === "paid") {
    if (session.amountTotal !== order.totalAmount || session.currency?.toLowerCase() !== order.currency.toLowerCase() || provider === "stripe" && !session.paymentIntentId) {
      throw new ReconcileFailure("payment_mismatch", "Completed payment does not match pending order");
    }
    await finalizeOrderPayment(ctx, {
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
}

// src/stripe-events.ts
import { eq as eq6 } from "drizzle-orm";

// src/disputes.ts
import { eq as eq5, sql as sql4 } from "drizzle-orm";
function parseStripeDispute(data, eventTime) {
  const paymentIntentId = typeof data?.payment_intent === "string" ? data.payment_intent : data?.payment_intent?.id;
  if (typeof data?.id !== "string" || !data.id || typeof paymentIntentId !== "string" || !paymentIntentId) return null;
  return {
    id: data.id.slice(0, 255),
    paymentIntentId,
    amountCents: Number.isSafeInteger(data.amount) && data.amount >= 0 ? data.amount : 0,
    currency: typeof data.currency === "string" && data.currency ? data.currency.toLowerCase() : null,
    reason: typeof data.reason === "string" && data.reason ? data.reason.slice(0, 100) : null,
    status: typeof data.status === "string" && data.status ? data.status.slice(0, 100) : "unknown",
    createdAt: Number.isSafeInteger(data.created) && data.created > 0 ? data.created : eventTime
  };
}
var openBefore = (column) => `(SELECT d.status_before FROM _ecommerce_disputes d
  WHERE d.${column} = r.id AND d.closed_at IS NULL ORDER BY d.created_at, d.id LIMIT 1)`;
var RECORDS = {
  order: {
    column: "order_id",
    table: "_ecommerce_orders",
    statusBefore: `CASE WHEN r.status = 'disputed' THEN COALESCE(${openBefore("order_id")}, 'paid') ELSE r.status END`
  },
  purchase: {
    column: "gift_card_purchase_id",
    table: "_ecommerce_gift_card_purchases",
    statusBefore: `COALESCE(CASE WHEN r.status = 'review' THEN ${openBefore("gift_card_purchase_id")} END, r.status)`
  }
};
function recordStatement(dispute, record, times) {
  const { column, table, statusBefore } = RECORDS[record.kind];
  return sql4`INSERT INTO _ecommerce_disputes
    (id, provider, ${sql4.raw(column)}, amount_cents, currency, reason, status, status_before, created_at, updated_at, closed_at)
    SELECT ${dispute.id}, 'stripe', r.id, ${dispute.amountCents}, ${dispute.currency ?? record.currency}, ${dispute.reason}, ${dispute.status},
      ${sql4.raw(statusBefore)}, ${dispute.createdAt}, ${times.now}, ${times.closedAt}
    FROM ${sql4.raw(table)} r WHERE r.id = ${record.id}
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, amount_cents = excluded.amount_cents,
      currency = excluded.currency, reason = COALESCE(excluded.reason, _ecommerce_disputes.reason),
      updated_at = excluded.updated_at, closed_at = COALESCE(_ecommerce_disputes.closed_at, excluded.closed_at)
    WHERE excluded.closed_at IS NOT NULL AND _ecommerce_disputes.status <> 'lost'`;
}
async function referralStatements(env, order, now, disputeLost = false) {
  if (!order.referralCode) return [];
  const policy = await getReferralPolicy(env);
  return referralReversalStatements(order.id, { minOrderCents: policy.minOrderCents, now, disputeLost });
}
async function orderBatch(env, orderId, statements) {
  const db = commerceDb(env);
  const items = [
    ...statements.map((statement) => db.run(statement)),
    db.get(sql4`SELECT status FROM _ecommerce_orders WHERE id = ${orderId}`)
  ];
  const results = await db.batch(items);
  return results[results.length - 1]?.status ?? null;
}
async function openOrderDispute(env, order, dispute, now) {
  return orderBatch(env, order.id, [
    recordStatement(dispute, { kind: "order", id: order.id, currency: order.currency }, { closedAt: null, now }),
    sql4`UPDATE _ecommerce_orders SET status = 'disputed', updated_at = ${now}
      WHERE id = ${order.id} AND status IN ('paid', 'fulfilled', 'partially_refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${dispute.id} AND order_id = ${order.id} AND closed_at IS NULL)`
  ]);
}
async function settleLostOrderDispute(env, order, record, disputeId, now) {
  return orderBatch(env, order.id, [
    record,
    sql4`UPDATE _ecommerce_orders SET status = 'refunded', updated_at = ${now}
      WHERE id = ${order.id} AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${disputeId} AND order_id = ${order.id} AND status = 'lost')`,
    sql4`UPDATE _ecommerce_payments SET status = 'refunded'
      WHERE order_id = ${order.id} AND provider = 'stripe'
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${order.id} AND status = 'refunded')`,
    ...fullRefundStatements(order.id, now),
    ...await referralStatements(env, order, now, true)
  ]);
}
async function closeOrderDispute(env, order, dispute, closedAt, now) {
  const record = recordStatement(dispute, { kind: "order", id: order.id, currency: order.currency }, { closedAt, now });
  if (dispute.status === "lost") return settleLostOrderDispute(env, order, record, dispute.id, now);
  return orderBatch(env, order.id, [
    record,
    sql4`UPDATE _ecommerce_orders SET status = CASE
        WHEN total_amount > 0 AND provider_refunded_cents >= total_amount THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE (SELECT status_before FROM _ecommerce_disputes WHERE id = ${dispute.id}) END,
      updated_at = ${now}
      WHERE id = ${order.id} AND status = 'disputed'
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${dispute.id} AND order_id = ${order.id} AND status <> 'lost')
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE order_id = ${order.id} AND closed_at IS NULL)`,
    // The previous release copies the order's status onto its payment when it sees a refund, so a
    // rollback during the dispute can leave the payment 'disputed', which reports leave out.
    sql4`UPDATE _ecommerce_payments SET status = CASE o.status
        WHEN 'refunded' THEN 'refunded' WHEN 'partially_refunded' THEN 'partially_refunded' ELSE 'success' END
      FROM _ecommerce_orders o
      WHERE _ecommerce_payments.order_id = o.id AND o.id = ${order.id} AND o.status <> 'disputed'
        AND _ecommerce_payments.provider = 'stripe' AND _ecommerce_payments.status = 'disputed'`,
    ...fullRefundStatements(order.id, now),
    ...await referralStatements(env, order, now)
  ]);
}
async function openPurchaseDispute(env, purchase, dispute, now) {
  await runStatements(commerceDb(env), [
    recordStatement(dispute, { kind: "purchase", id: purchase.id, currency: purchase.currency }, { closedAt: null, now }),
    sql4`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ${now}
      WHERE id = ${purchase.id} AND status IN ('paid', 'partially_refunded', 'refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${dispute.id} AND gift_card_purchase_id = ${purchase.id} AND closed_at IS NULL)`,
    ...giftCardPurchaseHoldStatements(purchase.id, now)
  ]);
}
async function closePurchaseDispute(env, purchase, dispute, closedAt, now) {
  const db = commerceDb(env);
  const record = recordStatement(dispute, { kind: "purchase", id: purchase.id, currency: purchase.currency }, { closedAt, now });
  if (dispute.status === "lost") {
    await runStatements(db, [
      record,
      // Held first, so nothing more is spent from the cards while a checkout in progress delays the void.
      sql4`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ${now}
        WHERE id = ${purchase.id} AND status IN ('paid', 'partially_refunded', 'refunded')`,
      ...giftCardPurchaseHoldStatements(purchase.id, now),
      ...giftCardPurchaseChargebackStatements(purchase.id, now)
    ]);
    const current = await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases).where(eq5(giftCardPurchases.id, purchase.id)).get();
    if (current?.status === "review") {
      throw new WebhookRetryLaterError("A checkout in progress holds value on the disputed purchase's card; the lost dispute is applied once it completes or expires");
    }
    return;
  }
  await runStatements(db, [
    record,
    sql4`UPDATE _ecommerce_gift_card_purchases SET status = CASE
        WHEN provider_refunded_cents > refund_adjusted_cents THEN 'review'
        WHEN d.status_before IN ('paid', 'partially_refunded', 'refunded') THEN d.status_before
        WHEN provider_refunded_cents >= amount_cents THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE 'paid' END,
      updated_at = ${now}
      FROM (SELECT status_before FROM _ecommerce_disputes WHERE id = ${dispute.id} AND status <> 'lost') AS d
      WHERE id = ${purchase.id} AND status = 'review'
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE gift_card_purchase_id = ${purchase.id} AND closed_at IS NULL)`,
    ...giftCardPurchaseReleaseStatements(purchase.id, now)
  ]);
}
async function applyStripeDispute(env, dispute, options) {
  const db = commerceDb(env);
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  const order = await db.select({ id: orders.id, currency: orders.currency, referralCode: orders.referralCode }).from(orders).where(eq5(orders.paymentIntentId, dispute.paymentIntentId)).get();
  if (order) {
    const status = options.closed ? await closeOrderDispute(env, order, dispute, options.at, now) : await openOrderDispute(env, order, dispute, now);
    return { orderId: order.id, status };
  }
  const purchase = await db.select({ id: giftCardPurchases.id, currency: giftCardPurchases.currency }).from(giftCardPurchases).where(eq5(giftCardPurchases.paymentIntentId, dispute.paymentIntentId)).get();
  if (purchase) {
    if (options.closed) await closePurchaseDispute(env, purchase, dispute, options.at, now);
    else await openPurchaseDispute(env, purchase, dispute, now);
    return { purchaseId: purchase.id };
  }
  return null;
}

// src/stripe-events.ts
function ignoredEvent(event) {
  console.info("[commerce] Stripe event ignored", { type: event.type, id: event.id });
  return { success: true, event: event.type, ignored: true };
}
async function assertNoAwaitedPayment(ctx, references) {
  const { db } = ctx;
  const purchaseId = references?.giftCardPurchaseId || null;
  const orderId = purchaseId ? null : references?.orderId || null;
  const record = purchaseId ? await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases).where(eq6(giftCardPurchases.id, purchaseId)).get() : orderId ? await db.select({ status: orders.status }).from(orders).where(eq6(orders.id, orderId)).get() : void 0;
  if (!record || record.status === "cancelled" || record.status === "draft") return;
  if (record.status === "pending") {
    throw new WebhookRetryLaterError(`The ${purchaseId ? "gift card purchase" : "order"} this payment is for has no recorded payment yet`);
  }
  throw new WebhookMismatchError("payment_not_recorded", "The payment is not the one recorded for the store record it names");
}
async function applyStripeEvent(ctx, event, stripeAdapter) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const text = (value) => typeof value === "string" && value ? value : null;
  const at3 = Number.isSafeInteger(event.created) && event.created > 0 ? event.created : Math.floor(Date.now() / 1e3);
  if (event.type === "checkout.session.completed") {
    const session = event.data;
    if (session.payment_status !== "paid") return ignoredEvent(event);
    const purchaseId = text(session.metadata?.giftCardPurchaseId);
    if (purchaseId) {
      const purchase = await db.select({ id: giftCardPurchases.id }).from(giftCardPurchases).where(eq6(giftCardPurchases.id, purchaseId)).get();
      return purchase ? confirmGiftCardPurchase(env, session) : ignoredEvent(event);
    }
    const orderId = text(session.metadata?.orderId) ?? text(session.client_reference_id);
    const order = orderId ? await db.select({ id: orders.id }).from(orders).where(eq6(orders.id, orderId)).get() : void 0;
    if (!order) return ignoredEvent(event);
    return finalizeOrderPayment(ctx, {
      orderId: order.id,
      provider: "stripe",
      providerId: session.id,
      paymentStatus: "success",
      amount: session.amount_total || 0,
      currency: session.currency,
      paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : void 0,
      customerEmail: session.customer_details?.email || session.customer_email
    });
  }
  if (event.type === "checkout.session.expired") {
    const session = event.data;
    const purchaseId = text(session.metadata?.giftCardPurchaseId);
    if (purchaseId) {
      const purchase = await db.select({ id: giftCardPurchases.id }).from(giftCardPurchases).where(eq6(giftCardPurchases.id, purchaseId)).get();
      if (!purchase) return ignoredEvent(event);
      await expireGiftCardPurchase(env, purchaseId, session.id);
      return { success: true, event: event.type };
    }
    const orderId = text(session.metadata?.orderId) ?? text(session.client_reference_id);
    if (orderId) {
      const order = await db.select().from(orders).where(eq6(orders.id, orderId)).get();
      if (order?.checkoutSessionId === session.id) {
        const cancelled = await cancelOrder(ctx, orderId, { sessionExpired: true });
        return { success: true, event: event.type, cancelled: cancelled?.status === "cancelled" };
      }
      if (!order && orderId === text(session.metadata?.orderId) && orderId.startsWith("ord_")) {
        await discardCheckoutDiscount(stripeAdapter, orderId);
        return { success: true, event: event.type, cancelled: false };
      }
    }
    return ignoredEvent(event);
  }
  if (event.type === "charge.refunded") {
    const charge = event.data;
    if (typeof charge.payment_intent !== "string") return ignoredEvent(event);
    const refund = {
      paymentIntentId: charge.payment_intent,
      amount: charge.amount,
      amountRefunded: charge.amount_refunded,
      currency: charge.currency
    };
    const giftPurchaseRefund = await recordGiftCardPurchaseRefund(env, refund);
    if (giftPurchaseRefund) return giftPurchaseRefund;
    const listed = Array.isArray(charge.refunds?.data) ? charge.refunds.data : [];
    const latest = listed.filter((item) => typeof item?.id === "string").sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))[0];
    const recorded = await recordProviderRefund(ctx, {
      ...refund,
      refundedAt: at3,
      providerRefundId: typeof latest?.id === "string" ? latest.id : null
    });
    if (recorded) {
      await reverseRefundedOrderTax(env, paymentAdapters, recorded.orderId);
      return recorded;
    }
    await assertNoAwaitedPayment(ctx, {
      orderId: text(charge.metadata?.orderId),
      giftCardPurchaseId: text(charge.metadata?.giftCardPurchaseId)
    });
    return ignoredEvent(event);
  }
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
    const dispute = parseStripeDispute(event.data, at3);
    if (!dispute) return ignoredEvent(event);
    const applied = await applyStripeDispute(env, dispute, { closed: event.type === "charge.dispute.closed", at: at3 });
    if (applied && "orderId" in applied && applied.status === "refunded") {
      await reverseRefundedOrderTax(env, paymentAdapters, applied.orderId);
    }
    if (applied) return { success: true, event: event.type, ...applied };
    await assertNoAwaitedPayment(ctx, await stripeAdapter.getPaymentReferences?.(dispute.paymentIntentId));
    return ignoredEvent(event);
  }
  return ignoredEvent(event);
}
async function handleStripeWebhook(ctx, payload, signature, secret) {
  const { adapters: paymentAdapters } = ctx;
  const stripeAdapter = paymentAdapters.find((a) => a.providerId === "stripe");
  if (!stripeAdapter?.validateWebhook) {
    throw new Error("Stripe adapter not configured options.paymentAdapters");
  }
  let event;
  try {
    event = await stripeAdapter.validateWebhook(payload, signature, secret || "");
  } catch (cause) {
    throw new WebhookSignatureError(cause instanceof Error ? cause.message : "Webhook Error", { cause });
  }
  try {
    return await applyStripeEvent(ctx, event, stripeAdapter);
  } catch (error) {
    if (!(error instanceof WebhookMismatchError)) throw error;
    console.error(
      "[commerce] Stripe event does not match the store records",
      { type: event.type, id: event.id, reason: error.reason }
    );
    return { success: true, event: event.type, ignored: true, reason: error.reason };
  }
}

// src/reconcile-job.ts
import { and as and5, eq as eq7, lt as lt2, or } from "drizzle-orm";
var at2 = (seconds) => new Date(seconds * 1e3);
async function reconcileCommerce(options, limit = 10) {
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  const { env } = options;
  const ctx = commerceContext(options);
  const now = Math.floor(Date.now() / 1e3);
  const { db } = ctx;
  const preparations = await env.DB.prepare(`SELECT id FROM _ecommerce_carts
    WHERE checkout_session_id >= 'preparing:' AND checkout_session_id < 'preparing;' AND updated_at < ?
    ORDER BY updated_at LIMIT ?`).bind(now - 35 * 60, count).all();
  const settlesAdminTest = options.paymentAdapters?.some((adapter) => adapter.providerId === "admin_test") ?? false;
  const pending = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status = 'pending' AND created_at < ? AND reconcile_review_at IS NULL AND ${RECONCILE_DUE}
      AND (? = 1 OR COALESCE(payment_provider, 'stripe') <> 'admin_test')
    ORDER BY ${RECONCILE_ORDER} LIMIT ?`).bind(now - 15 * 60, now, settlesAdminTest ? 1 : 0, count).all();
  const abandonedTests = settlesAdminTest ? { results: [] } : await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status = 'pending' AND payment_provider = 'admin_test' AND created_at < ?
    ORDER BY created_at LIMIT ?`).bind(now - 15 * 60, count).all();
  const giftPurchases = await env.DB.prepare(`SELECT id FROM _ecommerce_gift_card_purchases
    WHERE status = 'pending' AND provider_session_id IS NOT NULL AND created_at < ?
      AND reconcile_review_at IS NULL AND ${RECONCILE_DUE}
    ORDER BY ${RECONCILE_ORDER} LIMIT ?`).bind(now - 15 * 60, now, count).all();
  const results = [];
  for (const row of preparations.results ?? []) {
    try {
      await resumeCheckout(ctx, row.id);
      results.push({ id: row.id, status: "preparation_checked" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  for (const row of pending.results ?? []) {
    results.push(await reconcileAttempt(env, "order", row.id, now, () => reconcilePendingOrder(ctx, row.id)));
  }
  for (const row of abandonedTests.results ?? []) {
    try {
      const cancelled = await cancelOrder(ctx, row.id);
      results.push({ id: row.id, status: cancelled?.status ?? "unchanged" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  const stripe = options.paymentAdapters?.find((adapter) => adapter.providerId === "stripe");
  for (const row of giftPurchases.results ?? []) {
    results.push(await reconcileAttempt(
      env,
      "gift_card_purchase",
      row.id,
      now,
      () => reconcileGiftCardPurchase(env, stripe, row.id)
    ));
  }
  const adapters = options.paymentAdapters ?? [];
  const taxPasses = [
    ["tax_transactions", recordMissingTaxTransactions],
    ["tax_reversal_resends", resendPendingTaxReversals],
    ["tax_reversals", reverseUnreversedTax]
  ];
  for (const [name, pass] of taxPasses) {
    try {
      results.push(...await pass(env, adapters, now, count));
    } catch (error) {
      const failure = reconcileFailure(error);
      results.push({ id: name, status: "error", error: failure.message, code: failure.code });
    }
  }
  try {
    results.push(...await releaseReferralAwards(options, { limit: count }));
  } catch (error) {
    results.push({
      id: "referral_awards",
      status: "error",
      error: error instanceof Error ? error.message : "Referral release failed"
    });
  }
  try {
    results.push(...await deliverPendingCommerceEmails({ env }, { limit: Math.min(count, 5) }));
  } catch (error) {
    results.push({
      id: "commerce_emails",
      status: "error",
      error: error instanceof Error ? error.message : "Email delivery failed"
    });
  }
  await db.delete(customerSessions).where(or(
    and5(eq7(customerSessions.purpose, "email_challenge"), lt2(customerSessions.expiresAt, at2(now - 24 * 60 * 60))),
    and5(eq7(customerSessions.purpose, "session"), lt2(customerSessions.expiresAt, at2(now - 30 * 24 * 60 * 60)))
  ));
  return results;
}

// src/retention.ts
import { sql as sql5 } from "drizzle-orm";
var PURGE_MAX_BATCHES = 20;
async function purgeStaleCommerceData(options) {
  const { env } = options;
  const batchSize = Math.max(1, Math.min(1e3, Math.floor(options.batchSize ?? 500)));
  const now = Math.floor((options.now ?? /* @__PURE__ */ new Date()).getTime() / 1e3);
  const day = 24 * 60 * 60;
  const deleted = {
    carts: 0,
    customerSessions: 0,
    signInTokens: 0,
    unverifiedAccounts: 0,
    rateLimits: 0,
    authSessions: 0,
    authRateLimits: 0
  };
  const steps = [
    // Guest baskets untouched for 30 days. Account, checked-out and locked baskets stay.
    ["carts", (limit) => sql5`DELETE FROM _ecommerce_carts WHERE id IN (SELECT id FROM _ecommerce_carts
      WHERE user_id IS NULL AND closed = 0 AND checkout_session_id IS NULL AND updated_at < ${now - 30 * day}
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE cart_id = _ecommerce_carts.id)
      LIMIT ${limit})`],
    // Shopper sessions, and the `email_challenge` rows of earlier releases, a day after they expired, were used or signed out.
    ["customerSessions", (limit) => sql5`DELETE FROM _ecommerce_customer_sessions WHERE id IN (SELECT id
      FROM _ecommerce_customer_sessions WHERE expires_at < ${now - day} OR revoked_at < ${now - day} LIMIT ${limit})`],
    // Sign-in links, with the address they were sent to, a day after they expired or were used.
    ["signInTokens", (limit) => sql5`DELETE FROM _ecommerce_sign_in_tokens WHERE token_hash IN (SELECT token_hash
      FROM _ecommerce_sign_in_tokens WHERE expires_at < ${now - day} OR revoked_at < ${now - day} LIMIT ${limit})`],
    // Accounts that asking for a sign-in link used to create: never verified, a day old, and with no
    // orders, sessions, basket, credit, referral or discount use. Anything else keeps the account.
    ["unverifiedAccounts", (limit) => sql5`DELETE FROM _ecommerce_customer_accounts WHERE id IN (SELECT a.id
      FROM _ecommerce_customer_accounts a
      WHERE a.email_verified_at IS NULL AND a.cms_user_id IS NULL AND a.credit_balance = 0 AND a.created_at < ${now - day}
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE user_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_customer_sessions WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_carts WHERE user_id = a.id AND closed = 0)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referral_codes WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referrals WHERE referrer_account_id = a.id OR referred_account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_discount_redemptions WHERE account_id = a.id)
      LIMIT ${limit})`],
    // Shopper request counters. Every window is at most a day long.
    ["rateLimits", (limit) => sql5`DELETE FROM _ecommerce_rate_limits WHERE key IN (SELECT key FROM _ecommerce_rate_limits
      WHERE window_start < ${now - day} LIMIT ${limit})`],
    ["authSessions", (limit) => sql5`DELETE FROM galaxy_auth_session WHERE id IN (SELECT id FROM galaxy_auth_session
      WHERE expires_at < ${now} LIMIT ${limit})`],
    // better-auth records milliseconds. Shopper counters written in seconds by earlier releases may remain.
    ["authRateLimits", (limit) => sql5`DELETE FROM galaxy_auth_rate_limit WHERE id IN (SELECT id FROM galaxy_auth_rate_limit
      WHERE CASE WHEN last_request >= 100000000000 THEN last_request / 1000 ELSE last_request END < ${now - day}
      LIMIT ${limit})`]
  ];
  const db = commerceDb(env);
  const failures = [];
  for (const [table, statement] of steps) {
    try {
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
        const result = await db.run(statement(batchSize));
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

// src/api.ts
function bindCommerceApi(options) {
  const ctx = commerceContext(options);
  return {
    carts: {
      quote: (cartId) => quoteCart(ctx, cartId),
      find: (sessionToken, userId) => findCart(ctx, sessionToken, userId),
      /** Attach the current browser basket to an authenticated shopper account. */
      claim: (sessionToken, userId, choice) => claimCart(ctx, sessionToken, userId, choice),
      getOrCreate: (sessionToken, userId) => getOrCreateCart(ctx, sessionToken, userId),
      /**
       * Check an item list against the basket limits and the catalog without writing, for example
       * before creating a basket for it. Returns the list with only the stored fields.
       */
      validateItems: (items, current = []) => checkCartItems(ctx, items, current),
      updateItems: (cartId, items) => updateCartItems(ctx, cartId, items)
    },
    orders: {
      resumeFromCart: (cartId, options2 = {}) => resumeCheckout(ctx, cartId, options2),
      reconcilePending: (id) => reconcilePendingOrder(ctx, id),
      createFromCart: (cartId, options2) => createOrderFromCart(ctx, cartId, options2),
      create: (data) => createOrder(ctx, data),
      find: (id) => findOrder(ctx, id),
      findForSession: (id, sessionToken, customerId) => findOrderForSession(ctx, id, sessionToken, customerId),
      updateStatus: (id, status, fulfillment) => updateOrderStatus(ctx, id, status, fulfillment),
      finalizePayment: (id, options2) => finalizeOrderPayment(ctx, { orderId: id, ...options2 }),
      cancel: (id, options2 = {}) => cancelOrder(ctx, id, options2)
    },
    webhooks: {
      handleStripe: (payload, signature, secret) => handleStripeWebhook(ctx, payload, signature, secret)
    }
  };
}

export {
  CART_MAX_LINES,
  CART_MAX_LINE_QUANTITY,
  aggregateComponentDemand,
  isCheckoutDetailsError,
  checkoutSchema,
  checkoutInputError,
  PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS,
  PROVIDER_CHECK_RETRY_MESSAGE,
  ProviderCheckLimitedError,
  providerCheckLimitResponse,
  mayAskPaymentProvider,
  TaxCalculationError,
  PARKED_CHECKOUT_MESSAGE,
  shippingOptionsFor,
  reconcileCommerce,
  purgeStaleCommerceData,
  bindCommerceApi
};
