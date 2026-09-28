import { getTableColumns } from 'drizzle-orm';
import { createSchemaFactory } from 'drizzle-orm/zod';
import { columnKind } from '../db/column-kind';
import { validatePresetPayload } from '../presets';
import {
  buildZodSchemaForCollection,
  describeInvalidEntryId,
  describeInvalidEntrySlug,
  findUnwritableNativeColumns,
  isGlobalData,
  nextNativeUpdatedAt,
  normalizeBlankNativeValues,
  pickConfiguredNativeFields,
  type CollectionConfig,
  type CollectionHooks,
  type FieldDefinition,
  type FieldValidationIssue,
  type UiLibraryDefinition
} from '../types';
import { isMediaCollection } from '../db/media-policy';
import type { Actor } from './actor';
import { InvalidInputError, ValidationError } from './errors';
import { runHooks, type HookLogEntry } from './hooks';

/** A collection as a write sees it: its configuration, the fields in force and its native table, if any. */
export interface WriteCollection {
  config: CollectionConfig;
  slug: string;
  activeFields: FieldDefinition[];
  nativeTable: Record<string, any> | null;
  nativeIdCol: string;
}

/** Which native columns a caller may write: the configured fields, or any column (server code). */
export type WritableColumns = 'configured' | 'any';

export interface PrepareWriteInput {
  collection: WriteCollection;
  operation: 'create' | 'update';
  actor: Actor;
  /** The submitted data: an object, or JSON text. Undefined on an update that only renames. */
  data?: unknown;
  /** A client-chosen id (create only). */
  id?: unknown;
  /** A client-chosen slug (entries only). */
  slug?: unknown;
  /** The row an update changes: the entry row, or the native row. */
  stored?: Record<string, any>;
  /** The record as hooks see it before the change. */
  originalDoc?: any;
  req?: Request;
  columns?: WritableColumns;
  uiLibraries: UiLibraryDefinition[];
  hooks?: CollectionHooks;
  log?: HookLogEntry[];
}

export interface PreparedWrite {
  /** The validated data after the before* hooks; undefined for an update without data. */
  data?: Record<string, any>;
  id?: string;
  slug?: string;
  /** For a native table: the column values the insert or update writes. */
  nativePayload?: Record<string, any>;
}

// Set by the upload from the stored file; changing them would repoint or relabel the asset.
const UPLOAD_MANAGED_MEDIA_FIELDS = ['url', 'mimeType'];
const PRESETS_COLLECTION = '_ui_component_presets';

const isBlank = (value: unknown) => value === undefined || value === null || value === '';

/** Entry data may arrive as JSON text; either way it must be an object. */
export function readEntryData(data: unknown): Record<string, any> {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new InvalidInputError('Entry data is not valid JSON.');
    }
  }
  if (!isGlobalData(value)) throw new InvalidInputError('Entry data must be a JSON object.');
  return value;
}

// The column schemas coerce date strings, which the admin sends for a date field, into the Dates
// the timestamp columns take.
const columnSchemas = createSchemaFactory({ coerce: { date: true } });
const tableSchemas = new WeakMap<object, { create: ReturnType<typeof columnSchemas.createInsertSchema>; update: ReturnType<typeof columnSchemas.createUpdateSchema> }>();

/**
 * The column-level check of a native payload, after the collection's fields validated it: every
 * value must fit its column's type, an enum column takes one of its values, a NOT NULL column
 * without a default is present on a create and never set to null. The schema is read from the
 * table itself, so a rule the database enforces answers 400 with the column in the error path
 * instead of reaching D1, whose refusal names no column. Returns the payload as the columns take it.
 */
export function checkNativeColumns(table: Record<string, any>, payload: Record<string, any>, operation: 'create' | 'update') {
  let schemas = tableSchemas.get(table);
  if (!schemas) {
    schemas = { create: columnSchemas.createInsertSchema(table as any), update: columnSchemas.createUpdateSchema(table as any) };
    tableSchemas.set(table, schemas);
  }
  const parsed = schemas[operation].safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((issue): FieldValidationIssue => ({ path: [...issue.path], message: issue.message, code: issue.code })));
  }
  return parsed.data as Record<string, any>;
}

/** A native id may be a whole number (integer keys) or text in the entry id format. */
export function describeInvalidNativeId(value: unknown) {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? null : 'Record id must be a whole number or text';
  return describeInvalidEntryId(value);
}

/** Columns the server sets itself; a client may send them back, and they are dropped. */
export function nativeSystemColumns(collection: Pick<WriteCollection, 'nativeIdCol'>) {
  return [collection.nativeIdCol, 'createdAt', 'updatedAt'];
}

function invalid(message: string, path: PropertyKey[] = []): never {
  throw new ValidationError([{ path, message }]);
}

/** The columns a caller may write, by actor: the configured fields for users, any column for server code. */
export function writableColumns(actor: Actor, requested?: WritableColumns): WritableColumns {
  return actor.kind === 'user' ? 'configured' : requested ?? 'any';
}

/**
 * The values a native insert or update writes, from validated data. Table defaults still apply:
 * an id is generated only for a text column without a default of its own and a field not typed as
 * a number, and only integer timestamp columns are stamped (text ones keep `CURRENT_TIMESTAMP`).
 * Users never write the id or timestamps; trusted server code may pass its own, and an update it
 * leaves unstamped still moves `updatedAt` forward, so an editor's stale check keeps working.
 */
export function prepareNativeWrite(
  collection: WriteCollection,
  data: Record<string, any>,
  options: { mode: 'create' | 'update'; stored?: Record<string, any>; trusted: boolean }
): Record<string, any> {
  const payload: Record<string, any> = { ...data };
  const columns = getTableColumns(collection.nativeTable as any) as Record<string, any>;
  const idColumn = collection.nativeIdCol;

  for (const field of collection.activeFields) {
    if (field.type === 'array' && field.fields?.length === 1 && field.fields[0].name === 'url' && Array.isArray(payload[field.name])) {
      payload[field.name] = payload[field.name].map((item: unknown) =>
        item && typeof item === 'object' && 'url' in item ? (item as { url: unknown }).url : item
      );
    }
  }
  for (const key of nativeSystemColumns(collection)) {
    if (payload[key] === '') delete payload[key];
  }
  const dateColumn = (key: string) => columnKind(columns[key]) === 'date';
  const blank = (key: string) => payload[key] === undefined || payload[key] === null;

  if (options.mode === 'update') {
    delete payload[idColumn];
    if (!options.trusted) delete payload.createdAt;
    if (dateColumn('updatedAt') && (!options.trusted || blank('updatedAt'))) {
      payload.updatedAt = nextNativeUpdatedAt(options.stored?.updatedAt);
    }
    return payload;
  }

  const idField = collection.activeFields.find((field) => field.name === idColumn);
  const column = columns[idColumn];
  if (blank(idColumn) && idField?.type !== 'number' && columnKind(column) !== 'number' && !(column?.hasDefault || column?.defaultFn)) {
    payload[idColumn] = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const now = new Date();
  for (const key of ['createdAt', 'updatedAt']) {
    if (dateColumn(key) && (!options.trusted || (blank(key) && !columns[key].hasDefault))) payload[key] = now;
  }
  return payload;
}

/**
 * The one write pipeline, for entries and native rows through the admin API and the SDK: the data's
 * shape, the id and slug formats, the native column allowlist, blank values, the beforeValidate
 * hooks, the collection's schema, component presets, the beforeChange hooks and, for a native
 * table, the column values to write. It throws a ValidationError, an InvalidInputError or a hook's
 * error, and writes nothing.
 */
export async function prepareWrite(input: PrepareWriteInput): Promise<PreparedWrite> {
  const { collection, operation, actor } = input;
  const { config, activeFields, nativeTable, nativeIdCol } = collection;
  const columns = writableColumns(actor, input.columns);
  const hookArgs = { actor, req: input.req, collection: { slug: collection.slug, native: Boolean(nativeTable) }, operation, originalDoc: input.originalDoc };
  const hookOptions = { log: input.log };

  let slug: string | undefined;
  if (!nativeTable) {
    if (operation === 'create') {
      const idProblem = isBlank(input.id) ? null : describeInvalidEntryId(input.id);
      if (idProblem) invalid(idProblem);
      const slugProblem = isBlank(input.slug) ? null : describeInvalidEntrySlug(input.slug);
      if (slugProblem) invalid(slugProblem);
    } else {
      // A blank slug keeps the current one; a published entry's rename waits for its next publish.
      // Only a new slug is checked, so an entry whose slug predates the format rules can still be
      // saved (the editor always sends the slug back).
      const current = input.stored?.draftSlug || input.stored?.slug;
      const renamed = !isBlank(input.slug) && input.slug !== current;
      const slugProblem = renamed ? describeInvalidEntrySlug(input.slug) : null;
      if (slugProblem) invalid(slugProblem);
    }
    slug = isBlank(input.slug) ? undefined : String(input.slug);
  }
  const id = operation === 'create' && !isBlank(input.id) ? input.id : undefined;

  if (input.data === undefined) {
    if (operation === 'create') return prepareWrite({ ...input, data: {} });
    return { slug };
  }

  let data = readEntryData(input.data);

  if (nativeTable) {
    if (columns === 'configured') {
      // The configured fields are the columns a client may write; hooks can still set others.
      const unwritable = findUnwritableNativeColumns(activeFields, nativeTable, data, {
        ignore: nativeSystemColumns(collection),
        stored: operation === 'update' ? input.stored : undefined,
      });
      if (unwritable.length > 0) {
        throw new ValidationError(unwritable.map((column): FieldValidationIssue => ({
          path: [column],
          message: 'Not a field of this collection, so it cannot be saved here',
        })));
      }
      let submitted = pickConfiguredNativeFields(activeFields, nativeTable, data);
      if (operation === 'update' && isMediaCollection(config)) {
        const changed = UPLOAD_MANAGED_MEDIA_FIELDS.filter((field) => field in submitted && submitted[field] !== input.stored?.[field]);
        if (changed.length > 0) {
          throw new ValidationError(changed.map((field) => ({ path: [field], message: 'Set by the upload and cannot be changed' })));
        }
        submitted = { ...submitted };
        for (const field of UPLOAD_MANAGED_MEDIA_FIELDS) delete submitted[field];
      }
      data = submitted;
    }
    data = normalizeBlankNativeValues(config, activeFields, nativeTable, data);
    if (operation === 'create') {
      for (const [value, path] of [[id, []], [data[nativeIdCol], [nativeIdCol]]] as const) {
        const problem = describeInvalidNativeId(value);
        if (problem) invalid(problem, [...path]);
      }
    }
  }

  data = await runHooks(input.hooks, 'beforeValidate', { ...hookArgs, data }, hookOptions);

  // A native update writes only the columns it sends (an editor leaves out stock it did not
  // change), so an omitted required column keeps its stored value.
  const schema = buildZodSchemaForCollection({ ...config, fields: activeFields });
  const parsed = (nativeTable && operation === 'update' ? schema.partial() : schema).safeParse(data);
  if (!parsed.success) throw new ValidationError(parsed.error.issues);
  data = parsed.data;

  if (collection.slug === PRESETS_COLLECTION) {
    const result = validatePresetPayload(input.uiLibraries, data);
    if (!result.success) throw new ValidationError(result.issues);
    data = result.normalizedData;
  }

  data = await runHooks(input.hooks, 'beforeChange', { ...hookArgs, data }, hookOptions);

  const prepared: PreparedWrite = { data, slug, id: id === undefined ? undefined : String(id) };
  if (nativeTable) {
    prepared.nativePayload = checkNativeColumns(nativeTable, prepareNativeWrite(collection, {
      ...data,
      ...(operation === 'create' && nativeTable[nativeIdCol] && id !== undefined ? { [nativeIdCol]: id } : {}),
    }, { mode: operation, stored: input.stored, trusted: columns === 'any' }), operation);
  }
  return prepared;
}
