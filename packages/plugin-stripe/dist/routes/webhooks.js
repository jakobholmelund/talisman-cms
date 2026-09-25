// src/routes/webhooks.ts
import Stripe from "stripe";
import { stripeConfig } from "virtual:talisman-cms/stripe-config";
var POST = async ({ request }) => {
  const config = stripeConfig;
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
  const stripe = new Stripe(stripeSecretKey, {
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
export {
  POST
};
