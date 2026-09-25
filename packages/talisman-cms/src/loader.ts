export interface TalismanLoaderOptions {
  collection: string;
  version?: 'draft' | 'published';
  /** Supply published entries from a source available to Node during Astro builds. */
  buildEntries?: () => Promise<LiveDataEntry[]>;
}

export type TalismanLiveLoaderOptions = TalismanLoaderOptions;

// We define the minimal shape of an Astro LiveLoader to avoid strictly importing internal Astro types
export interface LiveDataEntry {
  id: string;
  data: Record<string, any>;
}

export interface LiveDataCollectionResult {
  entries?: Array<LiveDataEntry>;
  error?: Error;
}

export interface LiveDataEntryResult {
  entry?: LiveDataEntry;
  error?: Error;
}

export interface LiveLoader {
  name: string;
  loadEntry: (context: { filter: any; collection: string }) => Promise<LiveDataEntry | undefined | { error: Error }>;
  loadCollection: (context: { filter?: any; collection: string }) => Promise<{ entries: Array<LiveDataEntry> } | { error: Error }>;
}

export interface ContentLayerLoaderContext {
  store: {
    get: (id: string) => any;
    set: (entry: { id: string; data: Record<string, any>; digest?: string; rendered?: any }) => void;
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
  parseData?: (entry: { id: string; data: Record<string, any> }) => Promise<Record<string, any>>;
}

export interface TalismanLoader extends LiveLoader {
  name: string;
  load: (context: ContentLayerLoaderContext) => Promise<void>;
}

/**
 * Astro 7 Content Layer & Live Collections Loader for Talisman CMS
 */
export function talismanLoader(options: TalismanLoaderOptions): TalismanLoader {
  return {
    name: 'talisman-cms-loader',
    load: async (context: ContentLayerLoaderContext) => {
      const { store, generateDigest } = context;
      if (!options.buildEntries) {
        throw new Error(`talismanLoader(${options.collection}) needs buildEntries for Astro content sync. Use talismanLiveLoader for request-time Cloudflare data.`);
      }
      const entries = await options.buildEntries();
      store.clear();
      for (const entry of entries) {
        store.set({
          id: entry.id,
          data: entry.data,
          digest: generateDigest ? generateDigest(entry.data) : undefined,
        });
      }
    },
    loadEntry: async (context: { filter: any; collection: string }) => {
      try {
        const { fetchLiveEntry } = await import('./loader.server');
        return await fetchLiveEntry(options, context.filter);
      } catch (err: any) {
        return { error: err };
      }
    },
    loadCollection: async (context: { filter?: any; collection: string }) => {
      try {
        const { fetchLiveCollection } = await import('./loader.server');
        return await fetchLiveCollection(options, context.filter);
      } catch (err: any) {
        return { error: err };
      }
    }
  };
}

/**
 * Backwards compatibility alias for Astro Live Collections
 */
export const talismanLiveLoader = talismanLoader;
