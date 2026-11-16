import { CONSENT_KEY, CONSENT_LIFETIME_MS, createTracker, parseConsent, safePagePath, type Consent, type EventName, type Tracker, type TrackingAdapter, type TrackingEvents } from './tracking';
import { googleAnalytics, isGA4MeasurementId } from './tracking-ga4';

export interface BrowserTracking {
  tracker: Tracker;
  refresh(): void;
  getStorageAvailable(): boolean;
  choose(state: 'granted' | 'denied'): void;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}
let session: BrowserTracking | undefined;
const readyListeners = new Set<() => void>();

/** A missing integration is a no-op. Analytics must not become a dependency of a user action. */
export function track<N extends EventName>(name: N, properties: TrackingEvents[N]): void {
  try { session?.refresh(); void session?.tracker.track(name, properties).catch(() => {}); } catch { /* isolation */ }
}
export function onTrackingReady(callback: () => void): () => void {
  if (session) { try { callback(); } catch { /* isolation */ } }
  else readyListeners.add(callback);
  return () => { readyListeners.delete(callback); };
}

export function initializeTracking(options: { adapters: TrackingAdapter[]; pagePath: string; inspect?: boolean }): BrowserTracking {
  session?.dispose();
  const path = safePagePath(options.pagePath);
  let saved = { state: 'unknown' as Consent, expiresAt: 0 };
  let storageAvailable = true;
  try { saved = parseConsent(localStorage.getItem(CONSENT_KEY)); } catch { storageAvailable = false; }
  const tracker = createTracker({ adapters: path ? options.adapters : [], consent: saved.state, inspect: options.inspect });
  let expiry = saved.expiresAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = new Set<() => void>();
  const notify = () => { for (const fn of changed) { try { fn(); } catch { /* isolation */ } } };
  const pageView = () => { if (path) void tracker.track('page_viewed', { path }); };
  const schedule = () => {
    clearTimeout(timer);
    if (expiry) timer = setTimeout(refresh, Math.min(Math.max(1, expiry - Date.now()), 2147483647));
  };
  const refresh = () => {
    if (expiry && expiry <= Date.now()) { expiry = 0; tracker.setConsent('unknown'); notify(); }
    schedule();
  };
  const syncStorage = (event: StorageEvent) => {
    if (event.key !== CONSENT_KEY && event.key !== null) return;
    const next = parseConsent(event.key === null ? null : event.newValue);
    const previous = tracker.getConsent();
    expiry = next.expiresAt;
    tracker.setConsent(next.state);
    schedule(); notify();
    if (next.state === 'granted' && previous !== 'granted') pageView();
  };
  window.addEventListener('storage', syncStorage);
  window.addEventListener('focus', refresh);
  const result: BrowserTracking = {
    tracker,
    refresh,
    getStorageAvailable: () => storageAvailable,
    choose(state: 'granted' | 'denied') {
      if (state !== 'granted' && state !== 'denied') return;
      const previous = tracker.getConsent();
      expiry = Date.now() + CONSENT_LIFETIME_MS;
      // Disable immediately, before persisting or notifying the UI.
      tracker.setConsent(state);
      try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ version: 1, state, expiresAt: expiry })); storageAvailable = true; }
      catch { storageAvailable = false; }
      schedule(); notify();
      if (state === 'granted' && previous !== 'granted') pageView();
    },
    subscribe(fn: () => void) { changed.add(fn); return () => { changed.delete(fn); }; },
    dispose() {
      clearTimeout(timer);
      tracker.setConsent('unknown');
      window.removeEventListener('storage', syncStorage);
      window.removeEventListener('focus', refresh);
      changed.clear();
      if (session === result) session = undefined;
    },
  };
  session = result;
  schedule();
  pageView();
  for (const listener of readyListeners) { try { listener(); } catch { /* isolation */ } }
  readyListeners.clear();
  return result;
}

/** Mount the optional Astro UI. The core tracker also works with a site's own consent UI. */
export function mountTracking(root: HTMLElement) {
  const pagePath = root.dataset.pagePath ?? '/';
  const preview = root.dataset.preview === 'true';
  const inspect = root.dataset.inspect === 'true';
  const measurementId = root.dataset.measurementId ?? '';
  const adapters = isGA4MeasurementId(measurementId) && safePagePath(pagePath)
    ? [googleAnalytics({ measurementId, pagePath, preview })] : [];
  const browser = initializeTracking({ adapters, pagePath, inspect });
  const panel = root.querySelector<HTMLElement>('[data-consent-panel]')!;
  const preferences = root.querySelector<HTMLButtonElement>('[data-consent-open]')!;
  const status = root.querySelector<HTMLElement>('[data-consent-state]')!;
  const feedback = root.querySelector<HTMLElement>('[data-consent-feedback]')!;
  const storageNote = root.querySelector<HTMLElement>('[data-consent-storage]')!;
  let open = browser.tracker.getConsent() === 'unknown' && adapters.length > 0;
  function renderConsent() {
    const consent = browser.tracker.getConsent();
    panel.hidden = !open && consent !== 'unknown';
    if (consent === 'unknown') panel.hidden = adapters.length === 0 && !open;
    preferences.setAttribute('aria-expanded', String(!panel.hidden));
    status.textContent = adapters.length === 0 ? 'Optional event analytics is not configured.'
      : consent === 'granted' ? 'Optional analytics is allowed.' : consent === 'denied' ? 'Optional analytics is off.' : 'Optional analytics is off until you choose.';
    storageNote.hidden = browser.getStorageAvailable();
  }
  preferences.addEventListener('click', () => { open = true; renderConsent(); panel.querySelector<HTMLElement>('h2')?.focus(); });
  root.querySelector('[data-consent-close]')?.addEventListener('click', () => { open = false; panel.hidden = true; preferences.setAttribute('aria-expanded', 'false'); preferences.focus(); });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-consent-choice]')) button.addEventListener('click', () => {
    const state = button.dataset.consentChoice;
    if (state !== 'granted' && state !== 'denied') return;
    open = false;
    browser.choose(state);
    feedback.textContent = state === 'granted' ? 'Analytics preference saved: allowed.' : 'Analytics preference saved: off.';
    preferences.focus();
  });
  browser.subscribe(renderConsent);
  renderConsent();
  if (inspect) {
    const list = root.querySelector<HTMLOListElement>('[data-tracking-records]')!;
    const empty = root.querySelector<HTMLElement>('[data-tracking-empty]')!;
    const summary = root.querySelector<HTMLElement>('[data-inspector-summary]')!;
    const render = () => {
      const records = browser.tracker.snapshot();
      const expanded = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>('details[open]')).map(row => row.dataset.recordKey));
      summary.textContent = `${records.length} ${records.length === 1 ? 'event' : 'events'} · consent ${browser.tracker.getConsent()}`;
      empty.hidden = records.length > 0;
      list.replaceChildren();
      for (const record of records.slice().reverse()) {
        const li = document.createElement('li');
        const details = document.createElement('details');
        details.dataset.recordKey = `${record.id}:${record.destination}`;
        details.open = expanded.has(details.dataset.recordKey);
        const heading = document.createElement('summary');
        heading.textContent = `${record.event} · ${record.status} · ${record.destination}`;
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(record, null, 2);
        details.appendChild(heading); details.appendChild(pre); li.appendChild(details); list.appendChild(li);
      }
    };
    root.querySelector('[data-inspector-clear]')?.addEventListener('click', () => browser.tracker.clear());
    browser.tracker.subscribe(render); render();
  }
  return browser;
}
