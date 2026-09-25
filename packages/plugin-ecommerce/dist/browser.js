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
function requestCustomerEmailSignIn(email) {
  return commerceRequest("/api/ecommerce/account", "POST", { email });
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
function verifyCustomerEmailSignIn(token) {
  return commerceRequest("/api/ecommerce/account", "POST", { token });
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
function startAdminTestCheckout(input = {}) {
  return commerceRequest(
    "/admin/api/ecommerce/test-checkout",
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
  dispatchCartUpdated,
  getCustomerAccount,
  getOrderStatus,
  installTalismanEcommerceBrowserHelpers,
  readCustomerSignInToken,
  requestCustomerEmailSignIn,
  signOutCustomerAccount,
  startAdminTestCheckout,
  startCheckout,
  verifyCustomerEmailSignIn
};
