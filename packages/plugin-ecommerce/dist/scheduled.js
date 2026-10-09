import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-35CXWIDR.js";
import "./chunk-NXQCYUOX.js";
import "./chunk-PD7I5B62.js";
import "./chunk-IT7W6TQQ.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-J7AA22HC.js";
import "./chunk-6OI6C5UV.js";
import "./chunk-GB3RDLKI.js";
import "./chunk-GNU6N22K.js";
import "./chunk-WPNOY6AW.js";
import "./chunk-7BTUQQDZ.js";
import "./chunk-KLQ2VU7R.js";
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
