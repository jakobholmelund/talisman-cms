import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { applyAllMigrations } from './helpers/migrations.mjs';

// The admin route reads its bindings from cloudflare:workers and asks the CMS auth guard; both are served here.
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });',
  'talisman-cms/auth/guard': 'export async function authorizeCmsRequest(request, role) {'
    + ' const user = globalThis.cmsUser;'
    + " if (!user) return { response: Response.json({ error: 'Authentication required' }, { status: 401 }) };"
    + " if (role === 'admin' && user.role !== 'admin') return { response: Response.json({ error: 'Admin required' }, { status: 403 }) };"
    + ' return { user }; }',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!(specifier in stubs)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});
const adminRoute = (await import('../dist/routes/ecommerce-admin-gift-cards.js')).ALL;
const { bindCommerceApi } = await import('../dist/api.js');
const schema = await import('../dist/schema.js');
const { issueAdminGiftCard, startGiftCardPurchase, confirmGiftCardPurchase, getPurchasedGiftCard,
  evaluateGiftCard, setGiftCardActive, getGiftCardsAdmin, getGiftCardReviewsAdmin, resolveGiftCardReview,
  reencryptGiftCardCodes, getGiftCardKeyStatus, giftCardPurchaseHoldStatements,
  replaceAdminGiftCardCode, refundGiftCardTender } = await import('../dist/gift-cards.js');


/** The D1 shim from shared-components.test.mjs; `beforeNextBatch` runs once before the next batch. */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(sqlite);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_products
    (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at)
    VALUES ('frame', 'Frame', 'frame', 3000, 50, 'active', ?, ?)`).run(now, now);
  const DB = {
    beforeNextBatch: null,
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        sqlText: sql,
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
      const hook = DB.beforeNextBatch;
      DB.beforeNextBatch = null;
      await hook?.(statements);
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

const KEY_A = 'a'.repeat(64);
const KEY_B = '0123456789abcdef'.repeat(4);
const KEY_C = 'fedcba9876543210'.repeat(4);
// The key id is the first 16 hex characters of the SHA-256 of the key bytes, so operators can work it out.
const keyId = (key) => createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex').slice(0, 16);
const giftEnv = (DB, key = KEY_A, previous) => ({ DB, TALISMAN_COMMERCE_GIFT_CARD_KEY: key,
  ...(previous === undefined ? {} : { TALISMAN_COMMERCE_GIFT_CARD_PREVIOUS_KEYS: previous }) });

const stripe = {
  providerId: 'stripe',
  async createCheckoutSession({ orderId }) {
    return { providerSessionId: `cs_test_${orderId}`, url: `https://checkout.stripe.test/${orderId}` };
  },
  async expireCheckoutSession() {},
  async validateWebhook(payload) { return JSON.parse(payload); },
};
const purchaseUrls = { successUrl: 'https://shop.test/gift-cards/success?purchase={PURCHASE_ID}',
  cancelUrl: 'https://shop.test/gift-cards' };
const checkout = { customerEmail: 'shopper@example.test', successUrl: 'https://shop.test/checkout/success?order={ORDER_ID}',
  cancelUrl: 'https://shop.test/checkout/cancel?order={ORDER_ID}',
  shippingAddress: { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' } };

const row = (sqlite, sql, ...params) => { const found = sqlite.prepare(sql).get(...params); return found ? { ...found } : found; };
const rows = (sqlite, sql, ...params) => sqlite.prepare(sql).all(...params).map((item) => ({ ...item }));
const cardOf = (sqlite, purchaseId) => row(sqlite, 'SELECT * FROM _ecommerce_gift_cards WHERE purchase_id = ?', purchaseId);
const purchaseRow = (sqlite, id) => row(sqlite, `SELECT status, provider_refunded_cents, refund_adjusted_cents
  FROM _ecommerce_gift_card_purchases WHERE id = ?`, id);

/** A purchase paid through Stripe, with the code its buyer sees. */
async function buyGiftCard(sqlite, env, amountCents, paymentIntent) {
  const purchase = await startGiftCardPurchase(env, stripe, { amountCents, buyerEmail: 'buyer@example.test' }, purchaseUrls);
  await confirmGiftCardPurchase(env, { id: `cs_test_${purchase.id}`, metadata: { giftCardPurchaseId: purchase.id },
    amount_total: amountCents, currency: 'usd', payment_status: 'paid', payment_intent: paymentIntent });
  const { code } = await getPurchasedGiftCard(env, purchase.id, purchase.accessToken);
  return { id: purchase.id, accessToken: purchase.accessToken, code, card: cardOf(sqlite, purchase.id) };
}

let basket = 0;
/** Spends 3000 from a card on a gift-card-only order. */
async function spend(api, code) {
  const cart = await api.carts.getOrCreate(`basket-${++basket}`);
  await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkout, giftCardCode: code });
  assert.equal(order.status, 'paid');
  return order;
}

const refund = (api, paymentIntent, amount, amountRefunded) => api.webhooks.handleStripe(JSON.stringify({
  type: 'charge.refunded', data: { payment_intent: paymentIntent, amount, amount_refunded: amountRefunded, currency: 'usd' },
}), 'signature', 'secret');

/** The card's ledger adds up to its stored balance; returns that balance. */
function ledgerBalance(sqlite, cardId) {
  const { total } = row(sqlite, 'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM _ecommerce_gift_card_ledger WHERE card_id = ?', cardId);
  const { balance_cents: balance } = row(sqlite, 'SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?', cardId);
  assert.equal(total, balance, `ledger of ${cardId}`);
  return balance;
}

/** Value spent from a card on orders: reservations less releases and restores. */
const spentFrom = (sqlite, cardId) => -row(sqlite, `SELECT COALESCE(SUM(amount_cents), 0) AS total
  FROM _ecommerce_gift_card_ledger WHERE card_id = ? AND kind IN ('reserve','release','refund_restore')`, cardId).total;

/** The kind and amount of each ledger entry of a card, oldest first. */
const ledgerOf = (sqlite, cardId) => rows(sqlite, `SELECT kind, amount_cents FROM _ecommerce_gift_card_ledger
  WHERE card_id = ? ORDER BY rowid`, cardId);
const cardRow = (sqlite, id) => row(sqlite, 'SELECT status, balance_cents, held_for_review FROM _ecommerce_gift_cards WHERE id = ?', id);

/** What the purchase's cards can still be spent on: the balance of its active cards. */
const activeValue = (sqlite, purchaseId) => row(sqlite, `SELECT COALESCE(SUM(balance_cents), 0) AS total
  FROM _ecommerce_gift_cards WHERE status = 'active' AND (purchase_id = ? OR replaces_purchase_id = ?)`, purchaseId, purchaseId).total;

/** An order that needs 1000 more than a 2000 card holds stays pending with the card's value reserved. */
async function pendingOrder(api, code) {
  const cart = await api.carts.getOrCreate(`basket-${++basket}`);
  await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkout, giftCardCode: code });
  assert.equal(order.status, 'pending');
  return order;
}

async function legacySecret(key, code) {
  const cryptoKey = await webcrypto.subtle.importKey('raw', Buffer.from(key, 'hex'), 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(code));
  return `${Buffer.from(iv).toString('hex')}:${Buffer.from(ciphertext).toString('hex')}`;
}

function assertNoKeyMaterial(error) {
  for (const key of [KEY_A, KEY_B, KEY_C]) assert.ok(!error.message.includes(key), 'the error holds no key');
  return true;
}

// --- Key rotation -----------------------------------------------------------------------------

test('an admin issuance replay recovers the same private code and never adds stored value twice', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const input = { amountCents: 2500, reason: 'Service goodwill card', requestKey: crypto.randomUUID() };
  const issued = await issueAdminGiftCard(env, 'admin-1', input);
  assert.deepEqual(await issueAdminGiftCard(env, 'admin-1', { ...input, requestKey: input.requestKey.toUpperCase() }), issued);
  assert.equal(rows(sqlite, 'SELECT id FROM _ecommerce_gift_cards').length, 1);
  assert.deepEqual(ledgerOf(sqlite, issued.id), [{ kind: 'issue', amount_cents: 2500 }]);
  assert.equal(ledgerBalance(sqlite, issued.id), 2500);
  assert.notEqual(issued.id, `gift_${input.requestKey}`);
  assert.match(issued.id, /^gift_[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await setGiftCardActive(env, issued.id, false);
  await setGiftCardActive(env, issued.id, true);
  assert.deepEqual(await issueAdminGiftCard(env, 'admin-1', input), issued);
  assert.ok(!JSON.stringify(await getGiftCardsAdmin(env)).includes(input.requestKey));
  for (const changed of [{ amountCents: 3000 }, { reason: 'Different reason for card' }, { replacesPurchaseId: `gp_${crypto.randomUUID()}` }]) {
    await assert.rejects(issueAdminGiftCard(env, 'admin-1', { ...input, ...changed }), /already used/);
  }
  await assert.rejects(issueAdminGiftCard(env, 'admin-2', input), /already used/);
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { ...input, requestKey: 'not-a-uuid' }));
  // The listing's public ID is not an issuance key and cannot recover its private code.
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { ...input, requestKey: issued.id }));
  const rotated = giftEnv(DB, KEY_B, KEY_A);
  await reencryptGiftCardCodes(rotated);
  assert.deepEqual(await issueAdminGiftCard(giftEnv(DB, KEY_B), 'admin-1', input), issued);
  sqlite.close();
});

test('unkeyed issuance keeps creating independent cards, while the admin route accepts replay keys', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const data = { amountCents: 2500, reason: 'Original caller without a key' };
  const first = await issueAdminGiftCard(env, 'admin-1', data);
  const second = await issueAdminGiftCard(env, 'admin-1', data);
  assert.notEqual(first.id, second.id);
  const body = { action: 'issue', data: { ...data, requestKey: crypto.randomUUID() } };
  const admin = { id: 'admin-1', role: 'admin' };
  assert.equal((await callAdmin(env, undefined, { body })).status, 401);
  assert.equal((await callAdmin(env, { id: 'editor-1', role: 'editor' }, { body })).status, 403);
  assert.equal((await callAdmin(env, admin, { body, origin: 'https://other.test' })).status, 403);
  const issued = await callAdmin(env, admin, { body });
  assert.equal(issued.status, 200);
  assert.deepEqual(await callAdmin(env, admin, { body }), issued);
  assert.equal(rows(sqlite, 'SELECT id FROM _ecommerce_gift_cards').length, 3);
  sqlite.close();
});

test('a competing issuance with the same key commits one card and one issue ledger entry', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const input = { amountCents: 2500, reason: 'Concurrent goodwill card', requestKey: crypto.randomUUID() };
  let winner;
  DB.beforeNextBatch = async () => { winner = await issueAdminGiftCard(env, 'admin-1', input); };
  const second = await issueAdminGiftCard(env, 'admin-1', input);
  assert.deepEqual(second, winner);
  assert.deepEqual(ledgerOf(sqlite, second.id), [{ kind: 'issue', amount_cents: 2500 }]);
  assert.equal(rows(sqlite, 'SELECT id FROM _ecommerce_gift_cards').length, 1);
  // A race with a changed amount refuses the losing payload without changing the winner.
  const another = { ...input, requestKey: crypto.randomUUID() };
  DB.beforeNextBatch = () => issueAdminGiftCard(env, 'admin-1', another);
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { ...another, amountCents: 5000 }), /already used/);
  assert.deepEqual(rows(sqlite, 'SELECT balance_cents FROM _ecommerce_gift_cards').map(row => row.balance_cents), [2500, 2500]);
  sqlite.close();
});

test('a replacement replay never repeats the value transfer or voids a later replacement', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_replay_replace');
  const input = { amountCents: 10000, reason: 'Replacement for a lost card', replacesPurchaseId: purchase.id, requestKey: crypto.randomUUID() };
  let original;
  let later;
  // The replay is prepared first, then another invocation wins and staff later replaces its card.
  DB.beforeNextBatch = async () => {
    original = await issueAdminGiftCard(env, 'admin-1', input);
    later = await issueAdminGiftCard(env, 'admin-1', { ...input, reason: 'A later replacement card', requestKey: crypto.randomUUID() });
  };
  const recovered = await issueAdminGiftCard(env, 'admin-1', input);
  assert.deepEqual(recovered, original);
  assert.deepEqual(await issueAdminGiftCard(env, 'admin-1', input), original);
  assert.deepEqual(cardRow(sqlite, later.id), { status: 'active', balance_cents: 10000, held_for_review: 0 });
  assert.equal(ledgerBalance(sqlite, original.id), 0);
  assert.equal(rows(sqlite, 'SELECT id FROM _ecommerce_gift_cards').length, 3);
  assert.equal(rows(sqlite, "SELECT id FROM _ecommerce_gift_card_ledger WHERE kind = 'issue'").length, 3);
  sqlite.close();
});

const replacementInput = (card, balanceCents = card.amountCents, codeVersion = null) => ({
  cardId: card.id, balanceCents, codeVersion, reason: 'Replace the lost staff-issued code', requestKey: crypto.randomUUID(),
});
const codeAudits = (sqlite) => rows(sqlite, 'SELECT * FROM _ecommerce_gift_card_code_replacements ORDER BY rowid');

test('staff code replacement preserves funding and order identity, and later refunds reach the new code', async () => {
  const { sqlite, DB } = database(); const env = giftEnv(DB); const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const issuance = { amountCents: 5000, reason: 'Original goodwill card', requestKey: crypto.randomUUID() };
  const card = await issueAdminGiftCard(env, 'admin-1', issuance);
  const order = await spend(api, card.code);
  const ledger = ledgerOf(sqlite, card.id);
  const input = replacementInput(card, 2000);
  const replaced = await replaceAdminGiftCardCode(env, 'support-1', input);
  assert.equal(replaced.id, card.id); assert.notEqual(replaced.code, card.code);
  assert.equal(replaced.balanceCents, 2000); assert.deepEqual(ledgerOf(sqlite, card.id), ledger);
  assert.equal(ledgerBalance(sqlite, card.id), 2000);
  assert.equal(row(sqlite, 'SELECT gift_card_id FROM _ecommerce_orders WHERE id = ?', order.id).gift_card_id, card.id);
  await assert.rejects(evaluateGiftCard(env, card.code, 1), /unavailable/);
  assert.equal((await evaluateGiftCard(env, replaced.code, 1)).remainingCents, 2000);
  await refundGiftCardTender(env, 'support-1', { orderId: order.id, amountCents: 500, reason: 'Partial order return after code replacement' });
  assert.equal(ledgerBalance(sqlite, card.id), 2500);
  assert.equal((await evaluateGiftCard(env, replaced.code, 1)).remainingCents, 2500);
  const replayed = await replaceAdminGiftCardCode(env, 'support-1', { ...input, requestKey: input.requestKey.toUpperCase() });
  assert.equal(replayed.code, replaced.code); assert.equal(replayed.balanceCents, 2500);
  assert.equal(codeAudits(sqlite).length, 1); assert.equal(codeAudits(sqlite)[0].balance_cents, 2000);
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', issuance), /original issuance code has been replaced/);
  const listed = (await getGiftCardsAdmin(env)).find(item => item.id === card.id);
  assert.equal(listed.codeVersion, codeAudits(sqlite)[0].id);
  assert.equal(listed.lastCodeReplacement.reason, input.reason);
  const publicData = JSON.stringify(listed);
  for (const privateValue of [card.code, replaced.code, input.requestKey, codeAudits(sqlite)[0].new_code_hash]) assert.ok(!publicData.includes(privateValue));
  for (const changed of [{ cardId: `gift_${crypto.randomUUID()}` }, { balanceCents: 3000 }, { reason: 'A different replacement reason' }, { codeVersion: listed.codeVersion }]) {
    await assert.rejects(replaceAdminGiftCardCode(env, 'support-1', { ...input, ...changed }), /already used/);
  }
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-2', input), /already used/);
  await reencryptGiftCardCodes(giftEnv(DB, KEY_B, KEY_A));
  assert.equal((await replaceAdminGiftCardCode(giftEnv(DB, KEY_B), 'support-1', input)).code, replaced.code);
  assert.throws(() => sqlite.exec("UPDATE _ecommerce_gift_card_code_replacements SET reason = 'Changed audit reason'"), /append-only/);
  assert.throws(() => sqlite.exec('DELETE FROM _ecommerce_gift_card_code_replacements'), /append-only/);
  sqlite.close();
});

test('code replacement handles one-cent and exhausted balances and preserves suspension', async () => {
  for (const remainder of [1, 0]) {
    const { sqlite, DB } = database(); const env = giftEnv(DB); const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
    const card = await issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Small remaining card value' });
    sqlite.prepare('UPDATE _ecommerce_products SET base_price = ? WHERE id = ?').run(5000 - remainder, 'frame');
    await spend(api, card.code); await setGiftCardActive(env, card.id, false);
    const ledger = ledgerOf(sqlite, card.id);
    const result = await replaceAdminGiftCardCode(env, 'support-1', replacementInput(card, remainder));
    assert.equal(result.status, 'suspended'); assert.equal(result.balanceCents, remainder);
    assert.deepEqual(ledgerOf(sqlite, card.id), ledger); assert.equal(ledgerBalance(sqlite, card.id), remainder);
    assert.equal(rows(sqlite, 'SELECT id FROM _ecommerce_gift_cards').length, 1);
    await assert.rejects(evaluateGiftCard(env, result.code, 1), /unavailable/);
    if (remainder) {
      await setGiftCardActive(env, card.id, true); assert.equal((await evaluateGiftCard(env, result.code, 1)).remainingCents, 1);
      DB.beforeNextBatch = () => setGiftCardActive(env, card.id, false);
      const raced = await replaceAdminGiftCardCode(env, 'admin-1', replacementInput(card, 1, codeAudits(sqlite)[0].id));
      assert.equal(raced.status, 'suspended'); assert.equal(ledgerBalance(sqlite, card.id), 1);
    }
    sqlite.close();
  }
});

test('code replacement refuses purchased, purchase-backed, void, pending and stale cards', async () => {
  const { sqlite, DB } = database(); const env = giftEnv(DB); const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 5000, 'pi_code_replacement');
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', replacementInput(purchase.card, 5000)), /staff-issued/);
  const backed = await issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Purchased replacement card', replacesPurchaseId: purchase.id });
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', replacementInput(backed)), /staff-issued/);
  const card = await issueAdminGiftCard(env, 'admin-1', { amountCents: 2000, reason: 'Card reserved in checkout' });
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', replacementInput(card, 1000)), /balance changed/);
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', { ...replacementInput(card), requestKey: card.id }));
  await assert.rejects(replaceAdminGiftCardCode(env, '', replacementInput(card)), /identity/);
  await pendingOrder(api, card.code);
  assert.equal((await getGiftCardsAdmin(env)).find(item => item.id === card.id).checkoutPending, true);
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', replacementInput(card, 0)), /checkout in progress/);
  sqlite.prepare("UPDATE _ecommerce_gift_cards SET status = 'void' WHERE id = ?").run(backed.id);
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', replacementInput(backed)), /staff-issued/);
  assert.equal(codeAudits(sqlite).length, 0); sqlite.close();
});

test('competing code replacements commit one version and retries never overwrite a later version', async () => {
  const { sqlite, DB } = database(); const env = giftEnv(DB);
  const card = await issueAdminGiftCard(env, 'admin-1', { amountCents: 2500, reason: 'Concurrent code replacement' });
  const input = replacementInput(card); let winner;
  DB.beforeNextBatch = async () => { winner = await replaceAdminGiftCardCode(env, 'admin-1', input); };
  assert.deepEqual(await replaceAdminGiftCardCode(env, 'admin-1', input), winner);
  assert.equal(codeAudits(sqlite).length, 1); assert.equal(ledgerBalance(sqlite, card.id), 2500);
  const version = codeAudits(sqlite)[0].id;
  const next = replacementInput(card, 2500, version); let latest;
  DB.beforeNextBatch = async () => {
    await replaceAdminGiftCardCode(env, 'admin-1', next);
    latest = await replaceAdminGiftCardCode(env, 'support-2', replacementInput(card, 2500, codeAudits(sqlite)[1].id));
  };
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', next), /replaced again/);
  assert.equal(codeAudits(sqlite).length, 3); assert.equal(ledgerBalance(sqlite, card.id), 2500);
  assert.equal((await evaluateGiftCard(env, latest.code, 1)).remainingCents, 2500);
  await assert.rejects(evaluateGiftCard(env, winner.code, 1), /unavailable/);
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', { ...replacementInput(card), codeVersion: version }), /code or balance changed/);
  sqlite.close();
});

test('code replacement rechecks balance and reservations at commit and rolls its audit back on failure', async () => {
  const { sqlite, DB } = database(); const env = giftEnv(DB); const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const card = await issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Replacement transaction checks' });
  const input = replacementInput(card);
  sqlite.exec("CREATE TRIGGER fail_code_update BEFORE UPDATE OF code_hash ON _ecommerce_gift_cards BEGIN SELECT RAISE(ABORT,'Test replacement failure'); END;");
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', input));
  assert.equal(codeAudits(sqlite).length, 0); assert.equal((await evaluateGiftCard(env, card.code, 1)).remainingCents, 5000);
  sqlite.exec('DROP TRIGGER fail_code_update');
  DB.beforeNextBatch = () => spend(api, card.code);
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', input), /card changed/);
  assert.equal(codeAudits(sqlite).length, 0); assert.equal(ledgerBalance(sqlite, card.id), 2000);
  DB.beforeNextBatch = () => pendingOrder(api, card.code);
  await assert.rejects(replaceAdminGiftCardCode(env, 'admin-1', replacementInput(card, 2000)), /card changed/);
  assert.equal(codeAudits(sqlite).length, 0); assert.equal(ledgerBalance(sqlite, card.id), 0);
  sqlite.close();
});

test('the admin code replacement route requires administrator, same origin and a private retry key', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB } = database(); const env = giftEnv(DB);
  const card = await issueAdminGiftCard(env, 'admin-1', { amountCents: 2500, reason: 'Authorized code replacement' });
  const body = { action: 'replaceCode', data: replacementInput(card) }; const admin = { id: 'admin-1', role: 'admin' };
  assert.equal((await callAdmin(env, undefined, { body })).status, 401);
  assert.equal((await callAdmin(env, { id: 'editor-1', role: 'editor' }, { body })).status, 403);
  assert.equal((await callAdmin(env, admin, { body, origin: 'https://other.test' })).status, 403);
  const invalid = { action: 'replaceCode', data: { ...body.data, requestKey: undefined } };
  assert.equal((await callAdmin(env, admin, { body: invalid })).status, 400);
  const first = await callAdmin(env, admin, { body }); assert.equal(first.status, 200);
  assert.deepEqual(await callAdmin(env, admin, { body }), first);
  assert.equal(codeAudits(sqlite).length, 1); sqlite.close();
});

test('checkout reserves only the code it evaluated when a staff replacement commits first', async () => {
  for (const amountCents of [5000, 2000]) {
    const { sqlite, DB } = database(); const env = giftEnv(DB); const expired = [];
    const adapter = { ...stripe, async expireCheckoutSession(id) { expired.push(id); } };
    const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
    const card = await issueAdminGiftCard(env, 'admin-1', { amountCents, reason: 'Checkout code authorization check' });
    const cart = await api.carts.getOrCreate(`basket-${++basket}`);
    await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
    let replaced;
    const beforeReservation = async statements => {
      if (!statements.some(statement => /insert into "_ecommerce_gift_card_redemptions"/i.test(statement.sqlText))) {
        DB.beforeNextBatch = beforeReservation; return;
      }
      replaced = await replaceAdminGiftCardCode(env, 'support-1', replacementInput(card));
    };
    DB.beforeNextBatch = beforeReservation;
    await assert.rejects(api.orders.createFromCart(cart.id, { ...checkout, giftCardCode: card.code }), error => error.code === 'gift_card_changed' && error.status === 409);
    assert.equal(rows(sqlite, 'SELECT id FROM _ecommerce_orders').length, 0);
    assert.equal(rows(sqlite, 'SELECT id FROM _ecommerce_gift_card_redemptions').length, 0);
    assert.equal(rows(sqlite, 'SELECT id FROM _ecommerce_inventory_reservations').length, 0);
    assert.equal(row(sqlite, 'SELECT inventory_quantity FROM _ecommerce_products WHERE id = ?', 'frame').inventory_quantity, 50);
    assert.equal(row(sqlite, 'SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?', cart.id).checkout_session_id, null);
    assert.equal(ledgerBalance(sqlite, card.id), amountCents);
    assert.equal(expired.length, amountCents < 3000 ? 1 : 0); assert.equal(codeAudits(sqlite).length, 1);
    const { order } = await api.orders.createFromCart(cart.id, { ...checkout, giftCardCode: replaced.code });
    assert.equal(order.status, amountCents < 3000 ? 'pending' : 'paid'); assert.equal(order.giftCardId, card.id);
    assert.equal(ledgerBalance(sqlite, card.id), Math.max(0, amountCents - 3000));
    sqlite.close();
  }
});

test('a code encrypted before a key rotation still decrypts after it, and new codes use the new key', async () => {
  const { sqlite, DB } = database();
  const before = await buyGiftCard(sqlite, giftEnv(DB, KEY_A), 5000, 'pi_rotation_before');
  assert.match(before.code, /^GIFT-[A-F0-9]{32}$/);
  assert.ok(before.card.encrypted_code.startsWith(`v2:${keyId(KEY_A)}:`));
  assert.ok(!before.card.encrypted_code.includes(before.code));

  const rotated = giftEnv(DB, KEY_B, KEY_A);
  assert.equal((await getPurchasedGiftCard(rotated, before.id, before.accessToken)).code, before.code);
  const issued = await issueAdminGiftCard(rotated, 'admin-1', { amountCents: 2500, reason: 'Service goodwill card' });
  assert.ok(row(sqlite, 'SELECT encrypted_code FROM _ecommerce_gift_cards WHERE id = ?', issued.id)
    .encrypted_code.startsWith(`v2:${keyId(KEY_B)}:`));
  const after = await buyGiftCard(sqlite, rotated, 7000, 'pi_rotation_after');
  assert.ok(after.card.encrypted_code.startsWith(`v2:${keyId(KEY_B)}:`));
  assert.deepEqual(await getGiftCardKeyStatus(rotated), { keyId: keyId(KEY_B), previousKeyCodes: 1, legacyCodes: 0 });

  // Dropping the previous key too early fails clearly, naming only the key id.
  await assert.rejects(getPurchasedGiftCard(giftEnv(DB, KEY_B), before.id, before.accessToken),
    (error) => error.message === `Gift card code uses key ${keyId(KEY_A)}, which is not configured` && assertNoKeyMaterial(error));

  // Re-encrypting moves the old code to the new key, after which the previous key can go.
  assert.deepEqual(await reencryptGiftCardCodes(rotated), { keyId: keyId(KEY_B), reencrypted: 1, failed: [], next: null });
  assert.ok(cardOf(sqlite, before.id).encrypted_code.startsWith(`v2:${keyId(KEY_B)}:`));
  assert.deepEqual(await getGiftCardKeyStatus(rotated), { keyId: keyId(KEY_B), previousKeyCodes: 0, legacyCodes: 0 });
  assert.equal((await getPurchasedGiftCard(giftEnv(DB, KEY_B), before.id, before.accessToken)).code, before.code);
  assert.deepEqual(await reencryptGiftCardCodes(giftEnv(DB, KEY_B)), { keyId: keyId(KEY_B), reencrypted: 0, failed: [], next: null });
  await assert.rejects(getPurchasedGiftCard(giftEnv(DB, KEY_A), after.id, after.accessToken), /which is not configured/);
  sqlite.close();
});

test('re-encryption works in pages, so a code no key can read does not block the rest', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB, KEY_A);
  const bought = [];
  for (let index = 0; index < 3; index++) bought.push(await buyGiftCard(sqlite, env, 5000, `pi_page_${index}`));
  const unreadable = [...bought].sort((a, b) => a.card.id.localeCompare(b.card.id))[0];
  sqlite.prepare('UPDATE _ecommerce_gift_cards SET encrypted_code = ? WHERE id = ?')
    .run(await legacySecret(KEY_C, unreadable.code), unreadable.card.id);
  const rotated = giftEnv(DB, KEY_B, KEY_A);
  const first = await reencryptGiftCardCodes(rotated, { limit: 2 });
  assert.deepEqual([first.reencrypted, first.failed, typeof first.next], [1, [unreadable.card.id], 'string']);
  const second = await reencryptGiftCardCodes(rotated, { limit: 2, after: first.next });
  assert.deepEqual([second.reencrypted, second.failed, second.next], [1, [], null]);
  assert.deepEqual(await getGiftCardKeyStatus(rotated), { keyId: keyId(KEY_B), previousKeyCodes: 0, legacyCodes: 1 });
  for (const purchase of bought.filter((item) => item !== unreadable)) {
    assert.equal((await getPurchasedGiftCard(giftEnv(DB, KEY_B), purchase.id, purchase.accessToken)).code, purchase.code);
  }
  sqlite.close();
});

test('a ciphertext copied to another card does not decrypt there, even with that card\'s code hash', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const first = await buyGiftCard(sqlite, env, 5000, 'pi_copy_first');
  const second = await buyGiftCard(sqlite, env, 5000, 'pi_copy_second');
  sqlite.prepare('UPDATE _ecommerce_gift_cards SET encrypted_code = ? WHERE id = ?')
    .run(first.card.encrypted_code, second.card.id);
  await assert.rejects(getPurchasedGiftCard(env, second.id, second.accessToken),
    /Gift card code cannot be decrypted with the configured keys/);
  // The copy stays unreadable after a rotation, and re-encryption leaves it alone.
  const rotated = giftEnv(DB, KEY_B, KEY_A);
  const result = await reencryptGiftCardCodes(rotated);
  assert.deepEqual([result.reencrypted, result.failed], [1, [second.card.id]]);
  assert.equal(cardOf(sqlite, second.id).encrypted_code, first.card.encrypted_code);
  assert.equal((await getPurchasedGiftCard(rotated, first.id, first.accessToken)).code, first.code);

  // The card id is the additional data: moving both the ciphertext and the code hash to another card
  // passes the hash check, but decryption still fails there.
  const third = await buyGiftCard(sqlite, env, 5000, 'pi_copy_third');
  const fourth = await buyGiftCard(sqlite, env, 5000, 'pi_copy_fourth');
  sqlite.prepare('UPDATE _ecommerce_gift_cards SET code_hash = ? WHERE id = ?').run('moved-to-another-card', third.card.id);
  sqlite.prepare('UPDATE _ecommerce_gift_cards SET code_hash = ?, encrypted_code = ? WHERE id = ?')
    .run(third.card.code_hash, third.card.encrypted_code, fourth.card.id);
  await assert.rejects(getPurchasedGiftCard(env, fourth.id, fourth.accessToken), /cannot be decrypted with the configured keys/);
  sqlite.close();
});

test('codes stored before key ids were recorded stay readable, before and after a rotation', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const purchase = await buyGiftCard(sqlite, env, 5000, 'pi_legacy');
  const other = await buyGiftCard(sqlite, env, 5000, 'pi_legacy_other');
  // The format of earlier releases: iv and ciphertext in hex, no key id, no additional data.
  const legacy = await legacySecret(KEY_A, purchase.code);
  assert.match(legacy, /^[0-9a-f]{24}:[0-9a-f]+$/);
  sqlite.prepare('UPDATE _ecommerce_gift_cards SET encrypted_code = ? WHERE id = ?').run(legacy, purchase.card.id);
  assert.deepEqual(await getGiftCardKeyStatus(env), { keyId: keyId(KEY_A), previousKeyCodes: 0, legacyCodes: 1 });
  assert.equal((await getPurchasedGiftCard(env, purchase.id, purchase.accessToken)).code, purchase.code);
  const rotated = giftEnv(DB, KEY_B, KEY_A);
  assert.deepEqual(await getGiftCardKeyStatus(rotated), { keyId: keyId(KEY_B), previousKeyCodes: 1, legacyCodes: 1 });
  assert.equal((await getPurchasedGiftCard(rotated, purchase.id, purchase.accessToken)).code, purchase.code);
  await assert.rejects(getPurchasedGiftCard(giftEnv(DB, KEY_B), purchase.id, purchase.accessToken),
    /cannot be decrypted with the configured keys/);

  // Without a card id in the ciphertext, the stored hash keeps an unversioned copy from reading as another card's code.
  sqlite.prepare('UPDATE _ecommerce_gift_cards SET encrypted_code = ? WHERE id = ?').run(legacy, other.card.id);
  await assert.rejects(getPurchasedGiftCard(rotated, other.id, other.accessToken), /cannot be decrypted/);

  const result = await reencryptGiftCardCodes(rotated);
  assert.equal(result.reencrypted, 1);
  assert.deepEqual(result.failed, [other.card.id]);
  assert.ok(cardOf(sqlite, purchase.id).encrypted_code.startsWith(`v2:${keyId(KEY_B)}:`));
  assert.equal((await getPurchasedGiftCard(giftEnv(DB, KEY_B), purchase.id, purchase.accessToken)).code, purchase.code);
  assert.deepEqual(await getGiftCardKeyStatus(rotated), { keyId: keyId(KEY_B), previousKeyCodes: 0, legacyCodes: 1 });
  sqlite.close();
});

test('an unknown key id, a malformed secret or a malformed previous key fails without revealing a key', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB, KEY_A);
  const purchase = await buyGiftCard(sqlite, env, 5000, 'pi_unknown_key');
  const other = giftEnv(DB, KEY_C);
  const foreign = await issueAdminGiftCard(other, 'admin-1', { amountCents: 2500, reason: 'Card under another key' });
  const encrypted = row(sqlite, 'SELECT encrypted_code FROM _ecommerce_gift_cards WHERE id = ?', foreign.id).encrypted_code;
  // Encrypted under a key this Worker does not have, but bound to the purchase's card id.
  sqlite.prepare('UPDATE _ecommerce_gift_cards SET encrypted_code = ? WHERE id = ?').run(encrypted, purchase.card.id);
  await assert.rejects(getPurchasedGiftCard(env, purchase.id, purchase.accessToken),
    (error) => error.message === `Gift card code uses key ${keyId(KEY_C)}, which is not configured` && assertNoKeyMaterial(error));

  sqlite.prepare('UPDATE _ecommerce_gift_cards SET encrypted_code = ? WHERE id = ?').run('not-a-secret', purchase.card.id);
  await assert.rejects(getPurchasedGiftCard(env, purchase.id, purchase.accessToken), /Gift card secret is invalid/);

  const misconfigured = giftEnv(DB, KEY_A, `${KEY_B},${KEY_C.slice(2)}`);
  await assert.rejects(getPurchasedGiftCard(misconfigured, purchase.id, purchase.accessToken),
    (error) => /Each previous gift card key must be 64 hex characters/.test(error.message) && assertNoKeyMaterial(error));
  // A purchase is refused before any payment starts while the keys are misconfigured.
  const purchases = row(sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_purchases').n;
  await assert.rejects(startGiftCardPurchase(misconfigured, stripe, { amountCents: 5000, buyerEmail: 'buyer@example.test' },
    purchaseUrls), /64 hex characters/);
  await assert.rejects(startGiftCardPurchase(giftEnv(DB, 'short'), stripe, { amountCents: 5000, buyerEmail: 'buyer@example.test' },
    purchaseUrls), /Gift card encryption key is not configured/);
  assert.equal(row(sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_purchases').n, purchases);
  assert.equal(await getGiftCardKeyStatus({ DB }), null);
  sqlite.close();
});

// --- Review resolution ------------------------------------------------------------------------

test('reinstating a purchase held for review takes the refund off the card, and the ledger adds up', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_reinstate');
  await spend(api, purchase.code);
  assert.equal((await refund(api, 'pi_reinstate', 10000, 2000)).status, 'review');
  assert.deepEqual(cardRow(sqlite, purchase.card.id), { status: 'suspended', balance_cents: 7000, held_for_review: 1 });
  await assert.rejects(setGiftCardActive(env, purchase.card.id, true), /requires review/);
  await assert.rejects(evaluateGiftCard(env, purchase.code, 1000), /unavailable/);

  const { reviews, reviewCount } = await getGiftCardReviewsAdmin(env);
  assert.equal(reviewCount, 1);
  assert.deepEqual({ ...reviews[0] }, { purchaseId: purchase.id, status: 'review', amountCents: 10000, currency: 'usd',
    refundedCents: 2000, adjustedCents: 0, cardId: purchase.card.id, codeSuffix: purchase.code.slice(-4),
    cardStatus: 'suspended', cardHeld: true, cardReplacement: false, balanceCents: 7000, spentCents: 3000,
    pendingCents: 0, replacementCount: 0 });

  const result = await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Partial refund for a late delivery', refundedCents: 2000 });
  assert.deepEqual({ ...result, id: undefined }, { id: undefined, purchaseId: purchase.id, outcome: 'reinstate',
    adjustmentCents: 2000, status: 'partially_refunded' });
  assert.deepEqual(cardRow(sqlite, purchase.card.id), { status: 'active', balance_cents: 5000, held_for_review: 0 });
  assert.deepEqual(purchaseRow(sqlite, purchase.id),
    { status: 'partially_refunded', provider_refunded_cents: 2000, refund_adjusted_cents: 2000 });
  assert.deepEqual(ledgerOf(sqlite, purchase.card.id),
    [{ kind: 'issue', amount_cents: 10000 }, { kind: 'reserve', amount_cents: -3000 }, { kind: 'purchase_reversal', amount_cents: -2000 }]);
  // The purchase less its refunds is what is left on the card plus what was spent from it.
  assert.equal(ledgerBalance(sqlite, purchase.card.id), 5000);
  assert.equal(10000 - 2000, ledgerBalance(sqlite, purchase.card.id) + spentFrom(sqlite, purchase.card.id));
  assert.deepEqual(row(sqlite, `SELECT purchase_id, card_id, outcome, refunded_cents, adjustment_cents, admin_actor, reason
    FROM _ecommerce_gift_card_reviews WHERE id = ?`, result.id), { purchase_id: purchase.id, card_id: purchase.card.id,
    outcome: 'reinstate', refunded_cents: 2000, adjustment_cents: 2000, admin_actor: 'admin-1', reason: 'Partial refund for a late delivery' });
  assert.equal((await evaluateGiftCard(env, purchase.code, 1000)).remainingCents, 5000);
  await assert.rejects(resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Second click on the page', refundedCents: 2000 }), /not held for review/);
  // Once resolved, the card can be suspended and reactivated again.
  assert.equal((await setGiftCardActive(env, purchase.card.id, false)).status, 'suspended');
  assert.equal((await setGiftCardActive(env, purchase.card.id, true)).status, 'active');

  // A later refund puts the reinstated card back into review, and only the new part is taken off.
  assert.equal((await refund(api, 'pi_reinstate', 10000, 4500)).status, 'review');
  assert.equal(cardOf(sqlite, purchase.id).status, 'suspended');
  const [again] = (await getGiftCardReviewsAdmin(env)).reviews;
  assert.deepEqual([again.refundedCents, again.adjustedCents, again.balanceCents, again.spentCents], [4500, 2000, 5000, 3000]);
  const second = await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Second partial refund approved', refundedCents: 4500 });
  assert.equal(second.adjustmentCents, 2500);
  assert.equal(ledgerBalance(sqlite, purchase.card.id), 2500);
  assert.equal(10000 - 4500, ledgerBalance(sqlite, purchase.card.id) + spentFrom(sqlite, purchase.card.id));
  assert.deepEqual(purchaseRow(sqlite, purchase.id),
    { status: 'partially_refunded', provider_refunded_cents: 4500, refund_adjusted_cents: 4500 });
  sqlite.close();
});

test('reinstating lifts only the review hold: a card an administrator suspended stays suspended', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  // Suspended before the refund, for example because its code leaked.
  const leaked = await buyGiftCard(sqlite, env, 10000, 'pi_suspended_first');
  await setGiftCardActive(env, leaked.card.id, false);
  await refund(api, 'pi_suspended_first', 10000, 1000);
  assert.deepEqual(cardRow(sqlite, leaked.card.id), { status: 'suspended', balance_cents: 10000, held_for_review: 0 });
  assert.equal((await getGiftCardReviewsAdmin(env)).reviews[0].cardHeld, false);
  await resolveGiftCardReview(env, 'admin-1', { purchaseId: leaked.id, outcome: 'reinstate',
    reason: 'Partial refund approved', refundedCents: 1000 });
  assert.deepEqual(cardRow(sqlite, leaked.card.id), { status: 'suspended', balance_cents: 9000, held_for_review: 0 });
  await assert.rejects(evaluateGiftCard(env, leaked.code, 1000), /unavailable/);
  // With the refund resolved, the administrator decides about the card.
  assert.equal((await setGiftCardActive(env, leaked.card.id, true)).status, 'active');

  // Suspended by an administrator while the purchase was held: suspending is always possible, and it
  // takes precedence over the hold.
  const held = await buyGiftCard(sqlite, env, 8000, 'pi_suspended_during');
  await refund(api, 'pi_suspended_during', 8000, 500);
  assert.equal(cardRow(sqlite, held.card.id).held_for_review, 1);
  assert.equal((await setGiftCardActive(env, held.card.id, false)).status, 'suspended');
  await assert.rejects(setGiftCardActive(env, held.card.id, true), /requires review/);
  await resolveGiftCardReview(env, 'admin-1', { purchaseId: held.id, outcome: 'reinstate',
    reason: 'Partial refund approved', refundedCents: 500 });
  assert.deepEqual(cardRow(sqlite, held.card.id), { status: 'suspended', balance_cents: 7500, held_for_review: 0 });
  sqlite.close();
});

test('voiding a purchase held for review reverses what is left on the card', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_void');
  await spend(api, purchase.code);
  assert.equal((await refund(api, 'pi_void', 10000, 10000)).status, 'review');
  await assert.rejects(resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Try to keep the card', refundedCents: 10000 }), /balance does not cover the refund/);
  await assert.rejects(resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'void',
    reason: 'short', refundedCents: 10000 }));

  const result = await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'void',
    reason: 'Chargeback after partial use', refundedCents: 10000 });
  assert.deepEqual([result.adjustmentCents, result.status], [7000, 'refunded']);
  assert.deepEqual(cardRow(sqlite, purchase.card.id), { status: 'void', balance_cents: 0, held_for_review: 0 });
  assert.deepEqual(ledgerOf(sqlite, purchase.card.id),
    [{ kind: 'issue', amount_cents: 10000 }, { kind: 'reserve', amount_cents: -3000 }, { kind: 'purchase_reversal', amount_cents: -7000 }]);
  // Everything issued is either spent or reversed; the purchase is fully refunded, so the spent 3000 is the store's loss.
  assert.equal(ledgerBalance(sqlite, purchase.card.id), 0);
  assert.equal(10000, spentFrom(sqlite, purchase.card.id) + result.adjustmentCents);
  assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'refunded', provider_refunded_cents: 10000, refund_adjusted_cents: 10000 });
  assert.equal(row(sqlite, 'SELECT card_id FROM _ecommerce_gift_card_reviews WHERE id = ?', result.id).card_id, purchase.card.id);
  await assert.rejects(setGiftCardActive(env, purchase.card.id, true), /unavailable/);
  await assert.rejects(evaluateGiftCard(env, purchase.code, 1000), /unavailable/);
  assert.deepEqual((await getGiftCardReviewsAdmin(env)).reviews, []);
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Replacement for a lost code',
    replacesPurchaseId: purchase.id }), /Only the card of a paid purchase/);
  sqlite.close();
});

test('a void decision waits while a checkout in progress holds value on the card', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 2000, 'pi_pending_checkout');
  const order = await pendingOrder(api, purchase.code);
  // Its release would credit the old card, so the card is not replaced either.
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { amountCents: 2000, reason: 'Replacement for a lost code',
    replacesPurchaseId: purchase.id }), /checkout in progress/);
  assert.equal((await refund(api, 'pi_pending_checkout', 2000, 500)).status, 'review');
  const [seen] = (await getGiftCardReviewsAdmin(env)).reviews;
  assert.deepEqual([seen.balanceCents, seen.spentCents, seen.pendingCents], [0, 2000, 2000]);
  await assert.rejects(resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'void',
    reason: 'Void after the refund request', refundedCents: 500 }), /checkout in progress/);
  await assert.rejects(resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Partial refund approved', refundedCents: 500 }), /does not cover/);
  assert.equal(row(sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_reviews').n, 0);

  // Once the checkout is cancelled, its value is back on the held card and the decision can be made.
  await api.orders.cancel(order.id);
  assert.equal(ledgerBalance(sqlite, purchase.card.id), 2000);
  const result = await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'void',
    reason: 'Void after the refund request', refundedCents: 500 });
  assert.equal(result.adjustmentCents, 2000);
  assert.deepEqual(ledgerOf(sqlite, purchase.card.id), [{ kind: 'issue', amount_cents: 2000 }, { kind: 'reserve', amount_cents: -2000 },
    { kind: 'release', amount_cents: 2000 }, { kind: 'purchase_reversal', amount_cents: -2000 }]);
  assert.equal(ledgerBalance(sqlite, purchase.card.id), 0);
  assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'partially_refunded', provider_refunded_cents: 500, refund_adjusted_cents: 500 });
  sqlite.close();
});

test('a refund recorded after the administrator loaded the review stops the action', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_race');
  await spend(api, purchase.code);
  await refund(api, 'pi_race', 10000, 2000);
  const [seen] = (await getGiftCardReviewsAdmin(env)).reviews;
  const unchanged = () => {
    assert.equal(row(sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_reviews').n, 0);
    assert.equal(row(sqlite, `SELECT COUNT(*) AS n FROM _ecommerce_gift_card_ledger WHERE kind = 'purchase_reversal'`).n, 0);
    assert.deepEqual(cardRow(sqlite, purchase.card.id), { status: 'suspended', balance_cents: 7000, held_for_review: 1 });
    assert.equal(ledgerBalance(sqlite, purchase.card.id), 7000);
  };

  // Between the page load and the click.
  await refund(api, 'pi_race', 10000, 5000);
  await assert.rejects(resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Approve the partial refund', refundedCents: seen.refundedCents }), /Another refund was recorded/);
  unchanged();
  assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'review', provider_refunded_cents: 5000, refund_adjusted_cents: 0 });

  // Between the action's own check and its write: every statement is guarded, so nothing applies.
  for (const outcome of ['reinstate', 'void']) {
    const total = purchaseRow(sqlite, purchase.id).provider_refunded_cents;
    DB.beforeNextBatch = () => refund(api, 'pi_race', 10000, total + 500);
    await assert.rejects(resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome,
      reason: 'Approve the partial refund', refundedCents: total }), /changed while it was being resolved/);
    unchanged();
    assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'review', provider_refunded_cents: total + 500, refund_adjusted_cents: 0 });
  }

  const resolved = await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Approve the partial refund', refundedCents: 6000 });
  assert.equal(resolved.adjustmentCents, 6000);
  assert.equal(ledgerBalance(sqlite, purchase.card.id), 1000);
  sqlite.close();
});

test('a void card stays void when a later refund arrives', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_void_later');
  // A partial refund of an unspent card still waits for a decision.
  assert.equal((await refund(api, 'pi_void_later', 10000, 2000)).status, 'review');
  await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'void',
    reason: 'Buyer asked to cancel the card', refundedCents: 2000 });
  assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'partially_refunded', provider_refunded_cents: 2000, refund_adjusted_cents: 2000 });
  // Its value was cancelled, so there is nothing left for a replacement to take over.
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Replacement for a lost code',
    replacesPurchaseId: purchase.id }), /Only 0\.00 USD is left on the purchase's card/);

  assert.equal((await refund(api, 'pi_void_later', 10000, 5000)).status, 'partially_refunded');
  assert.deepEqual([cardOf(sqlite, purchase.id).status, ledgerBalance(sqlite, purchase.card.id)], ['void', 0]);
  assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'partially_refunded', provider_refunded_cents: 5000, refund_adjusted_cents: 5000 });
  assert.equal((await refund(api, 'pi_void_later', 10000, 10000)).status, 'refunded');
  assert.deepEqual([cardOf(sqlite, purchase.id).status, ledgerBalance(sqlite, purchase.card.id)], ['void', 0]);
  assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'refunded', provider_refunded_cents: 10000, refund_adjusted_cents: 10000 });
  // A repeated event changes nothing.
  assert.equal((await refund(api, 'pi_void_later', 10000, 10000)).duplicate, true);
  assert.equal(row(sqlite, `SELECT COUNT(*) AS n FROM _ecommerce_gift_card_ledger WHERE kind = 'purchase_reversal'`).n, 1);
  sqlite.close();
});

test('a reinstated card that was never spent is voided by the refund that completes a full refund', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_final_refund');
  await refund(api, 'pi_final_refund', 10000, 2000);
  await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Partial refund approved', refundedCents: 2000 });
  assert.deepEqual(cardRow(sqlite, purchase.card.id), { status: 'active', balance_cents: 8000, held_for_review: 0 });
  // Taking the first refund off the card was not spending, so the rest of the refund settles at once.
  assert.equal((await refund(api, 'pi_final_refund', 10000, 10000)).status, 'refunded');
  assert.deepEqual(cardRow(sqlite, purchase.card.id), { status: 'void', balance_cents: 0, held_for_review: 0 });
  assert.deepEqual(ledgerOf(sqlite, purchase.card.id), [{ kind: 'issue', amount_cents: 10000 },
    { kind: 'purchase_reversal', amount_cents: -2000 }, { kind: 'purchase_reversal', amount_cents: -8000 }]);
  assert.equal(ledgerBalance(sqlite, purchase.card.id), 0);
  assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'refunded', provider_refunded_cents: 10000, refund_adjusted_cents: 10000 });
  assert.deepEqual((await getGiftCardReviewsAdmin(env)).reviews, []);
  sqlite.close();
});

// --- Replacement cards ------------------------------------------------------------------------

test('a replacement takes over the value left on the purchase\'s card, and a refund holds it instead', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_replaced');
  await spend(api, purchase.code);
  // Support suspends the lost card and issues a replacement for what is left on it.
  await setGiftCardActive(env, purchase.card.id, false);
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { amountCents: 10000, reason: 'Replacement for a lost code',
    replacesPurchaseId: purchase.id }), /exactly what is left on the purchase's card: 70\.00 USD/);
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Replacement for a lost code',
    replacesPurchaseId: 'gp_00000000-0000-4000-8000-000000000000' }), /Only the card of a paid purchase/);
  const replacement = await issueAdminGiftCard(env, 'admin-1', { amountCents: 7000, reason: 'Replacement for a lost code',
    replacesPurchaseId: purchase.id });
  assert.equal(replacement.replacesPurchaseId, purchase.id);

  // The old card is emptied and void, so the lost code no longer works; the purchase funds one card.
  assert.deepEqual(cardRow(sqlite, purchase.card.id), { status: 'void', balance_cents: 0, held_for_review: 0 });
  assert.deepEqual(rows(sqlite, `SELECT id, purchase_id, kind, amount_cents FROM _ecommerce_gift_card_ledger
    WHERE card_id IN (?, ?) AND kind IN ('issue','purchase_reversal') ORDER BY rowid`, purchase.card.id, replacement.id), [
    { id: `gcl_issue_${purchase.card.id}`, purchase_id: purchase.id, kind: 'issue', amount_cents: 10000 },
    { id: `gcl_issue_${replacement.id}`, purchase_id: purchase.id, kind: 'issue', amount_cents: 7000 },
    { id: `gcl_replaced_${purchase.card.id}`, purchase_id: purchase.id, kind: 'purchase_reversal', amount_cents: -7000 },
  ]);
  await assert.rejects(evaluateGiftCard(env, purchase.code, 1000), /unavailable/);
  await assert.rejects(setGiftCardActive(env, purchase.card.id, true), /unavailable/);
  assert.equal((await evaluateGiftCard(env, replacement.code, 1000)).remainingCents, 7000);
  assert.equal((await getPurchasedGiftCard(env, purchase.id, purchase.accessToken)).code, null);
  assert.equal(activeValue(sqlite, purchase.id), 10000 - spentFrom(sqlite, purchase.card.id));

  // A refund of the purchase holds the replacement, and reinstating takes the refund off it.
  assert.equal((await refund(api, 'pi_replaced', 10000, 2000)).status, 'review');
  assert.deepEqual(cardRow(sqlite, replacement.id), { status: 'suspended', balance_cents: 7000, held_for_review: 1 });
  await assert.rejects(evaluateGiftCard(env, replacement.code, 1000), /unavailable/);
  await assert.rejects(setGiftCardActive(env, replacement.id, true), /requires review/);
  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { amountCents: 7000, reason: 'Another replacement card',
    replacesPurchaseId: purchase.id }), /not held for review/);
  const [review] = (await getGiftCardReviewsAdmin(env)).reviews;
  assert.deepEqual([review.cardId, review.cardReplacement, review.cardHeld, review.balanceCents, review.spentCents, review.replacementCount],
    [replacement.id, true, true, 7000, 3000, 1]);
  const result = await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Partial refund approved', refundedCents: 2000 });
  assert.equal(row(sqlite, 'SELECT card_id FROM _ecommerce_gift_card_reviews WHERE id = ?', result.id).card_id, replacement.id);
  assert.deepEqual(cardRow(sqlite, replacement.id), { status: 'active', balance_cents: 5000, held_for_review: 0 });
  assert.equal(cardOf(sqlite, purchase.id).status, 'void');
  assert.equal(activeValue(sqlite, purchase.id), 10000 - 2000 - 3000);

  // Replacing again moves the value on once more; the purchase still funds a single card.
  const next = await issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Second replacement card',
    replacesPurchaseId: purchase.id });
  assert.deepEqual(cardRow(sqlite, replacement.id), { status: 'void', balance_cents: 0, held_for_review: 0 });
  assert.deepEqual(cardRow(sqlite, next.id), { status: 'active', balance_cents: 5000, held_for_review: 0 });
  assert.equal(activeValue(sqlite, purchase.id), 5000);
  for (const id of [purchase.card.id, replacement.id, next.id]) ledgerBalance(sqlite, id);
  sqlite.close();
});

test('a fully refunded purchase whose replacement was spent cannot be reinstated', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_replacement_spent');
  await setGiftCardActive(env, purchase.card.id, false);
  const replacement = await issueAdminGiftCard(env, 'admin-1', { amountCents: 10000, reason: 'Replacement for a lost code',
    replacesPurchaseId: purchase.id });
  await spend(api, replacement.code);

  // Spending from the replacement counts, so the full refund waits for a decision.
  assert.equal((await refund(api, 'pi_replacement_spent', 10000, 10000)).status, 'review');
  await assert.rejects(resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Refund approved as it is', refundedCents: 10000 }), /does not cover/);
  const result = await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'void',
    reason: 'Refunded after the replacement was used', refundedCents: 10000 });
  assert.deepEqual([result.adjustmentCents, result.status], [7000, 'refunded']);
  for (const id of [purchase.card.id, replacement.id]) {
    assert.deepEqual(cardRow(sqlite, id), { status: 'void', balance_cents: 0, held_for_review: 0 });
    assert.equal(ledgerBalance(sqlite, id), 0);
    await assert.rejects(setGiftCardActive(env, id, true), /unavailable/);
  }
  // The purchase's 10000 were spent (3000) or reversed (7000); the replacement's issue moved value, it added none.
  assert.equal(10000, spentFrom(sqlite, replacement.id) + result.adjustmentCents);
  sqlite.close();
});

test('a full refund of an unspent purchase voids the replacement that holds its value', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 5000, 'pi_unspent_replaced');
  const replacement = await issueAdminGiftCard(env, 'admin-1', { amountCents: 5000,
    reason: 'Replacement for a lost code', replacesPurchaseId: purchase.id });
  assert.equal((await refund(api, 'pi_unspent_replaced', 5000, 5000)).status, 'refunded');
  for (const id of [purchase.card.id, replacement.id]) {
    assert.deepEqual(cardRow(sqlite, id), { status: 'void', balance_cents: 0, held_for_review: 0 });
    assert.deepEqual(ledgerOf(sqlite, id), [{ kind: 'issue', amount_cents: 5000 }, { kind: 'purchase_reversal', amount_cents: -5000 }]);
  }
  assert.deepEqual(purchaseRow(sqlite, purchase.id), { status: 'refunded', provider_refunded_cents: 5000, refund_adjusted_cents: 5000 });
  sqlite.close();
});

test('a replacement left active by an earlier release\'s refund handling can still be stopped and resolved', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const purchase = await buyGiftCard(sqlite, env, 6000, 'pi_rolled_back');
  const replacement = await issueAdminGiftCard(env, 'admin-1', { amountCents: 6000,
    reason: 'Replacement for a lost code', replacesPurchaseId: purchase.id });
  // A Worker rolled back to an earlier release records a partial refund with its own statements: it
  // knows only the purchased card, which it turns from void back to suspended.
  const T = Math.floor(Date.now() / 1000);
  sqlite.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = ?,provider_refunded_cents = ?,updated_at = ?
    WHERE id = ? AND provider_refunded_cents < ?`).run('review', 1000, T, purchase.id, 1000);
  sqlite.prepare('UPDATE _ecommerce_gift_cards SET status = ?,updated_at = ? WHERE id = ?').run('suspended', T, purchase.card.id);
  assert.equal(cardOf(sqlite, purchase.id).status, 'suspended');
  assert.equal(cardRow(sqlite, replacement.id).status, 'active');

  const listed = (await getGiftCardsAdmin(env)).find((card) => card.id === replacement.id);
  assert.deepEqual([listed.status, listed.inReview], ['active', true]);
  assert.equal((await setGiftCardActive(env, replacement.id, false)).status, 'suspended');
  await assert.rejects(setGiftCardActive(env, replacement.id, true), /requires review/);
  const [review] = (await getGiftCardReviewsAdmin(env)).reviews;
  assert.deepEqual([review.cardId, review.balanceCents], [replacement.id, 6000]);
  await resolveGiftCardReview(env, 'admin-1', { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Partial refund approved', refundedCents: 1000 });
  assert.deepEqual(cardRow(sqlite, replacement.id), { status: 'suspended', balance_cents: 5000, held_for_review: 0 });
  assert.deepEqual(cardRow(sqlite, purchase.card.id), { status: 'suspended', balance_cents: 0, held_for_review: 0 });
  assert.equal((await setGiftCardActive(env, replacement.id, true)).status, 'active');
  assert.equal(activeValue(sqlite, purchase.id), 6000 - 1000);
  sqlite.close();
});

test('the exported hold statements suspend every card a purchase funds, for reuse by other refund paths', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const purchase = await buyGiftCard(sqlite, env, 6000, 'pi_hold');
  const replacement = await issueAdminGiftCard(env, 'admin-1', { amountCents: 6000,
    reason: 'Replacement for a lost code', replacesPurchaseId: purchase.id });
  // As a later refund path would: move the purchase to review in the same batch. The statements are
  // Drizzle `sql` templates, run through the client's batch.
  const db = drizzle(DB);
  const timestamp = Math.floor(Date.now() / 1000);
  await db.batch([db.run(sql`UPDATE _ecommerce_gift_card_purchases SET status = 'review' WHERE id = ${purchase.id}`),
    ...giftCardPurchaseHoldStatements(purchase.id, timestamp).map((statement) => db.run(statement))]);
  assert.deepEqual(cardRow(sqlite, replacement.id), { status: 'suspended', balance_cents: 6000, held_for_review: 1 });
  assert.equal(cardRow(sqlite, purchase.card.id).status, 'void');
  assert.equal(purchaseRow(sqlite, purchase.id).status, 'review');
  // Applying them again changes nothing.
  await db.batch(giftCardPurchaseHoldStatements(purchase.id, timestamp).map((statement) => db.run(statement)));
  assert.deepEqual(cardRow(sqlite, replacement.id), { status: 'suspended', balance_cents: 6000, held_for_review: 1 });
  sqlite.close();
});

// --- Admin route ------------------------------------------------------------------------------

const ORIGIN = 'https://shop.test';

async function callAdmin(env, user, { method = 'POST', body, origin = ORIGIN } = {}) {
  globalThis.workerEnv = env;
  globalThis.cmsUser = user;
  const request = new Request(`${ORIGIN}/admin/api/ecommerce/gift-cards-admin`, { method,
    headers: { ...(origin ? { origin } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await adminRoute({ request });
  return { status: response.status, json: await response.json() };
}

test('only an administrator can list and resolve reviews, and only from the admin origin', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const api = bindCommerceApi({ env, paymentAdapters: [stripe] });
  const purchase = await buyGiftCard(sqlite, env, 10000, 'pi_route');
  await refund(api, 'pi_route', 10000, 4000);
  const admin = { id: 'admin-1', email: 'admin@shop.test', role: 'admin' };
  const editor = { id: 'editor-1', email: 'editor@shop.test', role: 'editor' };
  const resolve = { action: 'resolveReview', data: { purchaseId: purchase.id, outcome: 'reinstate',
    reason: 'Partial refund approved', refundedCents: 4000 } };

  assert.equal((await callAdmin(env, undefined, { method: 'GET' })).status, 401);
  assert.equal((await callAdmin(env, editor, { method: 'GET' })).status, 403);
  const listed = await callAdmin(env, admin, { method: 'GET' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.reviews.map((review) => [review.purchaseId, review.refundedCents]), [[purchase.id, 4000]]);
  assert.deepEqual(listed.json.cards.map((card) => [card.id, card.status, card.inReview]), [[purchase.card.id, 'suspended', true]]);
  assert.deepEqual(listed.json.encryption, { keyId: keyId(KEY_A), previousKeyCodes: 0, legacyCodes: 0 });

  assert.equal((await callAdmin(env, undefined, { body: resolve })).status, 401);
  assert.equal((await callAdmin(env, editor, { body: resolve })).status, 403);
  assert.equal((await callAdmin(env, admin, { body: resolve, origin: 'https://attacker.test' })).status, 403);
  assert.equal((await callAdmin(env, admin, { body: resolve, origin: null })).status, 403);
  assert.equal(purchaseRow(sqlite, purchase.id).status, 'review');
  assert.equal(row(sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_reviews').n, 0);

  const resolved = await callAdmin(env, admin, { body: resolve });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json.result.adjustmentCents, 4000);
  assert.equal(row(sqlite, 'SELECT admin_actor FROM _ecommerce_gift_card_reviews').admin_actor, 'admin-1');
  const repeated = await callAdmin(env, admin, { body: resolve });
  assert.deepEqual([repeated.status, repeated.json.error], [400, 'Gift card purchase is not held for review']);
  assert.equal((await callAdmin(env, editor, { body: { action: 'reencryptCodes' } })).status, 403);
  assert.deepEqual((await callAdmin(env, admin, { body: { action: 'reencryptCodes' } })).json.result,
    { keyId: keyId(KEY_A), reencrypted: 0, failed: [], next: null });
  sqlite.close();
});

test('the plugin schema only names gift card columns the migrations create', () => {
  const { sqlite } = database();
  for (const table of [schema.giftCards, schema.giftCardPurchases, schema.giftCardReviews, schema.giftCardLedger]) {
    const { name, columns } = getTableConfig(table);
    const created = new Set(sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(name).map((column) => column.name));
    for (const column of columns) assert.ok(created.has(column.name), `${name}.${column.name} is declared but no migration creates it`);
  }
  sqlite.close();
});
