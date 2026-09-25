// src/cookies.ts
var CART_SESSION_COOKIE = "talisman-cart";
var CART_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
var GIFT_CARD_ACCESS_COOKIE_PREFIX = "talisman-gift-";
var LEGACY_CART_SESSION_COOKIE = "galaxy-cart";
var LEGACY_GIFT_CARD_ACCESS_COOKIE_PREFIX = "galaxy-gift-";
function giftCardAccessCookie(purchaseId) {
  return `${GIFT_CARD_ACCESS_COOKIE_PREFIX}${purchaseId}`;
}
function legacyGiftCardAccessCookie(purchaseId) {
  return `${LEGACY_GIFT_CARD_ACCESS_COOKIE_PREFIX}${purchaseId}`;
}
function readCartSessionToken(cookies) {
  return cookies.get(CART_SESSION_COOKIE)?.value || cookies.get(LEGACY_CART_SESSION_COOKIE)?.value || void 0;
}
function readGiftCardAccessToken(cookies, purchaseId) {
  if (!purchaseId) return void 0;
  return cookies.get(giftCardAccessCookie(purchaseId))?.value || cookies.get(legacyGiftCardAccessCookie(purchaseId))?.value || void 0;
}
function ensureCartSession(cookies, secure) {
  const current = cookies.get(CART_SESSION_COOKIE)?.value;
  const legacy = cookies.get(LEGACY_CART_SESSION_COOKIE)?.value;
  if (legacy !== void 0) cookies.delete(LEGACY_CART_SESSION_COOKIE, { path: "/" });
  if (current) return current;
  const sessionToken = legacy || `anon_${crypto.randomUUID()}`;
  cookies.set(CART_SESSION_COOKIE, sessionToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: CART_SESSION_MAX_AGE
  });
  return sessionToken;
}

export {
  CART_SESSION_COOKIE,
  CART_SESSION_MAX_AGE,
  GIFT_CARD_ACCESS_COOKIE_PREFIX,
  LEGACY_CART_SESSION_COOKIE,
  LEGACY_GIFT_CARD_ACCESS_COOKIE_PREFIX,
  giftCardAccessCookie,
  legacyGiftCardAccessCookie,
  readCartSessionToken,
  readGiftCardAccessToken,
  ensureCartSession
};
