/** Browser basket token, shared by the cart routes, actions, components and storefront pages. */
export const CART_SESSION_COOKIE = 'talisman-cart';
export const CART_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
/** Gift card purchase access token; the full name is `talisman-gift-<purchase id>`. */
export const GIFT_CARD_ACCESS_COOKIE_PREFIX = 'talisman-gift-';

/** Names used before the Galaxy CMS rename. Only read, so existing baskets and purchases survive. */
export const LEGACY_CART_SESSION_COOKIE = 'galaxy-cart';
export const LEGACY_GIFT_CARD_ACCESS_COOKIE_PREFIX = 'galaxy-gift-';

export function giftCardAccessCookie(purchaseId: string) {
  return `${GIFT_CARD_ACCESS_COOKIE_PREFIX}${purchaseId}`;
}

export function legacyGiftCardAccessCookie(purchaseId: string) {
  return `${LEGACY_GIFT_CARD_ACCESS_COOKIE_PREFIX}${purchaseId}`;
}

/** The subset of Astro's cookie API these helpers use. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export interface CookieJar extends CookieReader {
  set(name: string, value: string, options: {
    path: string; httpOnly: boolean; sameSite: 'lax'; secure: boolean; maxAge: number
  }): void;
  delete(name: string, options: { path: string }): void;
}

/** Read the basket token without writing, falling back to a cookie set before the rename. */
export function readCartSessionToken(cookies: CookieReader): string | undefined {
  return cookies.get(CART_SESSION_COOKIE)?.value || cookies.get(LEGACY_CART_SESSION_COOKIE)?.value || undefined;
}

export function readGiftCardAccessToken(cookies: CookieReader, purchaseId: string | null | undefined): string | undefined {
  if (!purchaseId) return undefined;
  return cookies.get(giftCardAccessCookie(purchaseId))?.value ||
    cookies.get(legacyGiftCardAccessCookie(purchaseId))?.value || undefined;
}

/**
 * Return the browser's basket token, setting the cookie when it is missing.
 * A token found only under the legacy name is adopted; the legacy cookie is dropped either way.
 */
export function ensureCartSession(cookies: CookieJar, secure: boolean): string {
  const current = cookies.get(CART_SESSION_COOKIE)?.value;
  const legacy = cookies.get(LEGACY_CART_SESSION_COOKIE)?.value;
  if (legacy !== undefined) cookies.delete(LEGACY_CART_SESSION_COOKIE, { path: '/' });
  if (current) return current;

  const sessionToken = legacy || `anon_${crypto.randomUUID()}`;
  cookies.set(CART_SESSION_COOKIE, sessionToken, {
    path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: CART_SESSION_MAX_AGE
  });
  return sessionToken;
}
