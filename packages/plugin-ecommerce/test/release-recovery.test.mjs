import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi, reconcileCommerce, listTaxSyncReview, recoverTaxSync, attachGiftPurchaseSession } from '../dist/api.js';
import { manageShopperData, findCustomerSession, listCustomerOrders } from '../dist/accounts.js';
import { getReferralDashboard, getOrCreateReferralCode, releaseReferralAwards, reverseReferralForOrder } from '../dist/referrals.js';
import { createDiscountCode, saveReferralSettings } from '../dist/promotions.js';
import { issueAdminGiftCard, startGiftCardPurchase, confirmGiftCardPurchase, refundGiftCardTender, refundGiftCardOnlyOrder } from '../dist/gift-cards.js';
import { fulfillCommerceOrder, adjustCommerceFulfillment, listCommerceOrdersAdmin } from '../dist/fulfillment.js';
import { readCatalog, readCatalogPage } from '../dist/catalog.js';
import { StripePaymentAdapter } from '../dist/adapters/stripe.js';
import { hashOrderAccess } from '../dist/cookies.js';
import { applyAllMigrations } from './helpers/migrations.mjs';

/** D1 batches queue atomically, while reads/provider waits from independent requests can overlap. */
function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON'); applyAllMigrations(sqlite);
  let tail = Promise.resolve();
  const DB = { prepare(query) {
    let values = []; const statement = sqlite.prepare(query);
    return { bind(...params) { assert.ok(params.length <= 100); values = params; return this; },
      async all() { return { results: statement.all(...values) }; }, async first() { return statement.get(...values); },
      async raw() { const raw = sqlite.prepare(query); raw.setReturnArrays(true); return raw.all(...values); },
      async run() { return { meta: statement.run(...values) }; } };
  }, batch(statements) {
    const next = tail.then(async () => {
      sqlite.exec('BEGIN');
      try { const rows = []; for (const statement of statements) rows.push(await statement.all()); sqlite.exec('COMMIT'); return rows; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }); tail = next.catch(() => undefined); return next;
  } };
  const env = { DB, TALISMAN_COMMERCE_GIFT_CARD_KEY: 'ab'.repeat(32) };
  sqlite.exec(`INSERT INTO _ecommerce_products (id,name,slug,base_price,inventory_quantity,is_physical,status,created_at,updated_at)
    VALUES ('product','A product','product',1000,100,0,'active',1,1)`);
  return { sqlite, DB, env };
}
const details = { customerEmail: 'shopper@example.test', providerId: 'stripe',
  successUrl: 'https://shop.test/success?order={ORDER_ID}', cancelUrl: 'https://shop.test/cancel' };
const adapter = { providerId: 'stripe', async createCheckoutSession({ orderId }) {
  return { providerSessionId: `cs_test_${orderId}`, url: 'https://checkout.test/pay' };
}, async expireCheckoutSession() {}, async getDisputeStatus() { return 'none'; } };
async function basket(api, token, accountId) {
  const cart = await api.carts.getOrCreate(token, accountId);
  await api.carts.updateItems(cart.id, [{ productId: 'product', quantity: 1 }]); return cart;
}
function account(sqlite, id) {
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts(id,email,email_normalized,email_verified_at,created_at,updated_at)
    VALUES (?,?,?,1,1,1)`).run(id, `${id}@example.test`, `${id}@example.test`);
}
async function paid(api, order) {
  await api.orders.finalizePayment(order.id, { provider: order.paymentProvider, providerId: order.checkoutSessionId,
    paymentIntentId: `pi_${order.id}`, paymentStatus: 'success', amount: order.totalAmount, currency: 'usd' });
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
/** Both contenders have evaluated the same incentive before either reservation transaction can run. */
function checkoutGate(expected = 2) {
  const entered = deferred(); const release = deferred(); let arrivals = 0;
  return { entered: entered.promise, release: release.resolve, adapter: { ...adapter,
    async createCheckoutSession(input) { if (++arrivals === expected) entered.resolve(); await release.promise; return adapter.createCheckoutSession(input); } } };
}

test('guest order credentials still authorize status and cancellation after a new basket detaches the original token', async () => {
  const { env, sqlite } = database(); const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const cart = await basket(api, 'guest'); const created = await api.orders.createFromCart(cart.id, details);
  await paid(api, created.order); await basket(api, 'guest');
  assert.equal(sqlite.prepare('SELECT session_token FROM _ecommerce_carts WHERE id = ?').get(cart.id).session_token, null);
  assert.equal((await api.orders.findForSession(created.order.id, 'guest')).id, created.order.id);
  assert.equal(await api.orders.findForSession(created.order.id, 'another-browser'), null);
  assert.equal(await api.orders.findForSession(created.order.id), null);
  assert.equal((await api.orders.findForSession(created.order.id, undefined, undefined, created.orderAccessToken)).id, created.order.id);
  assert.equal(await api.orders.findForSession(created.order.id, undefined, undefined, 'wrong-token'), null);
  sqlite.close();
});

test('switching accounts preserves the previous basket and leaves a clean new basket that can be edited', async () => {
  const { env, sqlite } = database(); account(sqlite, 'a'); account(sqlite, 'b'); const api = bindCommerceApi({ env });
  const previous = await basket(api, 'browser', 'a');
  assert.equal(await api.carts.claim('browser', 'b'), null);
  const next = await api.carts.getOrCreate('browser', 'b'); assert.notEqual(next.id, previous.id); assert.deepEqual(next.items, []);
  await api.carts.updateItems(next.id, [{ productId: 'product', quantity: 2 }]);
  assert.equal((await api.carts.find(undefined, 'a')).items[0].quantity, 1);
  assert.equal((await api.carts.find('browser', 'b')).items[0].quantity, 2); sqlite.close();
});

for (const tender of ['promotion', 'card']) test(`gated overlapping checkouts cannot both reserve one shared ${tender} balance`, async () => {
  const { env, sqlite } = database(); const gate = checkoutGate(); const api = bindCommerceApi({ env, paymentAdapters: [gate.adapter] });
  let options;
  if (tender === 'promotion') {
    await createDiscountCode(env, { code: 'ONCE', description: null, type: 'amount', value: 100, maxDiscountCents: null, minOrderCents: 0, eligibleProductIds: [], maxUses: 1, maxUsesPerCustomer: null, firstOrderOnly: false, startsAt: null, expiresAt: null, active: true }); options = { discountCode: 'ONCE' };
  } else {
    const card = await issueAdminGiftCard(env, 'admin', { amountCents: 1000, reason: 'Race test funding' }); options = { giftCardCode: card.code };
    // A split payment invokes the provider; both evaluated the same 1000-card balance before either reserves it.
    sqlite.exec('UPDATE _ecommerce_products SET base_price = 1050');
  }
  const first = await basket(api, 'first'); const second = await basket(api, 'second');
  const pending = [api.orders.createFromCart(first.id, { ...details, ...options }),
    api.orders.createFromCart(second.id, { ...details, customerEmail: 'second@example.test', ...options })];
  await gate.entered; gate.release(); const results = await Promise.allSettled(pending);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const refused = results.find(result => result.status === 'rejected').reason;
  assert.equal(refused.code, tender === 'promotion' ? 'discount_changed' : 'gift_card_changed'); assert.equal(refused.status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_orders').get().n, 1);
  assert.equal(sqlite.prepare('SELECT inventory_quantity FROM _ecommerce_products').get().inventory_quantity, 99);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_carts WHERE checkout_session_id IS NULL').get().n, 1);
  if (tender === 'card') assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards').get().balance_cents, 0);
  sqlite.close();
});

test('a gated checkout refuses the exact credit balance that a concurrent award reversal removed', async () => {
  const { env, sqlite } = database(); account(sqlite, 'referrer'); account(sqlite, 'buyer');
  sqlite.exec(`INSERT INTO _ecommerce_orders(id,user_id,status,subtotal_amount,total_amount,created_at,updated_at)
    VALUES ('original','buyer','refunded',1000,1000,1,1);
    INSERT INTO _ecommerce_credit_ledger(id,account_id,order_id,kind,amount_cents,created_at)
    VALUES ('award','referrer','original','referral_award',500,1);`);
  const gate = checkoutGate(1); const api = bindCommerceApi({ env, paymentAdapters: [gate.adapter] });
  const cart = await basket(api, 'credit-browser', 'referrer'); const checkout = api.orders.createFromCart(cart.id, details);
  await gate.entered; await reverseReferralForOrder(env, 'original'); gate.release();
  await assert.rejects(checkout, { code: 'credit_changed', status: 409 });
  assert.equal(sqlite.prepare("SELECT credit_balance FROM _ecommerce_customer_accounts WHERE id='referrer'").get().credit_balance, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_orders WHERE cart_id = ?').get(cart.id).n, 0);
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?').get(cart.id).checkout_session_id, null); sqlite.close();
});

test('lost gift-card sessions are parked and a matching signed completion recovers the purchase once', async () => {
  const { env, sqlite } = database(); const access = await hashOrderAccess('purchase-token');
  sqlite.prepare(`INSERT INTO _ecommerce_gift_card_purchases(id,buyer_email,amount_cents,status,access_token_hash,created_at,updated_at)
    VALUES ('gp_lost','buyer@example.test',1000,'pending',?,1,1)`).run(access);
  const results = await reconcileCommerce({ env, paymentAdapters: [adapter] });
  assert.ok(results.some(result => result.id === 'gp_lost' && result.code === 'session_unrecorded'));
  assert.ok(sqlite.prepare("SELECT reconcile_review_at FROM _ecommerce_gift_card_purchases WHERE id='gp_lost'").get().reconcile_review_at);
  const completion = { id: 'cs_test_lost', metadata: { giftCardPurchaseId: 'gp_lost' }, amount_total: 1000,
    currency: 'usd', payment_status: 'paid', payment_intent: 'pi_lost' };
  await assert.rejects(confirmGiftCardPurchase(env, { ...completion, amount_total: 2000 }), /does not match/);
  await confirmGiftCardPurchase(env, completion); await confirmGiftCardPurchase(env, completion);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_cards').get().n, 1); sqlite.close();
});

test('an ambiguous gift-card provider failure preserves the purchase for recovery instead of cancelling accepted payment', async () => {
  const { env, sqlite } = database();
  await assert.rejects(startGiftCardPurchase(env, { ...adapter, async createCheckoutSession() { throw new Error('private provider detail'); } },
    { buyerEmail: 'buyer@example.test', amountCents: 1000 }, { successUrl: 'https://shop.test/success', cancelUrl: 'https://shop.test/cancel' }));
  const row = sqlite.prepare('SELECT status,reconcile_last_error,reconcile_review_at FROM _ecommerce_gift_card_purchases').get();
  assert.equal(row.status, 'pending'); assert.equal(row.reconcile_last_error, 'session_unrecorded'); assert.ok(row.reconcile_review_at); sqlite.close();
});

test('shipment request keys replay one parcel, and progress recovery is audited without inventing another parcel', async () => {
  const { env, sqlite } = database(); const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const cart = await basket(api, 'shipping'); const { order } = await api.orders.createFromCart(cart.id, details); await paid(api, order);
  const input = { orderId: order.id, requestKey: 'parcel-key-1', note: 'Parcel handed over', completesOrder: true };
  const shipment = await fulfillCommerceOrder(env, 'admin', input);
  const retry = await fulfillCommerceOrder(env, 'admin', input); assert.equal(shipment.fulfillmentId, retry.fulfillmentId);
  await assert.rejects(fulfillCommerceOrder(env, 'admin', { ...input, note: 'Changed tracking note' }), /request key/);
  await adjustCommerceFulfillment(env, 'admin', { action: 'reopen', orderId: order.id, requestKey: 'reopen-key-1', reason: 'Marked final too early' });
  assert.equal((await api.orders.find(order.id)).fulfillmentStatus, 'partially_fulfilled');
  sqlite.prepare("UPDATE _ecommerce_orders SET status='refunded' WHERE id=?").run(order.id);
  await adjustCommerceFulfillment(env, 'admin', { action: 'complete', orderId: order.id, requestKey: 'complete-key-1', reason: 'Remaining items were refunded' });
  const [listed] = (await listCommerceOrdersAdmin(env, { view: 'recent' })).orders;
  assert.equal(listed.shipments.length, 1); assert.equal(listed.fulfillmentEvents.length, 2); assert.equal(listed.fulfillmentStatus, 'fulfilled');
  assert.throws(() => sqlite.exec('DELETE FROM _ecommerce_fulfillments'), /append-only/); sqlite.close();
});

test('an order refund restores value to the current replacement card and keeps the original redemption', async () => {
  const { env, sqlite } = database(); const purchase = await startGiftCardPurchase(env, adapter,
    { buyerEmail: 'buyer@example.test', amountCents: 2000 }, { successUrl: 'https://shop.test/success', cancelUrl: 'https://shop.test/cancel' });
  await confirmGiftCardPurchase(env, { id: `cs_test_${purchase.id}`, metadata: { giftCardPurchaseId: purchase.id },
    amount_total: 2000, currency: 'usd', payment_status: 'paid', payment_intent: 'pi_purchase' });
  const original = sqlite.prepare('SELECT id FROM _ecommerce_gift_cards').get().id;
  // Use the code returned by a replacement, spend it, then replace that card too.
  const first = await issueAdminGiftCard(env, 'admin', { amountCents: 2000, replacesPurchaseId: purchase.id, reason: 'First code replacement' });
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] }); const cart = await basket(api, 'gift');
  const { order } = await api.orders.createFromCart(cart.id, { ...details, giftCardCode: first.code });
  const second = await issueAdminGiftCard(env, 'admin', { amountCents: 1000, replacesPurchaseId: purchase.id, reason: 'Replace remaining card value' });
  await refundGiftCardTender(env, 'admin', { orderId: order.id, amountCents: 500, reason: 'Return half the purchase' });
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id=?').get(first.id).balance_cents, 0);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id=?').get(second.id).balance_cents, 1500);
  assert.equal(sqlite.prepare('SELECT card_id FROM _ecommerce_gift_card_redemptions WHERE order_id=?').get(order.id).card_id, first.id);
  assert.equal(sqlite.prepare("SELECT card_id FROM _ecommerce_gift_card_ledger WHERE order_id=? AND kind='refund_restore'").get(order.id).card_id, second.id);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_gift_cards WHERE id=?').get(original).status, 'void');
  await refundGiftCardOnlyOrder(env, 'admin', { orderId: order.id, reason: 'Return the remaining purchase' });
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id=?').get(second.id).balance_cents, 2000);
  assert.equal((await api.orders.find(order.id)).status, 'refunded'); sqlite.close();
});

test('shopper exports omit credentials and anonymization revokes access while retaining accounting records', async () => {
  const { env, sqlite } = database(); account(sqlite, 'shopper'); const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const cart = await basket(api, 'privacy', 'shopper'); const { order } = await api.orders.createFromCart(cart.id, details); await paid(api, order);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions(id,account_id,token_hash,expires_at,created_at)
    VALUES ('session','shopper',?,?,1)`).run(await hashOrderAccess('token'), Math.floor(Date.now()/1000) + 10000);
  const exported = await manageShopperData(env, 'shopper', { accountId: 'shopper', action: 'export', reason: 'Shopper requested export' });
  assert.equal(exported.orders[0].id, order.id);
  assert.doesNotMatch(JSON.stringify(exported), /token_hash|guestAccess|checkoutSessionId|pi_|cs_test_|encrypted|reconcile/);
  assert.ok(await findCustomerSession(env, 'token'));
  await manageShopperData(env, 'shopper', { accountId: 'shopper', action: 'anonymize', reason: 'Shopper requested erasure' });
  assert.equal(await findCustomerSession(env, 'token'), null); assert.equal(await api.orders.findForSession(order.id, 'privacy'), null);
  const record = await api.orders.find(order.id); assert.equal(record.customerEmail, null); assert.equal(record.totalAmount, 1000);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_payments').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_shopper_audits').get().n, 2);
  assert.throws(() => sqlite.exec('DELETE FROM _ecommerce_shopper_audits'), /append-only/); sqlite.close();
});

test('anonymization refuses unsettled payments and revocation invalidates delayed sessions from the old generation', async () => {
  const { env, sqlite } = database(); account(sqlite, 'shopper'); const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const cart = await basket(api, 'privacy', 'shopper'); const { order } = await api.orders.createFromCart(cart.id, details);
  await assert.rejects(manageShopperData(env, 'shopper', { accountId: 'shopper', action: 'anonymize', reason: 'Shopper requested erasure' }), /Resolve open payments/);
  assert.equal((await api.orders.find(order.id)).customerEmail, details.customerEmail);
  await manageShopperData(env, 'shopper', { accountId: 'shopper', action: 'revoke', reason: 'Shopper revoked all sessions' });
  assert.throws(() => sqlite.exec(`INSERT INTO _ecommerce_customer_sessions(id,account_id,token_hash,expires_at,created_at)
    VALUES ('late','shopper','late-hash',9999999999,1)`), /credentials have been revoked/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_shopper_audits').get().n, 1); sqlite.close();
});

test('bounded catalog reads page in stable order and refuse oversized or unknown filters', async () => {
  const { env, sqlite } = database();
  for (let i = 0; i < 105; i++) sqlite.prepare(`INSERT INTO _ecommerce_products(id,name,slug,created_at,updated_at)
    VALUES (?,?,?,1,1)`).run(`p${String(i).padStart(3,'0')}`, `Product ${i}`, `p${i}`);
  assert.equal((await readCatalog(env)).length, 50);
  const first = await readCatalogPage(env, { limit: 100 }); const second = await readCatalogPage(env, { limit: 100, cursor: first.nextCursor });
  assert.equal(first.products.length, 100); assert.equal(second.products.length, 6); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.products,...second.products].map(product => product.id)).size, 106);
  assert.equal((await readCatalogPage(env, { slug: 'product' })).products[0].id, 'product');
  await assert.rejects(readCatalogPage(env, { limit: 101 })); await assert.rejects(readCatalogPage(env, { ids: Array(81).fill('p0') }));
  await assert.rejects(readCatalogPage(env, { unknown: true })); sqlite.close();
});

test('shopper order lists flag parked payments consistently', async () => {
  const { env, sqlite } = database(); account(sqlite, 'shopper'); const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const cart = await basket(api, 'review', 'shopper'); const { order } = await api.orders.createFromCart(cart.id, details);
  sqlite.prepare('UPDATE _ecommerce_orders SET reconcile_review_at=1 WHERE id=?').run(order.id);
  assert.equal((await listCustomerOrders(env, 'shopper'))[0].paymentUnderReview, true); sqlite.close();
});

test('permanent tax failures are parked, excluded from retries, and repaired only by an audited matching provider record', async () => {
  const { env, sqlite } = database(); env.TALISMAN_COMMERCE_TAX = 'stripe-exclusive'; let records = 0; let taxRecord;
  const taxAdapter = { ...adapter, async calculateTax({ lines }) { return { id: 'taxcalc_lost',
    amountTotal: lines.reduce((sum,line) => sum + line.amount, 0) + 100, taxAmountExclusive: 100, taxAmountInclusive: 0 }; },
    async recordTaxTransaction() { records++; throw Object.assign(new Error('private provider detail'), { code: 'resource_missing' }); },
    async reverseTaxTransaction() { return { reversalId: 'tax_rev' }; }, async getTaxRecord() { return taxRecord; } };
  const api = bindCommerceApi({ env, paymentAdapters: [taxAdapter] }); const cart = await basket(api, 'tax');
  const { order } = await api.orders.createFromCart(cart.id, { ...details, billingAddress: { country: 'US' } }); await paid(api, order);
  assert.equal(records, 1); const parked = await listTaxSyncReview(env); assert.equal(parked[0].orderId, order.id);
  await reconcileCommerce({ env, paymentAdapters: [taxAdapter] }); assert.equal(records, 1, 'parked record is not retried');
  taxRecord = { reference: 'other-order', currency: 'usd', type: 'transaction', amountTotal: 1100, amountTax: 100, originalTransaction: null };
  const input = { orderId: order.id, outcome: 'attach', providerId: 'tax_existing', reason: 'Checked the existing transaction' };
  await assert.rejects(recoverTaxSync(env, [taxAdapter], 'admin', input), /does not match/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_tax_sync_decisions').get().n, 0);
  taxRecord.reference = order.id;
  await recoverTaxSync(env, [taxAdapter], 'admin', input);
  assert.equal((await api.orders.find(order.id)).taxTransactionId, 'tax_existing'); assert.deepEqual(await listTaxSyncReview(env), []);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_tax_sync_decisions').get().n, 1);
  assert.throws(() => sqlite.exec("UPDATE _ecommerce_tax_sync_decisions SET reason='edited reason'"), /append-only/); sqlite.close();
});

test('native invariants reject inserted negative stock/prices, unbalanced totals, mutable ledgers, and excess tax reversals', async () => {
  const { sqlite, env } = database(); account(sqlite, 'shopper');
  for (const field of ['base_price','inventory_quantity']) assert.throws(() => sqlite.exec(`INSERT INTO _ecommerce_products
    (id,name,slug,${field},created_at,updated_at) VALUES ('bad','Bad','bad',-1,1,1)`), /CHECK constraint failed/);
  assert.throws(() => sqlite.exec(`INSERT INTO _ecommerce_orders(id,total_amount,subtotal_amount,created_at,updated_at)
    VALUES ('unbalanced',1000,900,1,1)`), /orders_totals_balanced/);
  sqlite.exec(`INSERT INTO _ecommerce_orders(id,user_id,status,total_amount,subtotal_amount,tax_transaction_id,provider_refunded_cents,created_at,updated_at)
    VALUES ('refund','shopper','partially_refunded',1000,1000,'tax_source',500,1,1);
    INSERT INTO _ecommerce_credit_ledger(id,account_id,order_id,kind,amount_cents,created_at)
    VALUES ('credit','shopper','refund','welcome_award',200,1);
    INSERT INTO _ecommerce_tax_reversals(id,order_id,reference,amount,provider_reversal_id,created_at)
    VALUES ('r1','refund','r1',300,'',1);`);
  assert.throws(() => sqlite.exec('UPDATE _ecommerce_credit_ledger SET amount_cents=100'), /append-only/);
  assert.throws(() => sqlite.exec('DELETE FROM _ecommerce_credit_ledger'), /append-only/);
  assert.throws(() => sqlite.exec(`INSERT INTO _ecommerce_tax_reversals(id,order_id,reference,amount,provider_reversal_id,created_at)
    VALUES ('r2','refund','r2',201,'',1)`), /exceeds refunded tender/);
  assert.throws(() => sqlite.exec('UPDATE _ecommerce_tax_reversals SET amount=200'), /immutable/);
  assert.equal(sqlite.prepare('SELECT credit_balance FROM _ecommerce_customer_accounts').get().credit_balance, 200); sqlite.close();
});


test('cancelled discounted sessions retry failed coupon cleanup without repeating tender releases', async () => {
  const { env, sqlite } = database(); let attempts = 0;
  const provider = { ...adapter, async discardCheckoutDiscount() { if (++attempts === 1) throw new Error('Temporary failure'); } };
  const api = bindCommerceApi({ env, paymentAdapters: [provider] });
  await createDiscountCode(env, { code: 'CLEANUP', description: null, type: 'amount', value: 100, maxDiscountCents: null,
    minOrderCents: 0, eligibleProductIds: [], maxUses: 1, maxUsesPerCustomer: null, firstOrderOnly: false, startsAt: null, expiresAt: null, active: true });
  const cart = await basket(api, 'cleanup'); const { order } = await api.orders.createFromCart(cart.id, { ...details, discountCode: 'CLEANUP' });
  await api.orders.cancel(order.id);
  assert.equal(sqlite.prepare('SELECT discount_cleanup_pending FROM _ecommerce_orders WHERE id=?').get(order.id).discount_cleanup_pending, 1);
  await reconcileCommerce({ env, paymentAdapters: [provider] }); await reconcileCommerce({ env, paymentAdapters: [provider] });
  assert.equal(attempts, 2); assert.equal(sqlite.prepare('SELECT inventory_quantity FROM _ecommerce_products').get().inventory_quantity, 100);
  assert.equal(sqlite.prepare('SELECT discount_cleanup_pending FROM _ecommerce_orders WHERE id=?').get(order.id).discount_cleanup_pending, 0);
  sqlite.close();
});

test('welcome award visibility and release retain checkout terms when the current policy changes', async () => {
  const { env, sqlite } = database(); account(sqlite, 'referrer'); account(sqlite, 'buyer');
  env.TALISMAN_COMMERCE_REFERRALS_ENABLED = 'true'; env.TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS = '100';
  env.TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS = '500'; env.TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS = '1';
  const code = await getOrCreateReferralCode(env, 'referrer'); const provider = { ...adapter, async getDisputeStatus() { return 'none'; } };
  const api = bindCommerceApi({ env, paymentAdapters: [provider] }); const cart = await basket(api, 'referred', 'buyer');
  const { order } = await api.orders.createFromCart(cart.id, { ...details, customerEmail: 'buyer@example.test', referralCode: code }); await paid(api, order);
  const pending = (await getReferralDashboard(env, 'buyer')).welcome;
  assert.equal(pending.state, 'pending'); assert.equal(pending.rewardCents, 100);
  assert.equal(pending.releasesAt.getTime() - pending.createdAt.getTime(), 86400000);
  await saveReferralSettings(env, { enabled: true, rewardCents: 200, minOrderCents: 1000, attributionDays: 30 });
  env.TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS = '30';
  assert.deepEqual((await getReferralDashboard(env, 'buyer')).welcome.releasesAt, pending.releasesAt);
  await releaseReferralAwards({ env, paymentAdapters: [provider] }, { now: new Date(pending.releasesAt.getTime() + 1000) });
  const released = (await getReferralDashboard(env, 'buyer')).welcome; assert.equal(released.state, 'released');
  assert.equal((await getReferralDashboard(env, 'buyer')).creditBalance, 100); sqlite.close();
});

test('canonical purchase checks have indexed columns for both checkout and account addresses', async () => {
  const { sqlite } = database(); account(sqlite, 'shopper');
  sqlite.exec("UPDATE _ecommerce_customer_accounts SET email_normalized='Jane.Doe+alias@googlemail.com' WHERE id='shopper'");
  assert.equal(sqlite.prepare('SELECT email_canonical FROM _ecommerce_customer_accounts').get().email_canonical, 'janedoe@gmail.com');
  for (const [table, column, index] of [['_ecommerce_orders','customer_email_canonical','_ecommerce_orders_canonical_email_idx'],
    ['_ecommerce_customer_accounts','email_canonical','_ecommerce_accounts_canonical_email_idx']]) {
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE ${column} = ?`).all('janedoe@gmail.com');
    assert.ok(plan.some(row => row.detail.includes(index)), JSON.stringify(plan));
  }
  sqlite.close();
});


test('anonymization during a provider wait cannot recreate shopper contact data in a new order', async () => {
  const { env, sqlite } = database(); account(sqlite, 'shopper'); const gate = checkoutGate(1);
  let expired = 0; const provider = { ...gate.adapter, async expireCheckoutSession() { expired++; } };
  const api = bindCommerceApi({ env, paymentAdapters: [provider] }); const cart = await basket(api, 'erase-race', 'shopper');
  const checkout = api.orders.createFromCart(cart.id, details); await gate.entered;
  await manageShopperData(env, 'shopper', { accountId: 'shopper', action: 'anonymize', reason: 'Shopper requested erasure' });
  gate.release(); await assert.rejects(checkout, { code: 'account_changed', status: 409 });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_orders').get().n, 0);
  assert.equal(sqlite.prepare('SELECT inventory_quantity FROM _ecommerce_products').get().inventory_quantity, 100);
  assert.equal(expired, 1); assert.ok(sqlite.prepare('SELECT anonymized_at FROM _ecommerce_customer_accounts').get().anonymized_at);
  sqlite.close();
});


test('lost gift-card attachment verifies metadata and records a decision before reopening reconciliation', async () => {
  const { env, sqlite } = database();
  sqlite.exec("INSERT INTO _ecommerce_gift_card_purchases(id,buyer_email,amount_cents,status,access_token_hash,reconcile_review_at,created_at,updated_at) VALUES ('gp_attach','buyer@example.test',1000,'pending','fake-hash',1,1,1)");
  const state = { purchaseId: 'gp_other' }; const provider = { ...adapter, async getCheckoutSession() {
    return { status: 'open', amountTotal: 1000, currency: 'usd', references: { giftCardPurchaseId: state.purchaseId } };
  } };
  const input = { purchaseId: 'gp_attach', sessionId: 'cs_test_attached', reason: 'Verified the purchase in Stripe' };
  await assert.rejects(attachGiftPurchaseSession({ env, paymentAdapters: [provider] }, 'admin', input), /does not match/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_reconcile_decisions').get().n, 0);
  state.purchaseId = 'gp_attach'; await attachGiftPurchaseSession({ env, paymentAdapters: [provider] }, 'admin', input);
  const row = sqlite.prepare("SELECT provider_session_id,reconcile_review_at FROM _ecommerce_gift_card_purchases WHERE id='gp_attach'").get();
  assert.equal(row.provider_session_id, input.sessionId); assert.equal(row.reconcile_review_at, null);
  assert.equal(sqlite.prepare('SELECT action FROM _ecommerce_reconcile_decisions').get().action, 'attach_session'); sqlite.close();
});

test('Stripe tax record verification includes every iterated item and the shipping tax behavior', async () => {
  const provider = new StripePaymentAdapter({ secretKey: 'sk_test_fake', webhookSecret: 'whsec_fake' });
  const rows = Array.from({ length: 101 }, () => ({ amount: 10, amount_tax: 1, tax_behavior: 'exclusive' }));
  rows.push({ amount: 500, amount_tax: 50, tax_behavior: 'inclusive' });
  provider.stripe = { tax: { transactions: {
    async retrieve() { return { reference: 'order', currency: 'usd', type: 'transaction', reversal: null,
      shipping_cost: { amount: 100, amount_tax: 10, tax_behavior: 'exclusive' } }; },
    async *listLineItems() { yield* rows; },
  } } };
  assert.deepEqual(await provider.getTaxRecord('tax_existing'), { reference: 'order', currency: 'usd', type: 'transaction',
    amountTotal: 1721, amountTax: 161, originalTransaction: null });
});
