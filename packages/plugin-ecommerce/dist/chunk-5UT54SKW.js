import {
  SHIPPING_OPTION_UNAVAILABLE,
  UNDELIVERABLE_COUNTRY,
  aggregateComponentDemand,
  calculateOrderTax,
  cancelCustomerReturn,
  cancelOrder,
  checkCartItems,
  checkoutInputError,
  checkoutSchema,
  claimCart,
  commerceContext,
  createCustomerReturn,
  createOrder,
  discardCheckoutDiscount,
  finalizeOrderPayment,
  findCart,
  findOrder,
  findOrderForSession,
  getOrCreateCart,
  listTaxSyncReview,
  loadBasketCatalog,
  mayAskPaymentProvider,
  quoteCart,
  readCustomerExchangeChoices,
  readCustomerReturns,
  readOrderTracking,
  recordMissingTaxTransactions,
  recordProviderRefund,
  recordRecoveryPaymentEvent,
  requireVariantChoice,
  resendPendingTaxReversals,
  resolveSelectedVariant,
  reverseRefundedOrderTax,
  reverseUnreversedTax,
  taxAddressFor,
  taxableLines,
  updateCartItems,
  updateOrderStatus,
  withCountryCode
} from "./chunk-PDZF27EW.js";
import {
  INVENTORY_COLUMNS,
  fullRefundStatements
} from "./chunk-BVMDOVSS.js";
import {
  evaluateDiscountCode
} from "./chunk-MPH2QR5Y.js";
import {
  adminActorNames,
  deliverPendingCommerceEmails
} from "./chunk-GLO65VCM.js";
import {
  RECONCILE_FAILURE_MESSAGES,
  RECONCILE_TABLES,
  ReconcileFailure,
  ShopperError,
  WebhookMismatchError,
  WebhookRetryLaterError,
  WebhookSignatureError,
  assertStoreStripeMode,
  completedCheckoutReturn,
  confirmGiftCardPurchase,
  decisionInsert,
  evaluateGiftCard,
  expireGiftCardPurchase,
  giftCardPurchaseChargebackStatements,
  giftCardPurchaseHoldStatements,
  giftCardPurchaseReleaseStatements,
  hashGiftCardSecret,
  isCountryCode,
  isMissingSessionError,
  isOtherStripeModeSession,
  isProviderError,
  readStoreSettings,
  reconcileAttempt,
  reconcileBackoff,
  reconcileFailure,
  reconcileGiftCardPurchase,
  recordGiftCardPurchaseRefund,
  sessionLookupFailure,
  uncheckedSessionRefusal
} from "./chunk-PVGGIHJ5.js";
import {
  canonicalEmail,
  canonicalEmails,
  findReferralCode,
  getReferralPolicy,
  hasCanonicalPurchase,
  referralReversalStatements,
  releaseReferralAwards
} from "./chunk-IC3XDWQU.js";
import {
  runtimeStripeMode,
  stripeSessionMode
} from "./chunk-GNU6N22K.js";
import {
  hasPurchaseHistory
} from "./chunk-PMYARYOQ.js";
import {
  batchGroups,
  commerceDb,
  commitBatch,
  errorText,
  runStatements
} from "./chunk-SXQHVX4E.js";
import {
  carts,
  creditLedger,
  customerAccounts,
  customerSessions,
  discountRedemptions,
  giftCardPurchases,
  giftCardRedemptions,
  giftCards,
  orders,
  reconcileDecisions,
  taxSyncDecisions
} from "./chunk-PLAJXKV3.js";
import {
  hashOrderAccess
} from "./chunk-NQUBOBQT.js";
import {
  minimumChargeAmount
} from "./chunk-HNDRZISR.js";

// src/checkout.ts
import { and, eq, isNull, lt, notExists, sql } from "drizzle-orm";

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
  if (!serving.length) throw new ShopperError("checkout_details", UNDELIVERABLE_COUNTRY, 400);
  const chosen = chosenId?.trim();
  const rate = chosen ? serving.find((candidate) => candidate.id === chosen) : serving[0];
  if (!rate) throw new ShopperError("checkout_details", SHIPPING_OPTION_UNAVAILABLE, 400);
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
var reservationRows = (list) => sql`SELECT json_extract(value, '$.target') AS target, json_extract(value, '$.amount') AS amount
  FROM json_each(${list})`;
async function createOrderFromCart(ctx, cartId, options) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const details = checkoutSchema.safeParse({
    customerEmail: options.customerEmail,
    shippingAddress: options.shippingAddress,
    billingAddress: options.billingAddress,
    shippingRateId: options.shippingRateId,
    discountCode: options.discountCode,
    giftCardCode: options.giftCardCode
  });
  if (!details.success) throw new ShopperError("invalid_checkout", checkoutInputError(details.error), 400);
  options = { ...options, ...details.data };
  const settings = readStoreSettings(env);
  const { currency, deliveryCountries } = settings;
  const cart = await db.select().from(carts).where(eq(carts.id, cartId)).get();
  if (!cart || cart.items.length === 0) {
    throw new ShopperError("basket_conflict", "Cart is empty or not found", 409);
  }
  if (cart.closed) {
    throw new ShopperError("basket_conflict", "Cart is closed", 409);
  }
  if (cart.checkoutSessionId) {
    throw new ShopperError("basket_conflict", "Checkout already started for this cart", 409);
  }
  const defaultAdapter = options.providerId ? paymentAdapters.find((adapter) => adapter.providerId === options.providerId) : paymentAdapters.length === 1 && paymentAdapters[0].providerId !== "admin_test" ? paymentAdapters[0] : void 0;
  if (!defaultAdapter) throw new ShopperError("provider_unavailable", "Checkout is unavailable right now. Please try again later.", 503);
  let requiresShipping = false;
  let totalAmount = 0;
  const orderItems = [];
  const componentItems = [];
  const inventoryDemand = /* @__PURE__ */ new Map();
  const catalog = await loadBasketCatalog(ctx, cart.items);
  for (const item of cart.items) {
    const product = catalog.products.get(String(item.productId));
    if (!product) {
      throw new ShopperError("basket_conflict", `Product not found: ${item.productId}`, 409);
    }
    if (product.status !== "active") {
      throw new ShopperError("basket_conflict", `Product is not available: ${item.productId}`, 409);
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
      throw new ShopperError("basket_conflict", `Insufficient stock for ${finalName}`, 409);
    }
    if (tracksInventory && requiredComponents.length) {
      componentItems.push({ quantity: item.quantity, components: requiredComponents });
    } else if (tracksInventory && inventoryTarget) {
      const key = `${inventoryTarget.type}:${inventoryTarget.id}`;
      const existing = inventoryDemand.get(key);
      inventoryDemand.set(key, { ...inventoryTarget, quantity: (existing?.quantity ?? 0) + item.quantity });
    }
    if (!Number.isSafeInteger(price) || price <= 0) {
      throw new ShopperError("basket_conflict", `A positive price is required for ${finalName}`, 409);
    }
    totalAmount += price * item.quantity;
    if (!Number.isSafeInteger(totalAmount)) throw new ShopperError("basket_conflict", "Order total is too large", 409);
    orderItems.push({
      ...item,
      priceAtPurchase: price,
      name: finalName,
      usesComponents: tracksInventory && requiredComponents.length > 0,
      stockTargets: defaultAdapter.reservesInventory === false || !tracksInventory ? [] : requiredComponents.length ? requiredComponents.map((part) => ({ type: "component", id: part.id, units: part.quantity })) : inventoryTarget ? [{ type: inventoryTarget.type, id: inventoryTarget.id, units: 1 }] : []
    });
  }
  const componentDemand = aggregateComponentDemand(componentItems);
  for (const component of componentDemand.values()) {
    if (component.available < component.quantity) {
      throw new ShopperError("basket_conflict", `Insufficient stock for component ${component.name}`, 409);
    }
  }
  if (requiresShipping && (!options.shippingAddress || !["name", "line1", "city", "postalCode", "country"].every((key) => typeof options.shippingAddress[key] === "string" && options.shippingAddress[key].trim()))) {
    throw new ShopperError("shipping_address_required", "Shipping address is required for physical products", 400);
  }
  const shippingAddress = withCountryCode(options.shippingAddress);
  const billingAddress = withCountryCode(options.billingAddress);
  if (requiresShipping && deliveryCountries && !deliveryCountries.includes(shippingAddress.country)) {
    throw new ShopperError("country_unavailable", UNDELIVERABLE_COUNTRY, 400);
  }
  const shippingRate = requiresShipping && settings.shippingRates.length ? chooseShippingRate(settings, shippingAddress.country, options.shippingRateId) : null;
  const taxBehavior = settings.tax.mode === "none" || defaultAdapter.providerId === "admin_test" ? null : settings.tax.mode === "stripe-inclusive" ? "inclusive" : "exclusive";
  const taxAddress = taxBehavior ? taxAddressFor(requiresShipping, shippingAddress, billingAddress) : null;
  const orderId = `ord_${crypto.randomUUID()}`;
  const orderAccessToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const guestAccessTokenHash = await hashOrderAccess(orderAccessToken);
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
  }).from(customerAccounts).where(eq(customerAccounts.id, cart.userId)).get() : void 0;
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
  if (!Number.isSafeInteger(amountDue)) throw new ShopperError("basket_conflict", "Order total is too large", 409);
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
    throw new ShopperError("basket_conflict", "Payment provider must support checkout session expiry", 409);
  }
  const successUrl = options.successUrl.replaceAll("{ORDER_ID}", orderId);
  const cancelUrl = options.cancelUrl.replaceAll("{ORDER_ID}", orderId);
  const now = /* @__PURE__ */ new Date();
  const timestamp = Math.floor(now.getTime() / 1e3);
  const preparationLock = `preparing:${orderId}`;
  const lock = await db.update(carts).set({ checkoutSessionId: preparationLock, updatedAt: now, version: sql`${carts.version} + 1` }).where(and(
    eq(carts.id, cartId),
    eq(carts.closed, false),
    isNull(carts.checkoutSessionId),
    eq(carts.items, cart.items),
    eq(carts.version, cart.version)
  )).returning({ id: carts.id });
  if (!lock.length) throw new ShopperError("basket_conflict", "Checkout already started for this cart", 409);
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
    if (!session.providerSessionId || !session.url) throw new ShopperError("basket_conflict", "Payment provider did not return a checkout session", 409);
    const checkoutSessionId = session.providerSessionId;
    const statements = [
      db.insert(orders).values({
        id: orderId,
        cartId,
        guestAccessTokenHash,
        guestBasketTokenHash: !cart.userId && cart.sessionToken ? await hashOrderAccess(cart.sessionToken) : null,
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
        referralTerms: referralCode ? { minOrderCents: referralsPolicy.minOrderCents, holdDays: referralsPolicy.holdDays, maxPerPeriod: referralsPolicy.maxPerPeriod, periodDays: referralsPolicy.periodDays } : null,
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
      const authorizedHash = await hashGiftCardSecret(options.giftCardCode.trim().toUpperCase());
      const authorizedCard = db.select({ id: giftCards.id }).from(giftCards).where(and(eq(giftCards.id, giftCard.id), eq(giftCards.codeHash, authorizedHash)));
      statements.push(db.insert(giftCardRedemptions).values({
        id: `gcr_${orderId}`,
        cardId: sql`(${authorizedCard})`,
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
    const componentReservations = reserves ? [...componentDemand].map(([target, demand]) => ({ id: crypto.randomUUID(), target, amount: demand.quantity })) : [];
    if (componentReservations.length) {
      const list = JSON.stringify(componentReservations);
      statements.push(db.run(sql`UPDATE _ecommerce_components
      SET quantity = quantity - demand.amount, updated_at = MAX(updated_at + 1, ${timestamp})
      FROM (${reservationRows(list)}) AS demand WHERE _ecommerce_components.id = demand.target`));
      statements.push(db.run(sql`INSERT INTO _ecommerce_component_reservations
      (id, order_id, component_id, quantity)
      SELECT json_extract(value, '$.id'), ${orderId}, json_extract(value, '$.target'), json_extract(value, '$.amount')
      FROM json_each(${list})`));
    }
    const inventoryReservations = reserves ? [...inventoryDemand.values()].map((demand) => ({ id: crypto.randomUUID(), type: demand.type, target: demand.id, amount: demand.quantity })) : [];
    for (const [type, { table, quantity }] of Object.entries(INVENTORY_COLUMNS)) {
      const list = inventoryReservations.filter((reservation) => reservation.type === type);
      if (!list.length) continue;
      statements.push(db.run(sql`UPDATE ${table}
      SET ${sql.identifier(quantity.name)} = ${sql.identifier(quantity.name)} - demand.amount, updated_at = MAX(updated_at + 1, ${timestamp})
      FROM (${reservationRows(JSON.stringify(list))}) AS demand WHERE ${table}.id = demand.target`));
    }
    if (inventoryReservations.length) {
      statements.push(db.run(sql`INSERT INTO _ecommerce_inventory_reservations
      (id, order_id, target_type, target_id, quantity)
      SELECT json_extract(value, '$.id'), ${orderId}, json_extract(value, '$.type'), json_extract(value, '$.target'),
        json_extract(value, '$.amount')
      FROM json_each(${JSON.stringify(inventoryReservations)})`));
    }
    statements.push(db.update(carts).set({ checkoutSessionId, updatedAt: now }).where(and(eq(carts.id, cartId), eq(carts.checkoutSessionId, preparationLock))));
    try {
      await commitBatch(db, statements);
      committed = true;
    } catch (cause) {
      const refused = errorText(cause);
      if (refused.includes("Shopper account changed during checkout")) {
        throw new ShopperError("account_changed", "Your account changed during checkout; please sign in again", 409, { cause });
      }
      if (refused.includes("Discount code is no longer available")) {
        throw new ShopperError("discount_changed", "Discount code is no longer available", 409, { cause });
      }
      if (refused.includes("Insufficient store credit")) {
        throw new ShopperError("credit_changed", "Store credit changed during checkout; please try again", 409, { cause });
      }
      if (refused.includes("Gift card is no longer available")) {
        throw new ShopperError("gift_card_changed", "Gift card is no longer available", 409, { cause });
      }
      throw new ShopperError("stock_changed", "Insufficient stock or checkout already started", 409, { cause });
    }
    const order = await findOrder(ctx, orderId);
    if (!order) throw new ShopperError("basket_conflict", "Checkout was created but the order could not be loaded", 409);
    if (internallyPaid) {
      await finalizeOrderPayment(ctx, {
        orderId,
        provider: "gift_card",
        providerId: checkoutSessionId,
        paymentStatus: "success",
        amount: 0,
        customerEmail: options.customerEmail
      });
      return { order: await findOrder(ctx, orderId), paymentUrl: session.url, orderAccessToken };
    }
    return { order, paymentUrl: session.url, orderAccessToken };
  } catch (error) {
    if (committed) throw error;
    try {
      if (session?.providerSessionId && !internallyPaid) {
        await defaultAdapter.expireCheckoutSession(session.providerSessionId);
      }
    } finally {
      if (providerDiscount) await discardCheckoutDiscount(defaultAdapter, orderId);
    }
    await db.update(carts).set({ checkoutSessionId: null }).where(and(eq(carts.id, cartId), eq(carts.checkoutSessionId, preparationLock)));
    throw error;
  }
}
async function resumeCheckout(ctx, cartId, options = {}) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const cart = await db.select().from(carts).where(eq(carts.id, cartId)).get();
  if (!cart?.checkoutSessionId) return null;
  if (cart.checkoutSessionId.startsWith("preparing:")) {
    const nowSeconds = Math.floor(Date.now() / 1e3);
    const cutoff = nowSeconds - 35 * 60;
    const pendingOrder = db.select({ one: sql`1` }).from(orders).where(and(eq(orders.cartId, carts.id), eq(orders.status, "pending")));
    await db.update(carts).set({ checkoutSessionId: null, updatedAt: new Date(nowSeconds * 1e3), version: sql`${carts.version} + 1` }).where(and(
      eq(carts.id, cartId),
      eq(carts.checkoutSessionId, cart.checkoutSessionId),
      lt(carts.updatedAt, new Date(cutoff * 1e3)),
      notExists(pendingOrder)
    ));
    return null;
  }
  const order = await db.select().from(orders).where(eq(orders.checkoutSessionId, cart.checkoutSessionId)).get();
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
import { eq as eq3 } from "drizzle-orm";

// src/disputes.ts
import { eq as eq2, sql as sql2 } from "drizzle-orm";
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
  return sql2`INSERT INTO _ecommerce_disputes
    (id, provider, ${sql2.raw(column)}, amount_cents, currency, reason, status, status_before, created_at, updated_at, closed_at)
    SELECT ${dispute.id}, 'stripe', r.id, ${dispute.amountCents}, ${dispute.currency ?? record.currency}, ${dispute.reason}, ${dispute.status},
      ${sql2.raw(statusBefore)}, ${dispute.createdAt}, ${times.now}, ${times.closedAt}
    FROM ${sql2.raw(table)} r WHERE r.id = ${record.id}
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
    db.get(sql2`SELECT status FROM _ecommerce_orders WHERE id = ${orderId}`)
  ];
  const results = await db.batch(items);
  return results[results.length - 1]?.status ?? null;
}
async function openOrderDispute(env, order, dispute, now) {
  return orderBatch(env, order.id, [
    recordStatement(dispute, { kind: "order", id: order.id, currency: order.currency }, { closedAt: null, now }),
    sql2`UPDATE _ecommerce_orders SET status = 'disputed', updated_at = ${now}
      WHERE id = ${order.id} AND status IN ('paid', 'fulfilled', 'partially_refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${dispute.id} AND order_id = ${order.id} AND closed_at IS NULL)`
  ]);
}
async function settleLostOrderDispute(env, order, record, disputeId, now) {
  return orderBatch(env, order.id, [
    record,
    sql2`UPDATE _ecommerce_orders SET status = 'refunded', updated_at = ${now}
      WHERE id = ${order.id} AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${disputeId} AND order_id = ${order.id} AND status = 'lost')`,
    sql2`UPDATE _ecommerce_payments SET status = 'refunded'
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
    sql2`UPDATE _ecommerce_orders SET status = CASE
        WHEN total_amount > 0 AND provider_refunded_cents >= total_amount THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE (SELECT status_before FROM _ecommerce_disputes WHERE id = ${dispute.id}) END,
      updated_at = ${now}
      WHERE id = ${order.id} AND status = 'disputed'
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${dispute.id} AND order_id = ${order.id} AND status <> 'lost')
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE order_id = ${order.id} AND closed_at IS NULL)`,
    // The previous release copies the order's status onto its payment when it sees a refund, so a
    // rollback during the dispute can leave the payment 'disputed', which reports leave out.
    sql2`UPDATE _ecommerce_payments SET status = CASE o.status
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
    sql2`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ${now}
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
      sql2`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ${now}
        WHERE id = ${purchase.id} AND status IN ('paid', 'partially_refunded', 'refunded')`,
      ...giftCardPurchaseHoldStatements(purchase.id, now),
      ...giftCardPurchaseChargebackStatements(purchase.id, now)
    ]);
    const current = await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases).where(eq2(giftCardPurchases.id, purchase.id)).get();
    if (current?.status === "review") {
      throw new WebhookRetryLaterError("A checkout in progress holds value on the disputed purchase's card; the lost dispute is applied once it completes or expires");
    }
    return;
  }
  await runStatements(db, [
    record,
    sql2`UPDATE _ecommerce_gift_card_purchases SET status = CASE
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
  const order = await db.select({ id: orders.id, currency: orders.currency, referralCode: orders.referralCode }).from(orders).where(eq2(orders.paymentIntentId, dispute.paymentIntentId)).get();
  if (order) {
    const status = options.closed ? await closeOrderDispute(env, order, dispute, options.at, now) : await openOrderDispute(env, order, dispute, now);
    return { orderId: order.id, status };
  }
  const purchase = await db.select({ id: giftCardPurchases.id, currency: giftCardPurchases.currency }).from(giftCardPurchases).where(eq2(giftCardPurchases.paymentIntentId, dispute.paymentIntentId)).get();
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
  const record = purchaseId ? await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases).where(eq3(giftCardPurchases.id, purchaseId)).get() : orderId ? await db.select({ status: orders.status }).from(orders).where(eq3(orders.id, orderId)).get() : void 0;
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
      const purchase = await db.select({ id: giftCardPurchases.id }).from(giftCardPurchases).where(eq3(giftCardPurchases.id, purchaseId)).get();
      return purchase ? confirmGiftCardPurchase(env, session) : ignoredEvent(event);
    }
    const orderId = text(session.metadata?.orderId) ?? text(session.client_reference_id);
    const order = orderId ? await db.select({ id: orders.id }).from(orders).where(eq3(orders.id, orderId)).get() : void 0;
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
      const purchase = await db.select({ id: giftCardPurchases.id }).from(giftCardPurchases).where(eq3(giftCardPurchases.id, purchaseId)).get();
      if (!purchase) return ignoredEvent(event);
      await expireGiftCardPurchase(env, purchaseId, session.id);
      return { success: true, event: event.type };
    }
    const orderId = text(session.metadata?.orderId) ?? text(session.client_reference_id);
    if (orderId) {
      const order = await db.select().from(orders).where(eq3(orders.id, orderId)).get();
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
    const recovery = await recordRecoveryPaymentEvent(env, charge.payment_intent, event.id ?? `recovery-refund:${charge.id}:${charge.amount_refunded}`, "refunded", at3);
    if (recovery) return recovery;
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
    const recorded2 = await recordProviderRefund(ctx, {
      ...refund,
      refundedAt: at3,
      providerRefundId: typeof latest?.id === "string" ? latest.id : null
    });
    if (recorded2) {
      await reverseRefundedOrderTax(env, paymentAdapters, recorded2.orderId);
      return recorded2;
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
    const recovery = await recordRecoveryPaymentEvent(env, dispute.paymentIntentId, event.id ?? `recovery-dispute:${dispute.id}:${event.type}`, event.type === "charge.dispute.created" ? "disputed" : dispute.status === "won" ? "won" : "lost", at3);
    if (recovery) return recovery;
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
import { and as and2, eq as eq4, gte, isNull as isNull2, lt as lt2, or, sql as sql3 } from "drizzle-orm";
var at = (seconds) => new Date(seconds * 1e3);
async function reconcileCommerce(options, limit = 10) {
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  const { env } = options;
  const ctx = commerceContext(options);
  const now = Math.floor(Date.now() / 1e3);
  const { db } = ctx;
  const stale = at(now - 15 * 60);
  const settlesAdminTest = options.paymentAdapters?.some((adapter) => adapter.providerId === "admin_test") ?? false;
  const pendingOrder = sql3`${orders.status} = 'pending'`;
  const orderWait = reconcileBackoff(orders, now);
  const purchaseWait = reconcileBackoff(giftCardPurchases, now);
  const queue = await batchGroups(db, {
    // ';' follows ':', so the range holds exactly the ids that start with 'preparing:', read from the
    // unique index on checkout_session_id. LIKE cannot use that index: it ignores case.
    preparations: [db.select({ id: carts.id }).from(carts).where(and2(
      gte(carts.checkoutSessionId, "preparing:"),
      lt2(carts.checkoutSessionId, "preparing;"),
      lt2(carts.updatedAt, at(now - 35 * 60))
    )).orderBy(carts.updatedAt).limit(count)],
    pending: [db.select({ id: orders.id }).from(orders).where(and2(
      pendingOrder,
      lt2(orders.createdAt, stale),
      isNull2(orders.reconcileReviewAt),
      orderWait.due,
      settlesAdminTest ? void 0 : sql3`COALESCE(${orders.paymentProvider}, 'stripe') <> 'admin_test'`
    )).orderBy(...orderWait.order).limit(count)],
    abandonedTests: settlesAdminTest ? [] : [db.select({ id: orders.id }).from(orders).where(and2(pendingOrder, eq4(orders.paymentProvider, "admin_test"), lt2(orders.createdAt, stale))).orderBy(orders.createdAt).limit(count)],
    giftPurchases: [db.select({ id: giftCardPurchases.id }).from(giftCardPurchases).where(and2(
      eq4(giftCardPurchases.status, "pending"),
      lt2(giftCardPurchases.createdAt, stale),
      isNull2(giftCardPurchases.reconcileReviewAt),
      purchaseWait.due
    )).orderBy(...purchaseWait.order).limit(count)]
  });
  const results = [];
  for (const row of queue.preparations) {
    try {
      await resumeCheckout(ctx, row.id);
      results.push({ id: row.id, status: "preparation_checked" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  for (const row of queue.pending) {
    results.push(await reconcileAttempt(env, "order", row.id, now, () => reconcilePendingOrder(ctx, row.id)));
  }
  for (const row of queue.abandonedTests) {
    try {
      const cancelled = await cancelOrder(ctx, row.id);
      results.push({ id: row.id, status: cancelled?.status ?? "unchanged" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  const stripe = options.paymentAdapters?.find((adapter) => adapter.providerId === "stripe");
  for (const row of queue.giftPurchases) {
    results.push(await reconcileAttempt(
      env,
      "gift_card_purchase",
      row.id,
      now,
      () => reconcileGiftCardPurchase(env, stripe, row.id)
    ));
  }
  const coupons = await db.select({ id: orders.id, sessionId: orders.checkoutSessionId, createdAt: orders.createdAt }).from(orders).where(sql3`${orders.discountCleanupPending} = 1 AND ${orders.status} = 'cancelled'`).orderBy(orders.updatedAt).limit(count);
  for (const coupon of coupons) {
    const otherMode = isOtherStripeModeSession(env, coupon.sessionId);
    const removed = otherMode ? coupon.createdAt.getTime() <= (now - 35 * 60) * 1e3 : await discardCheckoutDiscount(ctx.adapters.find((adapter) => adapter.providerId === "stripe"), coupon.id);
    await db.update(orders).set({ discountCleanupPending: !removed, updatedAt: at(now) }).where(eq4(orders.id, coupon.id));
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
    and2(eq4(customerSessions.purpose, "email_challenge"), lt2(customerSessions.expiresAt, at(now - 24 * 60 * 60))),
    and2(eq4(customerSessions.purpose, "session"), lt2(customerSessions.expiresAt, at(now - 30 * 24 * 60 * 60)))
  ));
  return results;
}

// src/retention.ts
import { sql as sql4 } from "drizzle-orm";
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
    ["carts", (limit) => sql4`DELETE FROM _ecommerce_carts WHERE id IN (SELECT id FROM _ecommerce_carts
      WHERE user_id IS NULL AND closed = 0 AND checkout_session_id IS NULL AND updated_at < ${now - 30 * day}
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE cart_id = _ecommerce_carts.id)
      LIMIT ${limit})`],
    // Shopper sessions, and the `email_challenge` rows of earlier releases, a day after they expired, were used or signed out.
    ["customerSessions", (limit) => sql4`DELETE FROM _ecommerce_customer_sessions WHERE id IN (SELECT id
      FROM _ecommerce_customer_sessions WHERE expires_at < ${now - day} OR revoked_at < ${now - day} LIMIT ${limit})`],
    // Sign-in links, with the address they were sent to, a day after they expired or were used.
    ["signInTokens", (limit) => sql4`DELETE FROM _ecommerce_sign_in_tokens WHERE token_hash IN (SELECT token_hash
      FROM _ecommerce_sign_in_tokens WHERE expires_at < ${now - day} OR revoked_at < ${now - day} LIMIT ${limit})`],
    // Accounts that asking for a sign-in link used to create: never verified, a day old, and with no
    // orders, sessions, basket, credit, referral or discount use. Anything else keeps the account.
    ["unverifiedAccounts", (limit) => sql4`DELETE FROM _ecommerce_customer_accounts WHERE id IN (SELECT a.id
      FROM _ecommerce_customer_accounts a
      WHERE a.email_verified_at IS NULL AND a.cms_user_id IS NULL AND a.credit_balance = 0 AND a.created_at < ${now - day}
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_shopper_audits WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE user_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_customer_sessions WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_carts WHERE user_id = a.id AND closed = 0)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referral_codes WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referrals WHERE referrer_account_id = a.id OR referred_account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_discount_redemptions WHERE account_id = a.id)
      LIMIT ${limit})`],
    // Shopper request counters. Every window is at most a day long.
    ["rateLimits", (limit) => sql4`DELETE FROM _ecommerce_rate_limits WHERE key IN (SELECT key FROM _ecommerce_rate_limits
      WHERE window_start < ${now - day} LIMIT ${limit})`],
    ["authSessions", (limit) => sql4`DELETE FROM galaxy_auth_session WHERE id IN (SELECT id FROM galaxy_auth_session
      WHERE expires_at < ${now} LIMIT ${limit})`],
    // better-auth records milliseconds. Shopper counters written in seconds by earlier releases may remain.
    ["authRateLimits", (limit) => sql4`DELETE FROM galaxy_auth_rate_limit WHERE id IN (SELECT id FROM galaxy_auth_rate_limit
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

// src/reconcile-review.ts
import { z } from "zod";
import { and as and3, desc, eq as eq5, sql as sql5 } from "drizzle-orm";
var ReconcileInputError = class extends Error {
  name = "ReconcileInputError";
};
var PARKED_LIST_LIMIT = 100;
var PROVIDER_UNREACHABLE = "Stripe could not be asked about this checkout session, so nothing was released. Try again later.";
var retrySchema = z.object({
  kind: z.enum(["order", "gift_card_purchase"]),
  id: z.string().trim().min(1).max(128),
  // Counted in characters, as the decision table's CHECK counts them; String.length counts UTF-16 units.
  reason: z.string().trim().refine((reason) => [...reason].length >= 8 && [...reason].length <= 500)
}).strict();
var releaseSchema = retrySchema.extend({ confirmPaymentReturned: z.boolean().optional() }).strict();
function parseAction(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ReconcileInputError("Name the parked record (kind order or gift_card_purchase, and its id) and give a reason of 8 to 500 characters");
  }
  return parsed.data;
}
function newDecision(actor, reason) {
  if (!actor.trim()) throw new Error("Administrator identity is required");
  return { id: `rcd_${crypto.randomUUID()}`, actor, reason };
}
var parked = (table) => sql5`${table.status} = 'pending' AND ${table.reconcileReviewAt} IS NOT NULL`;
var at2 = (seconds) => new Date(seconds * 1e3);
var recorded = (decisionId) => sql5`EXISTS (SELECT 1 FROM _ecommerce_reconcile_decisions WHERE id = ${decisionId})`;
var notParked = (kind) => kind === "order" ? "This order is not pending and parked for review; reload the list" : "This gift card purchase is not pending and parked for review; reload the list";
var isoTime = (seconds) => new Date(seconds * 1e3).toISOString();
async function listParkedCommerce(env) {
  const db = commerceDb(env);
  const [rows, counted] = await db.batch([
    db.all(sql5`SELECT 'order' AS kind, id, created_at, reconcile_attempts AS attempts,
        reconcile_last_at AS last_at, reconcile_last_error AS last_error, reconcile_review_at AS review_at,
        checkout_session_id AS session_id, COALESCE(payment_provider, 'stripe') AS provider,
        total_amount AS amount_cents, currency
      FROM _ecommerce_orders WHERE ${parked(orders)}
      UNION ALL
      SELECT 'gift_card_purchase', id, created_at, reconcile_attempts, reconcile_last_at, reconcile_last_error,
        reconcile_review_at, provider_session_id, 'stripe', amount_cents, currency
      FROM _ecommerce_gift_card_purchases WHERE ${parked(giftCardPurchases)}
      ORDER BY review_at, id LIMIT ${PARKED_LIST_LIMIT}`),
    db.get(sql5`SELECT (SELECT COUNT(*) FROM _ecommerce_orders WHERE ${parked(orders)})
      + (SELECT COUNT(*) FROM _ecommerce_gift_card_purchases WHERE ${parked(giftCardPurchases)}) AS count`)
  ]);
  const [paymentHistory, taxHistory] = await db.batch([
    db.select().from(reconcileDecisions).orderBy(desc(reconcileDecisions.createdAt), desc(reconcileDecisions.id)).limit(50),
    db.select().from(taxSyncDecisions).orderBy(desc(taxSyncDecisions.createdAt), desc(taxSyncDecisions.id)).limit(50)
  ]);
  const names = await adminActorNames(env, [...paymentHistory.map((row) => row.adminActor), ...taxHistory.map((row) => row.actor)]);
  const history = [
    ...paymentHistory.map((row) => ({
      id: row.id,
      kind: row.orderId ? "order" : "gift_card_purchase",
      subjectId: row.orderId ?? row.purchaseId,
      action: row.action,
      reason: row.reason,
      actor: row.adminActor,
      actorName: names.get(row.adminActor) ?? row.adminActor,
      paymentReturned: row.paymentReturned,
      createdAt: row.createdAt.toISOString()
    })),
    ...taxHistory.map((row) => ({
      id: row.id,
      kind: row.reversalId ? "tax_reversal" : "tax_transaction",
      subjectId: row.reversalId ?? row.orderId,
      action: row.action,
      reason: row.reason,
      actor: row.actor,
      actorName: names.get(row.actor) ?? row.actor,
      paymentReturned: null,
      createdAt: row.createdAt.toISOString()
    }))
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 50);
  const storeMode = runtimeStripeMode(env);
  return {
    storeMode,
    history,
    tax: await listTaxSyncReview(env),
    parkedCount: Number(counted?.count ?? 0),
    parked: rows.map((row) => {
      const code = row.last_error && row.last_error in RECONCILE_FAILURE_MESSAGES ? row.last_error : "failed";
      const stripe = row.provider === "stripe";
      return {
        kind: row.kind,
        id: row.id,
        createdAt: isoTime(row.created_at),
        parkedAt: isoTime(row.review_at),
        lastAttemptAt: row.last_at === null ? null : isoTime(row.last_at),
        attempts: row.attempts,
        lastError: code,
        problem: RECONCILE_FAILURE_MESSAGES[code],
        provider: row.provider,
        sessionMode: stripe ? stripeSessionMode(row.session_id) : null,
        otherMode: stripe && isOtherStripeModeSession(env, row.session_id),
        amountCents: row.amount_cents,
        currency: row.currency
      };
    })
  };
}
async function retryParkedCommerce(env, actor, input) {
  const { kind, id, reason } = parseAction(retrySchema, input);
  const decision = newDecision(actor, reason);
  const timestamp = Math.floor(Date.now() / 1e3);
  const db = commerceDb(env);
  const table = RECONCILE_TABLES[kind];
  const [, retried] = await db.batch([
    db.run(decisionInsert(kind, "retry", parked(table), {
      id: decision.id,
      paymentReturned: null,
      actor: decision.actor,
      reason: decision.reason,
      at: timestamp,
      recordId: id
    })),
    db.update(table).set({ reconcileReviewAt: null, reconcileAttempts: 0, reconcileLastAt: null, reconcileLastError: null }).where(and3(eq5(table.id, id), parked(table), recorded(decision.id))).returning({ id: table.id })
  ]);
  if (!retried.length) throw new Error(notParked(kind));
  console.info("[commerce] Parked checkout returned to reconciliation", { kind, id, actor });
  return { kind, id, status: "pending" };
}
function releaseRefusal(error) {
  const failure = reconcileFailure(error);
  if (failure.code === "provider_unavailable" || failure.code === "provider_refused") {
    return new Error(PROVIDER_UNREACHABLE, { cause: error });
  }
  return isProviderError(error) ? new Error("Stripe returned an error about this checkout session, so nothing was released.", { cause: error }) : error;
}
async function releaseParkedCommerce(options, actor, input) {
  const { kind, id, reason, confirmPaymentReturned = false } = parseAction(releaseSchema, input);
  const decision = newDecision(actor, reason);
  const { env } = options;
  const db = commerceDb(env);
  const table = RECONCILE_TABLES[kind];
  const row = await db.select({
    sessionId: kind === "order" ? orders.checkoutSessionId : giftCardPurchases.providerSessionId,
    createdAt: table.createdAt
  }).from(table).where(and3(eq5(table.id, id), parked(table))).get();
  if (!row) throw new Error(notParked(kind));
  const otherMode = isOtherStripeModeSession(env, row.sessionId);
  const decided = () => db.select({ paymentReturned: reconcileDecisions.paymentReturned }).from(reconcileDecisions).where(eq5(reconcileDecisions.id, decision.id)).get();
  let paymentReturned = null;
  if (kind === "order") {
    try {
      await bindCommerceApi(options).orders.cancel(id, { reviewRelease: { decision, confirmPaymentReturned } });
    } catch (error) {
      throw releaseRefusal(error);
    }
    const outcome = await decided();
    if (!outcome) throw new Error("The order changed while it was being released; reload the list");
    paymentReturned = outcome.paymentReturned;
  } else {
    if (!row.sessionId) {
      if (!confirmPaymentReturned) throw new Error("Find and attach the lost Stripe session, or confirm after checking Stripe that no payment remains before releasing");
      const refusal = uncheckedSessionRefusal(Math.floor(row.createdAt.getTime() / 1e3));
      if (refusal) throw refusal;
      paymentReturned = "confirmed";
    }
    if (row.sessionId) {
      const stripe = options.paymentAdapters?.find((adapter) => adapter.providerId === "stripe");
      if (!stripe?.getCheckoutSession || !stripe.expireCheckoutSession) {
        throw new Error("Stripe must be configured to check this checkout session before the purchase is released");
      }
      const refuseUnchecked = () => {
        const refusal = uncheckedSessionRefusal(Math.floor(row.createdAt.getTime() / 1e3));
        if (refusal) throw refusal;
      };
      if (otherMode) refuseUnchecked();
      if (!otherMode) {
        try {
          let session = null;
          try {
            session = await stripe.getCheckoutSession(row.sessionId);
          } catch (error) {
            if (!isMissingSessionError(error)) throw error;
            refuseUnchecked();
          }
          if (session?.status === "complete") paymentReturned = await completedCheckoutReturn(stripe, session, confirmPaymentReturned);
          else if (session && session.status !== "expired") await stripe.expireCheckoutSession(row.sessionId);
        } catch (error) {
          throw releaseRefusal(error);
        }
      }
    }
    const timestamp = Math.floor(Date.now() / 1e3);
    const [, released] = await db.batch([
      db.run(decisionInsert(kind, "release", parked(table), {
        id: decision.id,
        paymentReturned,
        actor: decision.actor,
        reason: decision.reason,
        at: timestamp,
        recordId: id
      })),
      db.update(giftCardPurchases).set({ status: "cancelled", updatedAt: at2(timestamp) }).where(and3(eq5(giftCardPurchases.id, id), parked(giftCardPurchases), recorded(decision.id))).returning({ id: giftCardPurchases.id })
    ]);
    if (!released.length) throw new Error("The purchase changed while it was being released; reload the list");
  }
  console.info("[commerce] Parked checkout released", { kind, id, actor, otherMode });
  return { kind, id, status: "cancelled", otherMode, paymentReturned };
}
async function attachGiftPurchaseSession(options, actor, input) {
  const values = parseAction(z.object({
    purchaseId: z.string().min(1).max(128),
    sessionId: z.string().regex(/^cs_(test_|live_)?[a-zA-Z0-9_]+$/),
    reason: z.string().trim().min(8).max(500)
  }).strict(), input);
  const decision = newDecision(actor, values.reason);
  const db = commerceDb(options.env);
  const purchase = await db.select().from(giftCardPurchases).where(eq5(giftCardPurchases.id, values.purchaseId)).get();
  if (!purchase || purchase.status !== "pending" || purchase.providerSessionId) throw new Error("Purchase is not awaiting a lost session");
  const adapter = options.paymentAdapters?.find((adapter2) => adapter2.providerId === "stripe");
  if (!adapter?.getCheckoutSession) throw new Error("Stripe is not configured");
  const session = await adapter.getCheckoutSession(values.sessionId);
  if (session.references?.giftCardPurchaseId !== purchase.id || session.amountTotal !== purchase.amountCents || session.currency !== purchase.currency || isOtherStripeModeSession(options.env, values.sessionId)) throw new Error("Stripe session does not match the gift card purchase");
  await db.batch([
    db.run(decisionInsert(
      "gift_card_purchase",
      "attach_session",
      sql5`status = 'pending' AND provider_session_id IS NULL`,
      { id: decision.id, paymentReturned: null, actor, reason: values.reason, at: Math.floor(Date.now() / 1e3), recordId: purchase.id }
    )),
    db.update(giftCardPurchases).set({
      providerSessionId: values.sessionId,
      reconcileReviewAt: null,
      reconcileAttempts: 0,
      reconcileLastAt: null,
      reconcileLastError: null
    }).where(and3(eq5(giftCardPurchases.id, purchase.id), recorded(decision.id)))
  ]);
  if (!await db.select({ id: reconcileDecisions.id }).from(reconcileDecisions).where(eq5(reconcileDecisions.id, decision.id)).get())
    throw new Error("The purchase changed; reload and review it again");
  return { purchaseId: purchase.id, status: "pending" };
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
      /** Shopper-safe parcel contents and return progress, after the same ownership check as order status. */
      tracking: (id, sessionToken, customerId, orderAccessToken) => readOrderTracking(ctx, id, sessionToken, customerId, orderAccessToken),
      resumeFromCart: (cartId, options2 = {}) => resumeCheckout(ctx, cartId, options2),
      reconcilePending: (id) => reconcilePendingOrder(ctx, id),
      createFromCart: (cartId, options2) => createOrderFromCart(ctx, cartId, options2),
      create: (data) => createOrder(ctx, data),
      find: (id) => findOrder(ctx, id),
      findForSession: (id, sessionToken, customerId, orderAccessToken) => findOrderForSession(ctx, id, sessionToken, customerId, orderAccessToken),
      updateStatus: (id, status, fulfillment) => updateOrderStatus(ctx, id, status, fulfillment),
      finalizePayment: (id, options2) => finalizeOrderPayment(ctx, { orderId: id, ...options2 }),
      cancel: (id, options2 = {}) => cancelOrder(ctx, id, options2)
    },
    returns: {
      exchangeChoices: (input, owner = {}) => readCustomerExchangeChoices(ctx, input, owner),
      read: (id, owner = {}) => readCustomerReturns(ctx, id, owner),
      request: (input, owner = {}) => createCustomerReturn(ctx, input, owner),
      cancel: (input, owner = {}) => cancelCustomerReturn(ctx, input, owner)
    },
    webhooks: {
      handleStripe: (payload, signature, secret) => handleStripeWebhook(ctx, payload, signature, secret)
    }
  };
}

export {
  shippingOptionsFor,
  reconcileCommerce,
  purgeStaleCommerceData,
  ReconcileInputError,
  listParkedCommerce,
  retryParkedCommerce,
  releaseParkedCommerce,
  attachGiftPurchaseSession,
  bindCommerceApi
};
