import {
  bindCommerceApi
} from "../chunk-JUC2XNS7.js";
import "../chunk-IK2LAKMW.js";
import "../chunk-MQQMY6EP.js";
import "../chunk-LVMYPANC.js";
import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-AVWDMCNG.js";
import "../chunk-IN4CG7W7.js";
import "../chunk-HYVPTDYO.js";
import {
  WebhookRetryLaterError,
  WebhookSignatureError
} from "../chunk-2QJ6LJ5B.js";
import "../chunk-TX6OICXZ.js";
import "../chunk-GNU6N22K.js";
import "../chunk-JTBD4QC4.js";
import "../chunk-4PHEXUQV.js";
import "../chunk-YT2QU5EG.js";
import "../chunk-NQUBOBQT.js";
import "../chunk-R2NISKMY.js";
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
