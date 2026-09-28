import {
  runtimePaymentAdapters
} from "./chunk-DQ2SJLJ6.js";
import "./chunk-6L7TQXAW.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-WCXILCO6.js";
import "./chunk-WVV2IFQ2.js";
import "./chunk-5NSVUOZJ.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-P54WYMS4.js";
import "./chunk-WP5KVMJI.js";
import "./chunk-EY3DVH22.js";
import "./chunk-4P4GRAPP.js";
import "./chunk-GNU6N22K.js";
import "./chunk-CDRJWRSQ.js";
import "./chunk-K4FWMXR2.js";
import "./chunk-NMGICNSV.js";
import "./chunk-2UYSCNNW.js";

// src/scheduled.ts
async function scheduled(event) {
  const env = event.env;
  const errors = [];
  try {
    const results = await reconcileCommerce({ env, paymentAdapters: runtimePaymentAdapters(event.env) });
    const failures = results.filter((result) => result.status === "error");
    if (failures.length) {
      console.error("[Commerce] Checkout reconciliation failed", failures);
      errors.push(`${failures.length} checkout reconciliation attempts failed`);
    }
  } catch (error) {
    console.error("[Commerce] Checkout reconciliation failed", error);
    errors.push("Checkout reconciliation failed");
  }
  try {
    await purgeStaleCommerceData({ env });
  } catch (error) {
    console.error("[Commerce] Data retention cleanup failed", error);
    errors.push("Data retention cleanup failed");
  }
  if (errors.length) throw new Error(errors.join("; "));
}
export {
  scheduled
};
