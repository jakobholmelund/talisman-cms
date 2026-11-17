import { dispatchCartUpdated } from '@talisman-cms/plugin-ecommerce/browser';
import { formatMoney } from '@talisman-cms/plugin-ecommerce/money';

import type { CartItem } from './cart-types';
import { shippingOptionsFor } from '@talisman-cms/plugin-ecommerce/browser';
import type { ShippingRate } from '@talisman-cms/plugin-ecommerce/browser';

interface CartViewState {
  items: CartItem[];
  locked: boolean;
  /** The store currency; prices are in its minor units. */
  currency: string;
  pricingError?: string | null;
  delivery?: {rates:ShippingRate[];deliveryCountries:string[]|null;taxMode:string};
}

function money(amount: number, currency: string) {
  return formatMoney(Number(amount || 0), currency);
}

function matchesItem(candidate: CartItem, productId: string, variantId: string) {
  return candidate.productId === productId && (candidate.variantId || '') === variantId;
}

function getItemCount(items: CartItem[]) {
  return items.reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function getSubtotal(items: CartItem[]) {
  return items.reduce((total, item) => total + Number(item.lineTotal || 0), 0);
}

function readState(root: HTMLElement): CartViewState | null {
  const stateEl = root.querySelector<HTMLScriptElement>('[data-cart-state]');
  if (!stateEl?.textContent) return null;
  return JSON.parse(stateEl.textContent) as CartViewState;
}

function createItemArticle(item: CartItem, state: CartViewState, template: HTMLTemplateElement) {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const article = fragment.firstElementChild;
  if (!(article instanceof HTMLElement)) return null;

  const imageLink = article.querySelector<HTMLAnchorElement>('[data-cart-image-link]');
  article.querySelector('[role=group]')?.setAttribute('aria-label',`Quantity of ${item.productName}`);
  article.dataset.productId = item.productId; article.dataset.variantId = item.variantId || '';
  if (imageLink) imageLink.href = item.href;

  const image = article.querySelector<HTMLImageElement>('[data-cart-image]');
  const imageFallback = article.querySelector<HTMLElement>('[data-cart-image-fallback]');
  if (image) {
    image.src = item.imageUrl || '';
    image.alt = item.productName;
    image.hidden = !item.imageUrl;
  }
  if (imageFallback) imageFallback.hidden = Boolean(item.imageUrl);

  const nameLink = article.querySelector<HTMLAnchorElement>('[data-cart-name]');
  if (nameLink) {
    nameLink.href = item.href;
    nameLink.textContent = item.productName;
  }

  const variantEl = article.querySelector<HTMLElement>('[data-cart-variant]');
  if (variantEl) {
    variantEl.textContent = item.variantLabel || '';
    variantEl.hidden = !item.variantLabel;
  }

  const stockEl = article.querySelector<HTMLElement>('[data-cart-stock]');
  if (stockEl) { stockEl.textContent = item.stockLabel; stockEl.dataset.unavailable = String(Boolean(item.unavailable)); }

  const lineTotalEl = article.querySelector<HTMLElement>('[data-cart-line-total]');
  if (lineTotalEl) lineTotalEl.textContent = money(item.lineTotal, state.currency);

  const quantityEl = article.querySelector<HTMLElement>('[data-cart-quantity]');
  if (quantityEl) { (quantityEl as HTMLInputElement).value = String(item.quantity); quantityEl.dataset.productId = item.productId; quantityEl.dataset.variantId = item.variantId || ''; quantityEl.setAttribute('aria-label', `Quantity of ${item.productName}${item.variantLabel ? `, ${item.variantLabel}` : ''}`); (quantityEl as HTMLInputElement).disabled = state.locked; }

  const unitPriceEl = article.querySelector<HTMLElement>('[data-cart-unit-price]');
  if (unitPriceEl) unitPriceEl.textContent = `${money(item.unitPrice, state.currency)} each`;

  for (const button of article.querySelectorAll<HTMLButtonElement>('[data-cart-action]')) {
    button.dataset.productId = item.productId;
    button.dataset.variantId = item.variantId || '';
    const action = button.dataset.cartAction;
    button.setAttribute('aria-label', action === 'remove' ? `Remove ${item.productName} from cart`
      : `${action === 'increment' ? 'Increase' : 'Decrease'} quantity of ${item.productName}`);
    button.disabled = state.locked || (action === 'decrement' && item.quantity <= 1) || (action === 'increment' && (item.quantity >= 99 || item.unavailable || (item.availableQuantity != null && item.quantity >= item.availableQuantity)));
  }

  return article;
}

function renderCart(root: HTMLElement, state: CartViewState) {
  const active = document.activeElement instanceof HTMLElement && root.contains?.(document.activeElement) ? document.activeElement : null;
  const focus = active?.closest<HTMLElement>('[data-cart-item]');
  const focusedAction = active?.dataset.cartAction;
  const focusedQuantity = active?.hasAttribute('data-cart-quantity');
  const emptyStateEl = root.querySelector<HTMLElement>('[data-cart-empty-state]');
  const contentEl = root.querySelector<HTMLElement>('[data-cart-content]');
  const listEl = root.querySelector<HTMLElement>('[data-cart-items-list]');
  const templateEl = root.querySelector<HTMLTemplateElement>('[data-cart-item-template]');
  const summaryCountEl = root.querySelector<HTMLElement>('[data-cart-summary-count]');
  const summaryShippingEl = root.querySelector<HTMLElement>('[data-cart-summary-shipping]');
  const summarySubtotalEl = root.querySelector<HTMLElement>('[data-cart-summary-subtotal]');

  const checkout = root.querySelector<HTMLAnchorElement>('[data-cart-checkout]');
  if (checkout) {
    checkout.classList.toggle('pointer-events-none', state.locked || Boolean(state.pricingError));
    checkout.setAttribute('aria-disabled', String(state.locked || Boolean(state.pricingError)));
  }
  const itemCount = getItemCount(state.items);
  const subtotal = getSubtotal(state.items);
  const requiresShipping = state.items.some((item) => item.isPhysical ?? item.type !== 'digital');

  if (emptyStateEl) emptyStateEl.hidden = itemCount > 0;
  if (contentEl) contentEl.hidden = itemCount === 0;
  if (summaryCountEl) summaryCountEl.textContent = String(itemCount);
  if (summaryShippingEl) summaryShippingEl.textContent = requiresShipping ? 'Calculated at checkout' : 'Not required';
  if (summarySubtotalEl) summarySubtotalEl.textContent = money(subtotal, state.currency);

  updateDelivery(root, state);
  if (!listEl || !templateEl) return;
  listEl.replaceChildren(
    ...state.items
      .map((item) => createItemArticle(item, state, templateEl))
      .filter(Boolean) as HTMLElement[]
  );
  if (focus) {
    const row = Array.from(listEl.querySelectorAll<HTMLElement>('[data-cart-item]')).find(row => row.dataset.productId === focus.dataset.productId && row.dataset.variantId === focus.dataset.variantId);
    const control = row && (focusedQuantity ? row.querySelector<HTMLElement>('[data-cart-quantity]') : Array.from(row.querySelectorAll<HTMLElement>('[data-cart-action]')).find(button => button.dataset.cartAction === focusedAction));
    if (control) ((control as HTMLButtonElement).disabled ? row?.querySelector<HTMLElement>('[data-cart-quantity]') : control)?.focus({preventScroll:true});
    else root.querySelector<HTMLElement>('[data-cart-feedback]')?.focus({preventScroll:true});
  }
}

function updateDelivery(root: HTMLElement, state: CartViewState) {
  const physical = state.items.some(item => item.isPhysical ?? item.type !== 'digital');
  const section = root.querySelector<HTMLElement>('[data-cart-delivery]'); if (section) section.hidden = !physical;
  const subtotal = getSubtotal(state.items);
  const total = root.querySelector<HTMLElement>('[data-cart-estimated-total]');
  const note = root.querySelector<HTMLElement>('[data-cart-estimate-note]');
  if (total) total.textContent = money(subtotal, state.currency);
  if (!state.delivery) return;
  const country = root.querySelector<HTMLElement & {value:string}>('[data-cart-country]')?.value || '';
  const rates = shippingOptionsFor({shippingRates:state.delivery.rates,deliveryCountries:state.delivery.deliveryCountries}, country, subtotal);
  const rate = [...rates].sort((a,b) => a.amount - b.amount)[0];
  const known = !physical || !state.delivery.rates.length || Boolean(rate);
  const shipping = physical && rate ? rate.amount : 0;
  const summary = root.querySelector<HTMLElement>('[data-cart-summary-shipping]');
  if (summary) summary.textContent = !physical ? 'Not required' : known ? shipping ? `From ${money(shipping,state.currency)}` : 'Free' : country ? 'Unavailable' : 'Choose a country';
  if (total) total.textContent = money(subtotal + shipping,state.currency);
  if (note) note.textContent = [!known ? 'Delivery is not included yet.' : 'Includes estimated delivery.', state.delivery.taxMode === 'stripe-exclusive' ? 'Tax is calculated before payment.' : state.delivery.taxMode === 'stripe-inclusive' ? 'Tax is included in prices.' : 'No additional tax.', 'Codes are confirmed at checkout.'].join(' ');
  const estimate = root.querySelector<HTMLElement>('[data-cart-delivery-estimate]');
  if (estimate) estimate.textContent = rate ? [rate.label, rate.description].filter(Boolean).join(' · ') : !state.delivery.rates.length ? 'No delivery charge for this order.' : country ? 'Delivery is unavailable for this destination.' : 'Choose a destination to estimate delivery.';
  const progress = root.querySelector<HTMLElement>('[data-cart-free-delivery]');
  if (progress) {
    const free = rates.filter(rate => rate.freeOver !== null).sort((a,b) => a.freeOver! - b.freeOver!)[0];
    progress.hidden = !free;
    if (free) progress.textContent = subtotal >= free.freeOver! ? `${free.label} is free for this basket, before discounts.` : `Add ${money(free.freeOver! - subtotal,state.currency)} for free ${free.label.toLowerCase()} to this destination. Discounts may affect eligibility.`;
  }
}

async function syncCart(items: CartItem[]) {
  const response = await fetch('/api/ecommerce/cart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId || undefined,
        quantity: item.quantity,
      })),
    }),
  });

  const payload = await response.json().catch(() => null) as (Partial<CartResponse> & { error?: unknown }) | null;
  if (!response.ok || !Array.isArray(payload?.items)) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Failed to update cart');
  return payload as CartResponse;
}

type CartResponse = { items: Array<{ productId: string; variantId?: string; quantity: number }>; locked?: boolean;
  pricingError?: string | null; quote?: { currency: string; lines: Array<{ productId: string; variantId?: string;
    unitAmount: number; lineTotal: number }> } | null };

/** Every intent is computed from the last server result, so rapid clicks never race or roll back a later save. */
export function createCartUpdateQueue(state: CartViewState, save: (items: CartItem[]) => Promise<CartResponse>,
  render: () => void, feedback: (message: string) => void, refresh?: () => Promise<CartResponse>) {
  let tail = Promise.resolve();
  const known = new Map(state.items.map(item => [item.key, item]));
  const adopt = (payload: CartResponse) => {
    const old = state.items;
    state.items = payload.items.map(line => {
      const previous = old.find(item => matchesItem(item, line.productId, line.variantId || '')) ?? [...known.values()].find(item => matchesItem(item, line.productId, line.variantId || ''));
      if (!previous) throw new Error('Basket changed in another window. Reload the page.');
      const price = payload.quote?.lines.find(item => item.productId === line.productId && (item.variantId || '') === (line.variantId || ''));
      return { ...previous, ...line, unitPrice: price?.unitAmount ?? previous.unitPrice,
        lineTotal: price?.lineTotal ?? previous.unitPrice * line.quantity };
    });
    state.locked = Boolean(payload.locked);
    state.pricingError = payload.pricingError;
    if (payload.quote) state.currency = payload.quote.currency;
    render(); dispatchCartUpdated({ itemCount: getItemCount(state.items) });
  };
  return (action: string, productId: string, variantId = '', value?: number) => {
    tail = tail.then(async () => {
      if (state.locked) return;
      if ((action === 'quantity' || action === 'restore') && (!Number.isSafeInteger(value) || value! < 1 || value! > 99)) { feedback('Choose a quantity between 1 and 99.'); render(); return; }
      const items = state.items.flatMap(item => {
        if (!matchesItem(item, productId, variantId)) return [item];
        const quantity = action === 'remove' ? 0 : action === 'quantity' ? value! : action === 'restore' ? item.quantity : Math.max(1, item.quantity + (action === 'increment' ? 1 : -1));
        return quantity > 0 ? [{ ...item, quantity, lineTotal: item.unitPrice * quantity }] : [];
      });
      if (action === 'restore' && !items.some(item => matchesItem(item,productId,variantId))) {
        const previous = [...known.values()].find(item => matchesItem(item,productId,variantId));
        if (previous) items.push({...previous,quantity:value || previous.quantity});
      }
      if (items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) { feedback('Choose a quantity between 1 and 99.'); render(); return; }
      feedback('Updating cart...');
      try {
        adopt(await save(items));
        feedback(state.pricingError || `Cart updated. ${getItemCount(state.items)} items in cart.`);
      } catch (error) {
        // A lost reply may have committed: reload before computing the next intent.
        if (refresh) { try { adopt(await refresh()); } catch { state.locked = true; render(); } }
        feedback(error instanceof Error ? error.message : 'Failed to update cart');
      }
    });
    return tail;
  };
}

function initCartRoot(root: HTMLElement) {
  if (root.dataset.cartBound) return;
  const parsed = readState(root); if (!parsed) return;
  const state: CartViewState = parsed;
  const country=root.querySelector<HTMLElement & {value:string;options:HTMLOptionElement[]}>('[data-cart-country]');
  try {const saved=sessionStorage.getItem('talisman:delivery-country');if(country&&saved&&Array.from(country.options).some(option=>option.value===saved))country.value=saved;}catch{/* Storage is optional. */}
  root.dataset.cartBound = 'true';
  const feedback = root.querySelector<HTMLElement>('[data-cart-feedback]');
  const undo = root.querySelector<HTMLButtonElement>('[data-cart-undo]');
  let removed: CartItem | null = null;
  let pending = 0;
  const setBusy = () => {
    root.setAttribute('aria-busy', String(pending > 0));
    root.querySelector('[data-cart-checkout]')?.setAttribute('aria-disabled', String(pending > 0 || state.locked || Boolean(state.pricingError)));
    if (undo) undo.disabled = pending > 0 || state.locked;
    const reload = root.querySelector<HTMLElement>('[data-cart-reload]'); if (reload) reload.hidden = !state.locked;
  };
  const announce = (message: string) => { if (feedback) { feedback.textContent = message; feedback.setAttribute('role', /could not|failed|unavailable|changed|choose/i.test(message) ? 'alert' : 'status'); } };
  const render = () => { renderCart(root,state); setBusy(); };
  render();
  root.querySelector('[data-cart-country]')?.addEventListener('change', () => {try{sessionStorage.setItem('talisman:delivery-country',country?.value||'');}catch{}updateDelivery(root,state);});
  root.querySelector('[data-cart-checkout]')?.addEventListener('click', event => { if (pending || state.locked || state.pricingError) { event.preventDefault(); announce(pending ? 'Your cart is updating. Please wait a moment.' : state.pricingError || 'Check your active checkout before continuing.'); feedback?.focus(); } });
  if (state.locked) return;
  const enqueue = createCartUpdateQueue(state, syncCart, render, announce, async () => {
    const response = await fetch('/api/ecommerce/cart');
    if (!response.ok) throw new Error('Basket could not be refreshed');
    return response.json();
  });
  async function update(action:string,productId:string,variantId='',quantity?:number) {
    const before = state.items.find(item => matchesItem(item,productId,variantId));
    pending++; setBusy();
    try {
      await enqueue(action,productId,variantId,quantity);
      if (action === 'remove' && before && !state.items.some(item => matchesItem(item,productId,variantId))) {
        removed = {...before}; if (undo) undo.hidden = false;
        announce(`${before.productName} removed from your cart.`);
      }
      if (action === 'restore' && state.items.some(item => matchesItem(item,productId,variantId))) { removed=null; if (undo) undo.hidden=true; announce('Item restored to your cart.'); }
    } finally { pending--; setBusy(); }
  }
  root.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-cart-action]') : null;
    if (!button || !['remove','increment','decrement'].includes(button.dataset.cartAction || '')) return;
    await update(button.dataset.cartAction || '',button.dataset.productId || '',button.dataset.variantId || '');
  });
  root.addEventListener('change', event => {
    const input = event.target instanceof HTMLElement && event.target.hasAttribute('data-cart-quantity') ? event.target as HTMLInputElement : null;
    if (!input) return;
    if (!input.checkValidity() || !input.value) { input.reportValidity(); render(); return; }
    void update('quantity',input.dataset.productId || '',input.dataset.variantId || '',Number(input.value));
  });
  undo?.addEventListener('click', () => { if (removed && !pending) void update('restore',removed.productId,removed.variantId || '',removed.quantity); });
}

export function initCartView() { for (const root of document.querySelectorAll<HTMLElement>('[data-cart-root]')) initCartRoot(root); }
document.addEventListener?.('astro:page-load', initCartView);
initCartView();
