/**
 * Remembers which page builder cards (blocks and slot items) an editor collapsed.
 *
 * One storage key per entry, the editor's scope key, holds the card map of every field in that
 * entry, and an index key lists the entries in the order they were last written. Past
 * COLLAPSED_STATE_MAX_ENTRIES the oldest entry is dropped. Nothing is written while the stored
 * cards are unchanged, so mounting a field does not touch storage. Storage is a parameter so the
 * logic runs in node tests; the browser passes window.localStorage.
 *
 * This module imports nothing: test/admin-ui-lib.test.mjs compiles it alone.
 */

/** Card key (for example `layout:2`) to whether the card is collapsed. */
export type CollapsedCardsMap = Record<string, boolean>;

/** The part of the DOM Storage interface this module uses. */
export type CollapsedStateStorage = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const COLLAPSED_STATE_PREFIX = 'talisman-cms:collapsed:';
export const COLLAPSED_STATE_INDEX_KEY = `${COLLAPSED_STATE_PREFIX}index`;
export const COLLAPSED_STATE_MAX_ENTRIES = 50;

function getBrowserStorage(): CollapsedStateStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Reading window.localStorage throws when the browser blocks storage.
    return null;
  }
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Only collapsed cards are kept: an expanded card is the same as one never touched. */
function readCardsMap(value: unknown): CollapsedCardsMap {
  const cards: CollapsedCardsMap = {};
  if (!isRecord(value)) return cards;
  for (const [cardKey, collapsed] of Object.entries(value)) {
    if (collapsed === true) cards[cardKey] = true;
  }
  return cards;
}

function collapsedCardKeys(cards: CollapsedCardsMap | undefined) {
  return Object.keys(readCardsMap(cards)).sort().join('\n');
}

function readEntryRecord(storage: CollapsedStateStorage, scopeKey: string): Record<string, CollapsedCardsMap> {
  const parsed = parseJson(storage.getItem(scopeKey));
  const record: Record<string, CollapsedCardsMap> = {};
  if (!isRecord(parsed)) return record;
  for (const [fieldName, cards] of Object.entries(parsed)) {
    const map = readCardsMap(cards);
    if (Object.keys(map).length > 0) record[fieldName] = map;
  }
  return record;
}

/** The entries with remembered cards, oldest first. */
function readIndex(storage: CollapsedStateStorage): string[] {
  const parsed = parseJson(storage.getItem(COLLAPSED_STATE_INDEX_KEY));
  return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
}

function writeIndex(storage: CollapsedStateStorage, index: string[]) {
  if (index.length === 0) storage.removeItem(COLLAPSED_STATE_INDEX_KEY);
  else storage.setItem(COLLAPSED_STATE_INDEX_KEY, JSON.stringify(index));
}

/** Makes the entry the most recently used one and drops the oldest entries past the cap. */
function touchIndex(storage: CollapsedStateStorage, scopeKey: string) {
  const index = readIndex(storage).filter((key) => key !== scopeKey);
  index.push(scopeKey);
  const evicted = index.splice(0, Math.max(0, index.length - COLLAPSED_STATE_MAX_ENTRIES));
  for (const key of evicted) storage.removeItem(key);
  writeIndex(storage, index);
  return evicted;
}

function dropFromIndex(storage: CollapsedStateStorage, scopeKey: string) {
  const index = readIndex(storage);
  if (index.includes(scopeKey)) writeIndex(storage, index.filter((key) => key !== scopeKey));
}

/** The collapsed cards of one field of an entry; {} when nothing is remembered or storage is unavailable. */
export function readCollapsedCards(scopeKey: string | undefined, fieldName: string, storage = getBrowserStorage()): CollapsedCardsMap {
  if (!scopeKey || !storage) return {};
  try {
    return readEntryRecord(storage, scopeKey)[fieldName] || {};
  } catch {
    return {};
  }
}

/**
 * Remembers the collapsed cards of one field of an entry. Returns whether storage changed: it does
 * not while the stored cards are the same, and an entry with no collapsed card left is removed.
 */
export function writeCollapsedCards(scopeKey: string | undefined, fieldName: string, cards: CollapsedCardsMap, storage = getBrowserStorage()) {
  if (!scopeKey || !storage) return false;
  try {
    const record = readEntryRecord(storage, scopeKey);
    if (collapsedCardKeys(record[fieldName]) === collapsedCardKeys(cards)) return false;

    const next = readCardsMap(cards);
    if (Object.keys(next).length > 0) record[fieldName] = next;
    else delete record[fieldName];

    if (Object.keys(record).length === 0) {
      storage.removeItem(scopeKey);
      dropFromIndex(storage, scopeKey);
    } else {
      storage.setItem(scopeKey, JSON.stringify(record));
      touchIndex(storage, scopeKey);
    }
    return true;
  } catch {
    // Storage can be full or blocked; collapsed cards are a convenience.
    return false;
  }
}

/**
 * Removes every collapsed-state key the index does not list: the one-key-per-field state that
 * earlier versions wrote, and entries left behind by a failed write. Returns the removed keys.
 */
export function pruneCollapsedState(storage = getBrowserStorage()) {
  if (!storage) return [];
  try {
    const keep = new Set([COLLAPSED_STATE_INDEX_KEY, ...readIndex(storage)]);
    const stale: string[] = [];
    for (let position = 0; position < storage.length; position += 1) {
      const key = storage.key(position);
      if (key && key.startsWith(COLLAPSED_STATE_PREFIX) && !keep.has(key)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
    return stale;
  } catch {
    return [];
  }
}
