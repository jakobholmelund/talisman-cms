import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-NKRAW7IR.js";
import "./chunk-4OZ23J3X.js";
import "./chunk-BVMDOVSS.js";
import "./chunk-25X32EKO.js";
import {
  runtimePaymentAdapters
} from "./chunk-AVWDMCNG.js";
import "./chunk-IN4CG7W7.js";
import "./chunk-3RWEM2DK.js";
import "./chunk-YHTTKGNB.js";
import "./chunk-QVDRNSCF.js";
import "./chunk-7CFKBAUU.js";
import "./chunk-LCILI57I.js";
import "./chunk-GNU6N22K.js";
import "./chunk-WHUJCCDD.js";
import "./chunk-3MXMGN5I.js";
import "./chunk-USNNZXV4.js";
import "./chunk-SXQHVX4E.js";
import "./chunk-PLAJXKV3.js";
import "./chunk-NQUBOBQT.js";
import "./chunk-XJTZUPZM.js";
import "./chunk-HNDRZISR.js";
import "./chunk-C66AEOTN.js";

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
