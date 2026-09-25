/** Browser basket token, shared by the cart routes, actions, components and storefront pages. */
declare const CART_SESSION_COOKIE = "talisman-cart";
declare const CART_SESSION_MAX_AGE: number;
/** Gift card purchase access token; the full name is `talisman-gift-<purchase id>`. */
declare const GIFT_CARD_ACCESS_COOKIE_PREFIX = "talisman-gift-";
/** Names used before the Galaxy CMS rename. Only read, so existing baskets and purchases survive. */
declare const LEGACY_CART_SESSION_COOKIE = "galaxy-cart";
declare const LEGACY_GIFT_CARD_ACCESS_COOKIE_PREFIX = "galaxy-gift-";
declare function giftCardAccessCookie(purchaseId: string): string;
declare function legacyGiftCardAccessCookie(purchaseId: string): string;
/** The subset of Astro's cookie API these helpers use. */
interface CookieReader {
    get(name: string): {
        value: string;
    } | undefined;
}
interface CookieJar extends CookieReader {
    set(name: string, value: string, options: {
        path: string;
        httpOnly: boolean;
        sameSite: 'lax';
        secure: boolean;
        maxAge: number;
    }): void;
    delete(name: string, options: {
        path: string;
    }): void;
}
/** Read the basket token without writing, falling back to a cookie set before the rename. */
declare function readCartSessionToken(cookies: CookieReader): string | undefined;
declare function readGiftCardAccessToken(cookies: CookieReader, purchaseId: string | null | undefined): string | undefined;
/**
 * Return the browser's basket token, setting the cookie when it is missing.
 * A token found only under the legacy name is adopted; the legacy cookie is dropped either way.
 */
declare function ensureCartSession(cookies: CookieJar, secure: boolean): string;

export { CART_SESSION_COOKIE, CART_SESSION_MAX_AGE, type CookieJar, type CookieReader, GIFT_CARD_ACCESS_COOKIE_PREFIX, LEGACY_CART_SESSION_COOKIE, LEGACY_GIFT_CARD_ACCESS_COOKIE_PREFIX, ensureCartSession, giftCardAccessCookie, legacyGiftCardAccessCookie, readCartSessionToken, readGiftCardAccessToken };
