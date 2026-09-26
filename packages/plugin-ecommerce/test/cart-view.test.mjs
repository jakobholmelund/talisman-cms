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
    globalThis.fetch = async () => Response.json({ items: [{ quantity: 3 }] });
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
