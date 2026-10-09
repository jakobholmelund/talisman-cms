import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-AJKVQPDI.js";
import "./chunk-PYEHVINE.js";
import "./chunk-BVMDOVSS.js";
import "./chunk-2WXNU27Y.js";
import {
  runtimePaymentAdapters
} from "./chunk-AVWDMCNG.js";
import "./chunk-IN4CG7W7.js";
import "./chunk-3SF7AMPH.js";
import "./chunk-L63XGUKQ.js";
import "./chunk-IC3XDWQU.js";
import "./chunk-GNU6N22K.js";
import "./chunk-PMYARYOQ.js";
import "./chunk-SXQHVX4E.js";
import "./chunk-PLAJXKV3.js";
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
