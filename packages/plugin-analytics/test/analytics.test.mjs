import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { analyticsPlugin } from '../dist/index.js';
import { fetchTrafficOverview } from '../dist/cloudflare.js';
import { fetchCommerceOverview } from '../dist/commerce.js';
import { createAskReport, planReport, precedingWindow, reportWindow, validateReportPlan } from '../dist/ask.js';

const day = 86_400;
const now = new Date('2026-09-25T12:00:00Z');
const paidAt = Math.floor(now.getTime() / 1000) - day;

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE _ecommerce_orders (
      id TEXT PRIMARY KEY, status TEXT, payment_provider TEXT, subtotal_amount INTEGER,
      discount_amount INTEGER, total_amount INTEGER, provider_refunded_cents INTEGER,
      gift_card_refunded_cents INTEGER, currency TEXT, items TEXT
    );
    CREATE TABLE _ecommerce_payments (order_id TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE _ecommerce_products (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO _ecommerce_products VALUES ('p1', 'Lens');
  `);
  return {
    sqlite,
    d1: {
      prepare(query) {
        const statement = sqlite.prepare(query);
        return { bind(...params) { return { async all() { return { results: statement.all(...params) }; } }; } };
      },
    },
  };
}

test('commerce uses payment date, separates currencies, and excludes admin tests and pending orders', async () => {
  const { sqlite, d1 } = sqliteD1();
  const insertOrder = sqlite.prepare(`INSERT INTO _ecommerce_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertPayment = sqlite.prepare(`INSERT INTO _ecommerce_payments VALUES (?, ?, ?)`);
  const item = JSON.stringify([{ productId: 'p1', quantity: 2, priceAtPurchase: 1000 }]);
  insertOrder.run('paid', 'partially_refunded', 'stripe', 2000, 100, 1900, 300, 0, 'usd', item);
  insertPayment.run('paid', 'partially_refunded', paidAt);
  insertOrder.run('gift', 'paid', 'gift_card', 1200, 0, 0, 0, 0, 'usd', JSON.stringify([{ productId: 'p1', quantity: 1, priceAtPurchase: 1200 }]));
  insertPayment.run('gift', 'success', paidAt);
  insertOrder.run('refunded', 'refunded', 'stripe', 1000, 0, 1000, 1000, 0, 'usd', item);
  insertPayment.run('refunded', 'refunded', paidAt);
  insertOrder.run('test', 'paid', 'admin_test', 5000, 0, 5000, 0, 0, 'usd', item);
  insertPayment.run('test', 'success', paidAt);
  insertOrder.run('pending', 'pending', 'stripe', 5000, 0, 5000, 0, 0, 'usd', item);
  insertOrder.run('eur', 'paid', 'stripe', 900, 0, 900, 0, 0, 'eur', item);
  insertPayment.run('eur', 'success', paidAt);
  const result = await fetchCommerceOverview(d1, 7, '/admin', 'products', now);
  const usd = result.currencies.find(row => row.currency === 'usd');
  assert.equal(usd.orders, 3);
  assert.equal(usd.grossSales, 4100);
  assert.equal(usd.netSales, 2800);
  assert.equal(usd.refunds, 1300);
  assert.equal(result.currencies.find(row => row.currency === 'eur').netSales, 900);
  assert.equal(result.products.find(row => row.currency === 'usd').units, 3);
  assert.equal(result.products.find(row => row.currency === 'usd').editHref, '/admin/commerce/products/p1');
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
    label: 'Previous month', start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z',
  });
  assert.deepEqual(precedingWindow(reportWindow('last_month', new Date('2026-04-15T12:00:00Z')), 'last_month'), {
    label: 'Previous month', start: '2026-02-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z',
  });
});

test('generated sales report uses confirmed aggregate orders and no customer records', async () => {
  const { sqlite, d1 } = sqliteD1();
  sqlite.prepare(`INSERT INTO _ecommerce_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'paid', 'paid', 'stripe', 2400, 0, 2400, 0, 0, 'usd', JSON.stringify([{ productId: 'p1', quantity: 2, priceAtPurchase: 1200 }])
  );
  sqlite.prepare('INSERT INTO _ecommerce_payments VALUES (?, ?, ?)').run('paid', 'success', paidAt);
  const ai = { async run() { return { response: { subject: 'sales', period: 'last_7_days', compare: false } }; } };
  const result = await createAskReport('How are sales doing this week?', ai, d1, {}, '/admin', 'products', now);
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
