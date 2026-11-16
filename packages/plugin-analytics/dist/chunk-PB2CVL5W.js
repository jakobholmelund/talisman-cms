import {
  CONSENT_LIFETIME_MS,
  safePagePath
} from "./chunk-XF2GAVBX.js";

// src/tracking-ga4.ts
var isGA4MeasurementId = (value) => typeof value === "string" && /^G-[A-Z0-9]{4,20}$/.test(value);
var denied = { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };
var granted = { ...denied, analytics_storage: "granted" };
function money(minor, currency) {
  const digits = currency.toUpperCase() === "HUF" ? 2 : new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  return minor / 10 ** (digits ?? 2);
}
function items(values, currency) {
  return values.map((value) => ({
    item_id: value.productId,
    ...value.variantId ? { item_variant: value.variantId } : {},
    quantity: value.quantity,
    ...currency && value.unitAmountMinor !== void 0 ? { price: money(value.unitAmountMinor, currency) } : {}
  }));
}
function mapGA4Event(event) {
  switch (event.name) {
    case "page_viewed":
      return { name: "page_view", parameters: { page_path: event.properties.path } };
    case "product_viewed":
      return { name: "view_item", parameters: { items: items([{ ...event.properties, quantity: 1 }]) } };
    case "product_option_selected":
      return { name: "product_option_selected", parameters: { ...event.properties } };
    case "basket_item_added":
    case "basket_item_removed":
      return { name: event.name === "basket_item_added" ? "add_to_cart" : "remove_from_cart", parameters: { items: items([event.properties]) } };
    case "basket_quantity_changed": {
      const difference = event.properties.quantity - event.properties.previousQuantity;
      return difference === 0 ? null : { name: difference > 0 ? "add_to_cart" : "remove_from_cart", parameters: { items: items([{ ...event.properties, quantity: Math.abs(difference) }]) } };
    }
    case "checkout_started":
    case "purchase_confirmed":
    case "refund_completed": {
      const p = event.properties;
      return { name: event.name === "checkout_started" ? "begin_checkout" : event.name === "purchase_confirmed" ? "purchase" : "refund", parameters: {
        items: items(p.items, p.currency),
        ...p.currency ? { currency: p.currency } : {},
        ...p.valueMinor !== void 0 && p.currency ? { value: money(p.valueMinor, p.currency) } : {},
        ..."transactionId" in p ? { transaction_id: p.transactionId } : {},
        ..."refundId" in p ? { refund_id: p.refundId } : {},
        ..."shippingMinor" in p && p.shippingMinor !== void 0 ? { shipping: money(p.shippingMinor, p.currency) } : {},
        ..."taxMinor" in p && p.taxMinor !== void 0 ? { tax: money(p.taxMinor, p.currency) } : {}
      } };
    }
  }
}
function browserGA4Runtime(measurementId) {
  const host = window;
  const layerName = `talismanAnalytics_${measurementId.replace(/-/g, "_")}`;
  let script;
  let loaded = false;
  const layer = () => host[layerName] ??= [];
  return {
    origin: window.location.origin,
    hostname: window.location.hostname,
    command(..._args) {
      layer().push(arguments);
    },
    setDisabled(disabled) {
      host[`ga-disable-${measurementId}`] = disabled;
    },
    clearCookies() {
      for (const cookie of document.cookie.split(";")) {
        const name = cookie.trim().split("=")[0];
        if (!/^talisman_ga(?:_|$)/.test(name)) continue;
        for (const domain of ["", `; Domain=${window.location.hostname}`, `; Domain=.${window.location.hostname}`]) {
          document.cookie = `${name}=; Max-Age=0; Path=/${domain}; SameSite=Lax`;
        }
      }
    },
    load(signal) {
      if (signal.aborted) return Promise.reject(new Error("Cancelled"));
      if (loaded) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const node = document.createElement("script");
        script = node;
        let timer;
        const finish = (ok) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          node.onload = node.onerror = null;
          if (ok && !signal.aborted) {
            loaded = true;
            resolve();
          } else {
            node.remove();
            if (script === node) script = void 0;
            host[`ga-disable-${measurementId}`] = true;
            layer().length = 0;
            reject(new Error("Google tag unavailable"));
          }
        };
        const abort = () => finish(false);
        signal.addEventListener("abort", abort, { once: true });
        node.async = true;
        node.referrerPolicy = "no-referrer";
        node.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}&l=${layerName}`;
        node.onload = () => finish(true);
        node.onerror = () => finish(false);
        timer = setTimeout(() => finish(false), 8e3);
        document.head.appendChild(node);
      });
    }
  };
}
function googleAnalytics(options) {
  if (!isGA4MeasurementId(options.measurementId)) throw new Error("Google Analytics requires a G- measurement ID");
  const path = safePagePath(options.pagePath);
  if (!path) throw new Error("Google Analytics is disabled on this path");
  let runtime = options.runtime;
  let ready;
  let enabled = false;
  return {
    name: options.preview ? "Google Analytics (local preview)" : "Google Analytics",
    disable() {
      enabled = false;
      ready = void 0;
      if (runtime && !options.preview) {
        runtime.setDisabled(true);
        runtime.command("consent", "update", denied);
        runtime.clearCookies();
      }
    },
    async send(event, signal) {
      const mapped = mapGA4Event(event);
      if (!mapped) return { status: "unsupported" };
      if (signal.aborted) throw new Error("Cancelled");
      if (options.preview) return { status: "preview", payload: mapped };
      runtime ??= browserGA4Runtime(options.measurementId);
      if (!ready) {
        enabled = true;
        runtime.setDisabled(false);
        runtime.command("consent", "default", denied);
        runtime.command("consent", "update", granted);
        runtime.command("js", /* @__PURE__ */ new Date());
        runtime.command("set", "ads_data_redaction", true);
        runtime.command("set", "url_passthrough", false);
        runtime.command("config", options.measurementId, {
          send_page_view: false,
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
          page_location: runtime.origin + path,
          page_referrer: "",
          page_title: path,
          ignore_referrer: true,
          cookie_prefix: "talisman",
          cookie_domain: runtime.hostname,
          cookie_path: "/",
          cookie_expires: CONSENT_LIFETIME_MS / 1e3,
          cookie_update: false,
          cookie_flags: "SameSite=Lax;Secure"
        });
        const attempt = runtime.load(signal);
        ready = attempt;
        void attempt.catch(() => {
          if (ready === attempt) ready = void 0;
        });
      }
      await ready;
      if (signal.aborted || !enabled) throw new Error("Cancelled");
      runtime.command("event", mapped.name, {
        ...mapped.parameters,
        send_to: options.measurementId,
        page_location: runtime.origin + (event.name === "page_viewed" ? event.properties.path : path),
        page_referrer: "",
        page_title: path
      });
      return { status: "handed-off", payload: mapped };
    }
  };
}

export {
  isGA4MeasurementId,
  mapGA4Event,
  browserGA4Runtime,
  googleAnalytics
};
