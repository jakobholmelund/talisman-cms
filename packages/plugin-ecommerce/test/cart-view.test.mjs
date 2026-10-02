import assert from 'node:assert/strict';
import { test } from 'node:test';

const needsTypeStripping = process.features.typescript ? false : 'Node type stripping is unavailable';

// cart-view.ts runs in the browser. These stand-ins give it just enough DOM to render a basket:
// each selector finds one lasting element, and each clone of the item template is a new article.
class FakeElement {
  dataset = {};
  textContent = '';
  classList = { toggle() {} };
  children = new Map();
  listeners = new Map();
  rendered = [];
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new FakeElement());
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  replaceChildren(...nodes) { this.rendered = nodes; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  closest() { return this; }
  setAttribute() {}
  get content() { return { cloneNode: () => ({ firstElementChild: new FakeElement() }) }; }
}

function cartRoot(state) {
  const root = new FakeElement();
  root.querySelector('[data-cart-state]').textContent = JSON.stringify(state);
  return root;
}

const shown = (major, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(major);
const poster = { key: 'poster:default', productId: 'poster', quantity: 2, productName: 'Poster', unitPrice: 1250,
  lineTotal: 2500, type: 'standard', stockLabel: '3 available', href: '/shop/poster' };

test('the cart view shows prices in the basket currency, scaled by its minor units', { skip: needsTypeStripping }, async () => {
  const saved = { document: globalThis.document, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, fetch: globalThis.fetch };
  let roots = [];
  Object.assign(globalThis, { document: { querySelectorAll: () => roots }, HTMLElement: FakeElement, Element: FakeElement });
  try {
    const { initCartView } = await import('../src/components/cart-view.ts');

    const yen = cartRoot({ items: [poster], locked: false, currency: 'jpy' });
    roots = [yen];
    initCartView();
    const [article] = yen.querySelector('[data-cart-items-list]').rendered;
    assert.equal(yen.querySelector('[data-cart-summary-subtotal]').textContent, shown(2500, 'JPY'));
    assert.equal(article.querySelector('[data-cart-line-total]').textContent, shown(2500, 'JPY'));
    assert.equal(article.querySelector('[data-cart-unit-price]').textContent, `${shown(1250, 'JPY')} each`);

    // A quantity change renders the basket again in its currency while it is saved.
    globalThis.fetch = async () => Response.json({ items: [{ productId: 'poster', quantity: 3 }] });
    const increment = new FakeElement();
    increment.dataset = { cartAction: 'increment', productId: 'poster', variantId: '' };
    await yen.listeners.get('click')({ target: increment });
    assert.equal(yen.querySelector('[data-cart-summary-subtotal]').textContent, shown(3750, 'JPY'));
    assert.equal(yen.querySelector('[data-cart-feedback]').textContent, 'Cart updated. 3 items in cart.');

    const dinar = cartRoot({ items: [{ ...poster, quantity: 1, lineTotal: 1250 }], locked: true, currency: 'kwd' });
    roots = [dinar];
    initCartView();
    assert.equal(dinar.querySelector('[data-cart-summary-subtotal]').textContent, shown(1.25, 'KWD'));
    assert.equal(dinar.querySelector('[data-cart-items-list]').rendered[0].querySelector('[data-cart-unit-price]').textContent,
      `${shown(1.25, 'KWD')} each`);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('rapid cart intents queue behind the server reply and render its authoritative quantities/prices', { skip: needsTypeStripping }, async () => {
  const saved = { document: globalThis.document, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element };
  Object.assign(globalThis, { document: { querySelectorAll: () => [] }, HTMLElement: FakeElement, Element: FakeElement });
  try {
    const { createCartUpdateQueue } = await import('../src/components/cart-view.ts');
    let complete; const held = new Promise(resolve => { complete = resolve; }); const sent = []; const rendered = [];
    const state = { items: [{ ...poster }], locked: false, currency: 'usd' };
    const queue = createCartUpdateQueue(state, async items => {
      sent.push(items.map(item => item.quantity));
      if (sent.length === 1) await held;
      return { items: [{ productId: 'poster', quantity: sent.length === 1 ? 4 : items[0].quantity }],
        quote: { currency: 'usd', lines: [{ productId: 'poster', unitAmount: 1500, lineTotal: 1500 * (sent.length === 1 ? 4 : items[0].quantity) }] } };
    }, () => rendered.push([state.items[0].quantity, state.items[0].lineTotal]), () => {});
    const first = queue('increment', 'poster'); const second = queue('increment', 'poster');
    await Promise.resolve(); assert.deepEqual(sent, [[3]], 'only one request is in flight');
    complete(); await Promise.all([first, second]);
    assert.deepEqual(sent, [[3], [5]], 'second intent starts from the authoritative quantity 4');
    assert.deepEqual(rendered, [[4,6000], [5,7500]]);
  } finally { Object.assign(globalThis, saved); }
});

test('a lost cart reply refreshes authoritative state before the next queued intent', { skip: needsTypeStripping }, async () => {
  const saved = { document: globalThis.document };
  globalThis.document = { querySelectorAll: () => [] };
  try {
    const { createCartUpdateQueue } = await import('../src/components/cart-view.ts');
    const state = { items: [{ ...poster }], locked: false, currency: 'usd' }; const sent = []; let refreshed = false;
    const queue = createCartUpdateQueue(state, async items => {
      sent.push(items[0].quantity); if (sent.length === 1) throw new Error('Reply lost');
      assert.ok(refreshed); return { items: [{ productId: 'poster', quantity: items[0].quantity }] };
    }, () => {}, () => {}, async () => { refreshed = true; return { items: [{ productId: 'poster', quantity: 3 }] }; });
    await Promise.all([queue('increment', 'poster'), queue('increment', 'poster')]);
    assert.deepEqual(sent, [3,4]); assert.equal(state.items[0].quantity, 4);
  } finally { Object.assign(globalThis, saved); }
});
