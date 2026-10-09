import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-HSKSWESH.js";
import "./chunk-737MTCCE.js";
import "./chunk-6DICT5V4.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-QQAERUXI.js";
import "./chunk-HZYMV637.js";
import "./chunk-IYLXVBBY.js";
import "./chunk-GNU6N22K.js";
import "./chunk-HYAFBBZB.js";
import "./chunk-P3TQBWDQ.js";
import "./chunk-IITGXIBG.js";
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
