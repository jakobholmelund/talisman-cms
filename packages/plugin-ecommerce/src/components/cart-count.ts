import type { TalismanEnv } from 'talisman-cms/client';
import { bindCommerceApi } from '@talisman-cms/plugin-ecommerce/api';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '@talisman-cms/plugin-ecommerce/accounts';
import { readCartSessionToken, type CookieReader } from '@talisman-cms/plugin-ecommerce/cookies';

/**
 * Count the shopper's basket items for a render-only component. This never writes:
 * getOrCreate would insert carts and detach a signed-in shopper's basket on every page view.
 */
export async function readCartItemCount(env: TalismanEnv, cookies: CookieReader) {
  const sessionToken = readCartSessionToken(cookies);
  const customerToken = cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!sessionToken && !customerToken) return 0;

  const customer = await findCustomerSession(env, customerToken);
  const api = bindCommerceApi({ env });
  const guest = sessionToken ? await api.carts.find(sessionToken) : null;
  const owned = customer ? await api.carts.find(undefined, customer.id) : null;
  // Match the basket the cart route claims: browser items win, otherwise the account basket.
  const cart = guest?.items.length ? guest : owned ?? guest;
  return (cart?.items ?? []).reduce((total, item) => total + Number(item.quantity || 0), 0);
}
