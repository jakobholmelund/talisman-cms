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

// src/routes/webhooks.ts
var webhooks_exports = {};
__export(webhooks_exports, {
  POST: () => POST
});
module.exports = __toCommonJS(webhooks_exports);
var import_stripe = __toESM(require("stripe"), 1);
var import_stripe_config = require("virtual:talisman-cms/stripe-config");
var POST = async ({ request }) => {
  const config = import_stripe_config.stripeConfig;
  if (!config) {
    return new Response(JSON.stringify({ error: "Stripe plugin config not found in global scope" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  const { stripeSecretKey, stripeWebhooksEndpointSecret, webhooks, logs } = config;
  if (!stripeWebhooksEndpointSecret) {
    return new Response(JSON.stringify({ error: "Missing stripeWebhooksEndpointSecret configuration" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response(JSON.stringify({ error: "No stripe-signature header present" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
  const rawBody = await request.text();
  const stripe = new import_stripe.default(stripeSecretKey, {
    apiVersion: "2022-08-01"
  });
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      stripeWebhooksEndpointSecret
    );
  } catch (err) {
    if (logs) console.error(`\u26A0\uFE0F Webhook signature verification failed: ${err.message}`);
    return new Response(JSON.stringify({ error: `Webhook Error: ${err.message}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (logs) {
    console.log(`\u2705 Received Stripe webhook event: ${event.type}`);
  }
  if (webhooks) {
    try {
      if (typeof webhooks === "function") {
        await webhooks(event);
      } else if (typeof webhooks === "object") {
        const handler = webhooks[event.type];
        if (handler && typeof handler === "function") {
          await handler(event);
        }
      }
    } catch (err) {
      if (logs) console.error(`\u274C Webhook handler failed for event ${event.type}:`, err);
      return new Response(JSON.stringify({ error: "Webhook handler failed", message: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  POST
});
