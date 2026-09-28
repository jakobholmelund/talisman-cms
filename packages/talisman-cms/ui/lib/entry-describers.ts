// The registered describer modules (Plugin.adminEntryDescribers) bound to the pure helpers in
// entry-labels.ts, for the relation pickers, summaries and the editor's data loader.
import { adminEntryDescribers } from 'virtual:talisman-cms/admin-extensions';
import {
  describeEntryWith,
  getEntryOptionLabel,
  getSupportCollectionSlugsWith,
  readAdminSetting,
  type EntriesBySlug,
  type EntryDescriberModule,
  type EntryLike,
} from './entry-labels';

const describers = adminEntryDescribers.map((describer) => describer.module as EntryDescriberModule);
const context = { readSetting: readAdminSetting };

/** Title, subtitle and details for a record: from the first describer that knows it, else generic. */
export function describeEntry(collectionSlug: string, entry: EntryLike | null | undefined, entriesBySlug: EntriesBySlug) {
  return describeEntryWith(describers, collectionSlug, entry, entriesBySlug, context);
}

export function getRelationOptionLabel(collectionSlug: string, entry: EntryLike, entriesBySlug: EntriesBySlug) {
  return getEntryOptionLabel(describeEntry(collectionSlug, entry, entriesBySlug));
}

/** The collections the editor of `collectionSlug` loads next to the entry, beyond its relation targets. */
export function getSupportCollectionSlugs(collectionSlug: string, relationTargets: string[] = []) {
  return getSupportCollectionSlugsWith(describers, collectionSlug, relationTargets);
}
