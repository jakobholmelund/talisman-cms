import {
  AdminTestPaymentAdapter
} from "./chunk-FK3KKBW6.js";
import {
  StripePaymentAdapter
} from "./chunk-6LYWG22B.js";

// src/runtime.ts
function runtimeStripeSecrets(env) {
  const mode = env.GALAXY_COMMERCE_STRIPE_MODE === "live" ? "live" : "test";
  const localSecretKey = mode === "test" && typeof env.GALAXY_COMMERCE_LOCAL_STRIPE_SECRET_KEY === "string" ? env.GALAXY_COMMERCE_LOCAL_STRIPE_SECRET_KEY : "";
  const localWebhookSecret = mode === "test" && typeof env.GALAXY_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET === "string" ? env.GALAXY_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET : "";
  const secretKey = typeof env.STRIPE_SECRET_KEY === "string" && env.STRIPE_SECRET_KEY ? env.STRIPE_SECRET_KEY : localSecretKey;
  const webhookSecret = typeof env.STRIPE_WEBHOOK_SECRET === "string" && env.STRIPE_WEBHOOK_SECRET ? env.STRIPE_WEBHOOK_SECRET : localWebhookSecret;
  return { secretKey, webhookSecret, mode };
}
function runtimePaymentAdapters(env) {
  const { secretKey, webhookSecret, mode } = runtimeStripeSecrets(env);
  const adapters = [new AdminTestPaymentAdapter()];
  if (!secretKey.startsWith(`sk_${mode}_`) || !webhookSecret.startsWith("whsec_") || secretKey === "sk_test_mockkey") return adapters;
  return [new StripePaymentAdapter({ secretKey, webhookSecret }), ...adapters];
}

export {
  runtimeStripeSecrets,
  runtimePaymentAdapters
};
