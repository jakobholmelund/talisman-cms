import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-TG2KLQXC.js";
import "./chunk-3LR7WYMB.js";
import "./chunk-HKPJHMPB.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-UCPUP2U7.js";
import "./chunk-UZSS3RLA.js";
import "./chunk-JBDGJ7AR.js";
import "./chunk-GNU6N22K.js";
import "./chunk-TOUOM5OZ.js";
import "./chunk-7225YI7R.js";
import "./chunk-2LKMD4JM.js";
import "./chunk-NQUBOBQT.js";
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
