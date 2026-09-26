import {
  StripePaymentAdapter
} from "./chunk-C2SYF4CS.js";

// src/runtime.ts
import { readSetting } from "talisman-cms/env";
function runtimeStripeSecrets(env) {
  const mode = readSetting(env, "COMMERCE_STRIPE_MODE") === "live" ? "live" : "test";
  const localSecretKey = mode === "test" ? readSetting(env, "COMMERCE_LOCAL_STRIPE_SECRET_KEY") ?? "" : "";
  const localWebhookSecret = mode === "test" ? readSetting(env, "COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET") ?? "" : "";
  const secretKey = typeof env.STRIPE_SECRET_KEY === "string" && env.STRIPE_SECRET_KEY ? env.STRIPE_SECRET_KEY : localSecretKey;
  const webhookSecret = typeof env.STRIPE_WEBHOOK_SECRET === "string" && env.STRIPE_WEBHOOK_SECRET ? env.STRIPE_WEBHOOK_SECRET : localWebhookSecret;
  return { secretKey, webhookSecret, mode };
}
function runtimePaymentAdapters(env) {
  const { secretKey, webhookSecret, mode } = runtimeStripeSecrets(env);
  if (!secretKey.startsWith(`sk_${mode}_`) || !webhookSecret.startsWith("whsec_") || secretKey === "sk_test_mockkey") return [];
  return [new StripePaymentAdapter({ secretKey, webhookSecret })];
}

export {
  runtimeStripeSecrets,
  runtimePaymentAdapters
};
