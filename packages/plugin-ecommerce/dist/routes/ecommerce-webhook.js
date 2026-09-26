import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-K47ZHGKG.js";
import "../chunk-YXG3523I.js";
import {
  bindCommerceApi
} from "../chunk-ZCEC33U7.js";
import "../chunk-BCWAVKQF.js";
import "../chunk-YXNRHYNN.js";
import "../chunk-2RLPKBNT.js";
import "../chunk-MS53KKKY.js";
import "../chunk-NITAPJVN.js";
import "../chunk-CLEUXV3O.js";

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
