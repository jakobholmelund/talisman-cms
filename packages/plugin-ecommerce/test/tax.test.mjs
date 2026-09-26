import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi, reconcileCommerce } from '../dist/api.js';
import { AdminTestPaymentAdapter } from '../dist/adapters/admin-test.js';
import { StripePaymentAdapter } from '../dist/adapters/stripe.js';
import { TaxAddressError, TaxCalculationError } from '../dist/index.js';
import { createDiscountCode } from '../dist/promotions.js';
import { issueAdminGiftCard, refundGiftCardOnlyOrder, refundGiftCardTender } from '../dist/gift-cards.js';
import { listCustomerOrders } from '../dist/accounts.js';

const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql', '0028_provider_refunds_and_disputes.sql',
  '0029_commerce_reconcile_backoff.sql'];

/** A frame and a case that ship, and a digital guide that does not. */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrationFiles) {
    const sql = readFileSync(new URL(`../../talisman-cms/drizzle/${migration}`, import.meta.url), 'utf8');
    sqlite.exec(sql.replaceAll('--> statement-breakpoint', ''));
  }
  const DB = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: prepared.all(...values) }; },
        async first() { return prepared.get(...values) ?? null; },
        async raw() {
          const raw = sqlite.prepare(sql);
          raw.setReturnArrays(true);
          return raw.all(...values);
        },
        async run() { return { meta: prepared.run(...values) }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  const now = Math.floor(Date.now() / 1000);
  const product = sqlite.prepare(`INSERT INTO _ecommerce_products
    (id, name, slug, base_price, inventory_quantity, is_physical, type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 20, ?, ?, 'active', ?, ?)`);
  product.run('frame', 'Frame', 'frame', 12000, 1, 'standard', now, now);
  product.run('case', 'Case', 'case', 2000, 1, 'standard', now, now);
  product.run('guide', 'Guide', 'guide', 3000, 0, 'digital', now, now);
  return { sqlite, DB };
}

const shippingAddress = { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', state: 'TX',
  postalCode: '78701', country: 'US' };
const checkout = { customerEmail: 'shopper@example.test', shippingAddress,
  successUrl: 'https://example.test/success?order={ORDER_ID}', cancelUrl: 'https://example.test/cancel?order={ORDER_ID}' };
const exclusive = { TALISMAN_COMMERCE_TAX: 'stripe-exclusive' };
const inclusive = { TALISMAN_COMMERCE_TAX: 'stripe-inclusive' };
const withShipping = { TALISMAN_COMMERCE_SHIPPING_RATES: JSON.stringify([
  { id: 'standard', label: 'Standard shipping', amount: 700 }]) };
const giftCardKey = { TALISMAN_COMMERCE_GIFT_CARD_KEY: 'a'.repeat(64) };

/**
 * Stands in for Stripe with a flat 10% tax and records every request. A test can replace the
 * calculation, make the next transaction fail or have a function pick the failure of each, or act
 * while a reversal is in flight.
 */
function taxingProvider(state = {}) {
  const calls = { sessions: [], calculations: [], transactions: [], reversals: [] };
  const adapter = {
    providerId: 'stripe',
    async createCheckoutSession(input) {
      calls.sessions.push(input);
      return { providerSessionId: `cs_test_${input.orderId}`, url: `https://checkout.stripe.test/${input.orderId}` };
    },
    async expireCheckoutSession() {},
    async validateWebhook(payload) { return JSON.parse(payload); },
    async calculateTax(params) {
      calls.calculations.push(params);
      if (state.calculate) return state.calculate(params);
      const base = params.lines.reduce((sum, line) => sum + line.amount, 0) + params.shippingAmount;
      const added = params.behavior === 'exclusive';
      const tax = added ? Math.round(base / 10) : base - Math.round(base / 1.1);
      return { id: `taxcalc_${calls.calculations.length}`, amountTotal: base + (added ? tax : 0),
        taxAmountExclusive: added ? tax : 0, taxAmountInclusive: added ? 0 : tax };
    },
    async recordTaxTransaction(params) {
      calls.transactions.push(params);
      const failure = state.recordError ?? state.recordFails?.(params);
      state.recordError = null;
      if (failure) throw failure;
      return { transactionId: `tax_${params.orderId}` };
    },
    async reverseTaxTransaction(params) {
      const number = calls.reversals.push(params);
      const onReverse = state.onReverse;
      state.onReverse = null;
      if (onReverse) await onReverse(params);
      const failure = state.reverseError ?? state.reverseFails?.(params);
      state.reverseError = null;
      if (failure) throw failure;
      return { reversalId: `taxrev_${number}` };
    },
  };
  return { adapter, calls, state };
}

async function placeOrder(api, browser, lines, details = {}, accountId) {
  const cart = await api.carts.getOrCreate(browser, accountId);
  await api.carts.updateItems(cart.id, lines);
  return (await api.orders.createFromCart(cart.id, { ...checkout, ...details })).order;
}

const pay = (api, order, paymentIntentId) => api.orders.finalizePayment(order.id, { provider: 'stripe',
  providerId: order.checkoutSessionId, paymentStatus: 'success', amount: order.totalAmount, currency: 'usd',
  paymentIntentId });

const providerRefund = (api, paymentIntentId, amount, amountRefunded) => api.webhooks.handleStripe(JSON.stringify({
  type: 'charge.refunded', data: { payment_intent: paymentIntentId, amount, amount_refunded: amountRefunded, currency: 'usd' },
}), 'signature', 'secret');

/** The stored [tax amount, tax behavior, calculation, transaction, total] of an order. */
function storedTax(sqlite, orderId) {
  const order = sqlite.prepare(`SELECT tax_amount, tax_behavior, tax_calculation_id, tax_transaction_id, total_amount
    FROM _ecommerce_orders WHERE id = ?`).get(orderId);
  return [order.tax_amount, order.tax_behavior, order.tax_calculation_id, order.tax_transaction_id, order.total_amount];
}

const reversals = (sqlite, orderId) => sqlite.prepare(`SELECT reference, amount, provider_reversal_id
  FROM _ecommerce_tax_reversals WHERE order_id = ? ORDER BY created_at, amount`).all(orderId).map((row) => ({ ...row }));

/** An order's failed tax attempts since its last success, and the code of the last one. */
const orderTaxSync = (sqlite, orderId) => ({ ...sqlite.prepare(`SELECT tax_sync_attempts AS attempts,
  tax_sync_last_error AS lastError FROM _ecommerce_orders WHERE id = ?`).get(orderId) });
/** Each reversal of an order: its amount, whether it was sent, and its failed attempts since its last success. */
const reversalSync = (sqlite, orderId) => sqlite.prepare(`SELECT amount, provider_reversal_id <> '' AS sent,
  tax_sync_attempts AS attempts, tax_sync_last_error AS lastError FROM _ecommerce_tax_reversals
  WHERE order_id = ? ORDER BY created_at, amount`).all(orderId).map((row) => ({ ...row }));

/** Mocks Date only, so the test decides how much time passes between runs. */
function clock(t) {
  const start = Math.floor(Date.now() / 1000) * 1000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  return (seconds) => t.mock.timers.setTime(start + seconds * 1000);
}

// Stripe errors as the SDK throws them: a request Stripe will never take, such as the record of an
// expired calculation, and an outage.
const rejected = () => Object.assign(new Error('The tax calculation has expired'),
  { type: 'StripeInvalidRequestError', statusCode: 400 });
const unreachable = () => Object.assign(new Error('An error occurred with our connection to Stripe.'),
  { type: 'StripeConnectionError' });

const frameAndCase = [{ productId: 'frame', quantity: 1 }, { productId: 'case', quantity: 1 }];

test('inclusive tax is calculated on the items and shipping, recorded, and changes no amount', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls } = taxingProvider();
  const api = bindCommerceApi({ env: { DB, ...inclusive, ...withShipping, TALISMAN_COMMERCE_TAX_CODE: 'txcd_99999999',
    TALISMAN_COMMERCE_SHIP_FROM_COUNTRY: 'us' }, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'inclusive-browser', frameAndCase);

  assert.deepEqual(calls.calculations, [{
    currency: 'usd', behavior: 'inclusive', taxCode: 'txcd_99999999', shipFromCountry: 'US',
    lines: [{ reference: 'L1:frame', amount: 12000, quantity: 1 }, { reference: 'L2:case', amount: 2000, quantity: 1 }],
    shippingAmount: 700, addressSource: 'shipping',
    // The address, without the shopper's name.
    address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
  }]);
  // $147 including $13.36 of tax: the totals are what they are without tax.
  assert.deepEqual(storedTax(sqlite, order.id), [1336, 'inclusive', 'taxcalc_1', null, 14700]);
  assert.deepEqual([order.subtotalAmount, order.shippingAmount, order.totalAmount], [14000, 700, 14700]);
  assert.equal(calls.sessions[0].tax, undefined);

  await pay(api, order, 'pi_inclusive');
  assert.deepEqual(calls.transactions, [{ orderId: order.id, calculationId: 'taxcalc_1' }]);
  assert.equal(storedTax(sqlite, order.id)[3], `tax_${order.id}`);
  sqlite.close();
});

test('exclusive tax is added to the total and to the provider session, and only the taxed total confirms', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls } = taxingProvider();
  const api = bindCommerceApi({ env: { DB, ...exclusive, ...withShipping }, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'exclusive-browser', frameAndCase);

  assert.deepEqual(storedTax(sqlite, order.id), [1470, 'exclusive', 'taxcalc_1', null, 16170]);
  assert.deepEqual(calls.sessions[0].tax, { amount: 1470 });
  assert.deepEqual(calls.calculations[0].lines.map((line) => line.amount), [12000, 2000]);
  assert.equal(calls.calculations[0].taxCode, null);
  assert.equal(calls.calculations[0].shipFromCountry, null);

  // A payment of the items and shipping without the tax does not confirm the order.
  await assert.rejects(api.orders.finalizePayment(order.id, { provider: 'stripe', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: 14700, currency: 'usd' }), /Payment amount does not match order total/);
  await pay(api, order, 'pi_exclusive');
  assert.equal(sqlite.prepare('SELECT amount FROM _ecommerce_payments WHERE order_id = ?').get(order.id).amount, 16170);
  assert.equal(storedTax(sqlite, order.id)[3], `tax_${order.id}`);
  // A repeated confirmation records the transaction once.
  await pay(api, order, 'pi_exclusive');
  assert.equal(calls.transactions.length, 1);

  // The shopper's orders list the tax with the other totals.
  const account = sqlite.prepare(`SELECT user_id FROM _ecommerce_orders WHERE id = ?`).get(order.id).user_id;
  const [listed] = await listCustomerOrders({ DB }, account);
  assert.deepEqual([listed.taxAmount, listed.taxBehavior, listed.totalAmount], [1470, 'exclusive', 16170]);
  sqlite.close();
});

test('the Stripe session charges the items, the shipping and a Tax line, which add up to the order total', async () => {
  const { sqlite, DB } = database();
  const stripe = new StripePaymentAdapter({ secretKey: 'sk_test_fake' });
  const calls = [];
  stripe.stripe = {
    coupons: { async create(input) { calls.push({ type: 'coupon', input }); return { id: input.id }; } },
    checkout: { sessions: { async create(input) {
      calls.push({ type: 'session', input });
      return { id: 'cs_test_taxed', url: 'https://checkout.stripe.test/taxed' };
    } } },
    tax: { calculations: { async create(input) {
      calls.push({ type: 'calculation', input });
      // Sales tax of 8.25% on the $115 of items left after the discount and the $7 of shipping.
      return { id: 'taxcalc_route', amount_total: 13207, tax_amount_exclusive: 1007, tax_amount_inclusive: 0 };
    } } },
  };
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_discount_codes (code, type, value, created_at, updated_at)
    VALUES ('SAVE500', 'amount', 500, ?, ?)`).run(now, now);
  const api = bindCommerceApi({ env: { DB, ...exclusive, ...withShipping }, paymentAdapters: [stripe] });
  const order = await placeOrder(api, 'stripe-tax-browser', [{ productId: 'frame', quantity: 1 }],
    { discountCode: 'SAVE500' });

  const calculation = calls.find((call) => call.type === 'calculation').input;
  assert.deepEqual(calculation.line_items, [{ amount: 11500, quantity: 1, reference: 'L1:frame', tax_behavior: 'exclusive' }]);
  assert.deepEqual(calculation.shipping_cost, { amount: 700, tax_behavior: 'exclusive' });
  const session = calls.find((call) => call.type === 'session').input;
  assert.deepEqual(session.line_items.map(({ price_data: price, quantity }) => [price.product_data.name, price.unit_amount, quantity]),
    [['Frame', 12000, 1], ['Standard shipping', 700, 1], ['Tax', 1007, 1]]);
  assert.equal(session.automatic_tax, undefined);
  const coupon = calls.find((call) => call.type === 'coupon').input;
  const lines = session.line_items.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0);
  assert.deepEqual([coupon.amount_off, lines - coupon.amount_off], [500, order.totalAmount]);
  assert.deepEqual(storedTax(sqlite, order.id), [1007, 'exclusive', 'taxcalc_route', null, 13207]);
  // The discount redemption guard checked the totals with the exclusive tax in them.
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_discount_redemptions WHERE order_id = ?')
    .get(order.id).status, 'reserved');
  sqlite.close();
});

test('the discount and credit are spread over the lines in proportion, and fully discounted lines are left out', async () => {
  const { sqlite, DB } = database();
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, credit_balance, created_at, updated_at)
    VALUES ('credit-shopper', 'credit-shopper@example.test', 'credit-shopper@example.test', 1001, ?, ?)`).run(now, now);
  const env = { DB, ...exclusive };
  const code = (value, overrides = {}) => ({ description: null, maxDiscountCents: null, minOrderCents: 0,
    eligibleProductIds: [], maxUses: null, maxUsesPerCustomer: null, firstOrderOnly: false, startsAt: null,
    expiresAt: null, active: true, ...value, ...overrides });
  await createDiscountCode(env, code({ code: 'TENOFF', type: 'percent', value: 1000 }));
  await createDiscountCode(env, code({ code: 'CASE5', type: 'amount', value: 500 }, { eligibleProductIds: ['case'] }));
  await createDiscountCode(env, code({ code: 'CASEFREE', type: 'amount', value: 6000 }, { eligibleProductIds: ['case'] }));
  const { adapter, calls } = taxingProvider();
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const basket = [{ productId: 'frame', quantity: 1 }, { productId: 'case', quantity: 3 }];
  const lines = () => calls.calculations.at(-1).lines.map((line) => [line.reference, line.amount, line.quantity]);

  // 10% off $180 is $18, spread $12 and $6; then $10.01 of credit over the $108 and $54 left.
  // Rounded down that is $6.67 and $3.33, and the cent left goes to the larger remainder.
  const credited = await placeOrder(api, 'spread-browser', basket,
    { customerEmail: 'credit-shopper@example.test', discountCode: 'TENOFF' }, 'credit-shopper');
  assert.deepEqual([credited.discountAmount, credited.creditApplied], [1800, 1001]);
  assert.deepEqual(lines(), [['L1:frame', 10133, 1], ['L2:case', 5066, 3]]);
  assert.equal(10133 + 5066, credited.subtotalAmount - credited.discountAmount - credited.creditApplied);

  // A code for the cases is taken off the cases only.
  await placeOrder(api, 'case-code-browser', basket, { discountCode: 'CASE5' });
  assert.deepEqual(lines(), [['L1:frame', 12000, 1], ['L2:case', 5500, 3]]);

  // Cases the code makes free are not sent.
  const free = await placeOrder(api, 'free-case-browser', basket, { discountCode: 'CASEFREE' });
  assert.equal(free.discountAmount, 6000);
  assert.deepEqual(lines(), [['L1:frame', 12000, 1]]);
  assert.deepEqual(storedTax(sqlite, free.id).slice(0, 2), [1200, 'exclusive']);

  // Credit that pays for every item leaves only the shipping taxed. Stripe takes no line at 0, so the
  // shipping is the calculation's only line, under the shipping tax code.
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, credit_balance, created_at, updated_at)
    VALUES ('rich-shopper', 'rich-shopper@example.test', 'rich-shopper@example.test', 50000, ?, ?)`).run(now, now);
  const shipped = bindCommerceApi({ env: { ...env, ...withShipping }, paymentAdapters: [adapter] });
  const covered = await placeOrder(shipped, 'covered-browser', basket,
    { customerEmail: 'rich-shopper@example.test' }, 'rich-shopper');
  assert.deepEqual([covered.creditApplied, covered.shippingAmount, covered.taxAmount, covered.totalAmount],
    [18000, 700, 70, 770]);
  assert.deepEqual([lines(), calls.calculations.at(-1).shippingAmount], [[['shipping', 700, 1]], 0]);
  assert.equal(calls.calculations.at(-1).lines[0].taxCode, 'txcd_92010001');
  sqlite.close();
});

test('a gift card pays part of a taxed order without lowering the taxed amounts, and its refunds are reversed', async () => {
  const { sqlite, DB } = database();
  const env = { DB, ...exclusive, ...giftCardKey };
  const card = await issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Customer service goodwill' });
  const { adapter, calls } = taxingProvider();
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'part-card-browser', [{ productId: 'frame', quantity: 1 }], { giftCardCode: card.code });

  // Tax on the full $120; the card pays $50 of the $132 due.
  assert.deepEqual(calls.calculations[0].lines.map((line) => line.amount), [12000]);
  assert.deepEqual([order.giftCardApplied, order.taxAmount, order.totalAmount], [5000, 1200, 8200]);
  assert.deepEqual([calls.sessions[0].giftCardApplied, calls.sessions[0].tax], [5000, { amount: 1200 }]);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_gift_card_redemptions WHERE order_id = ?')
    .get(order.id).status, 'reserved');
  await pay(api, order, 'pi_part_card');
  assert.equal(storedTax(sqlite, order.id)[3], `tax_${order.id}`);

  // A gift card tender refund is mirrored by the scheduled reconciliation.
  await refundGiftCardTender(env, 'admin-1', { orderId: order.id, amountCents: 2000, reason: 'Returned the case' });
  assert.deepEqual(calls.reversals, []);
  const results = await reconcileCommerce({ env, paymentAdapters: [adapter] });
  assert.deepEqual(results.filter((result) => result.id === order.id), [{ id: order.id, status: 'tax_reversed' }]);
  assert.deepEqual(calls.reversals, [{ orderId: order.id, transactionId: `tax_${order.id}`, amount: 2000,
    reference: `${order.id}:reversal:2000` }]);
  assert.deepEqual(reversals(sqlite, order.id), [{ reference: `${order.id}:reversal:2000`, amount: 2000,
    provider_reversal_id: 'taxrev_1' }]);

  // Refunding the card payment in full refunds the order, gift card included: all of its tax is reversed.
  assert.equal((await providerRefund(api, 'pi_part_card', 8200, 8200)).status, 'refunded');
  assert.deepEqual(reversals(sqlite, order.id).map((row) => [row.reference, row.amount]),
    [[`${order.id}:reversal:2000`, 2000], [`${order.id}:reversal:13200`, 11200]]);
  sqlite.close();
});

test('a gift-card-only order records its tax transaction when it is confirmed, and its refund reverses all of it', async () => {
  const { sqlite, DB } = database();
  const env = { DB, ...exclusive, ...giftCardKey };
  const card = await issueAdminGiftCard(env, 'admin-1', { amountCents: 20000, reason: 'Replacement gift card' });
  const { adapter, calls } = taxingProvider();
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'whole-card-browser', [{ productId: 'frame', quantity: 1 }], { giftCardCode: card.code });

  assert.deepEqual([order.status, order.paymentProvider, order.giftCardApplied, order.totalAmount], ['paid', 'gift_card', 13200, 0]);
  assert.equal(calls.sessions.length, 0);
  assert.deepEqual(calls.transactions, [{ orderId: order.id, calculationId: 'taxcalc_1' }]);
  assert.deepEqual(storedTax(sqlite, order.id), [1200, 'exclusive', 'taxcalc_1', `tax_${order.id}`, 0]);

  await refundGiftCardOnlyOrder(env, 'admin-1', { orderId: order.id, reason: 'Customer returned order' });
  await reconcileCommerce({ env, paymentAdapters: [adapter] });
  await reconcileCommerce({ env, paymentAdapters: [adapter] });
  assert.deepEqual(reversals(sqlite, order.id), [{ reference: `${order.id}:reversal:13200`, amount: 13200,
    provider_reversal_id: 'taxrev_1' }]);
  assert.equal(calls.reversals.length, 1);
  sqlite.close();
});

test('a tax transaction that fails at confirmation is logged, counted and recorded by reconcileCommerce', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (message) => { logged.push(message); });
  const { sqlite, DB } = database();
  const { adapter, calls, state } = taxingProvider();
  const env = { DB, ...exclusive };
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'retry-browser', [{ productId: 'frame', quantity: 1 }]);
  state.recordError = new Error('Stripe is unavailable');

  // The payment is confirmed all the same.
  assert.deepEqual(await pay(api, order, 'pi_retry'), { success: true, orderId: order.id, status: 'paid' });
  assert.deepEqual(storedTax(sqlite, order.id).slice(3), [null, 13200]);
  assert.deepEqual(logged, [`[Commerce] The tax transaction of order ${order.id} was not recorded: Stripe is unavailable`]);
  // The failure counts as an attempt, so reconciliation waits two minutes before it tries again.
  assert.deepEqual(orderTaxSync(sqlite, order.id), { attempts: 1, lastError: 'failed' });
  assert.deepEqual((await reconcileCommerce({ env, paymentAdapters: [adapter] }))
    .filter((result) => result.id === order.id), []);

  // Retried an hour after the payment, the record is dated at the payment; at confirmation it was not.
  const paidAt = Math.floor(Date.now() / 1000) - 3600;
  sqlite.prepare('UPDATE _ecommerce_payments SET created_at = ? WHERE order_id = ?').run(paidAt, order.id);
  sqlite.prepare('UPDATE _ecommerce_orders SET tax_sync_last_at = ? WHERE id = ?').run(paidAt, order.id);
  const results = await reconcileCommerce({ env, paymentAdapters: [adapter] });
  assert.deepEqual(results.filter((result) => result.id === order.id), [{ id: order.id, status: 'tax_recorded' }]);
  assert.equal(storedTax(sqlite, order.id)[3], `tax_${order.id}`);
  assert.deepEqual(calls.transactions.map((call) => call.postedAt), [undefined, paidAt]);
  assert.deepEqual(orderTaxSync(sqlite, order.id), { attempts: 0, lastError: null });
  // Recorded once: the next run finds nothing to record.
  const again = await reconcileCommerce({ env, paymentAdapters: [adapter] });
  assert.deepEqual(again.filter((result) => result.id === order.id), []);
  assert.deepEqual(calls.transactions.map((call) => call.orderId), [order.id, order.id]);
  sqlite.close();
});

test('an order disputed before its tax transaction was recorded still gets it recorded', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { sqlite, DB } = database();
  const { adapter, state } = taxingProvider();
  const env = { DB, ...exclusive };
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'disputed-browser', [{ productId: 'frame', quantity: 1 }]);
  state.recordError = new Error('Stripe is unavailable');
  await pay(api, order, 'pi_disputed');
  // A dispute opens before the retry. It does not undo the sale, so the transaction is still recorded.
  sqlite.prepare(`UPDATE _ecommerce_orders SET status = 'disputed', tax_sync_last_at = tax_sync_last_at - 3600
    WHERE id = ?`).run(order.id);
  const results = await reconcileCommerce({ env, paymentAdapters: [adapter] });
  assert.deepEqual(results.filter((result) => result.id === order.id), [{ id: order.id, status: 'tax_recorded' }]);
  assert.equal(storedTax(sqlite, order.id)[3], `tax_${order.id}`);
  sqlite.close();
});

test('partial and full provider refunds are reversed up to what was refunded, each once', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls } = taxingProvider();
  const env = { DB, ...exclusive };
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'refund-browser', [{ productId: 'frame', quantity: 1 }]);
  await pay(api, order, 'pi_refunded');

  await providerRefund(api, 'pi_refunded', 13200, 5000);
  // A repeated delivery of the same refund reverses nothing more.
  await providerRefund(api, 'pi_refunded', 13200, 5000);
  assert.deepEqual(reversals(sqlite, order.id), [{ reference: `${order.id}:reversal:5000`, amount: 5000,
    provider_reversal_id: 'taxrev_1' }]);
  const refunded = await providerRefund(api, 'pi_refunded', 13200, 13200);
  assert.deepEqual(refunded, { success: true, orderId: order.id, status: 'refunded' });
  assert.deepEqual(reversals(sqlite, order.id).map((row) => [row.reference, row.amount]),
    [[`${order.id}:reversal:5000`, 5000], [`${order.id}:reversal:13200`, 8200]]);
  // Nothing is left for the scheduled reconciliation.
  const results = await reconcileCommerce({ env, paymentAdapters: [adapter] });
  assert.deepEqual(results.filter((result) => result.id === order.id), []);
  assert.deepEqual(calls.reversals.map((call) => [call.reference, call.amount]),
    [[`${order.id}:reversal:5000`, 5000], [`${order.id}:reversal:13200`, 8200]]);
  sqlite.close();
});

test('a refund that arrives while a reversal is in flight reverses only the rest', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls, state } = taxingProvider();
  const api = bindCommerceApi({ env: { DB, ...exclusive }, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'racing-browser', [{ productId: 'frame', quantity: 1 }]);
  await pay(api, order, 'pi_racing');
  // The full refund's webhook is handled before Stripe answers the partial refund's reversal.
  state.onReverse = () => providerRefund(api, 'pi_racing', 13200, 13200);
  await providerRefund(api, 'pi_racing', 13200, 5000);
  assert.deepEqual(calls.reversals.map((call) => [call.reference, call.amount]),
    [[`${order.id}:reversal:5000`, 5000], [`${order.id}:reversal:13200`, 8200]]);
  assert.equal(reversals(sqlite, order.id).reduce((sum, row) => sum + row.amount, 0), 13200);
  sqlite.close();
});

test('a refund recorded between another reversal\'s read and its record is reversed once in all', async () => {
  const { sqlite, DB } = database();
  // Holds back the next reversal record until `before` has run.
  const hold = { before: null };
  const heldDB = { ...DB, prepare(sql) {
    const statement = DB.prepare(sql);
    if (!sql.includes('INSERT INTO _ecommerce_tax_reversals')) return statement;
    return { ...statement, bind(...params) { statement.bind(...params); return this; },
      async run() {
        const before = hold.before;
        hold.before = null;
        if (before) await before();
        return statement.run();
      } };
  } };
  const { adapter, calls } = taxingProvider();
  const api = bindCommerceApi({ env: { DB: heldDB, ...exclusive }, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'overtaken-browser', [{ productId: 'frame', quantity: 1 }]);
  await pay(api, order, 'pi_overtaken');
  // The partial refund's reversal has read what is left to reverse; the full refund is handled
  // completely before it records its own.
  hold.before = () => providerRefund(api, 'pi_overtaken', 13200, 13200);
  await providerRefund(api, 'pi_overtaken', 13200, 5000);
  assert.deepEqual(calls.reversals.map((call) => [call.reference, call.amount]), [[`${order.id}:reversal:13200`, 13200]]);
  assert.deepEqual(reversals(sqlite, order.id).map((row) => [row.reference, row.amount]),
    [[`${order.id}:reversal:13200`, 13200]]);
  sqlite.close();
});

test('a reversal the provider refused stays pending and is sent again, unchanged, by reconcileCommerce', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (message) => { logged.push(message); });
  const { sqlite, DB } = database();
  const { adapter, calls, state } = taxingProvider();
  const env = { DB, ...exclusive };
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'pending-browser', [{ productId: 'frame', quantity: 1 }]);
  await pay(api, order, 'pi_pending');
  state.reverseError = new Error('Stripe is unavailable');

  // The refund is recorded all the same.
  assert.deepEqual(await providerRefund(api, 'pi_pending', 13200, 3000),
    { success: true, orderId: order.id, status: 'partially_refunded' });
  assert.deepEqual(logged, [`[Commerce] The tax reversal of order ${order.id} was not recorded: Stripe is unavailable`]);
  assert.deepEqual(reversals(sqlite, order.id), [{ reference: `${order.id}:reversal:3000`, amount: 3000,
    provider_reversal_id: '' }]);
  // A reversal recorded in the last few minutes may still be in flight, so it is left alone.
  assert.deepEqual((await reconcileCommerce({ env, paymentAdapters: [adapter] }))
    .filter((result) => result.id === order.id), []);
  // Ten minutes on, both that wait and the one its counted failure started have passed.
  sqlite.prepare('UPDATE _ecommerce_tax_reversals SET created_at = created_at - 600, tax_sync_last_at = tax_sync_last_at - 600').run();
  assert.deepEqual((await reconcileCommerce({ env, paymentAdapters: [adapter] }))
    .filter((result) => result.id === order.id), [{ id: order.id, status: 'tax_reversed' }]);
  assert.deepEqual(calls.reversals[1], calls.reversals[0]);
  assert.deepEqual(reversals(sqlite, order.id), [{ reference: `${order.id}:reversal:3000`, amount: 3000,
    provider_reversal_id: 'taxrev_2' }]);
  sqlite.close();
});

test('ten tax records that keep failing do not hold back an eleventh, and each failure is counted', async (t) => {
  const at = clock(t);
  t.mock.method(console, 'error', () => {});
  const { sqlite, DB } = database();
  const { adapter, calls, state } = taxingProvider();
  const env = { DB, ...exclusive };
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const run = () => reconcileCommerce({ env, paymentAdapters: [adapter] });
  // Stripe cannot be reached while eleven orders are paid, a second apart.
  state.recordFails = () => unreachable();
  const orders = [];
  for (let index = 0; index < 11; index++) {
    at(index);
    const order = await placeOrder(api, `backlog-browser-${index}`, [{ productId: 'frame', quantity: 1 }]);
    await pay(api, order, `pi_backlog_${index}`);
    orders.push(order);
  }
  const stuck = orders.slice(0, 10);
  const eleventh = orders[10];
  // Each failure at payment counts, so reconciliation waits two minutes before trying an order again.
  assert.deepEqual(orders.map((order) => orderTaxSync(sqlite, order.id)),
    orders.map(() => ({ attempts: 1, lastError: 'provider_unavailable' })));
  at(119);
  assert.deepEqual(await run(), []);

  // Then Stripe refuses the ten oldest for good, as it does the records of expired calculations. They
  // take the batch once more and fail; the provider's own text is not reported.
  state.recordFails = (params) => stuck.some((order) => order.id === params.orderId) ? rejected() : null;
  at(130);
  assert.deepEqual((await run()).map((result) => [result.id, result.status, result.code, result.error]),
    stuck.map((order) => [order.id, 'error', 'failed', 'The payment provider returned an error']));
  assert.deepEqual(orderTaxSync(sqlite, stuck[0].id), { attempts: 2, lastError: 'failed' });
  // They now wait four minutes, so the next run records the eleventh, which clears its count.
  at(131);
  assert.deepEqual(await run(), [{ id: eleventh.id, status: 'tax_recorded' }]);
  assert.equal(storedTax(sqlite, eleventh.id)[3], `tax_${eleventh.id}`);
  assert.deepEqual(orderTaxSync(sqlite, eleventh.id), { attempts: 0, lastError: null });
  assert.equal(calls.transactions.filter((call) => call.orderId === eleventh.id).length, 2);
  at(130 + 239);
  assert.deepEqual(await run(), []);
  at(130 + 240);
  assert.equal((await run()).filter((result) => result.status === 'error').length, 10);

  // However many attempts failed, an order waits at most six hours.
  sqlite.prepare('UPDATE _ecommerce_orders SET tax_sync_attempts = 70, tax_sync_last_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - 6 * 60 * 60 + 1, stuck[0].id);
  assert.deepEqual(await run(), []);
  sqlite.prepare('UPDATE _ecommerce_orders SET tax_sync_last_at = tax_sync_last_at - 1 WHERE id = ?').run(stuck[0].id);
  assert.deepEqual((await run()).map((result) => [result.id, result.code]), [[stuck[0].id, 'failed']]);
  assert.deepEqual(orderTaxSync(sqlite, stuck[0].id), { attempts: 71, lastError: 'failed' });
  sqlite.close();
});

test('a reversal whose request keeps failing backs off on its own count, which its success clears', async (t) => {
  const at = clock(t);
  t.mock.method(console, 'error', () => {});
  const { sqlite, DB } = database();
  const { adapter, calls, state } = taxingProvider();
  const env = { DB, ...exclusive };
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const run = async () => (await reconcileCommerce({ env, paymentAdapters: [adapter] }))
    .map((result) => [result.id, result.status, result.code ?? null]);
  const order = await placeOrder(api, 'flaky-reversal-browser', [{ productId: 'frame', quantity: 1 }]);
  await pay(api, order, 'pi_flaky_reversal');
  let outage = true;
  state.reverseFails = () => outage ? unreachable() : null;

  // The refund's reversal is recorded, and its failed request is counted on the reversal, not the order.
  await providerRefund(api, 'pi_flaky_reversal', 13200, 3000);
  assert.deepEqual(reversalSync(sqlite, order.id), [{ amount: 3000, sent: 0, attempts: 1, lastError: 'provider_unavailable' }]);
  assert.deepEqual(orderTaxSync(sqlite, order.id), { attempts: 0, lastError: null });
  // It may be in flight for five minutes. Then it is sent again, and after a second failure it waits
  // four minutes.
  at(300);
  assert.deepEqual(await run(), []);
  at(301);
  assert.deepEqual(await run(), [[order.id, 'error', 'provider_unavailable']]);
  assert.deepEqual(reversalSync(sqlite, order.id), [{ amount: 3000, sent: 0, attempts: 2, lastError: 'provider_unavailable' }]);
  at(301 + 239);
  assert.deepEqual(await run(), []);
  outage = false;
  at(301 + 240);
  assert.deepEqual(await run(), [[order.id, 'tax_reversed', null]]);
  assert.deepEqual(reversalSync(sqlite, order.id), [{ amount: 3000, sent: 1, attempts: 0, lastError: null }]);
  // Each of the three requests named the same reversal, so Stripe reverses the refund once.
  assert.deepEqual(calls.reversals, [calls.reversals[0], calls.reversals[0], calls.reversals[0]]);
  assert.equal(calls.reversals[0].reference, `${order.id}:reversal:3000`);
  sqlite.close();
});

test('a refund whose reversal cannot be recorded counts on its order until reconciliation records it', async (t) => {
  const at = clock(t);
  t.mock.method(console, 'error', () => {});
  const { sqlite, DB } = database();
  const { adapter } = taxingProvider();
  const env = { DB, ...exclusive };
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const order = await placeOrder(api, 'unreversed-browser', [{ productId: 'frame', quantity: 1 }]);
  await pay(api, order, 'pi_unreversed');
  // A Worker whose provider cannot reverse tax takes the refund: there is no reversal to send yet, so
  // the order counts the failure.
  const cannotReverse = { ...adapter, reverseTaxTransaction: undefined };
  await providerRefund(bindCommerceApi({ env, paymentAdapters: [cannotReverse] }), 'pi_unreversed', 13200, 13200);
  assert.deepEqual(orderTaxSync(sqlite, order.id), { attempts: 1, lastError: 'provider_not_configured' });
  assert.deepEqual(reversals(sqlite, order.id), []);

  at(120);
  assert.deepEqual(await reconcileCommerce({ env, paymentAdapters: [cannotReverse] }), [{ id: order.id,
    status: 'error', error: 'Payment provider cannot reverse tax', code: 'provider_not_configured' }]);
  assert.deepEqual(orderTaxSync(sqlite, order.id), { attempts: 2, lastError: 'provider_not_configured' });
  at(120 + 239);
  assert.deepEqual(await reconcileCommerce({ env, paymentAdapters: [adapter] }), []);
  at(120 + 240);
  assert.deepEqual(await reconcileCommerce({ env, paymentAdapters: [adapter] }), [{ id: order.id, status: 'tax_reversed' }]);
  assert.deepEqual(orderTaxSync(sqlite, order.id), { attempts: 0, lastError: null });
  assert.deepEqual(reversalSync(sqlite, order.id), [{ amount: 13200, sent: 1, attempts: 0, lastError: null }]);
  sqlite.close();
});

/** The query plan of `sql`, one step per line. Its parameters do not change the plan, so each is bound as 0. */
const queryPlan = (sqlite, sql) => sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`)
  .all(...(sql.match(/\?/g) ?? []).map(() => 0)).map((step) => step.detail).join('\n');

test('the tax passes find their rows through partial indexes', async () => {
  const { sqlite, DB } = database();
  const { adapter } = taxingProvider();
  const statements = [];
  const recording = { ...DB, prepare(sql) {
    statements.push(sql.replace(/\s+/g, ' ').trim());
    return DB.prepare(sql);
  } };
  await reconcileCommerce({ env: { DB: recording, ...exclusive }, paymentAdapters: [adapter] });
  const statement = (start) => {
    const found = statements.find((sql) => sql.startsWith(start));
    assert.ok(found, start);
    return found;
  };
  // Paid orders without a transaction, from the partial index of migration 0025.
  assert.match(queryPlan(sqlite, statement('SELECT id FROM _ecommerce_orders WHERE status IN (')),
    /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_tax_transaction_missing_idx \(status=\?\)/);
  // Unsent reversals and refunded orders with a transaction, from those of migration 0029.
  assert.match(queryPlan(sqlite, statement('SELECT r.order_id, r.reference')),
    /SEARCH r USING INDEX _ecommerce_tax_reversals_unsent_idx \(created_at<\?\)/);
  assert.match(queryPlan(sqlite, statement('SELECT o.id FROM _ecommerce_orders o WHERE o.status IN (')),
    /SCAN o USING INDEX _ecommerce_orders_tax_refunded_idx/);
  sqlite.close();
});

test('admin test orders are not taxed, and a store without a tax mode asks for no tax', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls } = taxingProvider();
  const taxed = bindCommerceApi({ env: { DB, ...exclusive }, paymentAdapters: [adapter, new AdminTestPaymentAdapter()] });
  const simulated = await placeOrder(taxed, 'admin-test-browser', [{ productId: 'guide', quantity: 1 }],
    { providerId: 'admin_test' });
  await taxed.orders.finalizePayment(simulated.id, { provider: 'admin_test', providerId: simulated.checkoutSessionId,
    paymentStatus: 'success', amount: simulated.totalAmount, currency: 'usd' });
  assert.deepEqual(storedTax(sqlite, simulated.id), [0, null, null, null, 3000]);

  for (const settings of [{}, { TALISMAN_COMMERCE_TAX: 'none' }]) {
    const api = bindCommerceApi({ env: { DB, ...settings }, paymentAdapters: [adapter] });
    const order = await placeOrder(api, `untaxed-browser-${Object.keys(settings).length}`, [{ productId: 'frame', quantity: 1 }]);
    await pay(api, order, `pi_untaxed_${order.id}`);
    await providerRefund(api, `pi_untaxed_${order.id}`, 12000, 12000);
    await reconcileCommerce({ env: { DB, ...settings }, paymentAdapters: [adapter] });
    assert.deepEqual(storedTax(sqlite, order.id), [0, null, null, null, 12000]);
    assert.equal(calls.sessions.at(-1).tax, undefined);
  }
  assert.deepEqual([calls.calculations, calls.transactions, calls.reversals], [[], [], []]);
  sqlite.close();
});

test('taxed checkout needs an address to tax, and a failed calculation stops it before anything is reserved', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (message) => { logged.push(message); });
  const { sqlite, DB } = database();
  const { adapter, calls, state } = taxingProvider();
  const api = bindCommerceApi({ env: { DB, ...exclusive }, paymentAdapters: [adapter] });
  const guide = [{ productId: 'guide', quantity: 1 }];
  const required = { message: 'A billing address is required to calculate tax' };

  // Nothing ships, so the billing address is taxed, and it needs a country.
  await assert.rejects(placeOrder(api, 'no-address-browser', guide, { shippingAddress: undefined }), required);
  await assert.rejects(placeOrder(api, 'no-country-browser', guide,
    { shippingAddress: undefined, billingAddress: { line1: '1 Main St' } }), required);
  assert.equal(calls.calculations.length, 0);
  const billed = await placeOrder(api, 'billing-browser', guide,
    { shippingAddress: undefined, billingAddress: { name: 'Test Shopper', country: 'fr' } });
  assert.deepEqual([calls.calculations[0].address, calls.calculations[0].addressSource], [{ country: 'FR' }, 'billing']);
  assert.equal(billed.taxAmount, 300);

  const unavailable = { name: 'TaxCalculationError', message: 'Tax could not be calculated. Please try again.' };
  const failures = [
    [() => { throw new Error('Stripe Tax is not set up'); }, 'Stripe Tax is not set up'],
    // Amounts that do not add up to the order's own are refused too.
    [() => ({ id: 'taxcalc_off', amountTotal: 13300, taxAmountExclusive: 1200, taxAmountInclusive: 0 }),
      'calculation taxcalc_off totals 13300 with 1200 tax exclusive, where the order expects 12000 plus the tax'],
    [() => ({ id: 'taxcalc_mixed', amountTotal: 13200, taxAmountExclusive: 1200, taxAmountInclusive: 100 }),
      /calculation taxcalc_mixed totals 13200/],
  ];
  for (const [calculate, reason] of failures) {
    state.calculate = calculate;
    logged.length = 0;
    await assert.rejects(placeOrder(api, 'failing-browser', [{ productId: 'frame', quantity: 1 }]), (error) => {
      assert.ok(error instanceof TaxCalculationError);
      assert.deepEqual({ name: error.name, message: error.message }, unavailable);
      return true;
    });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^\[Commerce\] Tax could not be calculated for basket cart_/);
    if (typeof reason === 'string') assert.ok(logged[0].endsWith(`: ${reason}`), logged[0]);
    else assert.match(logged[0], reason);
  }
  // An address the provider cannot place is the shopper's to correct.
  state.calculate = () => { throw new TaxAddressError(); };
  await assert.rejects(placeOrder(api, 'failing-browser', [{ productId: 'frame', quantity: 1 }]),
    { message: 'Tax cannot be calculated for this address. Check it and try again.' });

  // A provider that cannot record and reverse tax cannot take taxed orders.
  const { calculateTax, ...untaxing } = adapter;
  logged.length = 0;
  const other = bindCommerceApi({ env: { DB, ...exclusive }, paymentAdapters: [{ ...untaxing, recordTaxTransaction: undefined }] });
  await assert.rejects(placeOrder(other, 'untaxing-browser', [{ productId: 'frame', quantity: 1 }]), unavailable);
  assert.deepEqual(logged.map((message) => message.replace(/cart_[0-9a-f-]+/, 'cart')),
    ['[Commerce] Tax could not be calculated for basket cart: payment provider stripe cannot calculate, record and reverse tax']);

  // Nothing was reserved or locked, and only the billed order exists.
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_orders').get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM _ecommerce_carts WHERE checkout_session_id IS NOT NULL").get().n, 1);
  assert.equal(sqlite.prepare("SELECT inventory_quantity FROM _ecommerce_products WHERE id = 'frame'").get().inventory_quantity, 20);
  sqlite.close();
});

test('the Stripe adapter calculates, records and reverses tax with the Stripe Tax parameters', async () => {
  const adapter = new StripePaymentAdapter({ secretKey: 'sk_test_fake' });
  const calls = [];
  let calculationError = null;
  adapter.stripe = {
    coupons: { async create(input) { return { id: input.id }; } },
    checkout: { sessions: { async create(input, options) {
      calls.push({ type: 'session', input, options });
      return { id: 'cs_test_tax', url: 'https://checkout.stripe.test/tax' };
    } } },
    tax: {
      calculations: { async create(input, options) {
        calls.push({ type: 'calculation', input, options });
        if (calculationError) throw calculationError;
        return { id: 'taxcalc_test', amount_total: 16170, tax_amount_exclusive: 1470, tax_amount_inclusive: 0 };
      } },
      transactions: {
        async createFromCalculation(input, options) {
          calls.push({ type: 'transaction', input, options });
          return { id: 'tax_test' };
        },
        async createReversal(input, options) {
          calls.push({ type: 'reversal', input, options });
          return { id: 'taxrev_test' };
        },
      },
    },
  };
  const lines = [{ reference: 'L1:frame', amount: 12000, quantity: 1 }, { reference: 'L2:case', amount: 2000, quantity: 1 }];
  const calculation = await adapter.calculateTax({ currency: 'usd', behavior: 'exclusive', taxCode: 'txcd_99999999',
    lines, shippingAmount: 700, addressSource: 'shipping', shipFromCountry: 'US',
    address: { line1: ' 1 Main St ', line2: '', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } });
  assert.deepEqual(calculation, { id: 'taxcalc_test', amountTotal: 16170, taxAmountExclusive: 1470, taxAmountInclusive: 0 });
  assert.deepEqual(calls[0].input, {
    currency: 'usd',
    line_items: [
      { amount: 12000, quantity: 1, reference: 'L1:frame', tax_behavior: 'exclusive', tax_code: 'txcd_99999999' },
      { amount: 2000, quantity: 1, reference: 'L2:case', tax_behavior: 'exclusive', tax_code: 'txcd_99999999' },
    ],
    // Blank parts are left out rather than sent empty, which would clear them.
    customer_details: { address: { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
      address_source: 'shipping' },
    shipping_cost: { amount: 700, tax_behavior: 'exclusive' },
    ship_from_details: { address: { country: 'US' } },
  });

  // Without shipping, a tax code or a ship-from country, none is sent.
  calls.length = 0;
  await adapter.calculateTax({ currency: 'eur', behavior: 'inclusive', taxCode: null, lines: lines.slice(0, 1),
    shippingAmount: 0, addressSource: 'billing', shipFromCountry: null, address: { country: 'FR' } });
  assert.deepEqual(calls[0].input, { currency: 'eur',
    line_items: [{ amount: 12000, quantity: 1, reference: 'L1:frame', tax_behavior: 'inclusive' }],
    customer_details: { address: { country: 'FR' }, address_source: 'billing' } });

  // Stripe cannot place the address: the shopper can correct it. Other errors pass through.
  calculationError = Object.assign(new Error('Unable to determine the location'), { code: 'customer_tax_location_invalid' });
  await assert.rejects(adapter.calculateTax({ currency: 'usd', behavior: 'exclusive', taxCode: null, lines,
    shippingAmount: 0, addressSource: 'billing', shipFromCountry: null, address: { country: 'US' } }),
  (error) => error instanceof TaxAddressError && error.cause === calculationError);
  calculationError = Object.assign(new Error('Stripe Tax is not active'), { code: 'tax_not_active' });
  await assert.rejects(adapter.calculateTax({ currency: 'usd', behavior: 'exclusive', taxCode: null, lines,
    shippingAmount: 0, addressSource: 'billing', shipFromCountry: null, address: { country: 'US' } }), calculationError);

  calls.length = 0;
  assert.deepEqual(await adapter.recordTaxTransaction({ orderId: 'ord_tax', calculationId: 'taxcalc_test' }),
    { transactionId: 'tax_test' });
  assert.deepEqual(await adapter.reverseTaxTransaction({ orderId: 'ord_tax', transactionId: 'tax_test', amount: 5000,
    reference: 'ord_tax:reversal:5000' }), { reversalId: 'taxrev_test' });
  assert.deepEqual(calls.map(({ type, input, options }) => ({ type, input, options })), [
    { type: 'transaction', input: { calculation: 'taxcalc_test', reference: 'ord_tax' },
      options: { idempotencyKey: 'tax-transaction:ord_tax' } },
    { type: 'reversal', input: { mode: 'partial', original_transaction: 'tax_test', reference: 'ord_tax:reversal:5000',
      flat_amount: -5000 }, options: { idempotencyKey: 'ord_tax:reversal:5000' } },
  ]);

  // A late record is dated at the payment, and a line's own tax code wins over the store's.
  calls.length = 0;
  calculationError = null;
  await adapter.recordTaxTransaction({ orderId: 'ord_late', calculationId: 'taxcalc_late', postedAt: 1789000000 });
  await adapter.calculateTax({ currency: 'usd', behavior: 'exclusive', taxCode: 'txcd_99999999', shippingAmount: 0,
    lines: [{ reference: 'shipping', amount: 700, quantity: 1, taxCode: 'txcd_92010001' }],
    addressSource: 'shipping', shipFromCountry: null, address: { country: 'US' } });
  assert.deepEqual([calls[0].input.posted_at, calls[1].input.line_items[0].tax_code, calls[1].input.shipping_cost],
    [1789000000, 'txcd_92010001', undefined]);
  assert.equal(calls.length, 2);

  // Exclusive tax is a line of its own in the session; none is added without tax.
  calls.length = 0;
  const urls = { successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' };
  await adapter.createCheckoutSession({ orderId: 'ord_tax', currency: 'usd', ...urls,
    items: [{ name: 'Frame', priceCents: 12000, quantity: 1 }], tax: { amount: 1200 } });
  await adapter.createCheckoutSession({ orderId: 'ord_untaxed', currency: 'usd', ...urls,
    items: [{ name: 'Frame', priceCents: 12000, quantity: 1 }], tax: { amount: 0 } });
  assert.deepEqual(calls[0].input.line_items.at(-1),
    { price_data: { currency: 'usd', product_data: { name: 'Tax' }, unit_amount: 1200 }, quantity: 1 });
  assert.deepEqual(calls[1].input.line_items.map((line) => line.price_data.product_data.name), ['Frame']);
  assert.ok(calls.every((call) => call.input.automatic_tax === undefined));
});
