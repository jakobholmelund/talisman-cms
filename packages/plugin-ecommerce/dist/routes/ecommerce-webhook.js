import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-M4D42HVD.js";
import "../chunk-DR67UJVQ.js";
import {
  bindCommerceApi
} from "../chunk-P3EGABPL.js";
import "../chunk-BSTJ7GJ6.js";
import "../chunk-7P5TCZDC.js";
import "../chunk-BGDJXEM5.js";
import "../chunk-5LOW7SRF.js";
import {
  WebhookRetryLaterError,
  WebhookSignatureError
} from "../chunk-EV6HVUHO.js";
import "../chunk-JHSJ3R6O.js";
import "../chunk-GNU6N22K.js";
import "../chunk-KGRQF4NN.js";
import "../chunk-FDE2IMK7.js";
import "../chunk-RVXM5XJ4.js";
import "../chunk-NQUBOBQT.js";
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
