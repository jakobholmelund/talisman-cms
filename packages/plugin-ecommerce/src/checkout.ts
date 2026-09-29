import { and, eq, isNull, lt, notExists, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { CommerceContext } from './commerce-context';
import { commitBatch, errorText } from './db';
import * as schema from './schema';
import { hasPurchaseHistory } from './accounts';
import { aggregateComponentDemand, loadBasketCatalog, requireVariantChoice, resolveSelectedVariant,
  type InventoryTarget, type RequiredComponent } from './basket';
import { UNDELIVERABLE_COUNTRY, withCountryCode } from './checkout-input';
import { canonicalEmail, canonicalEmails, hasCanonicalPurchase } from './email-identity';
import { evaluateGiftCard } from './gift-cards';
import { INVENTORY_COLUMNS } from './inventory';
import { minimumChargeAmount } from './money';
import { cancelOrder, discardCheckoutDiscount, finalizeOrderPayment, findOrder } from './orders';
import { evaluateDiscountCode } from './promotions';
import { mayAskPaymentProvider } from './provider-checks';
import { ReconcileFailure, assertStoreStripeMode, reconcileFailure, sessionLookupFailure } from './reconcile';
import { findReferralCode, getReferralPolicy } from './referrals';
import { chooseShippingRate, deliveryEstimate, shippingCharge } from './shipping';
import { readStoreSettings } from './store-settings';
import { calculateOrderTax, taxAddressFor, taxableLines } from './tax';

// Checkout: pricing a basket (discount, store credit, shipping, tax, gift card), reserving its stock
// and opening the provider session in one atomic step, and following a pending checkout until its
// payment is confirmed or it is released.

/** The rows of a JSON list of reservations. */
const reservationRows = (list: string) => sql`SELECT json_extract(value, '$.target') AS target, json_extract(value, '$.amount') AS amount
  FROM json_each(${list})`;

export async function createOrderFromCart(ctx: CommerceContext, cartId: string, options: {
  customerEmail: string; 
  providerId?: string;
  shippingAddress?: any; 
  billingAddress?: any;
  /** One of the store's shipping rates. Without it, the first rate that serves the country. */
  shippingRateId?: string;
  successUrl: string;
  cancelUrl: string;
  referralCode?: string;
  discountCode?: string;
  giftCardCode?: string;
}) {
  const { env, db, adapters: paymentAdapters } = ctx;
  // Read before the basket is locked, so invalid store settings stop checkout without writes.
  const settings = readStoreSettings(env);
  const { currency, deliveryCountries } = settings;
  const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
  if (!cart || cart.items.length === 0) {
    throw new Error('Cart is empty or not found');
  }
  if (cart.closed) {
    throw new Error('Cart is closed');
  }
  if (cart.checkoutSessionId) {
    throw new Error('Checkout already started for this cart');
  }
  // The simulated admin_test provider is used only when a caller names it.
  const defaultAdapter = options.providerId
    ? paymentAdapters.find((adapter) => adapter.providerId === options.providerId)
    : paymentAdapters.length === 1 && paymentAdapters[0].providerId !== 'admin_test' ? paymentAdapters[0] : undefined;
  if (!defaultAdapter) throw new Error('A payment provider must be selected and configured before checkout');

  let requiresShipping = false;
  let totalAmount = 0;
  const orderItems: Array<{ productId: string; variantId?: string; quantity: number; priceAtPurchase: number; name: string; usesComponents?: boolean }> = [];
  const componentItems: Array<{ quantity: number; components: RequiredComponent[] }> = [];
  const inventoryDemand = new Map<string, InventoryTarget>();

  // Fetch real product details from the database
  const catalog = await loadBasketCatalog(ctx, cart.items);
  for (const item of cart.items) {
     const product = catalog.products.get(String(item.productId));
     if (!product) {
        throw new Error(`Product not found: ${item.productId}`);
     }
     if (product.status !== 'active') {
        throw new Error(`Product is not available: ${item.productId}`);
     }
     // A line saved before its product had variants must be changed to one of them first.
     requireVariantChoice(catalog, product, item.variantId);

     let price = product.basePrice;
     let finalName = product.name;
     let availableQuantity = product.inventoryQuantity;
     let requiredComponents: RequiredComponent[] = [];
     let inventoryTarget: { type: InventoryTarget['type']; id: string } | null =
       { type: 'product', id: product.id };

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

     const tracksInventory = product.type === 'standard';
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
     if (!Number.isSafeInteger(totalAmount)) throw new Error('Order total is too large');

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

  if (requiresShipping && (!options.shippingAddress ||
    !['name', 'line1', 'city', 'postalCode', 'country'].every((key) =>
      typeof options.shippingAddress[key] === 'string' && options.shippingAddress[key].trim()))) {
     throw new Error('Shipping address is required for physical products');
  }
  // The same rule for every provider, the simulated one too. The billing country must be a
  // country code but is not restricted, and a basket with nothing to ship is not held to the list.
  const shippingAddress = withCountryCode(options.shippingAddress);
  const billingAddress = withCountryCode(options.billingAddress);
  if (requiresShipping && deliveryCountries && !deliveryCountries.includes(shippingAddress.country)) {
    throw new Error(UNDELIVERABLE_COUNTRY);
  }
  // With shipping rates, an order that ships goes only where a rate serves, at the one the
  // shopper chose or else the first. Without rates, or with nothing to ship, shipping is free.
  const shippingRate = requiresShipping && settings.shippingRates.length
    ? chooseShippingRate(settings, shippingAddress.country, options.shippingRateId) : null;
  // With a Stripe tax mode every order is taxed but the simulated ones, for where it ships, or
  // for the billing address when nothing ships.
  const taxBehavior = settings.tax.mode === 'none' || defaultAdapter.providerId === 'admin_test' ? null
    : settings.tax.mode === 'stripe-inclusive' ? 'inclusive' : 'exclusive';
  const taxAddress = taxBehavior ? taxAddressFor(requiresShipping, shippingAddress, billingAddress) : null;

  const orderId = `ord_${crypto.randomUUID()}`;
  const referralsPolicy = await getReferralPolicy(env);
  const subtotalAmount = totalAmount;
  const discount = options.discountCode && defaultAdapter.providerId === 'stripe'
    ? await evaluateDiscountCode(env, {
      code: options.discountCode, customerEmail: options.customerEmail,
      accountId: cart.userId, lines: orderItems, subtotal: subtotalAmount
    }) : null;
  const discountAmount = discount?.amount ?? 0;
  const merchandise = subtotalAmount - discountAmount;
  const shippingAmount = shippingRate ? shippingCharge(shippingRate, merchandise) : 0;
  let creditApplied = 0;
  const owner = cart.userId ? await db.select({ creditBalance: schema.customerAccounts.creditBalance,
    emailNormalized: schema.customerAccounts.emailNormalized })
    .from(schema.customerAccounts).where(eq(schema.customerAccounts.id, cart.userId)).get() : undefined;
  if (owner && defaultAdapter.providerId === 'stripe') {
    // Credit pays for items only, and leaves at least Stripe's minimum charge for the currency on
    // the card. It is never offered to a guest basket.
    creditApplied = Math.min(Math.max(0, owner.creditBalance), merchandise,
      Math.max(0, merchandise + shippingAmount - minimumChargeAmount(currency)));
  }
  // Tax is calculated on the items after the discount and credit, and on the shipping. A gift
  // card is a means of payment, so it never lowers the taxed amounts.
  const tax = taxBehavior && taxAddress ? await calculateOrderTax(defaultAdapter, {
    cartId, currency, behavior: taxBehavior, settings: settings.tax, shippingAmount, ...taxAddress,
    lines: taxableLines(orderItems, { amount: discountAmount, productIds: discount?.eligibleProductIds ?? [] },
      creditApplied),
  }) : null;
  // Exclusive tax is added to what the shopper pays; inclusive tax is already in the prices.
  const exclusiveTax = tax?.behavior === 'exclusive' ? tax.amount : 0;
  const amountDue = merchandise - creditApplied + shippingAmount + exclusiveTax;
  if (!Number.isSafeInteger(amountDue)) throw new Error('Order total is too large');
  // A gift card is a means of payment: it can pay for shipping too.
  const giftCard = options.giftCardCode && defaultAdapter.providerId === 'stripe'
    ? await evaluateGiftCard(env, options.giftCardCode, amountDue) : null;
  const giftCardApplied = giftCard?.amount ?? 0;
  totalAmount = amountDue - giftCardApplied;
  const internallyPaid = Boolean(giftCard && totalAmount === 0);
  let referralCode: string | null = null;
  if (referralsPolicy.enabled && options.referralCode && defaultAdapter.providerId === 'stripe' &&
      !internallyPaid && subtotalAmount - discountAmount >= referralsPolicy.minOrderCents) {
    // A referral is for a first purchase. A shopper who signed up first still qualifies;
    // only past paid orders under the account or either email rule it out. Addresses are
    // compared exactly and in canonical form, for the referrer and for earlier buyers.
    const referral = await findReferralCode(env, options.referralCode);
    const buyerEmails = [options.customerEmail.trim().toLowerCase(), owner?.emailNormalized];
    const referrerCanonical = canonicalEmail(referral?.emailNormalized);
    if (referral && referrerCanonical && referral.accountId !== cart.userId &&
        !buyerEmails.includes(referral.emailNormalized) &&
        !canonicalEmails(buyerEmails).includes(referrerCanonical) &&
        !await hasPurchaseHistory(env, { emails: buyerEmails, accountIds: [cart.userId] }) &&
        !await hasCanonicalPurchase(env, buyerEmails)) {
      referralCode = referral.code;
    }
  }
  if (!defaultAdapter.expireCheckoutSession) {
    throw new Error('Payment provider must support checkout session expiry');
  }
  const successUrl = options.successUrl.replaceAll('{ORDER_ID}', orderId);
  const cancelUrl = options.cancelUrl.replaceAll('{ORDER_ID}', orderId);
  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const preparationLock = `preparing:${orderId}`;
  // The lines are compared as stored, so a basket changed since it was read is not locked.
  const lock = await db.update(schema.carts)
    .set({ checkoutSessionId: preparationLock, updatedAt: now, version: sql`${schema.carts.version} + 1` })
    .where(and(eq(schema.carts.id, cartId), eq(schema.carts.closed, false), isNull(schema.carts.checkoutSessionId),
      eq(schema.carts.items, cart.items), eq(schema.carts.version, cart.version)))
    .returning({ id: schema.carts.id });
  if (!lock.length) throw new Error('Checkout already started for this cart');

  let session: Awaited<ReturnType<typeof defaultAdapter.createCheckoutSession>> | undefined;
  let committed = false;
  // The provider may have created a discount for this checkout once it was asked for a session.
  let providerDiscount = false;
  try {
  providerDiscount = !internallyPaid && creditApplied + discountAmount + giftCardApplied > 0;
  session = internallyPaid ? { providerSessionId: `internal:${orderId}`, url: successUrl }
    : await defaultAdapter.createCheckoutSession({
     orderId,
     currency,
     items: orderItems.map(i => ({
        name: i.name,
        priceCents: i.priceAtPurchase,
        quantity: i.quantity
     })),
     customerEmail: options.customerEmail,
     creditApplied,
     discountApplied: discountAmount,
     giftCardApplied,
     shipping: shippingRate ? { label: shippingRate.label, amount: shippingAmount,
       description: deliveryEstimate(shippingRate) ?? undefined } : undefined,
     tax: exclusiveTax > 0 ? { amount: exclusiveTax } : undefined,
     metadata: { giftCardApplied: String(giftCardApplied),
       storeCreditApplied: String(creditApplied), promotionDiscount: String(discountAmount) },
     successUrl,
     cancelUrl
  });
  if (!session.providerSessionId || !session.url) throw new Error('Payment provider did not return a checkout session');
  const checkoutSessionId = session.providerSessionId;
  const statements: BatchItem<'sqlite'>[] = [
    db.insert(schema.orders).values({
      id: orderId, cartId, userId: cart.userId, checkoutSessionId, paymentProvider: internallyPaid ? 'gift_card' : defaultAdapter.providerId,
      status: 'pending', items: orderItems.map(({ name, ...rest }) => rest), totalAmount,
      subtotalAmount, creditApplied, discountCode: discount?.code ?? null, discountAmount,
      giftCardId: giftCard?.id ?? null, giftCardApplied,
      referralCode, referralRewardCents: referralCode ? referralsPolicy.rewardCents : 0, currency,
      shippingAmount, shippingRateId: shippingRate?.id ?? null, shippingLabel: shippingRate?.label ?? null,
      taxAmount: tax?.amount ?? 0, taxBehavior: tax?.behavior ?? null, taxCalculationId: tax?.calculationId ?? null,
      customerEmail: options.customerEmail, shippingAddress: shippingAddress ?? null, billingAddress: billingAddress ?? null,
      createdAt: now, updatedAt: now,
    }),
  ];
  if (discount) {
    statements.push(db.insert(schema.discountRedemptions).values({
      id: `dred_${orderId}`, code: discount.code, orderId, accountId: cart.userId, emailNormalized: discount.emailNormalized,
      amountCents: discount.amount, status: 'reserved', createdAt: now, updatedAt: now,
    }));
  }
  if (giftCard) {
    statements.push(db.insert(schema.giftCardRedemptions).values({
      id: `gcr_${orderId}`, cardId: giftCard.id, orderId, amountCents: giftCardApplied, status: 'reserved', createdAt: now, updatedAt: now,
    }));
  }
  if (creditApplied && cart.userId) {
    statements.push(db.insert(schema.creditLedger).values({
      id: `credit_hold_${orderId}`, accountId: cart.userId, orderId, kind: 'checkout_reserve', amountCents: -creditApplied, createdAt: now,
    }));
  }
  // One statement per table whatever the size of the basket: each reads its rows from a JSON list.
  // Stock writes move updated_at by at least a second, so an admin save of stock loaded before
  // this reservation is refused as stale instead of overwriting it.
  const reserves = defaultAdapter.reservesInventory !== false;
  const componentReservations = reserves ? [...componentDemand].map(([target, demand]) =>
    ({ id: crypto.randomUUID(), target, amount: demand.quantity })) : [];
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
  const inventoryReservations = reserves ? [...inventoryDemand.values()].map((demand) =>
    ({ id: crypto.randomUUID(), type: demand.type, target: demand.id, amount: demand.quantity })) : [];
  for (const [type, [table, column]] of Object.entries(INVENTORY_COLUMNS)) {
    const list = inventoryReservations.filter((reservation) => reservation.type === type);
    if (!list.length) continue;
    statements.push(db.run(sql`UPDATE ${sql.raw(table)}
      SET ${sql.raw(column)} = ${sql.raw(column)} - demand.amount, updated_at = MAX(updated_at + 1, ${timestamp})
      FROM (${reservationRows(JSON.stringify(list))}) AS demand WHERE ${sql.raw(table)}.id = demand.target`));
  }
  if (inventoryReservations.length) {
    statements.push(db.run(sql`INSERT INTO _ecommerce_inventory_reservations
      (id, order_id, target_type, target_id, quantity)
      SELECT json_extract(value, '$.id'), ${orderId}, json_extract(value, '$.type'), json_extract(value, '$.target'),
        json_extract(value, '$.amount')
      FROM json_each(${JSON.stringify(inventoryReservations)})`));
  }
  statements.push(db.update(schema.carts).set({ checkoutSessionId, updatedAt: now })
    .where(and(eq(schema.carts.id, cartId), eq(schema.carts.checkoutSessionId, preparationLock))));
  // D1 batches are atomic; nonnegative constraints reject competing reservations.
  try {
    await commitBatch(db, statements);
    committed = true;
  } catch (cause) {
    // The database's refusal, a trigger's or a constraint's message, is under the query error.
    const refused = errorText(cause);
    if (refused.includes('Discount code is no longer available')) {
      throw new Error('Discount code is no longer available', { cause });
    }
    if (refused.includes('Insufficient store credit')) {
      throw new Error('Store credit changed during checkout; please try again', { cause });
    }
    if (refused.includes('Gift card is no longer available')) {
      throw new Error('Gift card is no longer available', { cause });
    }
    throw new Error('Insufficient stock or checkout already started', { cause });
  }

  const order = await findOrder(ctx, orderId);
  if (!order) throw new Error('Checkout was created but the order could not be loaded');
  if (internallyPaid) {
    await finalizeOrderPayment(ctx, { orderId, provider: 'gift_card',
      providerId: checkoutSessionId, paymentStatus: 'success', amount: 0,
      customerEmail: options.customerEmail });
    return { order: (await findOrder(ctx, orderId))!, paymentUrl: session.url };
  }
  return { order, paymentUrl: session.url };
  } catch (error) {
    if (committed) throw error;
    try {
      if (session?.providerSessionId && !internallyPaid) {
        // Never unlock the basket while a provider session may still accept payment.
        await defaultAdapter.expireCheckoutSession(session.providerSessionId);
      }
    } finally {
      if (providerDiscount) await discardCheckoutDiscount(defaultAdapter, orderId);
    }
    await db.update(schema.carts).set({ checkoutSessionId: null })
      .where(and(eq(schema.carts.id, cartId), eq(schema.carts.checkoutSessionId, preparationLock)));
    throw error;
  }
}

/**
 * The pending checkout that locks a basket: its payment URL while the provider session is open,
 * or null once the lock is gone. Public routes pass `limitProviderChecks`, so the provider is asked
 * only when the order's provider-check slot is free (see provider-checks.ts); otherwise the order is
 * returned as stored, with `providerCheckLimited` and no payment URL. An order parked for review, or
 * one whose check failed in a way no retry fixes, is returned with `review` and no payment URL; the
 * provider is not asked about a parked one.
 */
export async function resumeCheckout(ctx: CommerceContext, cartId: string, options: { limitProviderChecks?: boolean } = {}) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
  if (!cart?.checkoutSessionId) return null;
  if (cart.checkoutSessionId.startsWith('preparing:')) {
    // Stripe sessions created by this plugin expire after 31 minutes. A Worker can
    // stop between locking the basket and persisting the provider session; only
    // release that orphaned lock after the possible session has expired.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cutoff = nowSeconds - 35 * 60;
    const pendingOrder = db.select({ one: sql`1` }).from(schema.orders)
      .where(and(eq(schema.orders.cartId, schema.carts.id), eq(schema.orders.status, 'pending')));
    await db.update(schema.carts)
      .set({ checkoutSessionId: null, updatedAt: new Date(nowSeconds * 1000), version: sql`${schema.carts.version} + 1` })
      .where(and(eq(schema.carts.id, cartId), eq(schema.carts.checkoutSessionId, cart.checkoutSessionId),
        lt(schema.carts.updatedAt, new Date(cutoff * 1000)), notExists(pendingOrder)));
    return null;
  }
  const order = await db.select().from(schema.orders)
    .where(eq(schema.orders.checkoutSessionId, cart.checkoutSessionId)).get();
  if (!order || order.status !== 'pending') return null;
  if (order.paymentProvider === 'gift_card' && order.totalAmount === 0) {
    await finalizeOrderPayment(ctx, { orderId: order.id, provider: 'gift_card',
      providerId: order.checkoutSessionId!, paymentStatus: 'success', amount: 0,
      customerEmail: order.customerEmail ?? undefined });
    return { order: (await findOrder(ctx, order.id))!, paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
  }
  // A parked checkout keeps its basket locked until an administrator retries or releases it.
  if (order.reconcileReviewAt) return { order, paymentUrl: null, review: true };
  if (options.limitProviderChecks && !await mayAskPaymentProvider(env, order, paymentAdapters)) {
    return { order, paymentUrl: null, providerCheckLimited: true };
  }
  let reconciled;
  try {
    reconciled = await reconcilePendingOrder(ctx, order.id);
  } catch (error) {
    // No retry fixes this one: scheduled reconciliation parks it and reports it once.
    if (reconcileFailure(error).permanent) return { order, paymentUrl: null, review: true };
    throw error;
  }
  if (reconciled?.status === 'paid') {
    return { order: (await findOrder(ctx, order.id))!, paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
  }
  if (reconciled?.status === 'cancelled') return null;
  return { order, paymentUrl: reconciled?.paymentUrl ?? null };
}

export async function reconcilePendingOrder(ctx: CommerceContext, id: string) {
  const { env, adapters: paymentAdapters } = ctx;
  const order = await findOrder(ctx, id);
  if (!order || order.status !== 'pending' || !order.checkoutSessionId) return null;
  if (order.paymentProvider === 'gift_card') {
    await finalizeOrderPayment(ctx, { orderId: order.id, provider: 'gift_card',
      providerId: order.checkoutSessionId, paymentStatus: 'success', amount: 0,
      customerEmail: order.customerEmail ?? undefined });
    return { status: 'paid', paymentUrl: null };
  }
  if (order.paymentProvider === 'admin_test') {
    // Only the admin test route registers the simulated provider; public status checks never settle it.
    // The owner can cancel it, and reconcileCommerce releases it once stale.
    if (!paymentAdapters.some((candidate) => candidate.providerId === 'admin_test')) {
      return { status: 'pending', paymentUrl: null };
    }
    await finalizeOrderPayment(ctx, { orderId: order.id, provider: 'admin_test',
      providerId: order.checkoutSessionId, paymentStatus: 'success',
      amount: order.totalAmount, currency: order.currency });
    return { status: 'paid', paymentUrl: null };
  }
  // A parked order waits for an administrator's retry or release; nothing asks the provider about it.
  if (order.reconcileReviewAt) return { status: 'pending', paymentUrl: null, review: true };
  // Failures that another attempt cannot change throw a permanent ReconcileFailure, which
  // reconcileCommerce parks; the provider's own errors are classified there.
  const provider = order.paymentProvider ?? 'stripe';
  const adapter = paymentAdapters.find((candidate) => candidate.providerId === provider);
  if (!adapter?.getCheckoutSession) {
    throw new ReconcileFailure('provider_not_configured', 'Payment provider cannot reconcile checkout');
  }
  // Checked once Stripe is configured: its key then matches the mode setting, so a session of the
  // other mode is a leftover. Without Stripe, a missing mode setting would make every session look
  // like one, and the order waits like any other missing configuration.
  if (provider === 'stripe') assertStoreStripeMode(env, order.checkoutSessionId);
  const session = await adapter.getCheckoutSession(order.checkoutSessionId)
    .catch((error: unknown) => { throw sessionLookupFailure(error); });
  if (session.status === 'expired') {
    await cancelOrder(ctx, id, { sessionExpired: true });
    return { status: 'cancelled', paymentUrl: null };
  }
  if (session.status === 'complete' && session.paymentStatus === 'paid') {
    // What the provider charged must equal the order's total, which includes shipping and exclusive
    // tax; a mismatch stays a permanent failure.
    if (session.amountTotal !== order.totalAmount ||
      session.currency?.toLowerCase() !== order.currency.toLowerCase() ||
      (provider === 'stripe' && !session.paymentIntentId)) {
      throw new ReconcileFailure('payment_mismatch', 'Completed payment does not match pending order');
    }
    await finalizeOrderPayment(ctx, { orderId: id, provider: order.paymentProvider ?? 'stripe',
      providerId: order.checkoutSessionId, paymentStatus: 'success',
      amount: session.amountTotal, currency: session.currency,
      paymentIntentId: session.paymentIntentId ?? undefined,
      customerEmail: session.customerEmail ?? undefined });
    return { status: 'paid', paymentUrl: null };
  }
  return { status: 'pending', paymentUrl: session.status === 'open' ? session.url : null };
}
