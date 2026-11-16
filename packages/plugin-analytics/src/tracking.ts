/** Provider-independent, explicitly instrumented events. Never pass form data or credentials. */
export interface AnalyticsItem { productId: string; variantId?: string; quantity: number; unitAmountMinor?: number }
export interface TrackingEvents {
  page_viewed: { path: string };
  product_viewed: { productId: string; variantId?: string };
  product_option_selected: { productId?: string; optionId: string; valueId: string };
  basket_item_added: AnalyticsItem;
  basket_item_removed: AnalyticsItem;
  basket_quantity_changed: AnalyticsItem & { previousQuantity: number };
  checkout_started: { items: AnalyticsItem[]; currency?: string; valueMinor?: number };
  purchase_confirmed: { transactionId: string; items: AnalyticsItem[]; currency: string; valueMinor: number; shippingMinor?: number; taxMinor?: number };
  refund_completed: { transactionId: string; refundId: string; items: AnalyticsItem[]; currency: string; valueMinor: number };
}
export type EventName = keyof TrackingEvents;
export type TrackingEvent = { [N in EventName]: { name: N; properties: TrackingEvents[N]; id: string; version: 1; timestamp: string } }[EventName];
export type Consent = 'unknown' | 'denied' | 'granted';
export type Delivery = { status: 'preview' | 'handed-off' | 'unsupported'; payload?: unknown };
export interface TrackingAdapter {
  name: string;
  /** Resolve only once accepted by the SDK. This does not prove ingestion by the provider. */
  send(event: TrackingEvent, signal: AbortSignal): Promise<Delivery>;
  /** Must synchronously stop new dispatch and cancel pending initialization. */
  disable(): void;
}
export interface TrackingRecord {
  id: string;
  event: EventName | 'invalid';
  timestamp: string;
  properties?: TrackingEvents[EventName];
  destination: string;
  status: Delivery['status'] | 'blocked-consent' | 'disabled' | 'invalid' | 'dispatching' | 'cancelled' | 'failed' | 'busy';
  payload?: unknown;
}

const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v);
const amount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const quantity = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 10000;
export function safePagePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.split(/[?#]/, 1)[0];
  if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path) || path.length > 200) return null;
  if (/^\/(?:admin|api|account|r)(?:\/|$)/i.test(path) || /^\/(?:checkout\/(?:success|cancel)|gift-cards\/)/i.test(path)) return null;
  return path;
}
function item(value: unknown, zero = false, previous = false): boolean {
  return object(value) && keys(value, ['productId', 'variantId', 'quantity', 'unitAmountMinor', ...(previous ? ['previousQuantity'] : [])])
    && identifier(value.productId) && optional(value.variantId, identifier)
    && (quantity(value.quantity) || (zero && value.quantity === 0))
    && optional(value.unitAmountMinor, amount) && (!previous || quantity(value.previousQuantity));
}
/** Reject unknown properties rather than silently accepting accidental personal data. */
export function validateEvent(name: unknown, properties: unknown): boolean {
  if (!object(properties)) return false;
  const p = properties;
  switch (name) {
    case 'page_viewed': return keys(p, ['path']) && safePagePath(p.path) !== null;
    case 'product_viewed': return keys(p, ['productId', 'variantId']) && identifier(p.productId) && optional(p.variantId, identifier);
    case 'product_option_selected': return keys(p, ['productId', 'optionId', 'valueId']) && optional(p.productId, identifier) && identifier(p.optionId) && identifier(p.valueId);
    case 'basket_item_added': case 'basket_item_removed': return item(p);
    case 'basket_quantity_changed': return item(p, true, true);
    case 'checkout_started': case 'purchase_confirmed': case 'refund_completed': {
      const money = name !== 'checkout_started';
      return keys(p, ['items', 'currency', 'valueMinor', ...(money ? ['transactionId'] : []), ...(name === 'purchase_confirmed' ? ['shippingMinor', 'taxMinor'] : []), ...(name === 'refund_completed' ? ['refundId'] : [])])
        && Array.isArray(p.items) && p.items.length > 0 && p.items.length <= 100 && p.items.every(value => item(value))
        && (money ? typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) && amount(p.valueMinor) && identifier(p.transactionId)
          : optional(p.currency, v => typeof v === 'string' && /^[A-Z]{3}$/.test(v)) && optional(p.valueMinor, amount) && (p.valueMinor === undefined || p.currency !== undefined))
        && optional(p.shippingMinor, amount) && optional(p.taxMinor, amount) && (name !== 'refund_completed' || identifier(p.refundId));
    }
    default: return false;
  }
}

export function createTracker(options: { adapters?: TrackingAdapter[]; consent?: Consent; inspect?: boolean; now?: () => Date } = {}) {
  const adapters = options.adapters ?? [];
  if (new Set(adapters.map(a => a.name)).size !== adapters.length) throw new Error('Tracking adapter names must be unique');
  let consent: Consent = options.consent ?? 'unknown';
  let controller = new AbortController();
  let pending = 0;
  let sequence = 0;
  const records: TrackingRecord[] = [];
  const listeners = new Set<() => void>();
  const now = options.now ?? (() => new Date());
  const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* diagnostics never affect the site */ } } };
  const record = (value: TrackingRecord) => { if (options.inspect) { records.push(value); if (records.length > 100) records.shift(); notify(); } return value; };
  return {
    getConsent: () => consent,
    setConsent(next: Consent) {
      if (!['unknown', 'denied', 'granted'].includes(next) || next === consent) return;
      consent = next;
      controller.abort(); controller = new AbortController();
      if (next !== 'granted') for (const adapter of adapters) { try { adapter.disable(); } catch { /* isolation */ } }
      notify();
    },
    snapshot: () => structuredClone(records),
    clear() { records.length = 0; notify(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async track<N extends EventName>(name: N, properties: TrackingEvents[N]): Promise<void> {
      const timestamp = now().toISOString();
      const id = `${timestamp}-${++sequence}`;
      if (!validateEvent(name, properties)) { record({ id, event: 'invalid', timestamp, destination: 'none', status: 'invalid' }); return; }
      const clean = structuredClone(properties);
      if (name === 'page_viewed') (clean as TrackingEvents['page_viewed']).path = safePagePath((clean as TrackingEvents['page_viewed']).path)!;
      const event = { id, name, timestamp, version: 1, properties: clean } as TrackingEvent;
      if (consent !== 'granted' || adapters.length === 0 || pending >= 100) {
        record({ id, event: name, timestamp, properties: clean, destination: 'none', status: consent !== 'granted' ? 'blocked-consent' : adapters.length ? 'busy' : 'disabled' }); return;
      }
      const signal = controller.signal;
      pending++;
      try {
        await Promise.all(adapters.map(async adapter => {
          const entry = record({ id, event: name, timestamp, properties: clean, destination: adapter.name, status: 'dispatching' });
          try {
            const result = await adapter.send(structuredClone(event), signal);
            entry.status = signal.aborted ? 'cancelled' : result.status;
            if (!signal.aborted && options.inspect) entry.payload = structuredClone(result.payload);
          } catch { entry.status = signal.aborted ? 'cancelled' : 'failed'; }
          notify();
        }));
      } finally { pending--; }
    },
  };
}
export type Tracker = ReturnType<typeof createTracker>;

export const CONSENT_KEY = 'talisman:analytics-consent:v1';
export const CONSENT_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
export function parseConsent(raw: string | null, now = Date.now()): { state: Consent; expiresAt: number } {
  try {
    const saved = JSON.parse(raw ?? 'null');
    if (saved?.version === 1 && ['granted', 'denied'].includes(saved.state) && Number.isSafeInteger(saved.expiresAt)
      && saved.expiresAt > now && saved.expiresAt <= now + CONSENT_LIFETIME_MS) return { state: saved.state, expiresAt: saved.expiresAt };
  } catch { /* corrupted or blocked storage means no permission */ }
  return { state: 'unknown', expiresAt: 0 };
}
