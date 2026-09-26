import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { analyticsPlugin } from '../dist/index.js';
import { fetchTrafficOverview } from '../dist/cloudflare.js';
import { fetchCommerceOverview } from '../dist/commerce.js';
import { createAskReport, formatRange, planReport, precedingWindow, reportWindow, validateReportPlan } from '../dist/ask.js';

const day = 86_400;
const now = new Date('2026-09-25T12:00:00Z');
const nowSeconds = Math.floor(now.getTime() / 1000);
const paidAt = nowSeconds - day;
const lens = (quantity = 2, price = 1000) => JSON.stringify([{ productId: 'p1', quantity, priceAtPurchase: price }]);

function sqliteD1({ refundDates = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE _ecommerce_orders (
      id TEXT PRIMARY KEY, status TEXT, payment_provider TEXT, checkout_session_id TEXT,
      subtotal_amount INTEGER, discount_amount INTEGER, total_amount INTEGER,
      provider_refunded_cents INTEGER, gift_card_id TEXT, gift_card_refunded_cents INTEGER,
      currency TEXT, items TEXT
    );
    CREATE TABLE _ecommerce_payments (order_id TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE _ecommerce_products (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE _ecommerce_gift_card_purchases (id TEXT PRIMARY KEY, provider_session_id TEXT);
    CREATE TABLE _ecommerce_gift_cards (id TEXT PRIMARY KEY, purchase_id TEXT);
    CREATE TABLE _ecommerce_gift_card_refunds (id TEXT PRIMARY KEY, card_id TEXT, order_id TEXT, amount_cents INTEGER, created_at INTEGER);
    CREATE TABLE _ecommerce_gift_card_order_refunds (order_id TEXT PRIMARY KEY, created_at INTEGER);
    INSERT INTO _ecommerce_products VALUES ('p1', 'Lens');
  `);
  // The provider refund ledger that plugin-ecommerce writes once refund dates are recorded.
  if (refundDates) sqlite.exec(`CREATE TABLE _ecommerce_provider_refunds (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, provider TEXT NOT NULL, provider_refund_id TEXT,
    amount_cents INTEGER NOT NULL, created_at INTEGER)`);
  const insertOrder = sqlite.prepare(`INSERT INTO _ecommerce_orders
    (id, status, payment_provider, checkout_session_id, subtotal_amount, discount_amount, total_amount,
     provider_refunded_cents, gift_card_id, gift_card_refunded_cents, currency, items)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertPayment = sqlite.prepare('INSERT INTO _ecommerce_payments VALUES (?, ?, ?)');
  function order(id, {
    status = 'paid', provider = 'stripe', session = `cs_live_${id}`, subtotal = 1000, discount = 0,
    total = subtotal - discount, providerRefunded = 0, giftCard = null, giftCardRefunded = 0,
    currency = 'usd', items = lens(1, subtotal), paid = paidAt, payment = 'success',
  } = {}) {
    insertOrder.run(id, status, provider, session, subtotal, discount, total, providerRefunded,
      giftCard, giftCardRefunded, currency, items);
    if (paid !== null) insertPayment.run(id, payment, paid);
  }
  return {
    sqlite, order,
    d1: {
      prepare(query) {
        const statement = sqlite.prepare(query);
        return { bind(...params) { return { async all() { return { results: statement.all(...params) }; } }; } };
      },
    },
  };
}

test('commerce uses payment date, separates currencies, and excludes admin tests and pending orders', async () => {
  const { sqlite, d1, order } = sqliteD1();
  order('paid', { status: 'partially_refunded', subtotal: 2000, discount: 100, providerRefunded: 300, items: lens(2, 1000), payment: 'partially_refunded' });
  order('gift', { provider: 'gift_card', session: 'internal:gift', subtotal: 1200, total: 0, items: lens(1, 1200) });
  order('refunded', { status: 'refunded', subtotal: 1000, providerRefunded: 1000, items: lens(2, 1000), payment: 'refunded' });
  order('test', { provider: 'admin_test', session: 'admin_test:test', subtotal: 5000, items: lens(2, 1000) });
  order('pending', { status: 'pending', subtotal: 5000, items: lens(2, 1000), paid: null });
  order('eur', { currency: 'eur', subtotal: 900, items: lens(2, 1000) });
  const result = await fetchCommerceOverview(d1, 7, '/admin', 'products', 'live', now);
  const usd = result.currencies.find(row => row.currency === 'usd');
  assert.equal(result.refundBasis, 'payment_date');
  assert.equal(usd.orders, 3);
  assert.equal(usd.grossSales, 4100);
  assert.equal(usd.netSales, 2800);
  assert.equal(usd.refunds, 1300);
  assert.equal(usd.refundedOrders, 2);
  assert.equal(usd.averageOrderValue, 1367);
  assert.equal(result.currencies.find(row => row.currency === 'eur').netSales, 900);
  assert.equal(result.products.find(row => row.currency === 'usd').units, 3);
  assert.equal(result.products.find(row => row.currency === 'usd').editHref, '/admin/commerce/products/p1');
  sqlite.close();
});

function seedTestModeOrders({ sqlite, order }) {
  sqlite.exec(`
    INSERT INTO _ecommerce_gift_card_purchases VALUES ('gp_test', 'cs_test_gift'), ('gp_live', 'cs_live_gift');
    INSERT INTO _ecommerce_gift_cards VALUES ('card_test', 'gp_test'), ('card_live', 'gp_live'), ('card_admin', NULL);
  `);
  order('live', { subtotal: 1000 });
  order('stripe_test', { session: 'cs_test_a1', subtotal: 5000 });
  order('legacy_test', { provider: null, session: 'cs_test_b2', subtotal: 7000 });
  order('gift_test', { provider: 'gift_card', session: 'internal:gift_test', subtotal: 3000, total: 0, giftCard: 'card_test' });
  order('gift_live', { provider: 'gift_card', session: 'internal:gift_live', subtotal: 200, total: 0, giftCard: 'card_live' });
  order('gift_admin', { provider: 'gift_card', session: 'internal:gift_admin', subtotal: 30, total: 0, giftCard: 'card_admin' });
  // A live Stripe order is real revenue even if it also used a gift card bought in test mode.
  order('mixed', { session: 'cs_live_mixed', subtotal: 4, total: 2, giftCard: 'card_test' });
  // Admin test orders never count, in either mode.
  order('admin', { provider: 'admin_test', session: 'admin_test:admin', subtotal: 90000 });
}

test('in live mode, commerce excludes Stripe test-mode orders and orders paid with test-mode gift cards', async () => {
  const fixture = sqliteD1();
  seedTestModeOrders(fixture);
  const result = await fetchCommerceOverview(fixture.d1, 7, '/admin', 'products', 'live', now);
  assert.equal(result.stripeMode, 'live');
  assert.deepEqual(result.currencies.map(({ currency, orders, grossSales }) => ({ currency, orders, grossSales })),
    [{ currency: 'usd', orders: 4, grossSales: 1234 }]);
  assert.equal(result.products[0].itemSales, 1234);
  // Without a mode the report treats the store as live.
  const unspecified = await fetchCommerceOverview(fixture.d1, 7, '/admin', 'products', undefined, now);
  assert.equal(unspecified.stripeMode, 'live');
  assert.deepEqual(unspecified.currencies, result.currencies);
  fixture.sqlite.close();
});

test('in test mode, commerce includes Stripe test-mode orders but still excludes admin test orders', async () => {
  const fixture = sqliteD1();
  seedTestModeOrders(fixture);
  const result = await fetchCommerceOverview(fixture.d1, 7, '/admin', 'products', 'test', now);
  assert.equal(result.stripeMode, 'test');
  assert.deepEqual(result.currencies.map(({ currency, orders, grossSales }) => ({ currency, orders, grossSales })),
    [{ currency: 'usd', orders: 7, grossSales: 16234 }]);
  assert.equal(result.products[0].itemSales, 16234);
  fixture.sqlite.close();
});

// Last 30 days from `now` is Aug 26 12:00 to Sep 25 12:00; the 30 days before start on Jul 27 12:00.
function seedRefunds({ sqlite, order }) {
  const ago = days => nowSeconds - days * day;
  // Paid 40 days ago, fully refunded by Stripe yesterday.
  order('a', { status: 'refunded', subtotal: 10000, providerRefunded: 10000, paid: ago(40), payment: 'refunded' });
  // Paid 2 days ago, refunded $10 an hour ago.
  order('b', { status: 'partially_refunded', subtotal: 5000, providerRefunded: 1000, paid: ago(2), payment: 'partially_refunded' });
  // Paid 3 days ago; $5 refunded before refund dates were recorded.
  order('c', { status: 'partially_refunded', subtotal: 2000, providerRefunded: 500, paid: ago(3), payment: 'partially_refunded' });
  // Gift card and store credit order paid 50 days ago, fully refunded 5 days ago.
  order('d', { status: 'refunded', provider: 'gift_card', session: 'internal:d', subtotal: 3500, total: 0,
    giftCard: 'card', giftCardRefunded: 3000, paid: ago(50), payment: 'refunded' });
  // Stripe and store credit order paid 35 days ago, fully refunded 20 days ago.
  order('e', { status: 'refunded', subtotal: 2000, total: 1500, providerRefunded: 1500, paid: ago(35), payment: 'refunded' });
  // A test-mode order refunded yesterday never counts.
  order('f', { status: 'refunded', session: 'cs_test_f', subtotal: 9900, providerRefunded: 9900, paid: ago(2), payment: 'refunded' });
  sqlite.prepare('INSERT INTO _ecommerce_gift_card_refunds VALUES (?, ?, ?, ?, ?)').run('gfr_full_d', 'card', 'd', 3000, ago(5));
  sqlite.prepare('INSERT INTO _ecommerce_gift_card_order_refunds VALUES (?, ?)').run('d', ago(5));
  const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE name = '_ecommerce_provider_refunds'`).all();
  if (tables.length) {
    const refund = sqlite.prepare(`INSERT INTO _ecommerce_provider_refunds VALUES (?, ?, 'stripe', ?, ?, ?)`);
    refund.run('prf_a', 'a', 're_a', 10000, ago(1));
    refund.run('prf_b', 'b', 're_b', 1000, nowSeconds - 3600);
    refund.run('prf_e', 'e', 're_e', 1500, ago(20));
    refund.run('prf_f', 'f', 're_f', 9900, ago(1));
  }
}

test('refunds count on the date they were issued when provider refunds are recorded', async () => {
  const fixture = sqliteD1({ refundDates: true });
  seedRefunds(fixture);
  const current = await fetchCommerceOverview(fixture.d1, 30, '/admin', 'products', 'live', now);
  assert.equal(current.refundBasis, 'refund_date');
  assert.equal(current.undatedRefunds, true);
  assert.deepEqual(current.currencies, [{
    currency: 'usd', orders: 2, grossSales: 7000, netSales: -10000, refunds: 17000,
    refundedOrders: 5, charged: 7000, averageOrderValue: 3500,
  }]);
  assert.deepEqual(current.daily.find(row => row.date === '2026-09-24'), { date: '2026-09-24', currency: 'usd', orders: 0, netSales: -10000 });
  assert.deepEqual(current.daily.find(row => row.date === '2026-09-22'), { date: '2026-09-22', currency: 'usd', orders: 1, netSales: 1500 });
  // The earlier period keeps the sales it had: later refunds are not taken back out of it.
  const earlier = await fetchCommerceOverview(fixture.d1, 30, '/admin', 'products', 'live', new Date(now.getTime() - 30 * day * 1000));
  assert.deepEqual(earlier.currencies.map(({ orders, grossSales, refunds, netSales }) => ({ orders, grossSales, refunds, netSales })),
    [{ orders: 3, grossSales: 15500, refunds: 0, netSales: 15500 }]);
  assert.equal(earlier.undatedRefunds, false);
  fixture.sqlite.close();
});

test('without recorded refund dates, refunds count on the payment date and say so', async () => {
  const fixture = sqliteD1();
  seedRefunds(fixture);
  const current = await fetchCommerceOverview(fixture.d1, 30, '/admin', 'products', 'live', now);
  assert.equal(current.refundBasis, 'payment_date');
  assert.equal(current.undatedRefunds, false);
  assert.deepEqual(current.currencies.map(({ orders, grossSales, refunds, refundedOrders, netSales }) => ({ orders, grossSales, refunds, refundedOrders, netSales })),
    [{ orders: 2, grossSales: 7000, refunds: 1500, refundedOrders: 2, netSales: 5500 }]);
  const ai = { async run() { return { response: { subject: 'refunds', period: 'last_30_days', compare: false } }; } };
  const report = await createAskReport('How much did we refund this month?', ai, fixture.d1, {}, '/admin', 'products', 'live', now);
  assert.equal(report.summary, 'Orders paid in this period have $15.00 refunded across 2 orders in USD.');
  assert.ok(report.notes.some(note => note.startsWith('Refunds count on the payment date of the refunded order')));
  fixture.sqlite.close();
});

test('in test mode, refunds of Stripe test-mode orders count too', async () => {
  const fixture = sqliteD1({ refundDates: true });
  seedRefunds(fixture);
  const totals = ({ currencies }) => currencies.map(({ orders, grossSales, refunds, refundedOrders }) => ({ orders, grossSales, refunds, refundedOrders }));
  assert.deepEqual(totals(await fetchCommerceOverview(fixture.d1, 30, '/admin', 'products', 'live', now)),
    [{ orders: 2, grossSales: 7000, refunds: 17000, refundedOrders: 5 }]);
  // Order f was paid in test mode 2 days ago and fully refunded yesterday.
  assert.deepEqual(totals(await fetchCommerceOverview(fixture.d1, 30, '/admin', 'products', 'test', now)),
    [{ orders: 3, grossSales: 16900, refunds: 26900, refundedOrders: 6 }]);
  fixture.sqlite.close();
});

test('an Ask report counts test-mode orders only in test mode and says which rule applies', async () => {
  const { sqlite, d1, order } = sqliteD1();
  order('live', { subtotal: 1000 });
  order('stripe_test', { session: 'cs_test_ask', subtotal: 5000 });
  order('admin', { provider: 'admin_test', session: 'admin_test:ask', subtotal: 90000 });
  const ai = { async run() { return { response: { subject: 'sales', period: 'last_7_days', compare: true } }; } };
  const inLiveMode = await createAskReport('How are sales doing this week?', ai, d1, {}, '/admin', 'products', 'live', now);
  assert.match(inLiveMode.summary, /^There was 1 confirmed order and \$10\.00 net sales in USD\./);
  assert.deepEqual([inLiveMode.commerce.stripeMode, inLiveMode.previousCommerce.stripeMode], ['live', 'live']);
  assert.equal(inLiveMode.notes[0], 'Dates use UTC. Sales use the payment date and exclude pending orders, admin test orders and Stripe test-mode orders.');
  const inTestMode = await createAskReport('How are sales doing this week?', ai, d1, {}, '/admin', 'products', 'test', now);
  assert.match(inTestMode.summary, /^There were 2 confirmed orders and \$60\.00 net sales in USD\./);
  assert.deepEqual([inTestMode.commerce.stripeMode, inTestMode.previousCommerce.stripeMode], ['test', 'test']);
  assert.equal(inTestMode.notes[0], 'Dates use UTC. Sales use the payment date and exclude pending orders and admin test orders. ' +
    'The store is in Stripe test mode, so Stripe test-mode orders are included.');
  sqlite.close();
});

test('analytics plugin adds Commerce only when ecommerce is registered', () => {
  const analytics = analyticsPlugin();
  analytics.onInit({ plugins: [analytics] });
  assert.equal(analytics.adminUi.length, 1);
  const ecommerce = { name: '@talisman-cms/plugin-ecommerce' };
  analytics.onInit({ plugins: [analytics, ecommerce] });
  assert.equal(analytics.adminUi.length, 2);
  assert.equal(analytics.endpoints.length, 2);
  assert.equal(analytics.adminLinks[0].href, '/admin/extensions/commerce-analytics');
  const disabled = analyticsPlugin({ commerce: false });
  disabled.onInit({ plugins: [disabled, ecommerce] });
  assert.equal(disabled.adminUi.length, 1);
  const ask = analyticsPlugin({ ask: true });
  ask.onInit({ plugins: [ask, ecommerce] });
  assert.equal(ask.adminUi.length, 3);
  assert.ok(ask.endpoints.some(endpoint => endpoint.path === '/analytics/ask'));
  assert.ok(ask.adminLinks.some(link => link.href === '/admin/extensions/ask-analytics'));
});

test('Cloudflare traffic and vitals responses become separate dashboard metrics', async () => {
  const env = {
    CLOUDFLARE_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_ANALYTICS_SITE_TAG: 'b'.repeat(32),
    CLOUDFLARE_ANALYTICS_API_TOKEN: 'secret',
  };
  const queries = [];
  const fetcher = async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer secret');
    const { query } = JSON.parse(init.body);
    queries.push(query);
    const account = query.includes('rumWebVitalsEventsAdaptiveGroups')
      ? { vitals: [{ quantiles: { largestContentfulPaintP75: 2_500_000, interactionToNextPaintP75: 200_000, cumulativeLayoutShiftP75: 0.12 } }] }
      : { total: [{ count: 100, sum: { visits: 40 } }],
          trend: [{ count: 100, sum: { visits: 40 }, dimensions: { date: '2026-09-24' } }],
          pages: [{ count: 70, sum: { visits: 30 }, dimensions: { requestPath: '/about' } }],
          referrers: [{ sum: { visits: 10 }, dimensions: { refererHost: 'example.com' } }],
          countries: [{ sum: { visits: 15 }, dimensions: { countryName: 'Indonesia' } }] };
    return Response.json({ data: { viewer: { accounts: [account] } } });
  };
  const result = await fetchTrafficOverview(env, 7, fetcher, now);
  assert.equal(result.pageViews, 100);
  assert.equal(result.visits, 40);
  assert.equal(result.pages[0].path, '/about');
  assert.equal(result.vitals.lcpP75Ms, 2500);
  assert.equal(result.vitals.inpP75Ms, 200);
  assert.equal(result.vitals.clsP75, 0.12);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(query => query.includes('b'.repeat(32))));
});

test('question planning sends only the question to AI and rejects unsupported or malformed plans', async () => {
  let request;
  const ai = { async run(model, input) {
    request = { model, input };
    return { response: JSON.stringify({ subject: 'products', period: 'last_month', compare: false }) };
  } };
  assert.deepEqual(await planReport('Which products sold best last month?', ai),
    { subject: 'products', period: 'last_month', compare: false });
  assert.equal(request.input.messages[1].content, 'Which products sold best last month?');
  assert.equal(request.input.response_format.type, 'json_schema');
  assert.throws(() => validateReportPlan({ subject: 'unsupported', period: 'last_30_days', compare: false }), /needs data/);
  assert.throws(() => validateReportPlan({ subject: 'orders; DROP TABLE', period: 'last_30_days', compare: false }), /Could not understand/);
});

test('calendar month and comparison windows use exact UTC boundaries', () => {
  const current = reportWindow('last_month', now);
  assert.deepEqual(current, { label: 'Last month', start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(precedingWindow(current, 'last_month'), {
    label: 'The month before', start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z',
  });
  assert.deepEqual(precedingWindow(reportWindow('last_month', new Date('2026-04-15T12:00:00Z')), 'last_month'), {
    label: 'The month before', start: '2026-02-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z',
  });
});

test('today and this month are compared with the same span of the period before', () => {
  const compare = (period, at) => precedingWindow(reportWindow(period, new Date(at)), period);
  assert.deepEqual(compare('today', now), {
    label: 'The same hours yesterday', start: '2026-09-24T00:00:00.000Z', end: '2026-09-24T12:00:00.000Z',
  });
  assert.deepEqual(compare('yesterday', now), {
    label: 'The day before', start: '2026-09-23T00:00:00.000Z', end: '2026-09-24T00:00:00.000Z',
  });
  assert.deepEqual(compare('this_month', now), {
    label: 'The same days last month', start: '2026-08-01T00:00:00.000Z', end: '2026-08-25T12:00:00.000Z',
  });
  // Just after midnight on the 1st: 30 minutes of October against the first 30 minutes of September.
  assert.deepEqual(compare('this_month', '2026-10-01T00:30:00Z'), {
    label: 'The same days last month', start: '2026-09-01T00:00:00.000Z', end: '2026-09-01T00:30:00.000Z',
  });
  // March 31 is past the end of February, so all of February is the comparison.
  assert.deepEqual(compare('this_month', '2026-03-31T12:00:00Z'), {
    label: 'All of last month', start: '2026-02-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z',
  });
  assert.deepEqual(compare('this_month', '2026-01-15T06:00:00Z'), {
    label: 'The same days last month', start: '2025-12-01T00:00:00.000Z', end: '2025-12-15T06:00:00.000Z',
  });
  assert.deepEqual(compare('last_7_days', now), {
    label: 'The previous 7 days', start: '2026-09-11T12:00:00.000Z', end: '2026-09-18T12:00:00.000Z',
  });
});

test('date ranges show times whenever a boundary is not at midnight', () => {
  const range = (period, at = now) => {
    const window = reportWindow(period, new Date(at));
    return formatRange(window.start, window.end, 'en');
  };
  assert.equal(range('yesterday'), 'Sep 24, 2026 UTC');
  assert.equal(range('last_month'), 'Aug 1, 2026–Aug 31, 2026 UTC');
  assert.equal(range('today'), 'Sep 25, 2026, 00:00–12:00 UTC');
  assert.equal(range('last_7_days'), 'Sep 18, 2026, 12:00 – Sep 25, 2026, 12:00 UTC');
  const previous = precedingWindow(reportWindow('last_7_days', now), 'last_7_days');
  assert.equal(formatRange(previous.start, previous.end, 'en'), 'Sep 11, 2026, 12:00 – Sep 18, 2026, 12:00 UTC');
});

test('a sales comparison names the window it compares with', async () => {
  const { sqlite, d1, order } = sqliteD1();
  order('today', { subtotal: 3000, paid: nowSeconds - 3600 });
  order('yesterday_morning', { subtotal: 2000, paid: nowSeconds - day - 3600 });
  order('yesterday_evening', { subtotal: 9000, paid: nowSeconds - day + 6 * 3600 });
  const ai = { async run() { return { response: { subject: 'sales', period: 'today', compare: true } }; } };
  const report = await createAskReport('Are sales up today compared with yesterday?', ai, d1, {}, '/admin', 'products', 'live', now);
  assert.equal(report.previous.label, 'The same hours yesterday');
  assert.equal(report.summary, 'There was 1 confirmed order and $30.00 net sales in USD. USD net sales rose 50% compared with Sep 24, 2026, 00:00–12:00 UTC.');
  sqlite.close();
});

test('a refunds report summarizes and compares refunds, not net sales', async () => {
  const fixture = sqliteD1({ refundDates: true });
  seedRefunds(fixture);
  const ai = { async run() { return { response: { subject: 'refunds', period: 'last_30_days', compare: true } }; } };
  const report = await createAskReport('Did refunds increase compared with the previous 30 days?', ai, fixture.d1, {}, '/admin', 'products', 'live', now);
  assert.equal(report.summary, 'Refunds issued: $170.00 on 5 orders in USD. USD refunds issued rose from zero compared with Jul 27, 2026, 12:00 – Aug 26, 2026, 12:00 UTC.');
  assert.doesNotMatch(report.summary, /net sales/);
  assert.ok(report.notes.some(note => note.startsWith('Refunds count on the date they were issued')));
  assert.ok(report.notes.some(note => note.startsWith('Some refunds were recorded before refund dates were stored')));
  fixture.sqlite.close();
});

test('without refund dates, a refunds comparison compares the refunds on each window\'s orders and says so', async () => {
  const fixture = sqliteD1();
  seedRefunds(fixture);
  const ai = { async run() { return { response: { subject: 'refunds', period: 'last_30_days', compare: true } }; } };
  const report = await createAskReport('Did refunds increase compared with the previous 30 days?', ai, fixture.d1, {}, '/admin', 'products', 'live', now);
  // $110 was refunded in the last 30 days, but on orders paid earlier, so it counts in the previous window.
  assert.equal(report.summary, 'Orders paid in this period have $15.00 refunded across 2 orders in USD. ' +
    'Refunds on USD orders paid in this period fell 90% compared with orders paid Jul 27, 2026, 12:00 – Aug 26, 2026, 12:00 UTC.');
  assert.doesNotMatch(report.summary, /USD refunds (issued )?(rose|fell)/);
  assert.equal(report.previousCommerce.refundBasis, 'payment_date');
  fixture.sqlite.close();
});

test('provider refunds never count for more than the order\'s provider refund total', async () => {
  const fixture = sqliteD1({ refundDates: true });
  const { sqlite, order } = fixture;
  const ago = days => nowSeconds - days * day;
  // Two webhooks raced: both saw nothing refunded and recorded the cumulative 300 and 500 in full.
  order('race', { status: 'partially_refunded', subtotal: 1000, providerRefunded: 500, paid: ago(10), payment: 'partially_refunded' });
  // The same full refund recorded twice.
  order('twice', { status: 'refunded', subtotal: 800, providerRefunded: 800, paid: ago(10), payment: 'refunded' });
  const refund = sqlite.prepare(`INSERT INTO _ecommerce_provider_refunds VALUES (?, ?, 'stripe', NULL, ?, ?)`);
  refund.run('prf_race_1', 'race', 300, ago(3));
  refund.run('prf_race_2', 'race', 500, ago(2));
  refund.run('prf_twice_1', 'twice', 800, ago(2));
  refund.run('prf_twice_2', 'twice', 800, ago(1));
  const result = await fetchCommerceOverview(fixture.d1, 30, '/admin', 'products', 'live', now);
  assert.deepEqual(result.currencies.map(({ grossSales, refunds, refundedOrders, netSales }) => ({ grossSales, refunds, refundedOrders, netSales })),
    [{ grossSales: 1800, refunds: 1300, refundedOrders: 2, netSales: 500 }]);
  assert.equal(result.undatedRefunds, false);
  // Earliest first: the first race row counts in full and the second only for the 200 that is left.
  const refundsOn = date => 0 - (result.daily.find(row => row.date === date)?.netSales ?? 0);
  assert.equal(refundsOn('2026-09-22'), 300);
  assert.equal(refundsOn('2026-09-23'), 1000);
  assert.equal(refundsOn('2026-09-24'), 0);
  sqlite.close();
});

test('a products report names the best seller in each currency', async () => {
  const { sqlite, d1, order } = sqliteD1();
  order('lens', { subtotal: 3000, items: lens(3, 1000) });
  order('eur', { currency: 'eur', subtotal: 800, items: lens(1, 800) });
  const ai = { async run() { return { response: { subject: 'products', period: 'last_7_days', compare: false } }; } };
  const report = await createAskReport('Which products sold best this week?', ai, d1, {}, '/admin', 'products', 'live', now);
  assert.match(report.summary, /Top product in EUR: Lens, with 1 unit and €8\.00 in item sales\. Top product in USD: Lens, with 3 units and \$30\.00 in item sales\.$/);
  sqlite.close();
});

test('report amounts are scaled by each currency’s minor units', async () => {
  const { sqlite, d1, order } = sqliteD1();
  // Yen have no minor unit and Kuwaiti dinars have three decimals: 1250 is ¥1,250 and 12345 is KWD 12.345.
  order('yen', { currency: 'jpy', subtotal: 1250, items: lens(1, 1250) });
  order('dinar', { currency: 'kwd', subtotal: 12345, items: lens(1, 12345) });
  const ai = { async run() { return { response: { subject: 'products', period: 'last_7_days', compare: false } }; } };
  const report = await createAskReport('Which products sold best this week?', ai, d1, {}, '/admin', 'products', 'live', now);
  assert.match(report.summary, /1 confirmed order and ¥1,250 net sales in JPY/);
  assert.match(report.summary, /1 confirmed order and KWD\s12\.345 net sales in KWD/);
  assert.match(report.summary, /Top product in JPY: Lens, with 1 unit and ¥1,250 in item sales\./);
  assert.match(report.summary, /Top product in KWD: Lens, with 1 unit and KWD\s12\.345 in item sales\./);
  sqlite.close();
});

test('generated sales report uses confirmed aggregate orders and no customer records', async () => {
  const { sqlite, d1, order } = sqliteD1();
  order('paid', { subtotal: 2400, items: lens(2, 1200) });
  const ai = { async run() { return { response: { subject: 'sales', period: 'last_7_days', compare: false } }; } };
  const result = await createAskReport('How are sales doing this week?', ai, d1, {}, '/admin', 'products', 'live', now);
  assert.equal(result.commerce.currencies[0].netSales, 2400);
  assert.match(result.summary, /one|1 confirmed order/);
  assert.equal(result.traffic, undefined);
  assert.equal(JSON.stringify(result).includes('customer'), false);
  sqlite.close();
});

test('conversion requests are rejected before calling the model or database', async () => {
  let called = false;
  const ai = { async run() { called = true; return { response: {} }; } };
  await assert.rejects(() => createAskReport('What is our conversion rate?', ai, {}, {}), /needs data/);
  assert.equal(called, false);
});
