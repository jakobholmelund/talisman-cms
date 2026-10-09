import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-XWCAAKPV.js";
import "./chunk-VFNKIRVX.js";
import "./chunk-XXEE54YQ.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-AGIIDIRO.js";
import "./chunk-K7KINC5L.js";
import "./chunk-OSTMSMQZ.js";
import "./chunk-GNU6N22K.js";
import "./chunk-JHEPRJVB.js";
import "./chunk-HZZSX5TT.js";
import "./chunk-3XLIJPB2.js";
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
