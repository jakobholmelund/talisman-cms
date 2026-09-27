import { getEntryRevision, getLatestRevision, listEntryRevisions, restoreEntryRevision, toEditableEntry } from '../versioning';
import { assertAllowed } from './actor';
import { invalidateEntryCache } from './cache';
import { resolveCollection } from './collections';
import type { ServiceContext } from './context';
import { PreconditionRequiredError, UnsupportedOperationError } from './errors';
import { NATIVE_REVISIONS_MESSAGE } from './entries';

/** Revision history of versioned entries: listing, one revision, and restoring one. */
export function revisionsService(ctx: ServiceContext) {
  const { db, env } = ctx;

  async function versioned(slug: string, operation: 'read' | 'restore') {
    const collection = await resolveCollection(ctx, slug);
    assertAllowed(ctx.actor, collection.config, operation);
    if (collection.nativeTable) throw new UnsupportedOperationError(NATIVE_REVISIONS_MESSAGE);
    return collection;
  }

  return {
    /** Newest first. Without `includeData` the history lists metadata only; a revision's data loads on its own. */
    async list(slug: string, entryId: string, options: { includeData?: boolean; limit?: number } = {}) {
      const collection = await versioned(slug, 'read');
      return listEntryRevisions(db as any, collection.record.id, entryId, { includeData: options.includeData ?? false, limit: options.limit });
    },

    async get(slug: string, entryId: string, revisionId: string) {
      const collection = await versioned(slug, 'read');
      return getEntryRevision(db as any, collection.record.id, entryId, revisionId);
    },

    /** Restores a revision's data as a new revision; the caller names the latest revision it loaded. */
    async restore(slug: string, entryId: string, revisionId: string, options: { expectedRevisionId?: unknown } = {}) {
      const collection = await versioned(slug, 'restore');
      if (typeof options.expectedRevisionId !== 'string' || !options.expectedRevisionId) throw new PreconditionRequiredError();
      const restored = await restoreEntryRevision(db as any, collection.record as any, entryId, revisionId, options.expectedRevisionId);
      await invalidateEntryCache(env, slug, entryId);
      return { ...toEditableEntry(restored), latestRevisionId: (await getLatestRevision(db as any, entryId))?.id ?? null };
    },
  };
}
