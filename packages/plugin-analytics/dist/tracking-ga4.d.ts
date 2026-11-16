import { TrackingAdapter, TrackingEvent } from './tracking.js';

declare const isGA4MeasurementId: (value: unknown) => value is string;
interface GA4Payload {
    name: string;
    parameters: Record<string, unknown>;
}
/** Mapping is pure and independently testable; money remains integer minor units in our API. */
declare function mapGA4Event(event: TrackingEvent): GA4Payload | null;
/** Runtime injection supports deterministic tests without loading Google's code or sending data. */
interface GA4Runtime {
    origin: string;
    hostname: string;
    command(...args: unknown[]): void;
    load(signal: AbortSignal): Promise<void>;
    setDisabled(disabled: boolean): void;
    clearCookies(): void;
}
declare function browserGA4Runtime(measurementId: string): GA4Runtime;
declare function googleAnalytics(options: {
    measurementId: string;
    pagePath: string;
    preview?: boolean;
    runtime?: GA4Runtime;
}): TrackingAdapter;

export { type GA4Payload, type GA4Runtime, browserGA4Runtime, googleAnalytics, isGA4MeasurementId, mapGA4Event };
