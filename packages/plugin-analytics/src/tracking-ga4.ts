import { CONSENT_LIFETIME_MS, safePagePath, type AnalyticsItem, type TrackingAdapter, type TrackingEvent } from './tracking';

export const isGA4MeasurementId = (value: unknown): value is string => typeof value === 'string' && /^G-[A-Z0-9]{4,20}$/.test(value);
const denied = { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
const granted = { ...denied, analytics_storage: 'granted' };
export interface GA4Payload { name: string; parameters: Record<string, unknown> }
function money(minor: number, currency: string) {
  // Match Commerce's payment scale: newer ICU displays HUF without decimals, but charges
  // and stored amounts still use hundredths. Locale upgrades must not multiply revenue.
  const digits = currency.toUpperCase() === 'HUF' ? 2
    : new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return minor / 10 ** (digits ?? 2);
}
function items(values: AnalyticsItem[], currency?: string) {
  return values.map(value => ({ item_id: value.productId, ...(value.variantId ? { item_variant: value.variantId } : {}),
    quantity: value.quantity, ...(currency && value.unitAmountMinor !== undefined ? { price: money(value.unitAmountMinor, currency) } : {}) }));
}
/** Mapping is pure and independently testable; money remains integer minor units in our API. */
export function mapGA4Event(event: TrackingEvent): GA4Payload | null {
  switch (event.name) {
    case 'page_viewed': return { name: 'page_view', parameters: { page_path: event.properties.path } };
    case 'product_viewed': return { name: 'view_item', parameters: { items: items([{ ...event.properties, quantity: 1 }]) } };
    case 'product_option_selected': return { name: 'product_option_selected', parameters: { ...event.properties } };
    case 'basket_item_added': case 'basket_item_removed': return { name: event.name === 'basket_item_added' ? 'add_to_cart' : 'remove_from_cart', parameters: { items: items([event.properties]) } };
    case 'basket_quantity_changed': {
      const difference = event.properties.quantity - event.properties.previousQuantity;
      return difference === 0 ? null : { name: difference > 0 ? 'add_to_cart' : 'remove_from_cart', parameters: { items: items([{ ...event.properties, quantity: Math.abs(difference) }]) } };
    }
    case 'checkout_started': case 'purchase_confirmed': case 'refund_completed': {
      const p = event.properties;
      return { name: event.name === 'checkout_started' ? 'begin_checkout' : event.name === 'purchase_confirmed' ? 'purchase' : 'refund', parameters: {
        items: items(p.items, p.currency), ...(p.currency ? { currency: p.currency } : {}),
        ...(p.valueMinor !== undefined && p.currency ? { value: money(p.valueMinor, p.currency) } : {}),
        ...('transactionId' in p ? { transaction_id: p.transactionId } : {}),
        ...('refundId' in p ? { refund_id: p.refundId } : {}),
        ...('shippingMinor' in p && p.shippingMinor !== undefined ? { shipping: money(p.shippingMinor, p.currency!) } : {}),
        ...('taxMinor' in p && p.taxMinor !== undefined ? { tax: money(p.taxMinor, p.currency!) } : {}),
      } };
    }
  }
}

/** Runtime injection supports deterministic tests without loading Google's code or sending data. */
export interface GA4Runtime {
  origin: string;
  hostname: string;
  command(...args: unknown[]): void;
  load(signal: AbortSignal): Promise<void>;
  setDisabled(disabled: boolean): void;
  clearCookies(): void;
}
export function browserGA4Runtime(measurementId: string): GA4Runtime {
  const host = window as unknown as Record<string, unknown>;
  const layerName = `talismanAnalytics_${measurementId.replace(/-/g, '_')}`;
  let script: HTMLScriptElement | undefined;
  let loaded = false;
  const layer = () => (host[layerName] ??= []) as IArguments[];
  return {
    origin: window.location.origin,
    hostname: window.location.hostname,
    command(..._args: unknown[]) { layer().push(arguments); },
    setDisabled(disabled) { host[`ga-disable-${measurementId}`] = disabled; },
    clearCookies() {
      // Only our configured prefix and host; leave other tags and application cookies alone.
      for (const cookie of document.cookie.split(';')) {
        const name = cookie.trim().split('=')[0];
        if (!/^talisman_ga(?:_|$)/.test(name)) continue;
        for (const domain of ['', `; Domain=${window.location.hostname}`, `; Domain=.${window.location.hostname}`]) {
          document.cookie = `${name}=; Max-Age=0; Path=/${domain}; SameSite=Lax`;
        }
      }
    },
    load(signal) {
      if (signal.aborted) return Promise.reject(new Error('Cancelled'));
      if (loaded) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const node = document.createElement('script');
        script = node;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          node.onload = node.onerror = null;
          if (ok && !signal.aborted) { loaded = true; resolve(); }
          else {
            node.remove();
            if (script === node) script = undefined;
            // Do not let a late load process pending configuration after withdrawal/failure.
            host[`ga-disable-${measurementId}`] = true;
            layer().length = 0;
            reject(new Error('Google tag unavailable'));
          }
        };
        const abort = () => finish(false);
        signal.addEventListener('abort', abort, { once: true });
        node.async = true;
        node.referrerPolicy = 'no-referrer';
        node.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}&l=${layerName}`;
        node.onload = () => finish(true);
        node.onerror = () => finish(false);
        timer = setTimeout(() => finish(false), 8000);
        document.head.appendChild(node);
      });
    },
  };
}

export function googleAnalytics(options: { measurementId: string; pagePath: string; preview?: boolean; runtime?: GA4Runtime }): TrackingAdapter {
  if (!isGA4MeasurementId(options.measurementId)) throw new Error('Google Analytics requires a G- measurement ID');
  const path = safePagePath(options.pagePath);
  if (!path) throw new Error('Google Analytics is disabled on this path');
  let runtime = options.runtime;
  let ready: Promise<void> | undefined;
  let enabled = false;
  return {
    name: options.preview ? 'Google Analytics (local preview)' : 'Google Analytics',
    disable() {
      enabled = false;
      ready = undefined;
      if (runtime && !options.preview) {
        runtime.setDisabled(true);
        runtime.command('consent', 'update', denied);
        runtime.clearCookies();
      }
    },
    async send(event, signal) {
      const mapped = mapGA4Event(event);
      if (!mapped) return { status: 'unsupported' };
      if (signal.aborted) throw new Error('Cancelled');
      if (options.preview) return { status: 'preview', payload: mapped };
      runtime ??= browserGA4Runtime(options.measurementId);
      if (!ready) {
        enabled = true;
        runtime.setDisabled(false);
        runtime.command('consent', 'default', denied);
        runtime.command('consent', 'update', granted);
        runtime.command('js', new Date());
        runtime.command('set', 'ads_data_redaction', true);
        runtime.command('set', 'url_passthrough', false);
        runtime.command('config', options.measurementId, {
          send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
          page_location: runtime.origin + path, page_referrer: '', page_title: path, ignore_referrer: true,
          cookie_prefix: 'talisman', cookie_domain: runtime.hostname, cookie_path: '/',
          cookie_expires: CONSENT_LIFETIME_MS / 1000, cookie_update: false,
          cookie_flags: 'SameSite=Lax;Secure',
        });
        const attempt = runtime.load(signal);
        ready = attempt;
        void attempt.catch(() => { if (ready === attempt) ready = undefined; });
      }
      await ready;
      if (signal.aborted || !enabled) throw new Error('Cancelled');
      runtime.command('event', mapped.name, { ...mapped.parameters, send_to: options.measurementId,
        page_location: runtime.origin + (event.name === 'page_viewed' ? event.properties.path : path), page_referrer: '', page_title: path });
      return { status: 'handed-off', payload: mapped };
    },
  };
}
