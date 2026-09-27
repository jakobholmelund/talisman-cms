// The entry editor's data: the route loader that gathers a collection, an entry, its history and the
// related records, and the admin API request helpers the editor shares with it. The editor component
// itself lives in components/editor and is loaded with its route, so nothing heavy belongs here.
import { formatFieldErrors, type ServerFieldErrors } from '../components/fields/field-errors';
import { buildRelationOptions, fieldsNeedPresetEntries } from '../components/fields/relations';
import { fetchCollectionConfigs, fetchEntriesBySlug } from './admin-api';
import { getCommerceSupportSlugs, type CommerceSupportEntries } from './commerce-models';
import { isSlugConflict, isStaleRecordConflict } from './entry-save';
import { collectRelationshipFields, getRelationTargets } from './page-builder';

/** How many revisions the history lists; the newest come first. */
export const REVISION_LIST_LIMIT = 50;

export function isNativeCollection(collection: any) {
  return Boolean(collection?.nativeSchemaMapping);
}

/** The collections whose records the editor needs next to the entry: relation targets, commerce models, presets. */
function getRelationSupportSlugs(collection: any) {
  if (!collection?.fields) return [];
  const relationFields = collectRelationshipFields(collection.fields);
  const relationTargets = [...new Set(relationFields.flatMap((field: any) => getRelationTargets(field)))];
  const supportSlugs = getCommerceSupportSlugs(collection.slug, relationTargets);
  if (fieldsNeedPresetEntries(collection.fields)) {
    supportSlugs.push('_ui_component_presets');
  }
  return supportSlugs;
}

export async function loadEntryEditorData(basePath: string, slug: string, entryId: string) {
  const isNew = entryId === 'new';
  const collections = await fetchCollectionConfigs(basePath);
  const collection = collections.find((c: any) => c.slug === slug);

  // The entry, its history and the related records do not depend on each other, so they load together.
  const [loadedEntry, revisions, relationSupportEntries] = await Promise.all([
    isNew ? Promise.resolve(null) : (async () => {
      const entryRes = await fetch(`${basePath}/api/collections/${slug}/entries/${entryId}`);
      if (!entryRes.ok) {
        throw await toRequestError(entryRes, entryRes.status === 404 ? 'This entry no longer exists' : 'Failed to load this entry');
      }
      return entryRes.json();
    })(),
    // Native records have no revision history; asking for it only produces a 400.
    isNew || !collection || isNativeCollection(collection)
      ? Promise.resolve([] as any[])
      : fetch(`${basePath}/api/collections/${slug}/entries/${entryId}/revisions?limit=${REVISION_LIST_LIMIT}`)
          .then(async (res) => (res.ok ? await res.json() as any[] : []))
          .catch(() => [] as any[]),
    collection ? fetchEntriesBySlug(basePath, getRelationSupportSlugs(collection), collections) : Promise.resolve({}),
  ]);

  const entry = loadedEntry as any;
  const relationOptions = buildRelationOptions(collection?.fields, relationSupportEntries);

  return { collection, entry, revisions, isNew, relationOptions, relationSupportEntries: relationSupportEntries as CommerceSupportEntries };
}

const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Sign in again in another tab, then try again. Your edits are still here.';

export class EditorRequestError extends Error {
  status: number;
  fieldErrors: ServerFieldErrors;
  /** The error body's machine-readable `code`, such as `revision_conflict` or `slug_conflict`. */
  code: string | null;

  constructor(message: string, status: number, fieldErrors: ServerFieldErrors = {}, code: string | null = null) {
    super(message);
    this.name = 'EditorRequestError';
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.code = code;
  }
}

/** True when the record changed after it was loaded, so the conflict panel and "Load latest version" help. */
export function isStaleEditError(error: unknown): error is EditorRequestError {
  return error instanceof EditorRequestError && isStaleRecordConflict(error);
}

/** True when another entry already uses the slug; the user has to choose another one. */
export function isSlugConflictError(error: unknown): error is EditorRequestError {
  return error instanceof EditorRequestError && isSlugConflict(error);
}

/** Converts an error path (`['layout', 0, 'title']` or `layout.0.title`) to the form's field name (`layout[0].title`). */
function toFormFieldPath(path: unknown) {
  const segments: unknown[] = Array.isArray(path) ? path : String(path ?? '').split(/[.[\]]+/);
  let fieldPath = '';
  for (const rawSegment of segments) {
    const segment = rawSegment && typeof rawSegment === 'object' && 'key' in rawSegment
      ? (rawSegment as { key: unknown }).key
      : rawSegment;
    if (segment === undefined || segment === null || segment === '') continue;
    const text = String(segment);
    fieldPath = /^\d+$/.test(text) ? `${fieldPath}[${text}]` : fieldPath ? `${fieldPath}.${text}` : text;
  }
  return fieldPath;
}

/** Reads `fieldErrors` ({ field: [messages] }) and legacy `issues` (Zod issues) from a 400 response body. */
function readFieldErrors(payload: any): ServerFieldErrors {
  const fieldErrors: ServerFieldErrors = {};
  const add = (fieldPath: string, messages: unknown) => {
    const next = formatFieldErrors(messages);
    if (next.length > 0) fieldErrors[fieldPath] = [...new Set([...(fieldErrors[fieldPath] || []), ...next])];
  };

  for (const source of [payload?.fieldErrors, payload?.details?.fieldErrors]) {
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [fieldPath, messages] of Object.entries(source)) add(toFormFieldPath(fieldPath), messages);
    }
  }
  if (Array.isArray(payload?.issues)) {
    for (const issue of payload.issues) add(toFormFieldPath(issue?.path), issue?.message);
  }
  return fieldErrors;
}

function readErrorMessage(payload: any) {
  for (const candidate of [payload?.error, payload?.message]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object' && typeof candidate.message === 'string' && candidate.message.trim()) {
      return candidate.message.trim();
    }
  }
  return '';
}

async function toRequestError(res: Response, fallback: string) {
  if (res.status === 401) return new EditorRequestError(SESSION_EXPIRED_MESSAGE, 401);
  const payload: any = await res.json().catch(() => null);
  const code = typeof payload?.code === 'string' && payload.code ? payload.code : null;
  return new EditorRequestError(readErrorMessage(payload) || `${fallback} (HTTP ${res.status})`, res.status, readFieldErrors(payload), code);
}

export async function requestEditorApi(url: string, init: RequestInit, fallback: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new EditorRequestError(`${fallback}: the server could not be reached. Your edits are still here.`, 0);
  }

  if (!res.ok) throw await toRequestError(res, fallback);
  return res.json().catch(() => {
    throw new EditorRequestError(`${fallback}: the server sent an unexpected response.`, res.status);
  });
}

/** One-line message for places that cannot highlight individual fields. */
export function describeRequestError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const fieldErrors = error instanceof EditorRequestError ? Object.entries(error.fieldErrors) : [];
  if (fieldErrors.length === 0) return error.message;
  return `${error.message}: ${fieldErrors.map(([fieldPath, messages]) => `${fieldPath || 'record'}: ${messages.join(', ')}`).join('; ')}`;
}
