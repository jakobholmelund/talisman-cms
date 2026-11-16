// src/tracking.ts
var identifier = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v);
var amount = (v) => Number.isSafeInteger(v) && v >= 0;
var object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var keys = (v, allowed) => Object.keys(v).every((key) => allowed.includes(key));
var optional = (v, check) => v === void 0 || check(v);
var quantity = (v) => Number.isSafeInteger(v) && v > 0 && v <= 1e4;
function safePagePath(value) {
  if (typeof value !== "string") return null;
  const path = value.split(/[?#]/, 1)[0];
  if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path) || path.length > 200) return null;
  if (/^\/(?:admin|api|account|r)(?:\/|$)/i.test(path) || /^\/(?:checkout\/(?:success|cancel)|gift-cards\/)/i.test(path)) return null;
  return path;
}
function item(value, zero = false, previous = false) {
  return object(value) && keys(value, ["productId", "variantId", "quantity", "unitAmountMinor", ...previous ? ["previousQuantity"] : []]) && identifier(value.productId) && optional(value.variantId, identifier) && (quantity(value.quantity) || zero && value.quantity === 0) && optional(value.unitAmountMinor, amount) && (!previous || quantity(value.previousQuantity));
}
function validateEvent(name, properties) {
  if (!object(properties)) return false;
  const p = properties;
  switch (name) {
    case "page_viewed":
      return keys(p, ["path"]) && safePagePath(p.path) !== null;
    case "product_viewed":
      return keys(p, ["productId", "variantId"]) && identifier(p.productId) && optional(p.variantId, identifier);
    case "product_option_selected":
      return keys(p, ["productId", "optionId", "valueId"]) && optional(p.productId, identifier) && identifier(p.optionId) && identifier(p.valueId);
    case "basket_item_added":
    case "basket_item_removed":
      return item(p);
    case "basket_quantity_changed":
      return item(p, true, true);
    case "checkout_started":
    case "purchase_confirmed":
    case "refund_completed": {
      const money = name !== "checkout_started";
      return keys(p, ["items", "currency", "valueMinor", ...money ? ["transactionId"] : [], ...name === "purchase_confirmed" ? ["shippingMinor", "taxMinor"] : [], ...name === "refund_completed" ? ["refundId"] : []]) && Array.isArray(p.items) && p.items.length > 0 && p.items.length <= 100 && p.items.every((value) => item(value)) && (money ? typeof p.currency === "string" && /^[A-Z]{3}$/.test(p.currency) && amount(p.valueMinor) && identifier(p.transactionId) : optional(p.currency, (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v)) && optional(p.valueMinor, amount) && (p.valueMinor === void 0 || p.currency !== void 0)) && optional(p.shippingMinor, amount) && optional(p.taxMinor, amount) && (name !== "refund_completed" || identifier(p.refundId));
    }
    default:
      return false;
  }
}
function createTracker(options = {}) {
  const adapters = options.adapters ?? [];
  if (new Set(adapters.map((a) => a.name)).size !== adapters.length) throw new Error("Tracking adapter names must be unique");
  let consent = options.consent ?? "unknown";
  let controller = new AbortController();
  let pending = 0;
  let sequence = 0;
  const records = [];
  const listeners = /* @__PURE__ */ new Set();
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
      }
    }
  };
  const record = (value) => {
    if (options.inspect) {
      records.push(value);
      if (records.length > 100) records.shift();
      notify();
    }
    return value;
  };
  return {
    getConsent: () => consent,
    setConsent(next) {
      if (!["unknown", "denied", "granted"].includes(next) || next === consent) return;
      consent = next;
      controller.abort();
      controller = new AbortController();
      if (next !== "granted") for (const adapter of adapters) {
        try {
          adapter.disable();
        } catch {
        }
      }
      notify();
    },
    snapshot: () => structuredClone(records),
    clear() {
      records.length = 0;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async track(name, properties) {
      const timestamp = now().toISOString();
      const id = `${timestamp}-${++sequence}`;
      if (!validateEvent(name, properties)) {
        record({ id, event: "invalid", timestamp, destination: "none", status: "invalid" });
        return;
      }
      const clean = structuredClone(properties);
      if (name === "page_viewed") clean.path = safePagePath(clean.path);
      const event = { id, name, timestamp, version: 1, properties: clean };
      if (consent !== "granted" || adapters.length === 0 || pending >= 100) {
        record({ id, event: name, timestamp, properties: clean, destination: "none", status: consent !== "granted" ? "blocked-consent" : adapters.length ? "busy" : "disabled" });
        return;
      }
      const signal = controller.signal;
      pending++;
      try {
        await Promise.all(adapters.map(async (adapter) => {
          const entry = record({ id, event: name, timestamp, properties: clean, destination: adapter.name, status: "dispatching" });
          try {
            const result = await adapter.send(structuredClone(event), signal);
            entry.status = signal.aborted ? "cancelled" : result.status;
            if (!signal.aborted && options.inspect) entry.payload = structuredClone(result.payload);
          } catch {
            entry.status = signal.aborted ? "cancelled" : "failed";
          }
          notify();
        }));
      } finally {
        pending--;
      }
    }
  };
}
var CONSENT_KEY = "talisman:analytics-consent:v1";
var CONSENT_LIFETIME_MS = 180 * 24 * 60 * 60 * 1e3;
function parseConsent(raw, now = Date.now()) {
  try {
    const saved = JSON.parse(raw ?? "null");
    if (saved?.version === 1 && ["granted", "denied"].includes(saved.state) && Number.isSafeInteger(saved.expiresAt) && saved.expiresAt > now && saved.expiresAt <= now + CONSENT_LIFETIME_MS) return { state: saved.state, expiresAt: saved.expiresAt };
  } catch {
  }
  return { state: "unknown", expiresAt: 0 };
}

export {
  safePagePath,
  validateEvent,
  createTracker,
  CONSENT_KEY,
  CONSENT_LIFETIME_MS,
  parseConsent
};
