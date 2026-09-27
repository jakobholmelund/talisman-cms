import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { FieldDefinition } from '../types';
import { InvalidInputError, ValidationError } from './errors';

export type Scalar = string | number | boolean | null;

/** The comparisons a `where` clause may make; which apply depends on the field's type. */
export interface Operators {
  eq?: Scalar;
  ne?: Scalar;
  in?: Scalar[];
  lt?: Scalar;
  lte?: Scalar;
  gt?: Scalar;
  gte?: Scalar;
  /** Whether a relationship or array field holds the value. */
  contains?: Scalar;
  isNull?: boolean;
}

/** `{ field: value }` means equality; `{ field: { op: value } }` names the comparison. */
export type WhereClause = Record<string, Scalar | Operators>;

export interface EntryQuery {
  where?: WhereClause;
  /** Field names, `-` for descending; at most two. */
  sort?: string | string[];
  /** Rows to skip, with `limit`; at most 10000. */
  offset?: number;
}

export const MAX_WHERE_CLAUSES = 8;
export const MAX_SORT_KEYS = 2;
export const MAX_OFFSET = 10_000;
// D1 binds 100 parameters per statement; the collection and status filters and the page take the rest.
export const MAX_BOUND_PARAMETERS = 90;

const OPERATORS = new Set(['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte', 'contains', 'isNull']);
const ORDERED_TYPES = new Set(['number', 'date', 'timestamp']);
const ENTRY_SYSTEM_FIELDS: Record<string, { type: string; column: keyof typeof schema.entries }> = {
  id: { type: 'text', column: 'id' },
  slug: { type: 'text', column: 'slug' },
  status: { type: 'text', column: 'status' },
  createdAt: { type: 'timestamp', column: 'createdAt' },
  updatedAt: { type: 'timestamp', column: 'updatedAt' },
  publishedAt: { type: 'timestamp', column: 'publishedAt' },
};

/** What a query runs against: the entries table with a data view, or a native table. */
export type QueryTarget =
  | { kind: 'entries'; fields: FieldDefinition[]; data: SQL }
  | { kind: 'native'; fields: FieldDefinition[]; table: Record<string, any> };

interface ResolvedField {
  name: string;
  type: string;
  /** For entries, the field lives in the JSON data; `contains` works on its array. */
  json: boolean;
  list: boolean;
  expression: SQL | any;
  /** Bound parameters the expression itself takes (the JSON path). */
  parameters: number;
}

/** The draft data of the entries table, or the published snapshot where one exists. */
export function entryDataExpression(view: 'draft' | 'published'): SQL {
  const entries = schema.entries;
  return view === 'published'
    ? sql`CASE WHEN ${entries.status} = 'published' AND ${entries.publishedData} IS NOT NULL THEN ${entries.publishedData} ELSE ${entries.data} END`
    : sql`${entries.data}`;
}

function refuse(name: string, message: string): never {
  throw new ValidationError([{ path: [name], message }]);
}

const isColumn = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && 'dataType' in (value as object);

/** A field named in `where` or `sort`: a system field, a configured field, or a native column. */
function resolveField(target: QueryTarget, name: string): ResolvedField {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return refuse(String(name), 'Not a field of this collection');
  if (target.kind === 'entries') {
    const system = ENTRY_SYSTEM_FIELDS[name];
    if (system) return { name, type: system.type, json: false, list: false, expression: schema.entries[system.column], parameters: 0 };
    const field = target.fields.find((candidate) => candidate.name === name);
    if (!field) return refuse(name, 'Not a field of this collection');
    const list = field.type === 'array' || Boolean(field.hasMany);
    // The path is bound, never spliced into the statement.
    return { name, type: field.type, json: true, list, expression: sql`json_extract(${target.data}, ${'$.' + name})`, parameters: 1 };
  }
  const columns = target.table;
  const property = isColumn(columns[name]) ? name : Object.keys(columns).find((key) => isColumn(columns[key]) && columns[key].name === name);
  if (!property) return refuse(name, 'Not a field of this collection');
  const column = columns[property];
  const field = target.fields.find((candidate) => candidate.name === property || candidate.name === column.name);
  const type = field?.type ?? (column.dataType === 'date' ? 'timestamp' : column.dataType === 'number' ? 'number' : column.dataType === 'boolean' ? 'boolean' : 'text');
  return { name, type, json: false, list: false, expression: column, parameters: 0 };
}

/** The value a comparison binds, cast by the field's type; HTTP sends everything as text. */
function castValue(field: ResolvedField, value: Scalar): unknown {
  if (value === null) return null;
  switch (field.type) {
    case 'number': {
      const number = typeof value === 'number' ? value : Number(value);
      if (typeof value === 'boolean' || Number.isNaN(number)) refuse(field.name, `"${value}" is not a number`);
      return number;
    }
    case 'boolean': {
      const bool = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
      if (bool === null) refuse(field.name, `"${value}" is not true or false`);
      // JSON stores booleans as 1 and 0.
      return field.json ? (bool ? 1 : 0) : bool;
    }
    case 'timestamp': {
      const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
      if (Number.isNaN(date.getTime())) refuse(field.name, `"${value}" is not a date`);
      return date;
    }
    default:
      return typeof value === 'boolean' ? String(value) : value;
  }
}

/**
 * Compiles a `where`, `sort` and `offset` into SQL for the target. Field names must be configured
 * fields or system fields, operators must fit the field's type, and the values are bound, so no
 * input reaches the statement text. Returns null clauses for an empty query.
 */
export function compileQuery(target: QueryTarget, query: EntryQuery) {
  let parameters = 0;
  const clauses: SQL[] = [];
  const entries = Object.entries(query.where ?? {});
  if (entries.length > MAX_WHERE_CLAUSES) throw new InvalidInputError(`where takes at most ${MAX_WHERE_CLAUSES} fields.`);

  for (const [name, condition] of entries) {
    const field = resolveField(target, name);
    const operators: Operators = condition !== null && typeof condition === 'object' && !Array.isArray(condition) ? condition : { eq: condition as Scalar };
    for (const [operator, raw] of Object.entries(operators)) {
      if (!OPERATORS.has(operator)) refuse(name, `"${operator}" is not a comparison`);
      parameters += field.parameters;
      switch (operator) {
        case 'eq':
        case 'ne': {
          const value = castValue(field, raw as Scalar);
          if (value === null) {
            clauses.push(operator === 'eq' ? isNull(field.expression) : isNotNull(field.expression));
          } else {
            parameters += 1;
            clauses.push(operator === 'eq' ? eq(field.expression, value) : ne(field.expression, value));
          }
          break;
        }
        case 'in': {
          const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw];
          if (list.length === 0) refuse(name, 'in needs at least one value');
          const values = list.map((value) => castValue(field, value as Scalar));
          if (values.some((value) => value === null)) refuse(name, 'in does not take null; use isNull');
          parameters += values.length;
          clauses.push(inArray(field.expression, values));
          break;
        }
        case 'lt':
        case 'lte':
        case 'gt':
        case 'gte': {
          if (!ORDERED_TYPES.has(field.type)) refuse(name, `${operator} needs a number or date field`);
          const value = castValue(field, raw as Scalar);
          if (value === null) refuse(name, `${operator} does not take null`);
          parameters += 1;
          const compare = { lt, lte, gt, gte }[operator];
          clauses.push(compare(field.expression, value));
          break;
        }
        case 'contains': {
          if (!field.json || !field.list) refuse(name, 'contains needs a relationship with hasMany or an array field');
          const value = castValue(field, raw as Scalar);
          if (value === null) refuse(name, 'contains does not take null');
          parameters += 1;
          clauses.push(sql`EXISTS (SELECT 1 FROM json_each(${field.expression}) WHERE json_each.value = ${value})`);
          break;
        }
        case 'isNull': {
          if (raw !== true && raw !== false && raw !== 'true' && raw !== 'false') refuse(name, 'isNull takes true or false');
          clauses.push(raw === true || raw === 'true' ? isNull(field.expression) : isNotNull(field.expression));
          break;
        }
      }
    }
  }
  if (parameters > MAX_BOUND_PARAMETERS) throw new InvalidInputError(`The query binds too many values (at most ${MAX_BOUND_PARAMETERS}).`);

  const sortKeys = (typeof query.sort === 'string' ? query.sort.split(',') : query.sort ?? []).map((key) => key.trim()).filter(Boolean);
  if (sortKeys.length > MAX_SORT_KEYS) throw new InvalidInputError(`sort takes at most ${MAX_SORT_KEYS} fields.`);
  const orderBy = sortKeys.map((key) => {
    const descending = key.startsWith('-');
    const field = resolveField(target, descending ? key.slice(1) : key);
    return descending ? desc(field.expression) : asc(field.expression);
  });

  if (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > MAX_OFFSET)) {
    throw new InvalidInputError(`offset must be a whole number from 0 to ${MAX_OFFSET}.`);
  }

  return {
    where: clauses.length > 0 ? and(...clauses) : undefined,
    orderBy,
    offset: query.offset,
    /** Whether the query narrows, orders or skips, in which case its result is never cached. */
    custom: clauses.length > 0 || orderBy.length > 0 || Boolean(query.offset),
  };
}
