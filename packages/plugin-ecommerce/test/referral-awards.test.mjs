import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi, reconcileCommerce } from '../dist/api.js';
import { canonicalEmail, getOrCreateReferralCode, getReferralDashboard, getReferralPolicy, referralPolicy,
  releaseReferralAwards, reverseReferralForOrder } from '../dist/referrals.js';
import { createDiscountCode, getPromotionsAdmin, saveReferralSettings } from '../dist/promotions.js';
import { issueAdminGiftCard, refundGiftCardTender } from '../dist/gift-cards.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ENABLED = { TALISMAN_COMMERCE_REFERRALS_ENABLED: 'true' };
const TERMS = { rewardCents: 1000, minOrderCents: 5000, attributionDays: 30 };
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql'];

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

const address = { shippingAddress: { name: 'Test', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' },
  successUrl: 'https://example.test/success?order={ORDER_ID}', cancelUrl: 'https://example.test/cancel?order={ORDER_ID}' };

/** A store with one $120 product, a referrer at jane.doe@gmail.com and a Stripe test adapter. */
function shop(settings = ENABLED) {
  const { sqlite, DB } = database();
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at)
    VALUES ('lamp', 'Lamp', 'lamp', 12000, 100, 'active', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at)
    VALUES ('referrer', 'Jane.Doe@gmail.com', 'jane.doe@gmail.com', ?, ?, ?)`).run(now, now, now);
  const env = { DB, TALISMAN_COMMERCE_GIFT_CARD_KEY: 'a'.repeat(64), ...settings };
  const state = { dispute: 'none', disputeCalls: [] };
  const adapter = {
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://example.test/${orderId}` };
    },
    async expireCheckoutSession() {},
    async validateWebhook(payload) { return JSON.parse(payload); },
    async getDisputeStatus(paymentIntentId) { state.disputeCalls.push(paymentIntentId); return state.dispute; },
  };
  return { sqlite, DB, env, state, adapter, browsers: 0,
    api: bindCommerceApi({ env, paymentAdapters: [adapter] }) };
}

function addAccount(store, id, email) {
  const now = Math.floor(Date.now() / 1000);
  store.sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, email, email.toLowerCase(), now, now, now);
}

async function checkout(store, details, { accountId } = {}) {
  const cart = await store.api.carts.getOrCreate(`browser-${++store.browsers}`, accountId);
  await store.api.carts.updateItems(cart.id, [{ productId: 'lamp', quantity: 1 }]);
  return (await store.api.orders.createFromCart(cart.id, { ...address, providerId: 'stripe', ...details })).order;
}

async function pay(store, order, providerEmail) {
  await store.api.orders.finalizePayment(order.id, { provider: 'stripe', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: order.totalAmount, currency: 'usd', paymentIntentId: `pi_${order.id}`,
    customerEmail: providerEmail });
  return store.api.orders.find(order.id);
}

/** A new shopper follows the referrer's link and pays. */
async function referredPurchase(store, email = 'friend@example.com') {
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  const order = await checkout(store, { customerEmail: email, referralCode: code });
  assert.equal(order.referralCode, code);
  return pay(store, order);
}

const release = (store, days = 31, adapters = [store.adapter]) => releaseReferralAwards(
  { env: store.env, paymentAdapters: adapters }, { now: new Date(Date.now() + days * DAY_MS) });
const statuses = (results) => results.map((result) => result.status);
const balance = async (store, accountId) => (await getReferralDashboard(store.env, accountId)).creditBalance;
const referralStatus = (store, orderId) => store.sqlite
  .prepare('SELECT status FROM _ecommerce_referrals WHERE order_id = ?').get(orderId)?.status ?? null;
const ledger = (store, orderId) => store.sqlite
  .prepare('SELECT kind, amount_cents FROM _ecommerce_credit_ledger WHERE order_id = ? ORDER BY kind').all(orderId)
  .map((row) => `${row.kind}:${row.amount_cents}`);
const RELEASED = ['referral_award:1000', 'welcome_award:1000'];
const REVERSED = ['referral_award:1000', 'referral_reversal:-1000', 'welcome_award:1000', 'welcome_reversal:-1000'];

const refund = (store, order, amountRefunded) => store.api.webhooks.handleStripe(JSON.stringify({
  type: 'charge.refunded', data: { payment_intent: `pi_${order.id}`, amount: order.totalAmount,
    amount_refunded: amountRefunded, currency: 'usd' } }), 'signature', 'secret');
const disputeClosed = (store, paymentIntent, status) => store.api.webhooks.handleStripe(JSON.stringify({
  type: 'charge.dispute.closed', data: { payment_intent: paymentIntent, status } }), 'signature', 'secret');

test('canonical addresses drop sub-addressing everywhere and dots only for Gmail', () => {
  assert.equal(canonicalEmail(' Jane.Doe+Promo@GoogleMail.com '), 'janedoe@gmail.com');
  assert.equal(canonicalEmail('j.a.n.e.doe@gmail.com.'), 'janedoe@gmail.com');
  assert.equal(canonicalEmail('Sam.Lee+shop@Example.com'), 'sam.lee@example.com');
  assert.equal(canonicalEmail('+tag@example.com'), '+tag@example.com');
  assert.equal(canonicalEmail('not-an-address'), null);
  assert.equal(canonicalEmail('@example.com'), null);
  assert.equal(canonicalEmail(undefined), null);
});

test('referrals are off with no saved settings and no Worker setting', async () => {
  assert.equal(referralPolicy({}).enabled, false);
  for (const value of ['1', 'yes', 'on', 'TRUE', 'false']) {
    assert.equal(referralPolicy({ TALISMAN_COMMERCE_REFERRALS_ENABLED: value }).enabled, false, value);
  }
  const store = shop({});
  assert.deepEqual(await getReferralPolicy(store.env), { enabled: false, switchedOn: false, termsError: null,
    source: 'settings', ...TERMS, holdDays: 30, maxPerPeriod: 10, periodDays: 30 });
  assert.equal((await getPromotionsAdmin(store.env)).referral.switchedOn, false);
  // No code is issued while referrals are off.
  const dashboard = await getReferralDashboard(store.env, 'referrer');
  assert.deepEqual([dashboard.code, dashboard.codeActive], [null, false]);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_referral_codes').get().count, 0);
  // A code issued earlier is still shown, and attributes nothing.
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  assert.equal((await getReferralDashboard(store.env, 'referrer')).code, code);
  const order = await checkout(store, { customerEmail: 'friend@example.com', referralCode: code });
  assert.deepEqual([order.referralCode, order.referralRewardCents], [null, 0]);
});

test('the Worker setting turns referrals on and a saved row wins in both directions', async () => {
  assert.equal(referralPolicy({ TALISMAN_COMMERCE_REFERRALS_ENABLED: true }).enabled, true);
  const store = shop();
  assert.equal((await getReferralPolicy(store.env)).enabled, true);
  const { code } = await getReferralDashboard(store.env, 'referrer');
  assert.match(code, /^REF-[A-F0-9]{20}$/);
  assert.equal((await checkout(store, { customerEmail: 'friend@example.com', referralCode: code })).referralCode, code);

  await saveReferralSettings(store.env, { enabled: false, ...TERMS });
  assert.deepEqual(await getReferralPolicy(store.env), { enabled: false, switchedOn: false, termsError: null,
    source: 'saved', ...TERMS, holdDays: 30, maxPerPeriod: 10, periodDays: 30 });
  assert.equal((await checkout(store, { customerEmail: 'second@example.com', referralCode: code })).referralCode, null);

  const saved = shop({});
  await saveReferralSettings(saved.env, { enabled: true, ...TERMS });
  const savedCode = (await getReferralDashboard(saved.env, 'referrer')).code;
  assert.ok(savedCode);
  assert.equal((await checkout(saved, { customerEmail: 'friend@example.com', referralCode: savedCode })).referralCode, savedCode);
});

test('a reward above half the minimum order is refused and attributes nothing', async () => {
  const store = shop();
  await assert.rejects(saveReferralSettings(store.env, { enabled: true, rewardCents: 2501, minOrderCents: 5000,
    attributionDays: 30 }), { message: 'The reward must be at most half the minimum first order' });
  assert.equal((await saveReferralSettings(store.env, { enabled: true, rewardCents: 2500, minOrderCents: 5000,
    attributionDays: 30 })).enabled, true);

  const fromSettings = referralPolicy({ ...ENABLED, TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS: '3000' });
  assert.deepEqual([fromSettings.switchedOn, fromSettings.enabled], [true, false]);
  assert.match(fromSettings.termsError, /at most half the minimum/);

  // A row saved before the rule keeps its values but pauses new referrals, and the admin sees why.
  store.sqlite.exec('UPDATE _ecommerce_referral_settings SET reward_cents = 4000');
  const saved = (await getPromotionsAdmin(store.env)).referral;
  assert.deepEqual([saved.switchedOn, saved.enabled, saved.rewardCents], [true, false, 4000]);
  assert.match(saved.termsError, /at most half the minimum/);
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  assert.equal((await checkout(store, { customerEmail: 'friend@example.com', referralCode: code })).referralCode, null);
  // Such a row can be switched off without changing its terms; the terms must be valid to switch it on.
  const off = await saveReferralSettings(store.env, { enabled: false, rewardCents: 4000, minOrderCents: 5000,
    attributionDays: 30 });
  assert.deepEqual([off.switchedOn, off.enabled], [false, false]);
});

test('the minimum order applies to the subtotal less the promotion discount', async () => {
  const store = shop();
  const discount = (code, value) => createDiscountCode(store.env, { code, description: null, type: 'amount', value,
    maxDiscountCents: null, minOrderCents: 0, eligibleProductIds: [], maxUses: null, maxUsesPerCustomer: null,
    firstOrderOnly: false, startsAt: null, expiresAt: null, active: true });
  await discount('SAVE7001', 7001);
  await discount('SAVE7000', 7000);
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  const below = await checkout(store, { customerEmail: 'one@example.com', referralCode: code, discountCode: 'SAVE7001' });
  assert.deepEqual([below.discountAmount, below.referralCode], [7001, null]);
  const exact = await checkout(store, { customerEmail: 'two@example.com', referralCode: code, discountCode: 'SAVE7000' });
  assert.deepEqual([exact.discountAmount, exact.referralCode], [7000, code]);
});

test('shipping counts toward neither the minimum order nor what the order keeps', async () => {
  const rates = { TALISMAN_COMMERCE_SHIPPING_RATES: JSON.stringify([
    { id: 'standard', label: 'Standard shipping', amount: 1500 }]) };
  // $120 of items with $15 of shipping stay below a $125 minimum.
  const high = shop({ ...ENABLED, ...rates, TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS: '12500' });
  const highCode = await getOrCreateReferralCode(high.env, 'referrer');
  const below = await checkout(high, { customerEmail: 'friend@example.com', referralCode: highCode });
  assert.deepEqual([below.shippingAmount, below.totalAmount, below.referralCode], [1500, 13500, null]);

  // At a $120 minimum the items qualify. A refund counts against the goods even when it returned
  // the shipping, so refunding $15 leaves less than the minimum kept.
  const store = shop({ ...ENABLED, ...rates, TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS: '12000' });
  const order = await referredPurchase(store);
  assert.deepEqual([order.shippingAmount, order.totalAmount], [1500, 13500]);
  assert.equal(referralStatus(store, order.id), 'approved');
  await refund(store, order, 1500);
  assert.equal(referralStatus(store, order.id), 'void');
});

test('addresses that reach the referrer\'s mailbox are refused at checkout', async () => {
  const store = shop();
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  for (const email of ['JaneDoe@gmail.com', 'jane.doe+shop@gmail.com', 'j.a.n.e.d.o.e@googlemail.com',
    ' Jane.Doe+x@GoogleMail.com ']) {
    assert.equal((await checkout(store, { customerEmail: email, referralCode: code })).referralCode, null, email);
  }
  // A signed-in account whose address is equivalent, whatever the checkout email.
  addAccount(store, 'alias', 'jane.doe+alt@gmail.com');
  assert.equal((await checkout(store, { customerEmail: 'other@example.com', referralCode: code },
    { accountId: 'alias' })).referralCode, null);

  // Sub-addressing counts on every domain; dots only for Gmail.
  addAccount(store, 'sam', 'sam.lee@example.com');
  const samCode = await getOrCreateReferralCode(store.env, 'sam');
  assert.equal((await checkout(store, { customerEmail: 'Sam.Lee+promo@example.com', referralCode: samCode })).referralCode, null);
  assert.equal((await checkout(store, { customerEmail: 'samlee@example.com', referralCode: samCode })).referralCode, samCode);
});

test('a shopper who bought under an equivalent address is not a first-time buyer', async () => {
  const store = shop();
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  await pay(store, await checkout(store, { customerEmail: 'buyer@example.com' }));
  await pay(store, await checkout(store, { customerEmail: 'pat.smith@gmail.com' }));
  for (const email of ['Buyer+2@example.com', 'buyer+referral@example.com', 'patsmith+new@googlemail.com']) {
    assert.equal((await checkout(store, { customerEmail: email, referralCode: code })).referralCode, null, email);
  }
  assert.equal((await checkout(store, { customerEmail: 'buyer2@example.com', referralCode: code })).referralCode, code);
});

test('at payment the provider\'s address is compared with the referrer and with earlier buyers', async () => {
  const store = shop();
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  const own = await checkout(store, { customerEmail: 'friend@example.com', referralCode: code });
  assert.equal(own.referralCode, code);
  await pay(store, own, 'JANE.DOE+pay@gmail.com');
  assert.equal(referralStatus(store, own.id), null);

  await pay(store, await checkout(store, { customerEmail: 'early@example.com' }));
  const repeat = await checkout(store, { customerEmail: 'fresh@example.com', referralCode: code });
  assert.equal(repeat.referralCode, code);
  await pay(store, repeat, 'early+again@example.com');
  assert.equal(referralStatus(store, repeat.id), null);

  const genuine = await checkout(store, { customerEmail: 'new@example.com', referralCode: code });
  await pay(store, genuine, 'new@example.com');
  assert.equal(referralStatus(store, genuine.id), 'approved');
});

test('each referrer has a cap per period and a new period allows more', async () => {
  const store = shop({ ...ENABLED, TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD: '2',
    TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS: '7' });
  const policy = await getReferralPolicy(store.env);
  assert.deepEqual([policy.maxPerPeriod, policy.periodDays, policy.holdDays], [2, 7, 30]);
  const paid = [];
  for (const email of ['one@example.com', 'two@example.com', 'three@example.com']) {
    paid.push(await referredPurchase(store, email));
  }
  assert.deepEqual(paid.map((order) => referralStatus(store, order.id)), ['approved', 'approved', null]);

  store.sqlite.prepare('UPDATE _ecommerce_referrals SET created_at = created_at - ?').run(8 * 24 * 60 * 60);
  const later = await referredPurchase(store, 'four@example.com');
  assert.equal(referralStatus(store, later.id), 'approved');

  // Values that are not positive whole numbers in range fall back to the defaults.
  const fallback = referralPolicy({ TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS: '366',
    TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD: '-1', TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS: '0' });
  assert.deepEqual([fallback.holdDays, fallback.maxPerPeriod, fallback.periodDays], [30, 10, 30]);
});

test('the cap per period counts the referrer\'s equivalent addresses together', async () => {
  const store = shop({ ...ENABLED, TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD: '1' });
  addAccount(store, 'referrer-two', 'jane.doe+two@gmail.com');
  const first = await referredPurchase(store, 'one@example.com');
  const secondCode = await getOrCreateReferralCode(store.env, 'referrer-two');
  const second = await pay(store, await checkout(store, { customerEmail: 'two@example.com', referralCode: secondCode }));
  assert.deepEqual([referralStatus(store, first.id), referralStatus(store, second.id)], ['approved', null]);

  addAccount(store, 'other', 'other@example.com');
  const otherCode = await getOrCreateReferralCode(store.env, 'other');
  const third = await pay(store, await checkout(store, { customerEmail: 'three@example.com', referralCode: otherCode }));
  assert.equal(referralStatus(store, third.id), 'approved');
});

test('payment records a pending award with no credit and the dashboard shows when it releases', async () => {
  const store = shop();
  const order = await referredPurchase(store);
  assert.equal(referralStatus(store, order.id), 'approved');
  assert.deepEqual(ledger(store, order.id), []);
  assert.equal(await balance(store, 'referrer'), 0);
  assert.equal(await balance(store, order.userId), 0);
  const [entry] = (await getReferralDashboard(store.env, 'referrer')).earned;
  assert.deepEqual([entry.orderId, entry.state, entry.rewardCents], [order.id, 'pending', 1000]);
  assert.equal(entry.releasesAt.getTime(), entry.createdAt.getTime() + 30 * DAY_MS);
});

test('the scheduled job releases awards once after the hold, whatever the switch says', async () => {
  const store = shop({ ...ENABLED, TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS: '14' });
  const order = await referredPurchase(store);
  assert.deepEqual(await release(store, 13), []);
  assert.deepEqual(ledger(store, order.id), []);

  // Turning new referrals off does not hold back an award already earned.
  await saveReferralSettings(store.env, { enabled: false, ...TERMS });
  assert.deepEqual(statuses(await release(store, 15)), ['referral_released']);
  assert.deepEqual(await release(store, 15), []);
  assert.deepEqual(ledger(store, order.id), RELEASED);
  assert.equal(await balance(store, 'referrer'), 1000);
  assert.equal(await balance(store, order.userId), 1000);
  const [entry] = (await getReferralDashboard(store.env, 'referrer')).earned;
  assert.deepEqual([entry.state, entry.releasesAt], ['released', null]);
});

test('reconcileCommerce releases due awards and reports held ones without errors', async () => {
  const store = shop();
  const order = await referredPurchase(store);
  store.sqlite.prepare('UPDATE _ecommerce_referrals SET created_at = created_at - ?').run(31 * 24 * 60 * 60);
  store.state.dispute = 'open';
  let results = await reconcileCommerce({ env: store.env, paymentAdapters: [store.adapter] });
  assert.deepEqual(statuses(results), ['referral_held']);
  store.state.dispute = 'none';
  results = await reconcileCommerce({ env: store.env, paymentAdapters: [store.adapter] });
  assert.deepEqual(statuses(results), ['referral_released']);
  assert.deepEqual(ledger(store, order.id), RELEASED);
});

test('an open dispute, or no adapter that can report one, keeps the award pending', async () => {
  const store = shop();
  const order = await referredPurchase(store);
  store.state.dispute = 'open';
  assert.deepEqual(statuses(await release(store)), ['referral_held']);
  assert.deepEqual(store.state.disputeCalls, [`pi_${order.id}`]);
  assert.deepEqual(statuses(await release(store, 31, [])), ['referral_held']);
  assert.deepEqual(statuses(await release(store, 31, [{ providerId: 'stripe' }])), ['referral_held']);
  assert.deepEqual(ledger(store, order.id), []);
  assert.equal(referralStatus(store, order.id), 'approved');
  store.state.dispute = 'none';
  assert.deepEqual(statuses(await release(store)), ['referral_released']);
  assert.deepEqual(ledger(store, order.id), RELEASED);
});

test('a referral voided while the release runs receives nothing', async () => {
  const store = shop();
  const order = await referredPurchase(store);
  const adapter = { providerId: 'stripe', async getDisputeStatus(paymentIntentId) {
    await disputeClosed(store, paymentIntentId, 'lost');
    return 'none';
  } };
  assert.deepEqual(statuses(await release(store, 31, [adapter])), ['referral_void']);
  assert.equal(referralStatus(store, order.id), 'void');
  assert.deepEqual(ledger(store, order.id), []);
  assert.equal(await balance(store, 'referrer'), 0);
});

test('a lost dispute voids a pending award and reverses a released one', async () => {
  const store = shop();
  const found = await referredPurchase(store, 'one@example.com');
  store.state.dispute = 'lost';
  assert.deepEqual(statuses(await release(store)), ['referral_void']);
  assert.equal(referralStatus(store, found.id), 'void');
  assert.deepEqual(ledger(store, found.id), []);
  store.state.dispute = 'none';
  assert.deepEqual(await release(store), []);

  const reported = await referredPurchase(store, 'two@example.com');
  assert.deepEqual(await disputeClosed(store, `pi_${reported.id}`, 'lost'),
    { success: true, event: 'charge.dispute.closed', orderId: reported.id });
  assert.equal(referralStatus(store, reported.id), 'void');
  assert.deepEqual(ledger(store, reported.id), []);

  const released = await referredPurchase(store, 'three@example.com');
  assert.deepEqual(statuses(await release(store)), ['referral_released']);
  assert.equal(await balance(store, 'referrer'), 1000);
  assert.deepEqual(await disputeClosed(store, `pi_${released.id}`, 'won'),
    { success: true, event: 'charge.dispute.closed', ignored: true });
  assert.deepEqual(ledger(store, released.id), RELEASED);
  await disputeClosed(store, `pi_${released.id}`, 'lost');
  await disputeClosed(store, `pi_${released.id}`, 'lost');
  assert.deepEqual(ledger(store, released.id), REVERSED);
  assert.equal(referralStatus(store, released.id), 'void');
  assert.equal(await balance(store, 'referrer'), 0);
  assert.equal(await balance(store, released.userId), 0);
  assert.deepEqual((await getReferralDashboard(store.env, 'referrer')).earned.map((entry) => entry.state),
    ['void', 'void', 'void']);

  assert.deepEqual(await disputeClosed(store, 'pi_unknown', 'lost'),
    { success: true, event: 'charge.dispute.closed', ignored: true });
});

test('a partial refund below the minimum voids a pending award and reverses a released one', async () => {
  const store = shop();
  const pending = await referredPurchase(store, 'one@example.com');
  await refund(store, pending, 7001);
  assert.equal((await store.api.orders.find(pending.id)).status, 'partially_refunded');
  assert.equal(referralStatus(store, pending.id), 'void');
  assert.deepEqual(ledger(store, pending.id), []);
  assert.deepEqual(await release(store), []);

  const released = await referredPurchase(store, 'two@example.com');
  assert.deepEqual(statuses(await release(store)), ['referral_released']);
  await refund(store, released, 8000);
  assert.equal(referralStatus(store, released.id), 'void');
  assert.deepEqual(ledger(store, released.id), REVERSED);
  assert.equal(await balance(store, 'referrer'), 0);
  assert.equal(await balance(store, released.userId), 0);
});

test('the promotion discount counts toward the net amount a refund is measured against', async () => {
  const store = shop();
  await createDiscountCode(store.env, { code: 'SAVE7000', description: null, type: 'amount', value: 7000,
    maxDiscountCents: null, minOrderCents: 0, eligibleProductIds: [], maxUses: null, maxUsesPerCustomer: null,
    firstOrderOnly: false, startsAt: null, expiresAt: null, active: true });
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  const pending = await pay(store, await checkout(store, { customerEmail: 'one@example.com', referralCode: code,
    discountCode: 'SAVE7000' }));
  assert.deepEqual([pending.discountAmount, pending.totalAmount], [7000, 5000]);
  assert.equal(referralStatus(store, pending.id), 'approved');
  await refund(store, pending, 1);
  assert.equal(referralStatus(store, pending.id), 'void');
  assert.deepEqual(ledger(store, pending.id), []);

  const released = await pay(store, await checkout(store, { customerEmail: 'two@example.com', referralCode: code,
    discountCode: 'SAVE7000' }));
  assert.deepEqual(statuses(await release(store)), ['referral_released']);
  await refund(store, released, 1);
  assert.equal(referralStatus(store, released.id), 'void');
  assert.deepEqual(ledger(store, released.id), REVERSED);
});

test('an award is measured against at least twice its own reward when the terms are lowered later', async () => {
  const store = shop({});
  await saveReferralSettings(store.env, { enabled: true, rewardCents: 5000, minOrderCents: 10000, attributionDays: 30 });
  const pending = await referredPurchase(store, 'one@example.com');
  const released = await referredPurchase(store, 'two@example.com');
  assert.deepEqual([pending.referralRewardCents, released.referralRewardCents], [5000, 5000]);
  store.sqlite.prepare('UPDATE _ecommerce_referrals SET created_at = created_at - ? WHERE order_id = ?')
    .run(31 * 24 * 60 * 60, released.id);
  assert.deepEqual(statuses(await release(store, 0)), ['referral_released']);
  await saveReferralSettings(store.env, { enabled: true, rewardCents: 1000, minOrderCents: 2000, attributionDays: 30 });

  // Each order keeps 2000 paid: enough for the new minimum, less than twice the 5000 reward.
  await refund(store, pending, 10000);
  await refund(store, released, 10000);
  assert.equal(referralStatus(store, pending.id), 'void');
  assert.equal(referralStatus(store, released.id), 'void');
  assert.deepEqual(await release(store), []);
  assert.deepEqual(ledger(store, pending.id), []);
  assert.deepEqual(ledger(store, released.id), ['referral_award:5000', 'referral_reversal:-5000',
    'welcome_award:5000', 'welcome_reversal:-5000']);
});

test('raising the minimum later never voids an award whose order was not refunded', async () => {
  const store = shop({});
  await saveReferralSettings(store.env, { enabled: true, ...TERMS });
  const pending = await referredPurchase(store, 'one@example.com');
  const released = await referredPurchase(store, 'two@example.com');
  store.sqlite.prepare('UPDATE _ecommerce_referrals SET created_at = created_at - ? WHERE order_id = ?')
    .run(31 * 24 * 60 * 60, released.id);
  assert.deepEqual(statuses(await release(store, 0)), ['referral_released']);

  // The orders paid 12000 at a 5000 minimum; the new minimum is above what either paid.
  await saveReferralSettings(store.env, { enabled: true, rewardCents: 1000, minOrderCents: 20000, attributionDays: 30 });
  assert.deepEqual(statuses(await release(store)), ['referral_released']);
  assert.deepEqual(ledger(store, pending.id), RELEASED);
  assert.equal(referralStatus(store, pending.id), 'approved');
  await reverseReferralForOrder(store.env, released.id);
  assert.equal(referralStatus(store, released.id), 'approved');
  assert.deepEqual(ledger(store, released.id), RELEASED);
});

test('after the minimum is raised, a refund is measured against the lower of it and what the order qualified with', async () => {
  const store = shop({});
  await saveReferralSettings(store.env, { enabled: true, ...TERMS });
  const order = await referredPurchase(store);
  await saveReferralSettings(store.env, { enabled: true, rewardCents: 1000, minOrderCents: 8000, attributionDays: 30 });
  await refund(store, order, 3000);
  assert.equal(referralStatus(store, order.id), 'approved');
  assert.deepEqual(statuses(await release(store)), ['referral_released']);
  assert.deepEqual(ledger(store, order.id), RELEASED);
  await refund(store, order, 4001);
  assert.equal(referralStatus(store, order.id), 'void');
  assert.deepEqual(ledger(store, order.id), REVERSED);
});

test('the release voids an award whose order kept less than twice its reward', async () => {
  const store = shop({});
  await saveReferralSettings(store.env, { enabled: true, rewardCents: 5000, minOrderCents: 10000, attributionDays: 30 });
  const order = await referredPurchase(store);
  await saveReferralSettings(store.env, { enabled: true, rewardCents: 1000, minOrderCents: 2000, attributionDays: 30 });
  // A refund recorded without the reversal step, so only the release checks the order.
  store.sqlite.prepare(`UPDATE _ecommerce_orders SET provider_refunded_cents = 10000, status = 'partially_refunded'
    WHERE id = ?`).run(order.id);
  assert.deepEqual(statuses(await release(store)), ['referral_void']);
  assert.deepEqual(ledger(store, order.id), []);
});

test('a partial refund that leaves the minimum paid keeps the award', async () => {
  const store = shop();
  const order = await referredPurchase(store);
  await refund(store, order, 3000);
  assert.equal(referralStatus(store, order.id), 'approved');
  assert.deepEqual(statuses(await release(store)), ['referral_released']);
  await refund(store, order, 7000);
  assert.equal(referralStatus(store, order.id), 'approved');
  assert.deepEqual(ledger(store, order.id), RELEASED);
  assert.equal(await balance(store, 'referrer'), 1000);
});

test('a gift card tender refund below the minimum reverses released awards', async () => {
  const store = shop();
  const gift = await issueAdminGiftCard(store.env, 'admin-1', { amountCents: 8000, reason: 'Goodwill gift card' });
  const code = await getOrCreateReferralCode(store.env, 'referrer');
  const order = await checkout(store, { customerEmail: 'friend@example.com', referralCode: code, giftCardCode: gift.code });
  assert.deepEqual([order.giftCardApplied, order.totalAmount, order.referralCode], [8000, 4000, code]);
  const paid = await pay(store, order);
  assert.deepEqual(statuses(await release(store)), ['referral_released']);

  await refundGiftCardTender(store.env, 'admin-1', { orderId: order.id, amountCents: 3000, reason: 'Returned one part' });
  assert.equal(referralStatus(store, order.id), 'approved');
  assert.deepEqual(ledger(store, order.id), RELEASED);
  await refundGiftCardTender(store.env, 'admin-1', { orderId: order.id, amountCents: 5000, reason: 'Returned the rest' });
  assert.equal(referralStatus(store, order.id), 'void');
  assert.deepEqual(ledger(store, order.id), REVERSED);
  assert.equal(await balance(store, paid.userId), 0);
});

test('a full refund voids a pending award and reverses a released one', async () => {
  const store = shop();
  const pending = await referredPurchase(store, 'one@example.com');
  await refund(store, pending, 12000);
  assert.equal(referralStatus(store, pending.id), 'void');
  assert.deepEqual(ledger(store, pending.id), []);

  const released = await referredPurchase(store, 'two@example.com');
  await release(store);
  await refund(store, released, 12000);
  assert.equal((await store.api.orders.find(released.id)).status, 'refunded');
  assert.equal(referralStatus(store, released.id), 'void');
  assert.deepEqual(ledger(store, released.id), REVERSED);
});
