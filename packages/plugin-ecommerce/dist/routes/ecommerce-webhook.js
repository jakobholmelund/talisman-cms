import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-M4D42HVD.js";
import "../chunk-DR67UJVQ.js";
import {
  bindCommerceApi
} from "../chunk-35CXWIDR.js";
import "../chunk-NXQCYUOX.js";
import "../chunk-PD7I5B62.js";
import "../chunk-IT7W6TQQ.js";
import "../chunk-BGDJXEM5.js";
import "../chunk-J7AA22HC.js";
import {
  WebhookRetryLaterError,
  WebhookSignatureError
} from "../chunk-6OI6C5UV.js";
import "../chunk-GB3RDLKI.js";
import "../chunk-GNU6N22K.js";
import "../chunk-WPNOY6AW.js";
import "../chunk-7BTUQQDZ.js";
import "../chunk-KLQ2VU7R.js";
import "../chunk-NQUBOBQT.js";
import "../chunk-QVPX4QWC.js";
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
