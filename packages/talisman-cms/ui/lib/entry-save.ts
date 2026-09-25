// Pure helpers for saving entries and reading save failures. They take plain field definitions and
// values, so they have no imports and can be tested on their own.

type SaveTarget = {
  /**
   * A native collection writes table columns. A blank ('', undefined or null) optional value that is
   * not free text is left out of a new row, so the column default applies, and becomes null on an
   * update, so the column is cleared. Blank free text is sent as '': only the server knows whether
   * the column takes NULL.
   */
  native?: boolean;
  mode?: 'create' | 'update';
  /** The values as loaded. On a native update a value the user did not change is sent back as loaded. */
  baseline?: Record<string, any> | null;
};

// In stored JSON an empty string is kept for text, but never for these types: it is not a number,
// not one of the options, and not the id of a related record.
const BLANK_MEANS_NULL_TYPES = new Set(['number', 'select', 'relationship', 'relation']);
// Free text a NOT NULL column may hold as ''; the server maps a blank to NULL where the column allows it.
const FREE_TEXT_TYPES = new Set(['text', 'textarea', 'color', 'media']);
const CONTAINER_TYPES = new Set(['group', 'array', 'blocks']);

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The form holds '' for an optional number, select or relation left blank, which the server refuses
 * for a number ("Expected number") and checks against the options or a foreign key. This turns those
 * blanks into null, or leaves them out of a new native row, down through groups, arrays and blocks.
 */
export function prepareFieldValuesForSave(fields: any[] | undefined, values: any, target: SaveTarget = {}): any {
  if (!isPlainObject(values)) return values;
  const next: Record<string, any> = { ...values };

  for (const field of fields || []) {
    const name = field?.name;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(next, name)) continue;
    const value = next[name];

    if (CONTAINER_TYPES.has(field.type)) {
      next[name] = prepareNestedValue(field, value);
      continue;
    }

    if (field.required || field.type === 'boolean') continue;

    if (target.native) {
      // A cleared optional number input holds null rather than '', and is just as blank.
      const blank = value === '' || value === undefined || value === null;
      if (!blank || FREE_TEXT_TYPES.has(field.type)) continue;
      if (target.mode === 'create') {
        delete next[name];
      } else if (!(target.baseline && Object.is(target.baseline[name], value))) {
        next[name] = null;
      }
      continue;
    }

    if (value === '' && BLANK_MEANS_NULL_TYPES.has(field.type)) next[name] = null;
  }

  return next;
}

// Nested values are stored as JSON (in an entry, a global, or a native JSON column).
function prepareNestedValue(field: any, value: any): any {
  if (field.type === 'group') return prepareFieldValuesForSave(field.fields, value);
  if (!Array.isArray(value)) return value;
  if (field.type === 'array') return value.map((item) => prepareFieldValuesForSave(field.fields, item));
  return value.map((item) => prepareBlockValue(field, item));
}

function prepareBlockValue(field: any, item: any): any {
  if (!isPlainObject(item)) return item;
  const block = (field.blocks || []).find((candidate: any) => candidate?.slug === item.blockType);
  if (!block) return item;

  const next = prepareFieldValuesForSave(block.fields, item);
  for (const slot of block.componentSlots || []) {
    if (!slot?.name || !Object.prototype.hasOwnProperty.call(next, slot.name)) continue;
    const slotValue = next[slot.name];
    next[slot.name] = Array.isArray(slotValue)
      ? slotValue.map((slotItem) => prepareComponentValue(slot, slotItem))
      : prepareComponentValue(slot, slotValue);
  }
  return next;
}

function prepareComponentValue(slot: any, item: any): any {
  if (!isPlainObject(item) || item.mode === 'preset') return item;
  const component = (slot.components || []).find((candidate: any) => candidate?.slug === item.componentType);
  return component ? prepareFieldValuesForSave(component.fields, item) : item;
}

/** A failed request as the editor sees it: HTTP status, the body's `code` and its message. */
export type SaveFailure = { status: number; code?: string | null; message: string };

// The server answers 409 for three different problems and says which in `code`.
const STALE_RECORD_CODES = new Set(['revision_conflict', 'stale_record']);
// Servers that send no `code` word a stale edit like this ("This entry changed since it was opened...").
const STALE_RECORD_MESSAGE = /changed since it was opened/i;
const SLUG_CONFLICT_MESSAGE = /already uses this slug/i;

/** True when someone else changed the record after it was loaded, so loading the latest version helps. */
export function isStaleRecordConflict({ status, code, message }: SaveFailure) {
  if (status !== 409) return false;
  return code ? STALE_RECORD_CODES.has(code) : STALE_RECORD_MESSAGE.test(message);
}

/** True when another entry in the collection already uses the slug; only a different slug helps. */
export function isSlugConflict({ status, code, message }: SaveFailure) {
  if (code) return code === 'slug_conflict';
  return (status === 409 || status === 422) && SLUG_CONFLICT_MESSAGE.test(message);
}

/**
 * A published entry keeps its live slug until the next publish. Returns both slugs when the slug
 * being edited (the saved draft slug, or what is typed now) differs from the live one.
 */
export function getPendingSlugRename(entry: any, editedSlug: unknown = entry?.slug) {
  const liveSlug = typeof entry?.publishedSlug === 'string' ? entry.publishedSlug : '';
  const nextSlug = typeof editedSlug === 'string' ? editedSlug.trim() : '';
  if (!liveSlug || !nextSlug || nextSlug === liveSlug) return null;
  return { liveSlug, nextSlug };
}

/** The site path of a page in the `pages` collection. */
export function getPagePath(slug: string | null | undefined) {
  if (!slug || slug === 'index') return '/';
  return `/${slug}`;
}

/** A publish or archive that a publishing Workflow was still running when the server stopped waiting. */
export type PendingTransition = {
  action: string;
  entryId: string;
  /** The entry's latest revision when the transition was asked for. A finished transition adds a newer one. */
  fromRevisionId: string | null;
  /** What the editor shows while it waits. */
  message: string;
};

/**
 * With a publishing Workflow binding, a publish or archive that is still running after the server's
 * wait is answered with HTTP 202: the entry as stored before the transition, `workflow: { status:
 * 'pending' }` and a `message` for editors. Returns the transition to wait for, or null when the
 * answer is the entry after a finished transition.
 */
export function readPendingTransition(
  result: any,
  { action, entryId, fromRevisionId, recordLabel = 'entry' }: { action: string; entryId: string; fromRevisionId?: string | null; recordLabel?: string }
): PendingTransition | null {
  if (result?.workflow?.status !== 'pending') return null;
  const message = typeof result.message === 'string' && result.message.trim()
    ? result.message.trim()
    : `The ${action} is still running. Reload the ${recordLabel} in a moment to see the result.`;
  return { action, entryId, fromRevisionId: fromRevisionId ?? null, message };
}

/**
 * Every publish and archive adds a revision, so the entry has moved on from a pending transition once
 * its latest revision is no longer the one the transition started from.
 */
export function hasEntryMovedOn(entry: any, pending: Pick<PendingTransition, 'fromRevisionId'>) {
  return isPlainObject(entry) && (entry.latestRevisionId ?? null) !== pending.fromRevisionId;
}

/** The notice for an entry that moved on from a pending transition: finished, or changed some other way. */
export function describeSettledTransition(entry: any, pending: PendingTransition, recordLabel = 'entry') {
  if (pending.action === 'publish' && entry?.status === 'published' && entry.publishedRevisionId === entry.latestRevisionId) {
    return `The ${recordLabel} is published.`;
  }
  if (pending.action === 'archive' && entry?.status === 'archived') return `The ${recordLabel} is archived.`;
  return `The ${recordLabel} changed while the ${pending.action} was running. Check its status before you try the ${pending.action} again.`;
}

/** How long the editor waits before each check of a publish or archive that is still running. */
export const PENDING_TRANSITION_CHECK_DELAYS_MS = [3000, 6000, 10000];

/**
 * Loads the entry after each delay until it has moved on from the pending transition. Resolves with
 * that entry, or null when it has not moved on by the last check or `isCancelled` returns true. A
 * check that fails counts as "not yet".
 */
export async function waitForPendingTransition(
  pending: Pick<PendingTransition, 'fromRevisionId'>,
  {
    loadEntry,
    delays = PENDING_TRANSITION_CHECK_DELAYS_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    isCancelled = () => false,
  }: {
    loadEntry: () => Promise<any>;
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    isCancelled?: () => boolean;
  }
): Promise<any | null> {
  for (const delay of delays) {
    await sleep(delay);
    if (isCancelled()) return null;
    try {
      const entry = await loadEntry();
      if (isCancelled()) return null;
      if (hasEntryMovedOn(entry, pending)) return entry;
    } catch {
      // The next check tries again; after the last one the editor offers a manual reload.
    }
  }
  return null;
}
