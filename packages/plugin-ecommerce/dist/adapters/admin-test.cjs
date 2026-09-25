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

// src/adapters/admin-test.ts
var admin_test_exports = {};
__export(admin_test_exports, {
  AdminTestPaymentAdapter: () => AdminTestPaymentAdapter
});
module.exports = __toCommonJS(admin_test_exports);
var AdminTestPaymentAdapter = class {
  providerId = "admin_test";
  reservesInventory = false;
  async createCheckoutSession(params) {
    return {
      providerSessionId: `admin_test:${params.orderId}`,
      url: params.successUrl
    };
  }
  async expireCheckoutSession() {
  }
  async getCheckoutSession() {
    return { status: "open", url: null };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AdminTestPaymentAdapter
});
