import type { LiveLoader as AstroLiveLoader } from 'astro/loaders';
import type { EntryQuery } from './service/query';

export interface TalismanLoaderOptions {
  collection: string;
  version?: 'draft' | 'published';
  /** Relationship levels to embed, from 0 (the default) to 5. */
  depth?: number;
  /** Default collection page size, from 1 to 200; defaults to 50. */
  limit?: number;
  /** Supply published entries from a source available to Node during Astro builds. */
  buildEntries?: () => Promise<LiveDataEntry[]>;
}

export type TalismanLiveLoaderOptions = TalismanLoaderOptions;

export interface TalismanLiveReadFilter {
  version?: 'draft' | 'published';
  depth?: number;
  /** Pass Astro.request for draft previews; the configured CMS adapter verifies it. */
  request?: Request;
}

export type TalismanLiveEntryFilter = TalismanLiveReadFilter & (
  | { id: string; slug?: never }
  | { slug: string; id?: never }
);

export interface TalismanLiveCollectionFilter extends TalismanLiveReadFilter, EntryQuery {
  limit?: number;
}

/** Entry data shared by request-time reads and explicit build-time sources. */
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

export type LiveLoader = AstroLiveLoader<Record<string, any>, TalismanLiveEntryFilter, TalismanLiveCollectionFilter>;

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
    loadEntry: async (context) => {
      try {
        const { fetchLiveEntry } = await import('./loader.server');
        return await fetchLiveEntry(options, context.filter);
      } catch (err: any) {
        return { error: err };
      }
    },
    loadCollection: async (context) => {
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
