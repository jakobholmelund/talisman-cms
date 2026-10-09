import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-OPKAELJD.js";
import "./chunk-KQ3MMFVN.js";
import "./chunk-YHPWUIBV.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-MPRBGWGN.js";
import "./chunk-OZACQY4G.js";
import "./chunk-IUC5ZIOJ.js";
import "./chunk-UJ6XROUG.js";
import "./chunk-GNU6N22K.js";
import "./chunk-LF4NCC75.js";
import "./chunk-4WYWYY7J.js";
import "./chunk-OMZRKOH6.js";
import "./chunk-NQUBOBQT.js";
import "./chunk-SPRRFCF5.js";
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
