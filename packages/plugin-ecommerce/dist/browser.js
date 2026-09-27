// src/browser.ts
var CART_UPDATED_EVENT = "talisman:cart-updated";
function dispatchCartUpdated(detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CART_UPDATED_EVENT, {
    detail
  }));
}
async function commerceRequest(path, method, body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === void 0 ? void 0 : { "Content-Type": "application/json" },
    body: body === void 0 ? void 0 : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Commerce request failed");
  return result;
}
function getCustomerAccount() {
  return commerceRequest("/api/ecommerce/account", "GET");
}
function activateNewCustomerAccount(orderId) {
  return commerceRequest("/api/ecommerce/account", "POST", { orderId });
}
function requestCustomerEmailSignIn(email, options = {}) {
  return commerceRequest(
    "/api/ecommerce/account",
    "POST",
    options.turnstileToken === void 0 ? { email } : { email, turnstileToken: options.turnstileToken }
  );
}
function readCustomerSignInToken(loc = typeof window === "undefined" ? void 0 : window.location, hist = typeof window === "undefined" ? void 0 : window.history) {
  if (!loc) return null;
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const query = new URLSearchParams(loc.search);
  const token = hash.get("token") || query.get("token");
  if (!token) return null;
  hash.delete("token");
  query.delete("token");
  const search = query.toString();
  const fragment = hash.toString();
  hist?.replaceState(hist.state, "", `${loc.pathname}${search ? `?${search}` : ""}${fragment ? `#${fragment}` : ""}`);
  return token;
}
function previewCustomerSignIn(token) {
  return commerceRequest("/api/ecommerce/account", "POST", { token, preview: true });
}
function verifyCustomerEmailSignIn(token) {
  return commerceRequest("/api/ecommerce/account", "POST", { token });
}
function readGiftCardClaimToken(loc = typeof window === "undefined" ? void 0 : window.location, hist = typeof window === "undefined" ? void 0 : window.history) {
  if (!loc) return null;
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const token = hash.get("token");
  if (!token) return null;
  hash.delete("token");
  const fragment = hash.toString();
  hist?.replaceState(hist.state, "", `${loc.pathname}${loc.search}${fragment ? `#${fragment}` : ""}`);
  return token;
}
async function claimGiftCardCode(token) {
  const failure = (message, status, retryable) => Object.assign(new Error(message), { status, retryable });
  let response;
  try {
    response = await fetch("/api/ecommerce/gift-cards", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "claim", token })
    });
  } catch {
    throw failure("The connection failed. Please try again.", 0, true);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw failure(
      result.error || "The gift card code could not be shown.",
      response.status,
      response.status === 429 || response.status >= 500
    );
  }
  if (typeof result.code !== "string") throw failure("The gift card code could not be shown.", response.status, false);
  return { code: result.code, balanceCents: result.balanceCents, currency: result.currency };
}
function signOutCustomerAccount() {
  return commerceRequest("/api/ecommerce/account", "DELETE");
}
function chooseCustomerBasket(choice) {
  return commerceRequest("/api/ecommerce/account", "POST", { basketChoice: choice });
}
function startCheckout(input = {}) {
  return commerceRequest("/api/ecommerce/checkout", "POST", input);
}
function startAdminTestCheckout(input = {}, options = {}) {
  const adminPath = (options.adminPath || "/admin").replace(/\/+$/, "");
  return commerceRequest(
    `${adminPath}/api/ecommerce/test-checkout`,
    "POST",
    input
  );
}
function getOrderStatus(orderId) {
  return commerceRequest(
    `/api/ecommerce/order?order=${encodeURIComponent(orderId)}`,
    "GET"
  );
}
function cancelCheckout(orderId) {
  return commerceRequest("/api/ecommerce/order", "POST", { orderId });
}
function installTalismanEcommerceBrowserHelpers(target = window) {
  target.TalismanEcommerce = {
    CART_UPDATED_EVENT,
    dispatchCartUpdated
  };
  return target.TalismanEcommerce;
}
export {
  CART_UPDATED_EVENT,
  activateNewCustomerAccount,
  cancelCheckout,
  chooseCustomerBasket,
  claimGiftCardCode,
  dispatchCartUpdated,
  getCustomerAccount,
  getOrderStatus,
  installTalismanEcommerceBrowserHelpers,
  previewCustomerSignIn,
  readCustomerSignInToken,
  readGiftCardClaimToken,
  requestCustomerEmailSignIn,
  signOutCustomerAccount,
  startAdminTestCheckout,
  startCheckout,
  verifyCustomerEmailSignIn
};
