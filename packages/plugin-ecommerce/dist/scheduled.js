import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-P3EGABPL.js";
import "./chunk-BSTJ7GJ6.js";
import "./chunk-7P5TCZDC.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-5LOW7SRF.js";
import "./chunk-EV6HVUHO.js";
import "./chunk-JHSJ3R6O.js";
import "./chunk-GNU6N22K.js";
import "./chunk-KGRQF4NN.js";
import "./chunk-FDE2IMK7.js";
import "./chunk-RVXM5XJ4.js";
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
