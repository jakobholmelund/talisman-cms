import {
  bindCommerceApi
} from "../chunk-NKRAW7IR.js";
import "../chunk-4OZ23J3X.js";
import "../chunk-BVMDOVSS.js";
import "../chunk-25X32EKO.js";
import {
  runtimePaymentAdapters,
  runtimeStripeSecrets
} from "../chunk-AVWDMCNG.js";
import "../chunk-IN4CG7W7.js";
import "../chunk-3RWEM2DK.js";
import "../chunk-YHTTKGNB.js";
import "../chunk-QVDRNSCF.js";
import {
  WebhookRetryLaterError,
  WebhookSignatureError
} from "../chunk-7CFKBAUU.js";
import "../chunk-LCILI57I.js";
import "../chunk-GNU6N22K.js";
import "../chunk-WHUJCCDD.js";
import "../chunk-3MXMGN5I.js";
import "../chunk-USNNZXV4.js";
import "../chunk-SXQHVX4E.js";
import "../chunk-PLAJXKV3.js";
import "../chunk-NQUBOBQT.js";
import "../chunk-XJTZUPZM.js";
import "../chunk-HNDRZISR.js";
import "../chunk-C66AEOTN.js";

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
