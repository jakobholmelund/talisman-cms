import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-NQXG7R3A.js";
import "./chunk-DWZTDVHN.js";
import "./chunk-2SPT4KWO.js";
import "./chunk-4MKR5MKL.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-XHAJX7QQ.js";
import "./chunk-U3FNGZWH.js";
import "./chunk-UD6L5VAO.js";
import "./chunk-GNU6N22K.js";
import "./chunk-6IAWWO32.js";
import "./chunk-WGLFN46D.js";
import "./chunk-YCXJGHVY.js";
import "./chunk-NQUBOBQT.js";
import "./chunk-QVPX4QWC.js";
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
