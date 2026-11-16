/** Provider-independent, explicitly instrumented events. Never pass form data or credentials. */
interface AnalyticsItem {
    productId: string;
    variantId?: string;
    quantity: number;
    unitAmountMinor?: number;
}
interface TrackingEvents {
    page_viewed: {
        path: string;
    };
    product_viewed: {
        productId: string;
        variantId?: string;
    };
    product_option_selected: {
        productId?: string;
        optionId: string;
        valueId: string;
    };
    basket_item_added: AnalyticsItem;
    basket_item_removed: AnalyticsItem;
    basket_quantity_changed: AnalyticsItem & {
        previousQuantity: number;
    };
    checkout_started: {
        items: AnalyticsItem[];
        currency?: string;
        valueMinor?: number;
    };
    purchase_confirmed: {
        transactionId: string;
        items: AnalyticsItem[];
        currency: string;
        valueMinor: number;
        shippingMinor?: number;
        taxMinor?: number;
    };
    refund_completed: {
        transactionId: string;
        refundId: string;
        items: AnalyticsItem[];
        currency: string;
        valueMinor: number;
    };
}
type EventName = keyof TrackingEvents;
type TrackingEvent = {
    [N in EventName]: {
        name: N;
        properties: TrackingEvents[N];
        id: string;
        version: 1;
        timestamp: string;
    };
}[EventName];
type Consent = 'unknown' | 'denied' | 'granted';
type Delivery = {
    status: 'preview' | 'handed-off' | 'unsupported';
    payload?: unknown;
};
interface TrackingAdapter {
    name: string;
    /** Resolve only once accepted by the SDK. This does not prove ingestion by the provider. */
    send(event: TrackingEvent, signal: AbortSignal): Promise<Delivery>;
    /** Must synchronously stop new dispatch and cancel pending initialization. */
    disable(): void;
}
interface TrackingRecord {
    id: string;
    event: EventName | 'invalid';
    timestamp: string;
    properties?: TrackingEvents[EventName];
    destination: string;
    status: Delivery['status'] | 'blocked-consent' | 'disabled' | 'invalid' | 'dispatching' | 'cancelled' | 'failed' | 'busy';
    payload?: unknown;
}
declare function safePagePath(value: unknown): string | null;
/** Reject unknown properties rather than silently accepting accidental personal data. */
declare function validateEvent(name: unknown, properties: unknown): boolean;
declare function createTracker(options?: {
    adapters?: TrackingAdapter[];
    consent?: Consent;
    inspect?: boolean;
    now?: () => Date;
}): {
    getConsent: () => Consent;
    setConsent(next: Consent): void;
    snapshot: () => TrackingRecord[];
    clear(): void;
    subscribe(listener: () => void): () => void;
    track<N extends EventName>(name: N, properties: TrackingEvents[N]): Promise<void>;
};
type Tracker = ReturnType<typeof createTracker>;
declare const CONSENT_KEY = "talisman:analytics-consent:v1";
declare const CONSENT_LIFETIME_MS: number;
declare function parseConsent(raw: string | null, now?: number): {
    state: Consent;
    expiresAt: number;
};

export { type AnalyticsItem, CONSENT_KEY, CONSENT_LIFETIME_MS, type Consent, type Delivery, type EventName, type Tracker, type TrackingAdapter, type TrackingEvent, type TrackingEvents, type TrackingRecord, createTracker, parseConsent, safePagePath, validateEvent };
