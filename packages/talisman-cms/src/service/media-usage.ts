import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema';
import { columnKind } from '../db/column-kind';
import { getNativeIdColumn } from '../types';
import { assertAllowed, actorRole, canRead } from './actor';
import { configuredCollectionFields } from './collections';
import type { ServiceContext } from './context';
import { AccessDeniedError, NotFoundError, InvalidInputError } from './errors';

type Usage = { id: string; title: string; collection: string | null; kind: 'draft' | 'published' | 'revision' | 'native' | 'global'; entryId?: string };
type Source = { collection: string | null; kind: Usage['kind']; query: (take: number, offset: number) => SQL };
const PAGE_SIZE = 50;
const SOURCES_PER_REQUEST = 10;

/** Exact structured references, including transformed URLs with query strings/fragments. */
function references(data: SQL, id: string, urls: string[]) {
  return sql`EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(${data}) THEN ${data} ELSE '{}' END) AS media_ref
    WHERE media_ref.type = 'text' AND (media_ref.value = ${id} OR
      ${sql.join(urls.map(url => sql`(media_ref.value = ${url} OR
        substr(media_ref.value, 1, length(${url}) + 1) IN (${url + '?'}, ${url + '#'}))`), sql` OR `)}))`;
}

/** A bounded, read-only inventory; code, external sites and arbitrary HTML strings are outside its scope. */
export async function mediaUsage(ctx: ServiceContext, id: string, origin: string, cursor?: string | null) {
  if (actorRole(ctx.actor) !== 'admin') throw new AccessDeniedError('Admin access required');
  const mediaCollection = ctx.config.collections.find(collection => collection.slug === 'media');
  if (!mediaCollection) throw new NotFoundError('Media collection not found');
  assertAllowed(ctx.actor, mediaCollection, 'read');
  const media = await ctx.db.select().from(schema.media).where(sql`${schema.media.id} = ${id}`).get();
  if (!media) throw new NotFoundError('Media not found');
  const urls = new Set([media.url]);
  try {
    const url = new URL(media.url, origin);
    urls.add(url.href); urls.add(url.pathname);
  } catch { /* An imported non-URL can still match its stored value. */ }
  const sources: Source[] = [];
  const excludedCollections: string[] = [];
  for (const collection of ctx.config.collections) {
    if (collection.slug === 'media') continue;
    if (!canRead(ctx.actor, collection)) { excludedCollections.push(collection.slug); continue; }
    if (collection.nativeSchemaMapping) {
      const table = ctx.config.nativeSchemas[collection.slug];
      if (!table) { excludedCollections.push(collection.slug); continue; }
      const columns = getTableColumns(table);
      const fields = configuredCollectionFields(collection, ctx.config.nativeSchemas);
      if (fields.length > 40) { excludedCollections.push(collection.slug); continue; }
      const values = fields.flatMap(field => {
        const column = columns[field.name];
        if (!column) return [];
        const kind = columnKind(column);
        if (kind !== 'string' && kind !== 'json') return [];
        const value = kind === 'json' ? sql`json(CASE WHEN json_valid(${column}) THEN ${column} ELSE 'null' END)` : sql`${column}`;
        return [sql`${field.name}`, value];
      });
      if (!values.length) continue;
      const key = columns[getNativeIdColumn(collection)];
      if (!key) { excludedCollections.push(collection.slug); continue; }
      const title = ['title', 'name', 'label', 'filename'].find(name => fields.some(field => field.name === name) && columns[name]);
      sources.push({ collection: collection.slug, kind: 'native', query: (take, offset) => sql`
        SELECT CAST(${key} AS TEXT) AS id, substr(CAST(${title ? columns[title] : key} AS TEXT), 1, 200) AS title
        FROM ${table} WHERE ${references(sql`json_object(${sql.join(values, sql`, `)})`, id, [...urls])}
        ORDER BY ${key} LIMIT ${take} OFFSET ${offset}` });
      continue;
    }
    for (const kind of ['draft', 'published'] as const) {
      const data = kind === 'draft' ? schema.entries.data : schema.entries.publishedData;
      sources.push({ collection: collection.slug, kind, query: (take, offset) => sql`
        SELECT ${schema.entries.id} AS id, substr(COALESCE(json_extract(${data}, '$.title'), ${schema.entries.slug}), 1, 200) AS title
        FROM ${schema.entries} INNER JOIN ${schema.collections} ON ${schema.entries.collectionId} = ${schema.collections.id}
        WHERE ${schema.collections.slug} = ${collection.slug} AND ${references(sql`${data}`, id, [...urls])}
        ORDER BY ${schema.entries.id} LIMIT ${take} OFFSET ${offset}` });
    }
    sources.push({ collection: collection.slug, kind: 'revision', query: (take, offset) => sql`
      SELECT ${schema.entryRevisions.id} AS id, ${schema.entryRevisions.entryId} AS entryId,
        substr(COALESCE(json_extract(${schema.entryRevisions.data}, '$.title'), ${schema.entries.slug}), 1, 200) AS title
      FROM ${schema.entryRevisions} INNER JOIN ${schema.entries} ON ${schema.entryRevisions.entryId} = ${schema.entries.id}
      INNER JOIN ${schema.collections} ON ${schema.entryRevisions.collectionId} = ${schema.collections.id}
      WHERE ${schema.collections.slug} = ${collection.slug} AND ${references(sql`${schema.entryRevisions.data}`, id, [...urls])}
      ORDER BY ${schema.entryRevisions.id} LIMIT ${take} OFFSET ${offset}` });
  }
  sources.push({ collection: null, kind: 'global', query: (take, offset) => sql`
    SELECT ${schema.globals.slug} AS id, ${schema.globals.name} AS title FROM ${schema.globals}
    WHERE ${references(sql`${schema.globals.data}`, id, [...urls])}
    ORDER BY ${schema.globals.slug} LIMIT ${take} OFFSET ${offset}` });
  let source = 0, offset = 0;
  if (cursor) {
    try {
      const value = JSON.parse(cursor);
      if (!value || value.id !== id || !Number.isSafeInteger(value.source) || value.source < 0 || value.source >= sources.length ||
        !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 1_000_000) throw new Error();
      source = value.source; offset = value.offset;
    } catch { throw new InvalidInputError('Invalid media usage cursor'); }
  }
  const usages: Usage[] = [];
  let queried = 0;
  while (source < sources.length && queried++ < SOURCES_PER_REQUEST && usages.length < PAGE_SIZE) {
    const item = sources[source];
    const take = PAGE_SIZE - usages.length;
    const rows = await ctx.db.all<{ id: string; title: string | null; entryId?: string }>(item.query(take + 1, offset));
    usages.push(...rows.slice(0, take).map(row => ({ ...row, id: String(row.id), title: String(row.title || row.id), collection: item.collection, kind: item.kind })));
    if (rows.length > take) { offset += take; break; }
    source++; offset = 0;
  }
  return {
    usages, nextCursor: source < sources.length ? JSON.stringify({ id, source, offset }) : null,
    excludedCollections,
    scope: 'CMS drafts, published snapshots, saved revisions, globals and configured native fields. Code, external sites and references embedded in HTML strings are not scanned.',
  };
}
