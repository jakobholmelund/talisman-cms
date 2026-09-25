import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-WXEFSKPU.js";
import "../chunk-FK3KKBW6.js";
import "../chunk-6LYWG22B.js";
import {
  bindCommerceApi
} from "../chunk-LVJ6XT5P.js";
import "../chunk-MPVZ6EEH.js";
import "../chunk-LHGIEHI6.js";
import "../chunk-JB5GG7SZ.js";
import "../chunk-53CI56PJ.js";
import "../chunk-XLYDGTBP.js";

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
