import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-IESTQB3Q.js";
import "./chunk-TLRIWP2Z.js";
import "./chunk-YQVSWTGG.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-FZBVFNZR.js";
import "./chunk-T4BAYRSK.js";
import "./chunk-XEY7CW6W.js";
import "./chunk-LM4JEW7F.js";
import "./chunk-GNU6N22K.js";
import "./chunk-RQGEGKRJ.js";
import "./chunk-NF2MUGI7.js";
import "./chunk-X3JP4EB3.js";
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
