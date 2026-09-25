// src/secrets.ts
import { readSetting } from "talisman-cms/env";
var MISSING_SECRET_KEY = "[plugin-stripe] STRIPE_SECRET_KEY is not set. Add it as a Worker secret; it is not read from astro.config.";
var MISSING_WEBHOOK_SECRET = "[plugin-stripe] TALISMAN_STRIPE_WEBHOOK_SECRET is not set. Add the signing secret of the /api/stripe/webhooks endpoint as a Worker secret.";
async function getWorkerEnv() {
  try {
    const worker = await import("cloudflare:workers");
    return worker.env;
  } catch {
    return globalThis.process?.env ?? {};
  }
}
function readStripeSecretKey(env) {
  const plain = env.STRIPE_SECRET_KEY;
  return readSetting(env, "STRIPE_SECRET_KEY") ?? (typeof plain === "string" && plain.trim() ? plain.trim() : void 0);
}
function readStripeWebhookSecret(env) {
  return readSetting(env, "STRIPE_WEBHOOK_SECRET");
}

export {
  MISSING_SECRET_KEY,
  MISSING_WEBHOOK_SECRET,
  getWorkerEnv,
  readStripeSecretKey,
  readStripeWebhookSecret
};
