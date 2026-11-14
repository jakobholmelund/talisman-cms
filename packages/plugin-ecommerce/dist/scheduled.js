import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-5UT54SKW.js";
import "./chunk-PDZF27EW.js";
import "./chunk-BVMDOVSS.js";
import "./chunk-MPH2QR5Y.js";
import {
  runtimePaymentAdapters
} from "./chunk-AVWDMCNG.js";
import "./chunk-IN4CG7W7.js";
import "./chunk-GLO65VCM.js";
import "./chunk-PVGGIHJ5.js";
import "./chunk-IC3XDWQU.js";
import "./chunk-GNU6N22K.js";
import "./chunk-PMYARYOQ.js";
import "./chunk-SXQHVX4E.js";
import "./chunk-PLAJXKV3.js";
import "./chunk-NQUBOBQT.js";
import "./chunk-AQNK3BKB.js";
import "./chunk-HNDRZISR.js";

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
