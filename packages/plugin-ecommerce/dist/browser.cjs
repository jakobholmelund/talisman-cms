"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/browser.ts
var browser_exports = {};
__export(browser_exports, {
  CART_UPDATED_EVENT: () => CART_UPDATED_EVENT,
  activateNewCustomerAccount: () => activateNewCustomerAccount,
  cancelCheckout: () => cancelCheckout,
  chooseCustomerBasket: () => chooseCustomerBasket,
  dispatchCartUpdated: () => dispatchCartUpdated,
  getCustomerAccount: () => getCustomerAccount,
  getOrderStatus: () => getOrderStatus,
  installTalismanEcommerceBrowserHelpers: () => installTalismanEcommerceBrowserHelpers,
  requestCustomerEmailSignIn: () => requestCustomerEmailSignIn,
  signOutCustomerAccount: () => signOutCustomerAccount,
  startAdminTestCheckout: () => startAdminTestCheckout,
  startCheckout: () => startCheckout,
  verifyCustomerEmailSignIn: () => verifyCustomerEmailSignIn
});
module.exports = __toCommonJS(browser_exports);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CART_UPDATED_EVENT,
  activateNewCustomerAccount,
  cancelCheckout,
  chooseCustomerBasket,
  dispatchCartUpdated,
  getCustomerAccount,
  getOrderStatus,
  installTalismanEcommerceBrowserHelpers,
  requestCustomerEmailSignIn,
  signOutCustomerAccount,
  startAdminTestCheckout,
  startCheckout,
  verifyCustomerEmailSignIn
});
