import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-JUC2XNS7.js";
import "./chunk-IK2LAKMW.js";
import "./chunk-MQQMY6EP.js";
import "./chunk-LVMYPANC.js";
import {
  runtimePaymentAdapters
} from "./chunk-AVWDMCNG.js";
import "./chunk-IN4CG7W7.js";
import "./chunk-HYVPTDYO.js";
import "./chunk-2QJ6LJ5B.js";
import "./chunk-TX6OICXZ.js";
import "./chunk-GNU6N22K.js";
import "./chunk-JTBD4QC4.js";
import "./chunk-4PHEXUQV.js";
import "./chunk-YT2QU5EG.js";
import "./chunk-NQUBOBQT.js";
import "./chunk-R2NISKMY.js";
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
