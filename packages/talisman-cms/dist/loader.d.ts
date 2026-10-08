import { LiveLoader as LiveLoader$1 } from 'astro/loaders';
import { E as EntryQuery } from './query-DgmKqS5C.js';

interface TalismanLoaderOptions {
    collection: string;
    version?: 'draft' | 'published';
    /** Relationship levels to embed, from 0 (the default) to 5. */
    depth?: number;
    /** Default collection page size, from 1 to 200; defaults to 50. */
    limit?: number;
    /** Supply published entries from a source available to Node during Astro builds. */
    buildEntries?: () => Promise<LiveDataEntry[]>;
}
type TalismanLiveLoaderOptions = TalismanLoaderOptions;
interface TalismanLiveReadFilter {
    version?: 'draft' | 'published';
    depth?: number;
    /** Pass Astro.request for draft previews; the configured CMS adapter verifies it. */
    request?: Request;
}
type TalismanLiveEntryFilter = TalismanLiveReadFilter & ({
    id: string;
    slug?: never;
} | {
    slug: string;
    id?: never;
});
interface TalismanLiveCollectionFilter extends TalismanLiveReadFilter, EntryQuery {
    limit?: number;
}
/** Entry data shared by request-time reads and explicit build-time sources. */
interface LiveDataEntry {
    id: string;
    data: Record<string, any>;
}
interface LiveDataCollectionResult {
    entries?: Array<LiveDataEntry>;
    error?: Error;
}
interface LiveDataEntryResult {
    entry?: LiveDataEntry;
    error?: Error;
}
type LiveLoader = LiveLoader$1<Record<string, any>, TalismanLiveEntryFilter, TalismanLiveCollectionFilter>;
interface ContentLayerLoaderContext {
    store: {
        get: (id: string) => any;
        set: (entry: {
            id: string;
            data: Record<string, any>;
            digest?: string;
            rendered?: any;
        }) => void;
        delete: (id: string) => void;
        clear: () => void;
        entries: () => [string, any][];
        has: (id: string) => boolean;
    };
    meta?: {
        get: (key: string) => any;
        set: (key: string, value: any) => void;
    };
    logger?: {
        info: (message: string) => void;
        warn: (message: string) => void;
        error: (message: string) => void;
        debug: (message: string) => void;
    };
    generateDigest?: (data: any) => string;
    parseData?: (entry: {
        id: string;
        data: Record<string, any>;
    }) => Promise<Record<string, any>>;
}
interface TalismanLoader extends LiveLoader {
    name: string;
    load: (context: ContentLayerLoaderContext) => Promise<void>;
}
/**
 * Astro 7 Content Layer & Live Collections Loader for Talisman CMS
 */
declare function talismanLoader(options: TalismanLoaderOptions): TalismanLoader;
/**
 * Backwards compatibility alias for Astro Live Collections
 */
declare const talismanLiveLoader: typeof talismanLoader;

export { type ContentLayerLoaderContext, type LiveDataCollectionResult, type LiveDataEntry, type LiveDataEntryResult, type LiveLoader, type TalismanLiveCollectionFilter, type TalismanLiveEntryFilter, type TalismanLiveLoaderOptions, type TalismanLiveReadFilter, type TalismanLoader, type TalismanLoaderOptions, talismanLiveLoader, talismanLoader };
