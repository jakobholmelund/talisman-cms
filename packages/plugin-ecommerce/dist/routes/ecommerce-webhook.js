import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-CP2YO37X.js";
import "../chunk-6LYWG22B.js";
import {
  bindCommerceApi
} from "../chunk-GXIIVRLB.js";
import "../chunk-K2FMPEG6.js";
import "../chunk-5JBBAHBQ.js";
import "../chunk-AGAY2N6E.js";
import "../chunk-4DBNSZO2.js";
import "../chunk-6RT3KMIV.js";

// src/routes/ecommerce-webhook.ts
var POST = async ({ request }) => {
  try {
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    const payload = await request.text();
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    const { secretKey: stripeSecretKey, webhookSecret: stripeWebhookSecret } = runtimeStripeSecrets(runtimeEnv);
    if (!stripeSecretKey || !stripeWebhookSecret) {
      return new Response(JSON.stringify({ error: "Stripe is not configured" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    const api = bindCommerceApi({
      env: runtimeEnv,
      paymentAdapters: runtimePaymentAdapters(runtimeEnv)
    });
    const result = await api.webhooks.handleStripe(payload, signature, stripeWebhookSecret);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
};
export {
  POST
};
