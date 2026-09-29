import {
  runtimePaymentAdapters
} from "./chunk-DQ2SJLJ6.js";
import "./chunk-6L7TQXAW.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-GHUSAF37.js";
import "./chunk-K6SXWFZP.js";
import "./chunk-4DUQOBXB.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-TMMXEXF2.js";
import "./chunk-46DBWAED.js";
import "./chunk-7PQWN42E.js";
import "./chunk-GNU6N22K.js";
import "./chunk-OPQXEAZM.js";
import "./chunk-ZI5IJOR6.js";
import "./chunk-NKJTK7MK.js";
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
