import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-DQ2SJLJ6.js";
import "../chunk-6L7TQXAW.js";
import {
  bindCommerceApi
} from "../chunk-2LIQHRTV.js";
import "../chunk-IK22DR6W.js";
import "../chunk-GGFLTIUK.js";
import "../chunk-BGDJXEM5.js";
import "../chunk-BGS2NWOG.js";
import "../chunk-WP5KVMJI.js";
import {
  WebhookRetryLaterError,
  WebhookSignatureError
} from "../chunk-A7BNM2SK.js";
import "../chunk-HBUWVAQK.js";
import "../chunk-GNU6N22K.js";
import "../chunk-NKZQB4F4.js";
import "../chunk-SFZBZWCM.js";
import "../chunk-NMGICNSV.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-webhook.ts
var json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" }
});
var POST = async ({ request }) => {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return json({ error: "Missing stripe-signature header" }, 400);
  try {
    const payload = await request.text();
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    const { secretKey: stripeSecretKey, webhookSecret: stripeWebhookSecret } = runtimeStripeSecrets(runtimeEnv);
    const paymentAdapters = runtimePaymentAdapters(runtimeEnv);
    if (!stripeSecretKey || !stripeWebhookSecret || !paymentAdapters.length) {
      return json({ error: "Stripe is not configured" }, 400);
    }
    const api = bindCommerceApi({ env: runtimeEnv, paymentAdapters });
    return json(await api.webhooks.handleStripe(payload, signature, stripeWebhookSecret), 200);
  } catch (error) {
    if (error instanceof WebhookSignatureError) return json({ error: error.message }, 400);
    if (error instanceof WebhookRetryLaterError) return json({ error: error.message, retry: true }, 409);
    console.error("[commerce] Stripe webhook failed", error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error });
    return json({ error: "The event could not be processed; Stripe will retry it" }, 500);
  }
};
export {
  POST
};
