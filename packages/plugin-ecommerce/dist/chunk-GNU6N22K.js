// src/stripe-mode.ts
import { readSetting } from "talisman-cms/env";
function runtimeStripeMode(env) {
  return readSetting(env, "COMMERCE_STRIPE_MODE") === "live" ? "live" : "test";
}
function stripeSessionMode(sessionId) {
  if (sessionId?.startsWith("cs_test_")) return "test";
  if (sessionId?.startsWith("cs_live_")) return "live";
  return null;
}

export {
  runtimeStripeMode,
  stripeSessionMode
};
