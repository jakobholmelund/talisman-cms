import {
  bindCommerceApi
} from "../chunk-MS2V2E45.js";
import "../chunk-YKKPVPTL.js";
import "../chunk-BVMDOVSS.js";
import "../chunk-OGYT5JJJ.js";
import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-AVWDMCNG.js";
import "../chunk-IN4CG7W7.js";
import "../chunk-GFXT6MBK.js";
import {
  WebhookRetryLaterError,
  WebhookSignatureError
} from "../chunk-MBWSY2KP.js";
import "../chunk-IC3XDWQU.js";
import "../chunk-GNU6N22K.js";
import "../chunk-PMYARYOQ.js";
import "../chunk-SXQHVX4E.js";
import "../chunk-PLAJXKV3.js";
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
