import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-V4AFX4JI.js";
import "./chunk-4IG6PUVV.js";
import "./chunk-CQTWJTOM.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-34DQPQAD.js";
import "./chunk-HQYYNOMX.js";
import "./chunk-FXE7QHWH.js";
import "./chunk-QVXNRCNA.js";
import "./chunk-GNU6N22K.js";
import "./chunk-MCHSKWPD.js";
import "./chunk-S5M56U3H.js";
import "./chunk-7YP7VGC3.js";
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
