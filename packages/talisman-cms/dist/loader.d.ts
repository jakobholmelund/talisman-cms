interface TalismanLoaderOptions {
    collection: string;
    version?: 'draft' | 'published';
    /** Supply published entries from a source available to Node during Astro builds. */
    buildEntries?: () => Promise<LiveDataEntry[]>;
}
type TalismanLiveLoaderOptions = TalismanLoaderOptions;
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
interface LiveLoader {
    name: string;
    loadEntry: (context: {
        filter: any;
        collection: string;
    }) => Promise<LiveDataEntry | undefined | {
        error: Error;
    }>;
    loadCollection: (context: {
        filter?: any;
        collection: string;
    }) => Promise<{
        entries: Array<LiveDataEntry>;
    } | {
        error: Error;
    }>;
}
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

export { type ContentLayerLoaderContext, type LiveDataCollectionResult, type LiveDataEntry, type LiveDataEntryResult, type LiveLoader, type TalismanLiveLoaderOptions, type TalismanLoader, type TalismanLoaderOptions, talismanLiveLoader, talismanLoader };
