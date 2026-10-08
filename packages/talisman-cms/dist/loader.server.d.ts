import { TalismanLoaderOptions, TalismanLiveCollectionFilter, LiveDataEntry, TalismanLiveEntryFilter } from './loader.js';
import 'astro/loaders';
import './query-DgmKqS5C.js';

declare function fetchLiveEntry(options: TalismanLoaderOptions, filter: TalismanLiveEntryFilter): Promise<LiveDataEntry | undefined>;
declare function fetchLiveCollection(options: TalismanLoaderOptions, filter?: TalismanLiveCollectionFilter): Promise<{
    entries: LiveDataEntry[];
}>;

export { fetchLiveCollection, fetchLiveEntry };
