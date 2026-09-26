import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi, WebhookRetryLaterError } from '../dist/api.js';
import { StripePaymentAdapter } from '../dist/adapters/stripe.js';
import { fulfillCommerceOrder, listCommerceOrdersAdmin } from '../dist/fulfillment.js';
import { getOrderAdjustmentsAdmin } from '../dist/order-adjustments.js';
import { getOrCreateReferralCode, releaseReferralAwards } from '../dist/referrals.js';
import { createDiscountCode } from '../dist/promotions.js';
import { confirmGiftCardPurchase, evaluateGiftCard, getGiftCardReviewsAdmin, getPurchasedGiftCard, issueAdminGiftCard,
  resolveGiftCardReview, setGiftCardActive, startGiftCardPurchase } from '../dist/gift-cards.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Math.floor(Date.now() / 1000);
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql', '0028_provider_refunds_and_disputes.sql',
  '0029_commerce_reconcile_backoff.sql', '0030_commerce_order_emails.sql'];

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
  return { sqlite, DB };
}

/**
 * A store with a $120 lamp and a $30 pin, a referrer and a Stripe stand-in whose webhook events arrive
 * already verified. `state` scripts what Stripe reports about disputes and payments.
 */
function shop() {
  const { sqlite, DB } = database();
  const product = sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 100, 'active', ?, ?)`);
  product.run('lamp', 'Lamp', 'lamp', 12000, NOW, NOW);
  product.run('pin', 'Pin', 'pin', 3000, NOW, NOW);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at)
    VALUES ('referrer', 'Referrer@example.test', 'referrer@example.test', ?, ?, ?)`).run(NOW, NOW, NOW);
  const env = { DB, TALISMAN_COMMERCE_GIFT_CARD_KEY: 'a'.repeat(64), TALISMAN_COMMERCE_REFERRALS_ENABLED: 'true' };
  const state = { dispute: 'none', disputeCalls: [], references: {} };
  const adapter = {
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `cs_test_${orderId}`, url: `https://checkout.example.test/${orderId}` };
    },
    async expireCheckoutSession() {},
    async getCheckoutSession() { return { status: 'open', url: 'https://checkout.example.test/open' }; },
    async validateWebhook(payload) { return JSON.parse(payload); },
    async getDisputeStatus(paymentIntentId) { state.disputeCalls.push(paymentIntentId); return state.dispute; },
    async getPaymentReferences(paymentIntentId) { return state.references[paymentIntentId] ?? null; },
  };
  return { sqlite, DB, env, state, adapter, browsers: 0, api: bindCommerceApi({ env, paymentAdapters: [adapter] }) };
}

const address = { shippingAddress: { name: 'Test', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' },
  successUrl: 'https://shop.example.test/success?order={ORDER_ID}', cancelUrl: 'https://shop.example.test/cancel?order={ORDER_ID}' };

async function checkout(store, details = {}, { accountId, items = [{ productId: 'lamp', quantity: 1 }] } = {}) {
  const cart = await store.api.carts.getOrCreate(`browser-${++store.browsers}`, accountId);
  await store.api.carts.updateItems(cart.id, items);
  return (await store.api.orders.createFromCart(cart.id, { ...address, providerId: 'stripe',
    customerEmail: 'friend@example.test', ...details })).order;
}

async function pay(store, order, paymentIntentId = `pi_${order.id}`) {
  await store.api.orders.finalizePayment(order.id, { provider: 'stripe', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: order.totalAmount, currency: 'usd', paymentIntentId });
  return store.api.orders.find(order.id);
}

/** A charge.dispute.created or charge.dispute.closed event for the payment `paymentIntentId`. */
const disputeEvent = (store, kind, paymentIntentId, dispute) => store.api.webhooks.handleStripe(JSON.stringify({
  id: `evt_${dispute.id}_${kind}_${dispute.status}`, type: `charge.dispute.${kind}`, created: NOW,
  data: { payment_intent: paymentIntentId, amount: 12000, currency: 'usd', reason: 'fraudulent', created: NOW - 60, ...dispute },
}), 'signature', 'secret');
const refund = (store, order, amountRefunded) => store.api.webhooks.handleStripe(JSON.stringify({
  id: `evt_refund_${order.id}_${amountRefunded}`, type: 'charge.refunded', created: NOW,
  data: { payment_intent: order.paymentIntentId, amount: order.totalAmount, amount_refunded: amountRefunded, currency: 'usd' },
}), 'signature', 'secret');
const release = (store) => releaseReferralAwards({ env: store.env, paymentAdapters: [store.adapter] },
  { now: new Date(Date.now() + 31 * DAY_MS) });

const row = (store, sql, ...params) => { const found = store.sqlite.prepare(sql).get(...params); return found ? { ...found } : found; };
const rows = (store, sql, ...params) => store.sqlite.prepare(sql).all(...params).map((item) => ({ ...item }));
const orderStatus = (store, orderId) => row(store, 'SELECT status FROM _ecommerce_orders WHERE id = ?', orderId).status;
const disputeRow = (store, id) => row(store, `SELECT order_id, gift_card_purchase_id, amount_cents, currency, reason, status,
  status_before, closed_at IS NOT NULL AS closed FROM _ecommerce_disputes WHERE id = ?`, id);
const ledger = (store, orderId) => rows(store, 'SELECT kind, amount_cents FROM _ecommerce_credit_ledger WHERE order_id = ? ORDER BY kind', orderId)
  .map((item) => `${item.kind}:${item.amount_cents}`);
const balance = (store, accountId) => row(store, 'SELECT credit_balance FROM _ecommerce_customer_accounts WHERE id = ?', accountId).credit_balance;
const shipment = (orderId) => ({ orderId, carrier: 'UPS', trackingNumber: '1Z999', note: 'Parcel handed to carrier' });

test('a dispute holds a paid order as disputed, so it cannot ship, and a won dispute gives it back', async () => {
  const store = shop();
  const order = await pay(store, await checkout(store));
  const opened = await disputeEvent(store, 'created', order.paymentIntentId, { id: 'dp_won', status: 'needs_response' });
  assert.deepEqual(opened, { success: true, event: 'charge.dispute.created', orderId: order.id, status: 'disputed' });
  assert.equal(orderStatus(store, order.id), 'disputed');
  assert.deepEqual(disputeRow(store, 'dp_won'), { order_id: order.id, gift_card_purchase_id: null, amount_cents: 12000,
    currency: 'usd', reason: 'fraudulent', status: 'needs_response', status_before: 'paid', closed: 0 });
  // A repeated delivery changes nothing, and the payment itself stays recorded as it was.
  await disputeEvent(store, 'created', order.paymentIntentId, { id: 'dp_won', status: 'needs_response' });
  assert.equal(disputeRow(store, 'dp_won').status_before, 'paid');
  assert.equal(row(store, 'SELECT status FROM _ecommerce_payments WHERE order_id = ?', order.id).status, 'success');

  // A disputed order cannot ship, by the admin action or by a raw insert, and leaves the queue.
  await assert.rejects(fulfillCommerceOrder(store.env, 'admin-1', shipment(order.id)), /A disputed order cannot ship/);
  assert.throws(() => store.sqlite.prepare(`INSERT INTO _ecommerce_fulfillments (id, order_id, admin_actor, note, created_at)
    VALUES ('ful_disputed', ?, 'admin-1', 'Parcel handed over', ?)`).run(order.id, NOW), /Order is not ready for fulfillment/);
  const awaiting = await listCommerceOrdersAdmin(store.env);
  assert.deepEqual([awaiting.awaitingCount, awaiting.orders.length], [0, 0]);
  const [recent] = (await listCommerceOrdersAdmin(store.env, { view: 'recent' })).orders;
  assert.deepEqual([recent.id, recent.status, recent.canShip], [order.id, 'disputed', false]);
  // Releasing a checkout never touches it.
  assert.equal((await store.api.orders.cancel(order.id)).status, 'disputed');
  const { disputes, restock } = (await getOrderAdjustmentsAdmin(store.env, { orderIds: [order.id] })).orders[order.id];
  assert.deepEqual(disputes.map((item) => [item.id, item.open, item.status, item.statusBefore, item.amountCents]),
    [['dp_won', true, 'needs_response', 'paid', 12000]]);
  assert.equal(restock, null);

  const closed = await disputeEvent(store, 'closed', order.paymentIntentId, { id: 'dp_won', status: 'won' });
  assert.deepEqual(closed, { success: true, event: 'charge.dispute.closed', orderId: order.id, status: 'paid' });
  assert.equal(orderStatus(store, order.id), 'paid');
  assert.deepEqual([disputeRow(store, 'dp_won').status, disputeRow(store, 'dp_won').closed], ['won', 1]);
  // An open event delivered after the close does not reopen it.
  await disputeEvent(store, 'created', order.paymentIntentId, { id: 'dp_won', status: 'needs_response' });
  assert.deepEqual([orderStatus(store, order.id), disputeRow(store, 'dp_won').status], ['paid', 'won']);
  await fulfillCommerceOrder(store.env, 'admin-1', shipment(order.id));
  assert.equal(row(store, 'SELECT fulfillment_status FROM _ecommerce_orders WHERE id = ?', order.id).fulfillment_status, 'fulfilled');
  // The orders screen learns that it shipped, so a later restock form can say so.
  assert.equal((await getOrderAdjustmentsAdmin(store.env, { orderIds: [order.id] })).orders[order.id].fulfillmentStatus, 'fulfilled');
});

test('a lost dispute refunds the order in full: redemptions refunded, credit returned and the referral reversed', async () => {
  const store = shop();
  const now = NOW;
  store.sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, credit_balance, created_at, updated_at)
    VALUES ('buyer', 'buyer@example.test', 'buyer@example.test', ?, 1000, ?, ?)`).run(now, now, now);
  const voucher = await createDiscountCode(store.env, { code: '', description: null, type: 'credit', value: 1000,
    maxDiscountCents: null, minOrderCents: 0, eligibleProductIds: [], maxUses: null, maxUsesPerCustomer: null,
    firstOrderOnly: false, startsAt: null, expiresAt: null, active: true });
  const gift = await issueAdminGiftCard(store.env, 'admin-1', { amountCents: 2000, reason: 'Customer service balance' });
  const referral = await getOrCreateReferralCode(store.env, 'referrer');
  const placed = await checkout(store, { customerEmail: 'buyer@example.test', discountCode: voucher.code,
    giftCardCode: gift.code, referralCode: referral }, { accountId: 'buyer' });
  assert.deepEqual([placed.subtotalAmount, placed.discountAmount, placed.creditApplied, placed.giftCardApplied, placed.totalAmount],
    [12000, 1000, 1000, 2000, 8000]);
  const order = await pay(store, placed);
  assert.deepEqual((await release(store)).map((item) => item.status), ['referral_released']);
  assert.deepEqual([balance(store, 'referrer'), balance(store, 'buyer')], [1000, 1000]);

  await disputeEvent(store, 'created', order.paymentIntentId, { id: 'dp_lost', amount: 8000, status: 'needs_response' });
  assert.equal(orderStatus(store, order.id), 'disputed');
  const lost = await disputeEvent(store, 'closed', order.paymentIntentId, { id: 'dp_lost', amount: 8000, status: 'lost' });
  // The answer names the order's status: whatever else follows a refund, such as a tax reversal, keys on it.
  assert.deepEqual(lost, { success: true, event: 'charge.dispute.closed', orderId: order.id, status: 'refunded' });

  assert.deepEqual(row(store, 'SELECT status, provider_refunded_cents FROM _ecommerce_orders WHERE id = ?', order.id),
    { status: 'refunded', provider_refunded_cents: 0 });
  // Not a provider refund: reports count a refunded order's whole sale as refunded.
  assert.equal(row(store, 'SELECT COUNT(*) AS n FROM _ecommerce_provider_refunds').n, 0);
  assert.equal(row(store, 'SELECT status FROM _ecommerce_payments WHERE order_id = ?', order.id).status, 'refunded');
  assert.deepEqual([disputeRow(store, 'dp_lost').status, disputeRow(store, 'dp_lost').closed], ['lost', 1]);
  // The full refund's effects: the voucher and the gift card get their value back, the credit returns.
  assert.equal(row(store, 'SELECT status FROM _ecommerce_discount_redemptions WHERE order_id = ?', order.id).status, 'refunded');
  assert.equal(row(store, 'SELECT remaining_cents FROM _ecommerce_discount_codes WHERE code = ?', voucher.code).remaining_cents, 1000);
  assert.equal(row(store, 'SELECT status FROM _ecommerce_gift_card_redemptions WHERE order_id = ?', order.id).status, 'refunded');
  assert.equal(row(store, 'SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?', gift.id).balance_cents, 2000);
  assert.equal(row(store, 'SELECT status FROM _ecommerce_referrals WHERE order_id = ?', order.id).status, 'void');
  assert.deepEqual(ledger(store, order.id), ['checkout_reserve:-1000', 'purchase_credit_refund:1000', 'referral_award:1000',
    'referral_reversal:-1000', 'welcome_award:1000', 'welcome_reversal:-1000']);
  assert.deepEqual([balance(store, 'referrer'), balance(store, 'buyer')], [0, 1000]);

  // Stripe retries the event; nothing changes twice, and a won event for the same dispute changes nothing.
  await disputeEvent(store, 'closed', order.paymentIntentId, { id: 'dp_lost', amount: 8000, status: 'lost' });
  await disputeEvent(store, 'closed', order.paymentIntentId, { id: 'dp_lost', amount: 8000, status: 'won' });
  assert.deepEqual([orderStatus(store, order.id), disputeRow(store, 'dp_lost').status], ['refunded', 'lost']);
  assert.equal(ledger(store, order.id).length, 6);
  assert.deepEqual([balance(store, 'referrer'), balance(store, 'buyer')], [0, 1000]);
  // The order can now be restocked like any refunded order.
  assert.equal((await getOrderAdjustmentsAdmin(store.env, { orderIds: [order.id] })).orders[order.id].restock, 'all');
});

test('a refund during a dispute is recorded, and closing the dispute applies the refund status', async () => {
  const store = shop();
  const partly = await pay(store, await checkout(store));
  await disputeEvent(store, 'created', partly.paymentIntentId, { id: 'dp_partly', status: 'warning_needs_response' });
  assert.deepEqual(await refund(store, partly, 3000), { success: true, orderId: partly.id, status: 'disputed' });
  assert.deepEqual(row(store, 'SELECT status, provider_refunded_cents FROM _ecommerce_orders WHERE id = ?', partly.id),
    { status: 'disputed', provider_refunded_cents: 3000 });
  assert.deepEqual(rows(store, 'SELECT amount_cents, created_at FROM _ecommerce_provider_refunds WHERE order_id = ?', partly.id),
    [{ amount_cents: 3000, created_at: NOW }]);
  assert.equal(row(store, 'SELECT status FROM _ecommerce_payments WHERE order_id = ?', partly.id).status, 'partially_refunded');
  await disputeEvent(store, 'closed', partly.paymentIntentId, { id: 'dp_partly', status: 'warning_closed' });
  assert.equal(orderStatus(store, partly.id), 'partially_refunded');

  // A full refund during the dispute returns the store credit once the dispute closes.
  const now = NOW;
  store.sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, credit_balance, created_at, updated_at)
    VALUES ('buyer', 'buyer@example.test', 'buyer@example.test', ?, 500, ?, ?)`).run(now, now, now);
  const full = await pay(store, await checkout(store, { customerEmail: 'buyer@example.test' }, { accountId: 'buyer' }));
  assert.equal(full.totalAmount, 11500);
  await disputeEvent(store, 'created', full.paymentIntentId, { id: 'dp_full', status: 'warning_needs_response' });
  await refund(store, full, 11500);
  assert.equal(orderStatus(store, full.id), 'disputed');
  assert.deepEqual(ledger(store, full.id), ['checkout_reserve:-500']);
  await disputeEvent(store, 'closed', full.paymentIntentId, { id: 'dp_full', status: 'warning_closed' });
  assert.equal(orderStatus(store, full.id), 'refunded');
  assert.deepEqual(ledger(store, full.id), ['checkout_reserve:-500', 'purchase_credit_refund:500']);
  assert.equal(balance(store, 'buyer'), 500);

  // A dispute lost after a partial refund keeps the refund as recorded.
  const lost = await pay(store, await checkout(store));
  await refund(store, lost, 2000);
  await disputeEvent(store, 'created', lost.paymentIntentId, { id: 'dp_after_refund', status: 'needs_response' });
  assert.equal(disputeRow(store, 'dp_after_refund').status_before, 'partially_refunded');
  await disputeEvent(store, 'closed', lost.paymentIntentId, { id: 'dp_after_refund', status: 'lost' });
  assert.deepEqual(row(store, 'SELECT status, provider_refunded_cents FROM _ecommerce_orders WHERE id = ?', lost.id),
    { status: 'refunded', provider_refunded_cents: 2000 });
  assert.equal(row(store, 'SELECT COUNT(*) AS n FROM _ecommerce_provider_refunds WHERE order_id = ?', lost.id).n, 1);
});

test('a payment the previous release marked disputed gets its status back when the dispute closes', async () => {
  const store = shop();
  const paymentStatus = (orderId) => row(store, 'SELECT status FROM _ecommerce_payments WHERE order_id = ?', orderId).status;
  // What the previous release does to a refund of a disputed order after a rollback: it records no
  // refund, but copies the order's status onto the payment.
  const previousReleaseRefund = (orderId) => store.sqlite.prepare(`UPDATE _ecommerce_payments
    SET status = (SELECT status FROM _ecommerce_orders WHERE id = ?) WHERE order_id = ? AND provider = 'stripe'`).run(orderId, orderId);

  const won = await pay(store, await checkout(store));
  await disputeEvent(store, 'created', won.paymentIntentId, { id: 'dp_rollback_won', status: 'needs_response' });
  previousReleaseRefund(won.id);
  assert.equal(paymentStatus(won.id), 'disputed');
  await disputeEvent(store, 'closed', won.paymentIntentId, { id: 'dp_rollback_won', status: 'won' });
  assert.deepEqual([orderStatus(store, won.id), paymentStatus(won.id)], ['paid', 'success']);

  // The refund delivered again after the rollback is recorded, and the payment shows it.
  const refunded = await pay(store, await checkout(store));
  await disputeEvent(store, 'created', refunded.paymentIntentId, { id: 'dp_rollback_refund', status: 'needs_response' });
  previousReleaseRefund(refunded.id);
  await refund(store, refunded, 4000);
  assert.equal(paymentStatus(refunded.id), 'partially_refunded');
  await disputeEvent(store, 'closed', refunded.paymentIntentId, { id: 'dp_rollback_refund', status: 'won' });
  assert.deepEqual([orderStatus(store, refunded.id), paymentStatus(refunded.id)], ['partially_refunded', 'partially_refunded']);

  const lost = await pay(store, await checkout(store));
  await disputeEvent(store, 'created', lost.paymentIntentId, { id: 'dp_rollback_lost', status: 'needs_response' });
  previousReleaseRefund(lost.id);
  await disputeEvent(store, 'closed', lost.paymentIntentId, { id: 'dp_rollback_lost', status: 'lost' });
  assert.deepEqual([orderStatus(store, lost.id), paymentStatus(lost.id)], ['refunded', 'refunded']);
});

test('an order with two disputes stays disputed until both close, then gets back its status from before the first', async () => {
  const store = shop();
  const order = await pay(store, await checkout(store));
  await refund(store, order, 1000);
  await disputeEvent(store, 'created', order.paymentIntentId, { id: 'dp_first', status: 'needs_response' });
  await disputeEvent(store, 'created', order.paymentIntentId, { id: 'dp_second', status: 'needs_response' });
  assert.deepEqual([disputeRow(store, 'dp_first').status_before, disputeRow(store, 'dp_second').status_before],
    ['partially_refunded', 'partially_refunded']);
  await disputeEvent(store, 'closed', order.paymentIntentId, { id: 'dp_first', status: 'won' });
  assert.equal(orderStatus(store, order.id), 'disputed');
  await disputeEvent(store, 'closed', order.paymentIntentId, { id: 'dp_second', status: 'won' });
  assert.equal(orderStatus(store, order.id), 'partially_refunded');
});

test('a disputed order holds its referral award without asking Stripe until the dispute closes', async () => {
  const store = shop();
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  const order = await pay(store, await checkout(store, { referralCode: code }));
  await disputeEvent(store, 'created', order.paymentIntentId, { id: 'dp_referral', status: 'needs_response' });
  assert.deepEqual((await release(store)).map((item) => item.status), ['referral_held']);
  assert.deepEqual(store.state.disputeCalls, []);
  assert.deepEqual(ledger(store, order.id), []);
  assert.equal(row(store, 'SELECT status FROM _ecommerce_referrals WHERE order_id = ?', order.id).status, 'approved');
  await disputeEvent(store, 'closed', order.paymentIntentId, { id: 'dp_referral', status: 'won' });
  assert.deepEqual((await release(store)).map((item) => item.status), ['referral_released']);
  assert.deepEqual(store.state.disputeCalls, [order.paymentIntentId]);
  assert.deepEqual(ledger(store, order.id), ['referral_award:1000', 'welcome_award:1000']);
});

/** A purchase paid through Stripe, with the code its buyer sees. */
async function buyGiftCard(store, amountCents, paymentIntent) {
  const purchase = await startGiftCardPurchase(store.env, store.adapter, { amountCents, buyerEmail: 'buyer@example.test' },
    { successUrl: 'https://shop.example.test/gift-cards/success?purchase={PURCHASE_ID}', cancelUrl: 'https://shop.example.test/gift-cards' });
  await confirmGiftCardPurchase(store.env, { id: `cs_test_${purchase.id}`, metadata: { giftCardPurchaseId: purchase.id },
    amount_total: amountCents, currency: 'usd', payment_status: 'paid', payment_intent: paymentIntent });
  const { code } = await getPurchasedGiftCard(store.env, purchase.id, purchase.accessToken);
  return { id: purchase.id, code, card: row(store, 'SELECT id FROM _ecommerce_gift_cards WHERE purchase_id = ?', purchase.id) };
}
const card = (store, id) => row(store, 'SELECT status, held_for_review, balance_cents FROM _ecommerce_gift_cards WHERE id = ?', id);
const purchaseStatus = (store, id) => row(store, 'SELECT status FROM _ecommerce_gift_card_purchases WHERE id = ?', id).status;

test('a gift card purchase dispute holds its cards, replacements included, and a won dispute releases them', async () => {
  const store = shop();
  const purchase = await buyGiftCard(store, 5000, 'pi_gift_won');
  // Support replaced the card; the replacement carries the purchase's value.
  const replacement = await issueAdminGiftCard(store.env, 'admin-1', { amountCents: 5000, reason: 'Buyer lost the code',
    replacesPurchaseId: purchase.id });
  assert.equal(card(store, purchase.card.id).status, 'void');

  const opened = await disputeEvent(store, 'created', 'pi_gift_won', { id: 'dp_gift_won', amount: 5000, status: 'needs_response' });
  assert.deepEqual(opened, { success: true, event: 'charge.dispute.created', purchaseId: purchase.id });
  assert.equal(purchaseStatus(store, purchase.id), 'review');
  assert.deepEqual(card(store, replacement.id), { status: 'suspended', held_for_review: 1, balance_cents: 5000 });
  assert.deepEqual(disputeRow(store, 'dp_gift_won'), { order_id: null, gift_card_purchase_id: purchase.id, amount_cents: 5000,
    currency: 'usd', reason: 'fraudulent', status: 'needs_response', status_before: 'paid', closed: 0 });
  // The value cannot be spent, reactivated or decided on while the dispute is open.
  await assert.rejects(evaluateGiftCard(store.env, replacement.code, 3000), /Gift card is unavailable/);
  await assert.rejects(setGiftCardActive(store.env, replacement.id, true), /Gift card purchase requires review/);
  assert.deepEqual(await getGiftCardReviewsAdmin(store.env), { reviews: [], reviewCount: 0 });
  await assert.rejects(resolveGiftCardReview(store.env, 'admin-1', { purchaseId: purchase.id, outcome: 'void',
    reason: 'Chargeback received', refundedCents: 1 }), /A payment dispute is open for this purchase/);

  await disputeEvent(store, 'closed', 'pi_gift_won', { id: 'dp_gift_won', amount: 5000, status: 'won' });
  assert.equal(purchaseStatus(store, purchase.id), 'paid');
  assert.deepEqual(card(store, replacement.id), { status: 'active', held_for_review: 0, balance_cents: 5000 });
  assert.equal((await evaluateGiftCard(store.env, replacement.code, 3000)).amount, 3000);
});

test('a gift card purchase disputed while held for a refund review goes back to that review when the dispute is won', async () => {
  const store = shop();
  const purchase = await buyGiftCard(store, 5000, 'pi_gift_review');
  await store.api.webhooks.handleStripe(JSON.stringify({ type: 'charge.refunded', data: { payment_intent: 'pi_gift_review',
    amount: 5000, amount_refunded: 1000, currency: 'usd' } }), 'signature', 'secret');
  assert.equal(purchaseStatus(store, purchase.id), 'review');
  await disputeEvent(store, 'created', 'pi_gift_review', { id: 'dp_gift_review', amount: 4000, status: 'needs_response' });
  assert.equal(disputeRow(store, 'dp_gift_review').status_before, 'review');
  await disputeEvent(store, 'closed', 'pi_gift_review', { id: 'dp_gift_review', amount: 4000, status: 'won' });
  assert.equal(purchaseStatus(store, purchase.id), 'review');
  assert.deepEqual(card(store, purchase.card.id), { status: 'suspended', held_for_review: 1, balance_cents: 5000 });
  // The refund decision is open again.
  assert.deepEqual((await getGiftCardReviewsAdmin(store.env)).reviews.map((review) => review.purchaseId), [purchase.id]);
});

test('a lost gift card purchase dispute voids its cards and reverses what is left, once no checkout holds value on them', async () => {
  const store = shop();
  const purchase = await buyGiftCard(store, 5000, 'pi_gift_lost');
  // 3000 spent on a gift-card-only order, and 2000 held by a checkout in progress.
  const spent = await checkout(store, { giftCardCode: purchase.code }, { items: [{ productId: 'pin', quantity: 1 }] });
  assert.equal(spent.status, 'paid');
  const holding = await checkout(store, { giftCardCode: purchase.code });
  assert.deepEqual([holding.status, holding.giftCardApplied], ['pending', 2000]);
  assert.equal(card(store, purchase.card.id).balance_cents, 0);

  await disputeEvent(store, 'created', 'pi_gift_lost', { id: 'dp_gift_lost', amount: 5000, status: 'needs_response' });
  await assert.rejects(disputeEvent(store, 'closed', 'pi_gift_lost', { id: 'dp_gift_lost', amount: 5000, status: 'lost' }),
    (error) => error instanceof WebhookRetryLaterError && /checkout in progress/.test(error.message));
  assert.equal(purchaseStatus(store, purchase.id), 'review');
  assert.deepEqual(card(store, purchase.card.id), { status: 'suspended', held_for_review: 1, balance_cents: 0 });
  assert.equal(disputeRow(store, 'dp_gift_lost').status, 'lost');

  // The checkout ends and gives its 2000 back to the card; Stripe delivers the event again.
  await store.api.orders.cancel(holding.id);
  assert.equal(card(store, purchase.card.id).balance_cents, 2000);
  assert.deepEqual(await disputeEvent(store, 'closed', 'pi_gift_lost', { id: 'dp_gift_lost', amount: 5000, status: 'lost' }),
    { success: true, event: 'charge.dispute.closed', purchaseId: purchase.id });
  assert.equal(purchaseStatus(store, purchase.id), 'refunded');
  assert.deepEqual(card(store, purchase.card.id), { status: 'void', held_for_review: 0, balance_cents: 0 });
  assert.deepEqual(rows(store, `SELECT kind, amount_cents FROM _ecommerce_gift_card_ledger WHERE card_id = ? ORDER BY rowid`, purchase.card.id)
    .map((item) => `${item.kind}:${item.amount_cents}`),
    ['issue:5000', 'reserve:-3000', 'reserve:-2000', 'release:2000', 'purchase_reversal:-2000']);
  // What was spent stays spent.
  assert.equal(orderStatus(store, spent.id), 'paid');
});

test('a dispute on a payment the store has not recorded is retried, and one of another integration is ignored', async () => {
  const store = shop();
  const early = await checkout(store);
  store.state.references.pi_early = { orderId: early.id, giftCardPurchaseId: null };
  await assert.rejects(disputeEvent(store, 'created', 'pi_early', { id: 'dp_early', status: 'needs_response' }),
    (error) => error instanceof WebhookRetryLaterError && /no recorded payment yet/.test(error.message));
  assert.equal(row(store, 'SELECT COUNT(*) AS n FROM _ecommerce_disputes').n, 0);
  await pay(store, early, 'pi_early');
  await disputeEvent(store, 'created', 'pi_early', { id: 'dp_early', status: 'needs_response' });
  assert.equal(orderStatus(store, early.id), 'disputed');

  const ignored = { success: true, event: 'charge.dispute.created', ignored: true };
  assert.deepEqual(await disputeEvent(store, 'created', 'pi_elsewhere', { id: 'dp_elsewhere', status: 'needs_response' }), ignored);
  const released = await checkout(store);
  await store.api.orders.cancel(released.id);
  store.state.references.pi_released = { orderId: released.id };
  assert.deepEqual(await disputeEvent(store, 'created', 'pi_released', { id: 'dp_released', status: 'needs_response' }), ignored);
  // A dispute event without its dispute id cannot be recorded.
  assert.deepEqual(await disputeEvent(store, 'created', early.paymentIntentId, { id: undefined, status: 'needs_response' }), ignored);
  // An order paid through another payment is logged as a mismatch rather than retried.
  const paid = await pay(store, await checkout(store));
  store.state.references.pi_second_payment = { orderId: paid.id };
  assert.deepEqual(await disputeEvent(store, 'created', 'pi_second_payment', { id: 'dp_second_payment', status: 'needs_response' }),
    { ...ignored, reason: 'payment_not_recorded' });
  assert.equal(orderStatus(store, paid.id), 'paid');
  // An adapter that cannot look payments up leaves an unknown dispute ignored.
  const plain = bindCommerceApi({ env: store.env, paymentAdapters: [{ ...store.adapter, getPaymentReferences: undefined }] });
  store.state.references.pi_unknown = { orderId: (await checkout(store)).id };
  assert.deepEqual(await plain.webhooks.handleStripe(JSON.stringify({ type: 'charge.dispute.closed',
    data: { id: 'dp_unknown', payment_intent: 'pi_unknown', status: 'lost' } }), 'signature', 'secret'),
  { success: true, event: 'charge.dispute.closed', ignored: true });
  assert.equal(row(store, 'SELECT COUNT(*) AS n FROM _ecommerce_disputes').n, 1);
});

test('Stripe payments carry the store reference, and a payment is looked up by it', async () => {
  const adapter = new StripePaymentAdapter({ secretKey: 'sk_test_fake', webhookSecret: 'whsec_fake' });
  const sessions = [];
  adapter.stripe = {
    coupons: { async create(input) { return { id: input.id }; } },
    checkout: { sessions: { async create(input) { sessions.push(input); return { id: `cs_test_${sessions.length}`, url: 'https://checkout.stripe.test/pay' }; } } },
    paymentIntents: { async retrieve(id) {
      if (id === 'pi_missing') throw Object.assign(new Error('No such payment_intent'), { code: 'resource_missing', statusCode: 404 });
      if (id === 'pi_down') throw Object.assign(new Error('Stripe is unavailable'), { statusCode: 500 });
      return { id, metadata: { pi_order: { orderId: 'ord_1' }, pi_gift: { giftCardPurchaseId: 'gp_1' } }[id] ?? {} };
    } },
    webhooks: { async constructEventAsync() {
      return { id: 'evt_1', type: 'charge.dispute.created', created: 1_700_000_000, data: { object: { id: 'dp_1' } } };
    } },
  };
  const urls = { successUrl: 'https://shop.example.test/success', cancelUrl: 'https://shop.example.test/cancel' };
  await adapter.createCheckoutSession({ orderId: 'ord_1', items: [{ name: 'Lamp', priceCents: 12000, quantity: 1 }],
    metadata: { giftCardApplied: '0' }, ...urls });
  await adapter.createCheckoutSession({ orderId: 'gp_1', items: [{ name: 'Gift card', priceCents: 5000, quantity: 1 }],
    metadata: { giftCardPurchaseId: 'gp_1' }, ...urls });
  assert.deepEqual(sessions.map((session) => session.payment_intent_data), [
    { metadata: { orderId: 'ord_1' } }, { metadata: { giftCardPurchaseId: 'gp_1' } }]);
  assert.deepEqual(sessions.map((session) => session.metadata), [
    { orderId: 'ord_1', giftCardApplied: '0' }, { orderId: 'gp_1', giftCardPurchaseId: 'gp_1' }]);

  assert.deepEqual(await adapter.getPaymentReferences('pi_order'), { orderId: 'ord_1', giftCardPurchaseId: null });
  assert.deepEqual(await adapter.getPaymentReferences('pi_gift'), { orderId: null, giftCardPurchaseId: 'gp_1' });
  assert.deepEqual(await adapter.getPaymentReferences('pi_other'), { orderId: null, giftCardPurchaseId: null });
  assert.equal(await adapter.getPaymentReferences('pi_missing'), null);
  await assert.rejects(adapter.getPaymentReferences('pi_down'), /Stripe is unavailable/);

  const event = await adapter.validateWebhook('{}', 'signature');
  assert.deepEqual([event.type, event.id, event.created, event.data], ['charge.dispute.created', 'evt_1', 1_700_000_000, { id: 'dp_1' }]);
});
