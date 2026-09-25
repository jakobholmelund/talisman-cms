export const CART_UPDATED_EVENT = 'talisman:cart-updated';

export interface CartUpdatedDetail {
  itemCount: number;
}

export interface TalismanEcommerceBrowserHelpers {
  CART_UPDATED_EVENT: typeof CART_UPDATED_EVENT;
  dispatchCartUpdated: (detail: CartUpdatedDetail) => void;
}

declare global {
  interface Window {
    TalismanEcommerce?: TalismanEcommerceBrowserHelpers;
  }
}

export function dispatchCartUpdated(detail: CartUpdatedDetail) {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent<CartUpdatedDetail>(CART_UPDATED_EVENT, {
    detail,
  }));
}

async function commerceRequest<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Commerce request failed');
  return result;
}

export interface CustomerAccountSummary {
  id: string;
  email: string;
  name: string | null;
}

export function getCustomerAccount() {
  return commerceRequest<{ account: CustomerAccountSummary | null }>('/api/ecommerce/account', 'GET');
}

/** Deprecated: checkout alone cannot verify account ownership. */
export function activateNewCustomerAccount(orderId: string) {
  return commerceRequest<{ account: CustomerAccountSummary }>('/api/ecommerce/account', 'POST', { orderId });
}

export function requestCustomerEmailSignIn(email: string) {
  return commerceRequest<{ accepted: true }>('/api/ecommerce/account', 'POST', { email });
}

export function verifyCustomerEmailSignIn(token: string) {
  return commerceRequest<{ account: CustomerAccountSummary }>('/api/ecommerce/account', 'POST', { token });
}

export function signOutCustomerAccount() {
  return commerceRequest<{ account: null }>('/api/ecommerce/account', 'DELETE');
}

export function chooseCustomerBasket(choice: 'browser' | 'account') {
  return commerceRequest<{ cart: { id: string } }>('/api/ecommerce/account', 'POST', { basketChoice: choice });
}

export function startCheckout(input: {
  customerEmail?: string;
  discountCode?: string;
  giftCardCode?: string;
  shippingAddress?: Record<string, string>;
  billingAddress?: Record<string, string>;
} = {}) {
  return commerceRequest<{ orderId: string; redirectUrl: string }>('/api/ecommerce/checkout', 'POST', input);
}

/** Available only to authenticated CMS administrators. Creates a simulated payment. */
export function startAdminTestCheckout(input: {
  customerEmail?: string;
  shippingAddress?: Record<string, string>;
  billingAddress?: Record<string, string>;
} = {}) {
  return commerceRequest<{ orderId: string; status: string; paymentProvider: 'admin_test'; redirectUrl: string }>(
    '/admin/api/ecommerce/test-checkout', 'POST', input);
}

export function getOrderStatus(orderId: string) {
  return commerceRequest<{ orderId: string; status: string; paymentProvider: string | null; accountCreatedByOrder: boolean; accountLinked: boolean; totalAmount: number; subtotalAmount: number; creditApplied: number; discountCode: string | null; discountAmount: number; giftCardApplied: number; giftCardRefundedCents: number; providerRefundedCents: number; currency: string }>(
    `/api/ecommerce/order?order=${encodeURIComponent(orderId)}`, 'GET');
}

export function cancelCheckout(orderId: string) {
  return commerceRequest<{ orderId: string; status: string }>('/api/ecommerce/order', 'POST', { orderId });
}

export function installTalismanEcommerceBrowserHelpers(target: Window = window) {
  target.TalismanEcommerce = {
    CART_UPDATED_EVENT,
    dispatchCartUpdated,
  };

  return target.TalismanEcommerce;
}
