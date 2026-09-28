import {
  runtimePaymentAdapters
} from "./chunk-DQ2SJLJ6.js";
import "./chunk-6L7TQXAW.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-MMEDVRVI.js";
import "./chunk-RVFZ32XF.js";
import "./chunk-Z2C4AXU4.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-XVJD7KXQ.js";
import "./chunk-WP5KVMJI.js";
import "./chunk-57TAUBRV.js";
import "./chunk-G46A3EJO.js";
import "./chunk-GNU6N22K.js";
import "./chunk-Y77MQPH2.js";
import "./chunk-YQM6TC4O.js";
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
