import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-7AB4ZVXG.js";
import "./chunk-UR52F5YS.js";
import "./chunk-BFCTU77S.js";
import "./chunk-UWIRME3U.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-RLJNYAC6.js";
import "./chunk-5CEWEWY2.js";
import "./chunk-L6PZD3R6.js";
import "./chunk-GNU6N22K.js";
import "./chunk-DIRLX3FV.js";
import "./chunk-WUDMFQXC.js";
import "./chunk-OX54ZSQZ.js";
import "./chunk-NQUBOBQT.js";
import "./chunk-E6QRZBC6.js";
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
