import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTracker, validateEvent, safePagePath, parseConsent, CONSENT_KEY, CONSENT_LIFETIME_MS } from '../dist/tracking.js';
import { googleAnalytics, mapGA4Event, browserGA4Runtime } from '../dist/tracking-ga4.js';
import { initializeTracking, track } from '../dist/tracking-browser.js';

const product = { productId: 'frame-1', variantId: 'amber' };
const event = (name, properties) => ({ id: 'e-1', version: 1, timestamp: '2026-01-01T00:00:00Z', name, properties });
const adapter = (send = async () => ({ status: 'handed-off' })) => ({ name: 'test', send, disable() {} });

test('unknown/denied consent drops events, grant does not replay, and revocation stops dispatch', async () => {
  const received = []; let disabled = 0;
  const tracker = createTracker({ inspect: true, adapters: [{ name: 'test', send: async e => { received.push(e); return { status: 'handed-off' }; }, disable() { disabled++; } }] });
  await tracker.track('product_viewed', product);
  tracker.setConsent('denied'); await tracker.track('product_viewed', product);
  tracker.setConsent('granted'); assert.equal(received.length, 0);
  await tracker.track('product_viewed', product);
  tracker.setConsent('denied'); await tracker.track('product_viewed', product);
  assert.equal(received.length, 1); assert.equal(disabled, 2);
  assert.deepEqual(tracker.snapshot().map(r => r.status), ['blocked-consent', 'blocked-consent', 'handed-off', 'blocked-consent']);
});

test('schemas reject unknown fields and unsafe identifiers without retaining rejected input', async () => {
  const tracker = createTracker({ inspect: true, consent: 'granted', adapters: [adapter(() => assert.fail('invalid event sent'))] });
  for (const properties of [{ ...product, email: 'private@example.test' }, { productId: 'private@example.test' }, { productId: '<script>alert(1)</script>' }]) await tracker.track('product_viewed', properties);
  await tracker.track('unknown_private_event', { token: 'secret' });
  assert.ok(tracker.snapshot().every(r => r.status === 'invalid'));
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /private|secret|script/);
  assert.equal(validateEvent('basket_item_added', { ...product, quantity: NaN }), false);
  assert.equal(validateEvent('basket_item_added', { ...product, quantity: -1 }), false);
  assert.equal(validateEvent('checkout_started', { items: [{ ...product, quantity: 1 }], valueMinor: 100 }), false);
});

test('page paths omit queries/fragments and private destinations', async () => {
  for (const path of ['/account', '/account/verify#token=secret', '/admin/users', '/api/data', '/checkout/success?order=private', '/r/code', '/gift-cards/claim', '/someone@example.test', '//evil.test', 'https://evil.test']) assert.equal(safePagePath(path), null, path);
  const tracker = createTracker({ inspect: true });
  await tracker.track('page_viewed', { path: '/shop/frame?email=private#token' });
  assert.equal(tracker.snapshot()[0].properties.path, '/shop/frame');
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /email|token|private/);
});

test('inspector is opt-in, bounded, immutable to consumers, and clearable', async () => {
  const hidden = createTracker(); await hidden.track('product_viewed', product); assert.deepEqual(hidden.snapshot(), []);
  const tracker = createTracker({ inspect: true });
  for (let i = 0; i < 120; i++) await tracker.track('product_viewed', product);
  assert.equal(tracker.snapshot().length, 100);
  tracker.snapshot()[0].properties.productId = 'changed';
  assert.equal(tracker.snapshot()[0].properties.productId, 'frame-1');
  tracker.clear(); assert.equal(tracker.snapshot().length, 0);
});

test('adapter and inspector failures are isolated, with cancellation during pending delivery', async () => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const tracker = createTracker({ consent: 'granted', inspect: true, adapters: [adapter(async () => { await held; return { status: 'handed-off' }; }), { ...adapter(async () => { throw new Error('secret vendor error'); }), name: 'broken' }] });
  tracker.subscribe(() => { throw new Error('inspector failure'); });
  const pending = tracker.track('product_viewed', product);
  tracker.setConsent('denied'); finish(); await pending;
  assert.ok(tracker.snapshot().every(r => r.status === 'cancelled'));
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /secret vendor/);
  assert.throws(() => createTracker({ adapters: [adapter(), adapter()] }), /unique/);
});

test('GA4 uses quantity differences, transaction IDs and currency minor units', () => {
  const added = mapGA4Event(event('basket_quantity_changed', { ...product, quantity: 4, previousQuantity: 1 }));
  assert.equal(added.name, 'add_to_cart'); assert.equal(added.parameters.items[0].quantity, 3);
  assert.equal(mapGA4Event(event('basket_quantity_changed', { ...product, quantity: 0, previousQuantity: 1 })).name, 'remove_from_cart');
  assert.equal(mapGA4Event(event('basket_quantity_changed', { ...product, quantity: 1, previousQuantity: 1 })), null);
  for (const [currency, amount, expected] of [['USD', 1234, 12.34], ['JPY', 1234, 1234], ['KWD', 1234, 1.234], ['HUF', 1234, 12.34]]) {
    const p = mapGA4Event(event('purchase_confirmed', { transactionId: 'order-1', currency, valueMinor: amount, shippingMinor: 0, taxMinor: 0, items: [{ ...product, quantity: 1, unitAmountMinor: amount }] }));
    assert.equal(p.parameters.transaction_id, 'order-1'); assert.equal(p.parameters.value, expected);
    assert.equal(p.parameters.items[0].price, expected);
  }
  assert.equal(mapGA4Event(event('refund_completed', { transactionId: 'order-1', refundId: 'refund-1', currency: 'USD', valueMinor: 100, items: [{ ...product, quantity: 1 }] })).parameters.refund_id, 'refund-1');
});

function runtime(load = async () => {}) {
  const commands = []; const disabled = []; let clears = 0;
  return { commands, disabled, get clears() { return clears; }, origin: 'https://shop.test', hostname: 'shop.test',
    load, command(...args) { commands.push(args); }, setDisabled(value) { disabled.push(value); }, clearCookies() { clears++; } };
}

test('GA preview has no runtime effects; live adapter initializes once and sanitizes defaults', async () => {
  const r = runtime(() => assert.fail('preview requested Google'));
  const preview = createTracker({ consent: 'granted', inspect: true, adapters: [googleAnalytics({ measurementId: 'G-TEST1234', pagePath: '/shop', preview: true, runtime: r })] });
  await preview.track('product_viewed', product);
  assert.equal(preview.snapshot()[0].status, 'preview'); assert.equal(r.commands.length, 0);
  let loads = 0; const live = runtime(async () => { loads++; });
  const tracker = createTracker({ consent: 'granted', adapters: [googleAnalytics({ measurementId: 'G-TEST1234', pagePath: '/shop?email=private#token', runtime: live })] });
  await Promise.all([tracker.track('product_viewed', product), tracker.track('basket_item_added', { ...product, quantity: 1 })]);
  assert.equal(loads, 1);
  const config = live.commands.find(c => c[0] === 'config')[2];
  assert.equal(config.send_page_view, false); assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false); assert.equal(config.page_location, 'https://shop.test/shop');
  assert.equal(config.page_referrer, ''); assert.equal(config.cookie_update, false);
  assert.deepEqual(live.commands[0].slice(0, 2), ['consent', 'default']);
  assert.equal(live.commands[0][2].analytics_storage, 'denied');
  assert.equal(live.commands.filter(c => c[0] === 'event').length, 2);
  assert.doesNotMatch(JSON.stringify(live.commands), /private|token/);
  tracker.setConsent('denied'); assert.equal(live.disabled.at(-1), true); assert.equal(live.clears, 1);
});

test('withdrawal during Google initialization prevents the event; later consent can initialize again', async () => {
  const pending = [];
  const r = runtime(signal => new Promise((resolve, reject) => { pending.push(resolve); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }));
  const tracker = createTracker({ consent: 'granted', inspect: true, adapters: [googleAnalytics({ measurementId: 'G-TEST1234', pagePath: '/', runtime: r })] });
  const first = tracker.track('product_viewed', product);
  tracker.setConsent('denied'); await first;
  assert.equal(r.commands.filter(c => c[0] === 'event').length, 0);
  tracker.setConsent('granted'); const second = tracker.track('product_viewed', product);
  pending[1](); await second;
  assert.equal(r.commands.filter(c => c[0] === 'event').length, 1);
  assert.deepEqual(tracker.snapshot().map(r => r.status), ['cancelled', 'handed-off']);
});

test('failed tag initialization is reported and a later event can retry', async () => {
  let attempts = 0;
  const r = runtime(async () => { if (++attempts === 1) throw new Error('network'); });
  const tracker = createTracker({ consent: 'granted', inspect: true, adapters: [googleAnalytics({ measurementId: 'G-TEST1234', pagePath: '/', runtime: r })] });
  await tracker.track('product_viewed', product); await tracker.track('product_viewed', product);
  assert.deepEqual(tracker.snapshot().map(r => r.status), ['failed', 'handed-off']);
});

test('consent records are versioned, expiring and fail closed', () => {
  const now = Date.now();
  for (const raw of [null, '{invalid', '{}', JSON.stringify({ version: 1, state: 'granted', expiresAt: now - 1 }), JSON.stringify({ version: 2, state: 'granted', expiresAt: now + 1 }), JSON.stringify({ version: 1, state: 'granted', expiresAt: now + CONSENT_LIFETIME_MS + 1 })]) assert.equal(parseConsent(raw, now).state, 'unknown');
  assert.equal(parseConsent(JSON.stringify({ version: 1, state: 'granted', expiresAt: now + 1000 }), now).state, 'granted');
});

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  }
}

test('browser consent persists only after a choice and follows cross-tab withdrawal/expiry', async t => {
  const win = new EventTarget(); const storage = new Map(); let writes = 0; const received = [];
  globals(t, { window: win, localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); writes++; } } });
  const a = adapter(async e => { received.push(e); return { status: 'handed-off' }; });
  let browser = initializeTracking({ adapters: [a], pagePath: '/shop', inspect: true });
  assert.equal(writes, 0); assert.equal(received.length, 0);
  browser.choose('granted'); assert.equal(writes, 1); await Promise.resolve();
  assert.equal(received.length, 1); assert.equal(received[0].name, 'page_viewed');
  browser.dispose(); browser = initializeTracking({ adapters: [a], pagePath: '/shop' });
  assert.equal(browser.tracker.getConsent(), 'granted');
  const revoke = new Event('storage'); Object.assign(revoke, { key: CONSENT_KEY, newValue: JSON.stringify({ version: 1, state: 'denied', expiresAt: Date.now() + 1000 }) });
  win.dispatchEvent(revoke); assert.equal(browser.tracker.getConsent(), 'denied');
  const before = received.length; track('product_viewed', product); assert.equal(received.length, before);
  browser.choose('granted'); const now = Date.now(); t.mock.method(Date, 'now', () => now + CONSENT_LIFETIME_MS + 1);
  browser.refresh(); assert.equal(browser.tracker.getConsent(), 'unknown'); browser.dispose();
});

test('blocked storage still permits a page-only choice and starts unknown on the next initialization', t => {
  globals(t, { window: new EventTarget(), localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  let browser = initializeTracking({ adapters: [], pagePath: '/' });
  assert.equal(browser.tracker.getConsent(), 'unknown'); browser.choose('granted');
  assert.equal(browser.getStorageAvailable(), false); assert.equal(browser.tracker.getConsent(), 'granted');
  browser.dispose(); browser = initializeTracking({ adapters: [], pagePath: '/' });
  assert.equal(browser.tracker.getConsent(), 'unknown'); browser.dispose();
});

test('real browser transport creates only the expected script, cancels pending loads and clears only its cookies', async t => {
  let node; const cookies = [];
  const doc = { createElement: () => ({ remove() { this.removed = true; } }), head: { appendChild(value) { node = value; } },
    get cookie() { return 'talisman_ga=one; talisman_ga_TEST1234=two; talisman-cart=keep; _ga=other'; }, set cookie(value) { cookies.push(value); } };
  const win = { location: { origin: 'https://shop.test', hostname: 'shop.test' } };
  globals(t, { window: win, document: doc });
  const r = browserGA4Runtime('G-TEST1234'); const control = new AbortController();
  r.command('config', 'G-TEST1234', { send_page_view: false });
  const pending = r.load(control.signal);
  assert.match(node.src, /^https:\/\/www.googletagmanager.com\/gtag\/js\?id=G-TEST1234&l=talismanAnalytics_G_TEST1234$/);
  assert.equal(node.referrerPolicy, 'no-referrer');
  control.abort(); await assert.rejects(pending); assert.equal(node.removed, true);
  assert.equal(win['ga-disable-G-TEST1234'], true); assert.equal(win.talismanAnalytics_G_TEST1234.length, 0);
  r.clearCookies(); assert.equal(cookies.length, 6); assert.ok(cookies.every(c => c.startsWith('talisman_ga')));
});
