import {
  runtimePaymentAdapters
} from "./chunk-DQ2SJLJ6.js";
import "./chunk-6L7TQXAW.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-2LIQHRTV.js";
import "./chunk-IK22DR6W.js";
import "./chunk-GGFLTIUK.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-BGS2NWOG.js";
import "./chunk-WP5KVMJI.js";
import "./chunk-A7BNM2SK.js";
import "./chunk-HBUWVAQK.js";
import "./chunk-GNU6N22K.js";
import "./chunk-NKZQB4F4.js";
import "./chunk-SFZBZWCM.js";
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
