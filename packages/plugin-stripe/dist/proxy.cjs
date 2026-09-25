"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/proxy.ts
var proxy_exports = {};
__export(proxy_exports, {
  stripeProxy: () => stripeProxy
});
module.exports = __toCommonJS(proxy_exports);
var import_stripe = __toESM(require("stripe"), 1);
var stripeProxy = async (args) => {
  const { stripeSecretKey, stripeMethod, stripeArgs = [] } = args;
  if (!stripeSecretKey) {
    throw new Error("Stripe secret key must be provided");
  }
  const stripe = new import_stripe.default(stripeSecretKey, {
    apiVersion: "2022-08-01",
    // Target recent version per docs, or user can override
    appInfo: {
      name: "Talisman CMS Stripe Plugin",
      version: "0.0.1"
    }
  });
  const methodParts = stripeMethod.split(".");
  let currentContext = stripe;
  let methodToCall = void 0;
  for (let i = 0; i < methodParts.length; i++) {
    const part = methodParts[i];
    if (part.startsWith("_")) {
      throw new Error(`Cannot access internal Stripe property: ${part}`);
    }
    if (i === methodParts.length - 1) {
      methodToCall = currentContext[part];
    } else {
      currentContext = currentContext[part];
    }
    if (!currentContext) {
      throw new Error(`Invalid Stripe method path: ${methodParts.slice(0, i + 1).join(".")}`);
    }
  }
  if (typeof methodToCall !== "function") {
    throw new Error(`The resolved Stripe property '${stripeMethod}' is not a function.`);
  }
  try {
    const result = await methodToCall.apply(currentContext, stripeArgs);
    return {
      status: 200,
      data: result
    };
  } catch (err) {
    return {
      status: err.statusCode || 500,
      message: err.message,
      type: err.type,
      code: err.code
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  stripeProxy
});
