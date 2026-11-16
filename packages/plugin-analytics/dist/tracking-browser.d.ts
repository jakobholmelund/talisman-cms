import { Tracker, TrackingAdapter, EventName, TrackingEvents } from './tracking.js';

interface BrowserTracking {
    tracker: Tracker;
    refresh(): void;
    getStorageAvailable(): boolean;
    choose(state: 'granted' | 'denied'): void;
    subscribe(fn: () => void): () => void;
    dispose(): void;
}
/** A missing integration is a no-op. Analytics must not become a dependency of a user action. */
declare function track<N extends EventName>(name: N, properties: TrackingEvents[N]): void;
declare function onTrackingReady(callback: () => void): () => void;
declare function initializeTracking(options: {
    adapters: TrackingAdapter[];
    pagePath: string;
    inspect?: boolean;
}): BrowserTracking;
/** Mount the optional Astro UI. The core tracker also works with a site's own consent UI. */
declare function mountTracking(root: HTMLElement): BrowserTracking;

export { type BrowserTracking, initializeTracking, mountTracking, onTrackingReady, track };
