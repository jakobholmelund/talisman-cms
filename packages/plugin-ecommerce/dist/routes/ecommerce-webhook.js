import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-R7FZZLF2.js";
import "../chunk-C2SYF4CS.js";
import {
  bindCommerceApi
} from "../chunk-GDYU3454.js";
import "../chunk-HAO6IOX2.js";
import "../chunk-BGDJXEM5.js";
import "../chunk-63W5IYCB.js";
import "../chunk-3I33VHHD.js";
import "../chunk-2UYSCNNW.js";
import "../chunk-6773WH54.js";
import "../chunk-AASKNEFP.js";
import "../chunk-U2UUCKVF.js";

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
