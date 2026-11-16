import {
  googleAnalytics,
  isGA4MeasurementId
} from "./chunk-PB2CVL5W.js";
import {
  CONSENT_KEY,
  CONSENT_LIFETIME_MS,
  createTracker,
  parseConsent,
  safePagePath
} from "./chunk-XF2GAVBX.js";

// src/tracking-browser.ts
var session;
var readyListeners = /* @__PURE__ */ new Set();
function track(name, properties) {
  try {
    session?.refresh();
    void session?.tracker.track(name, properties).catch(() => {
    });
  } catch {
  }
}
function onTrackingReady(callback) {
  if (session) {
    try {
      callback();
    } catch {
    }
  } else readyListeners.add(callback);
  return () => {
    readyListeners.delete(callback);
  };
}
function initializeTracking(options) {
  session?.dispose();
  const path = safePagePath(options.pagePath);
  let saved = { state: "unknown", expiresAt: 0 };
  let storageAvailable = true;
  try {
    saved = parseConsent(localStorage.getItem(CONSENT_KEY));
  } catch {
    storageAvailable = false;
  }
  const tracker = createTracker({ adapters: path ? options.adapters : [], consent: saved.state, inspect: options.inspect });
  let expiry = saved.expiresAt;
  let timer;
  const changed = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const fn of changed) {
      try {
        fn();
      } catch {
      }
    }
  };
  const pageView = () => {
    if (path) void tracker.track("page_viewed", { path });
  };
  const schedule = () => {
    clearTimeout(timer);
    if (expiry) timer = setTimeout(refresh, Math.min(Math.max(1, expiry - Date.now()), 2147483647));
  };
  const refresh = () => {
    if (expiry && expiry <= Date.now()) {
      expiry = 0;
      tracker.setConsent("unknown");
      notify();
    }
    schedule();
  };
  const syncStorage = (event) => {
    if (event.key !== CONSENT_KEY && event.key !== null) return;
    const next = parseConsent(event.key === null ? null : event.newValue);
    const previous = tracker.getConsent();
    expiry = next.expiresAt;
    tracker.setConsent(next.state);
    schedule();
    notify();
    if (next.state === "granted" && previous !== "granted") pageView();
  };
  window.addEventListener("storage", syncStorage);
  window.addEventListener("focus", refresh);
  const result = {
    tracker,
    refresh,
    getStorageAvailable: () => storageAvailable,
    choose(state) {
      if (state !== "granted" && state !== "denied") return;
      const previous = tracker.getConsent();
      expiry = Date.now() + CONSENT_LIFETIME_MS;
      tracker.setConsent(state);
      try {
        localStorage.setItem(CONSENT_KEY, JSON.stringify({ version: 1, state, expiresAt: expiry }));
        storageAvailable = true;
      } catch {
        storageAvailable = false;
      }
      schedule();
      notify();
      if (state === "granted" && previous !== "granted") pageView();
    },
    subscribe(fn) {
      changed.add(fn);
      return () => {
        changed.delete(fn);
      };
    },
    dispose() {
      clearTimeout(timer);
      tracker.setConsent("unknown");
      window.removeEventListener("storage", syncStorage);
      window.removeEventListener("focus", refresh);
      changed.clear();
      if (session === result) session = void 0;
    }
  };
  session = result;
  schedule();
  pageView();
  for (const listener of readyListeners) {
    try {
      listener();
    } catch {
    }
  }
  readyListeners.clear();
  return result;
}
function mountTracking(root) {
  const pagePath = root.dataset.pagePath ?? "/";
  const preview = root.dataset.preview === "true";
  const inspect = root.dataset.inspect === "true";
  const measurementId = root.dataset.measurementId ?? "";
  const adapters = isGA4MeasurementId(measurementId) && safePagePath(pagePath) ? [googleAnalytics({ measurementId, pagePath, preview })] : [];
  const browser = initializeTracking({ adapters, pagePath, inspect });
  const panel = root.querySelector("[data-consent-panel]");
  const preferences = root.querySelector("[data-consent-open]");
  const status = root.querySelector("[data-consent-state]");
  const feedback = root.querySelector("[data-consent-feedback]");
  const storageNote = root.querySelector("[data-consent-storage]");
  let open = browser.tracker.getConsent() === "unknown" && adapters.length > 0;
  function renderConsent() {
    const consent = browser.tracker.getConsent();
    panel.hidden = !open && consent !== "unknown";
    if (consent === "unknown") panel.hidden = adapters.length === 0 && !open;
    preferences.setAttribute("aria-expanded", String(!panel.hidden));
    status.textContent = adapters.length === 0 ? "Optional event analytics is not configured." : consent === "granted" ? "Optional analytics is allowed." : consent === "denied" ? "Optional analytics is off." : "Optional analytics is off until you choose.";
    storageNote.hidden = browser.getStorageAvailable();
  }
  preferences.addEventListener("click", () => {
    open = true;
    renderConsent();
    panel.querySelector("h2")?.focus();
  });
  root.querySelector("[data-consent-close]")?.addEventListener("click", () => {
    open = false;
    panel.hidden = true;
    preferences.setAttribute("aria-expanded", "false");
    preferences.focus();
  });
  for (const button of root.querySelectorAll("[data-consent-choice]")) button.addEventListener("click", () => {
    const state = button.dataset.consentChoice;
    if (state !== "granted" && state !== "denied") return;
    open = false;
    browser.choose(state);
    feedback.textContent = state === "granted" ? "Analytics preference saved: allowed." : "Analytics preference saved: off.";
    preferences.focus();
  });
  browser.subscribe(renderConsent);
  renderConsent();
  if (inspect) {
    const list = root.querySelector("[data-tracking-records]");
    const empty = root.querySelector("[data-tracking-empty]");
    const summary = root.querySelector("[data-inspector-summary]");
    const render = () => {
      const records = browser.tracker.snapshot();
      const expanded = new Set(Array.from(list.querySelectorAll("details[open]")).map((row) => row.dataset.recordKey));
      summary.textContent = `${records.length} ${records.length === 1 ? "event" : "events"} \xB7 consent ${browser.tracker.getConsent()}`;
      empty.hidden = records.length > 0;
      list.replaceChildren();
      for (const record of records.slice().reverse()) {
        const li = document.createElement("li");
        const details = document.createElement("details");
        details.dataset.recordKey = `${record.id}:${record.destination}`;
        details.open = expanded.has(details.dataset.recordKey);
        const heading = document.createElement("summary");
        heading.textContent = `${record.event} \xB7 ${record.status} \xB7 ${record.destination}`;
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(record, null, 2);
        details.appendChild(heading);
        details.appendChild(pre);
        li.appendChild(details);
        list.appendChild(li);
      }
    };
    root.querySelector("[data-inspector-clear]")?.addEventListener("click", () => browser.tracker.clear());
    browser.tracker.subscribe(render);
    render();
  }
  return browser;
}
export {
  initializeTracking,
  mountTracking,
  onTrackingReady,
  track
};
