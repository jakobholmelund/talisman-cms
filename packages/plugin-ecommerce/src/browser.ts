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

/**
 * Asks for a sign-in link. Pass `turnstileToken` when the site configures a bot check (see
 * `shopperSignInBotCheck` in `@talisman-cms/plugin-ecommerce/accounts`); a missing or failed check is
 * refused with "The security check failed. Please try again." `limited: true` means today's general
 * sign-in email budget is spent: only existing customers still receive a link, and every address
 * gets this same answer.
 */
export function requestCustomerEmailSignIn(email: string, options: { turnstileToken?: string } = {}) {
  return commerceRequest<{ accepted: true; limited?: true }>('/api/ecommerce/account', 'POST',
    options.turnstileToken === undefined ? { email } : { email, turnstileToken: options.turnstileToken });
}

type SignInLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;
type SignInHistory = Pick<History, 'replaceState' | 'state'>;

/**
 * Reads the one-time token on the page a sign-in link opens, then removes it from the address bar.
 * Links carry it in the fragment (`/account/verify#token=...`), which browsers never send to the
 * server. `?token=` links sent before that change are still read. Returns null without a token.
 */
export function readCustomerSignInToken(
  loc: SignInLocation | undefined = typeof window === 'undefined' ? undefined : window.location,
  hist: SignInHistory | undefined = typeof window === 'undefined' ? undefined : window.history,
) {
  if (!loc) return null;
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const query = new URLSearchParams(loc.search);
  const token = hash.get('token') || query.get('token');
  if (!token) return null;
  hash.delete('token');
  query.delete('token');
  const search = query.toString();
  const fragment = hash.toString();
  hist?.replaceState(hist.state, '', `${loc.pathname}${search ? `?${search}` : ''}${fragment ? `#${fragment}` : ''}`);
  return token;
}

/**
 * The address a sign-in link belongs to, masked as `{ email: 'j•••@example.com' }`, so the verify page
 * can show which account the shopper is about to open. The link stays usable and no session is
 * created. Rejects with "This sign-in link is invalid or has expired." for a used or expired link.
 */
export function previewCustomerSignIn(token: string) {
  return commerceRequest<{ email: string }>('/api/ecommerce/account', 'POST', { token, preview: true });
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

/**
 * Available only to authenticated CMS administrators, and only when the site registers
 * ecommercePlugin({ adminTestCheckout: true }). Creates a simulated payment.
 * Pass `adminPath` when talismanCms({ adminPath }) is not `/admin`.
 */
export function startAdminTestCheckout(input: {
  customerEmail?: string;
  shippingAddress?: Record<string, string>;
  billingAddress?: Record<string, string>;
} = {}, options: { adminPath?: string } = {}) {
  const adminPath = (options.adminPath || '/admin').replace(/\/+$/, '');
  return commerceRequest<{ orderId: string; status: string; paymentProvider: 'admin_test'; redirectUrl: string }>(
    `${adminPath}/api/ecommerce/test-checkout`, 'POST', input);
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
