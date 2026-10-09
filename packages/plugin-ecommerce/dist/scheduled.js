import {
  runtimePaymentAdapters
} from "./chunk-M4D42HVD.js";
import "./chunk-DR67UJVQ.js";
import {
  purgeStaleCommerceData,
  reconcileCommerce
} from "./chunk-5DE3NGJU.js";
import "./chunk-RIONC7RV.js";
import "./chunk-POZUPQDU.js";
import "./chunk-OH67LHUT.js";
import "./chunk-BGDJXEM5.js";
import "./chunk-7V3IKGLW.js";
import "./chunk-KRCC4OBZ.js";
import "./chunk-7YQJMR2T.js";
import "./chunk-GNU6N22K.js";
import "./chunk-YGPEQZYU.js";
import "./chunk-5VVOAOAK.js";
import "./chunk-KPJJ2U3F.js";
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
