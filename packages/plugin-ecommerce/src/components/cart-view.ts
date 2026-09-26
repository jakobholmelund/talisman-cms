import { dispatchCartUpdated } from '@talisman-cms/plugin-ecommerce/browser';
import { formatMoney } from '@talisman-cms/plugin-ecommerce/money';

interface CartItem {
  key: string;
  productId: string;
  variantId?: string | null;
  quantity: number;
  productName: string;
  variantLabel?: string | null;
  imageUrl?: string | null;
  unitPrice: number;
  lineTotal: number;
  type: string;
  stockLabel: string;
  href: string;
}

interface CartViewState {
  items: CartItem[];
  locked: boolean;
  /** The store currency; prices are in its minor units. */
  currency: string;
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
  if (imageLink) imageLink.href = item.href;

  const image = article.querySelector<HTMLImageElement>('[data-cart-image]');
  const imageFallback = article.querySelector<HTMLElement>('[data-cart-image-fallback]');
  if (image) {
    image.src = item.imageUrl || '';
    image.alt = item.productName;
    image.classList.toggle('hidden', !item.imageUrl);
  }
  imageFallback?.classList.toggle('hidden', Boolean(item.imageUrl));

  const nameLink = article.querySelector<HTMLAnchorElement>('[data-cart-name]');
  if (nameLink) {
    nameLink.href = item.href;
    nameLink.textContent = item.productName;
  }

  const variantEl = article.querySelector<HTMLElement>('[data-cart-variant]');
  if (variantEl) {
    variantEl.textContent = item.variantLabel || '';
    variantEl.classList.toggle('hidden', !item.variantLabel);
  }

  const stockEl = article.querySelector<HTMLElement>('[data-cart-stock]');
  if (stockEl) stockEl.textContent = item.stockLabel;

  const lineTotalEl = article.querySelector<HTMLElement>('[data-cart-line-total]');
  if (lineTotalEl) lineTotalEl.textContent = money(item.lineTotal, state.currency);

  const quantityEl = article.querySelector<HTMLElement>('[data-cart-quantity]');
  if (quantityEl) quantityEl.textContent = String(item.quantity);

  const unitPriceEl = article.querySelector<HTMLElement>('[data-cart-unit-price]');
  if (unitPriceEl) unitPriceEl.textContent = `${money(item.unitPrice, state.currency)} each`;

  for (const button of article.querySelectorAll<HTMLButtonElement>('[data-cart-action]')) {
    button.dataset.productId = item.productId;
    button.dataset.variantId = item.variantId || '';
    button.disabled = state.locked;
  }

  return article;
}

function renderCart(root: HTMLElement, state: CartViewState) {
  const emptyStateEl = root.querySelector<HTMLElement>('[data-cart-empty-state]');
  const contentEl = root.querySelector<HTMLElement>('[data-cart-content]');
  const listEl = root.querySelector<HTMLElement>('[data-cart-items-list]');
  const templateEl = root.querySelector<HTMLTemplateElement>('[data-cart-item-template]');
  const summaryCountEl = root.querySelector<HTMLElement>('[data-cart-summary-count]');
  const summaryShippingEl = root.querySelector<HTMLElement>('[data-cart-summary-shipping]');
  const summarySubtotalEl = root.querySelector<HTMLElement>('[data-cart-summary-subtotal]');

  const itemCount = getItemCount(state.items);
  const subtotal = getSubtotal(state.items);
  const requiresShipping = state.items.some((item) => item.type !== 'digital');

  emptyStateEl?.classList.toggle('hidden', itemCount > 0);
  contentEl?.classList.toggle('hidden', itemCount === 0);
  if (summaryCountEl) summaryCountEl.textContent = String(itemCount);
  if (summaryShippingEl) summaryShippingEl.textContent = requiresShipping ? 'Calculated at checkout' : 'Not required';
  if (summarySubtotalEl) summarySubtotalEl.textContent = money(subtotal, state.currency);

  if (!listEl || !templateEl) return;
  listEl.replaceChildren(
    ...state.items
      .map((item) => createItemArticle(item, state, templateEl))
      .filter(Boolean) as HTMLElement[]
  );
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

  const payload = (await response.json().catch(() => null)) as { error?: string; items?: { quantity?: number }[] } | null;
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to update cart');
  }

  const itemCount = Array.isArray(payload?.items)
    ? payload.items.reduce((total: number, item: { quantity?: number }) => total + Number(item.quantity || 0), 0)
    : 0;

  dispatchCartUpdated({ itemCount });
}

function initCartRoot(root: HTMLElement) {
  const state = readState(root);
  if (!state) return;

  const feedbackEl = root.querySelector<HTMLElement>('[data-cart-feedback]');
  renderCart(root, state);

  if (state.locked) return;

  root.addEventListener('click', async (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('[data-cart-action]')
      : null;
    if (!button) return;

    const action = button.dataset.cartAction || '';
    const productId = button.dataset.productId || '';
    const variantId = button.dataset.variantId || '';
    const previousItems = state.items.map((item) => ({ ...item }));

    if (action === 'remove') {
      state.items = state.items.filter((item) => !matchesItem(item, productId, variantId));
    } else if (action === 'increment' || action === 'decrement') {
      const delta = action === 'increment' ? 1 : -1;
      state.items = state.items
        .map((item) => matchesItem(item, productId, variantId)
          ? { ...item, quantity: item.quantity + delta, lineTotal: item.unitPrice * (item.quantity + delta) }
          : item)
        .filter((item) => item.quantity > 0);
    } else {
      return;
    }

    renderCart(root, state);

    try {
      if (feedbackEl) feedbackEl.textContent = 'Updating cart...';
      await syncCart(state.items);
      if (feedbackEl) {
        const itemCount = getItemCount(state.items);
        feedbackEl.textContent = itemCount > 0
          ? `Cart updated. ${itemCount} item${itemCount === 1 ? '' : 's'} in cart.`
          : 'Cart emptied.';
      }
    } catch (error) {
      state.items = previousItems;
      renderCart(root, state);
      if (feedbackEl) feedbackEl.textContent = error instanceof Error ? error.message : 'Failed to update cart';
    }
  });
}

export function initCartView() {
  for (const root of document.querySelectorAll<HTMLElement>('[data-cart-root]')) {
    initCartRoot(root);
  }
}

initCartView();
