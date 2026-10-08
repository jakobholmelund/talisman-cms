import { authorizeCmsRequest } from './auth/guard';
import { getClient, type TalismanEnv } from './db/client';
import type { LiveDataEntry, TalismanLiveCollectionFilter, TalismanLiveEntryFilter, TalismanLiveReadFilter, TalismanLoaderOptions } from './loader';
import { userActor, type Actor } from './service/actor';
import { AccessDeniedError, InvalidInputError } from './service/errors';

const READ_KEYS = ['version', 'depth', 'request'];

function validateFilter(filter: unknown, keys: string[]): void {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new InvalidInputError('The live loader filter must be an object.');
  }
  for (const key of Object.keys(filter)) {
    if (!keys.includes(key)) throw new InvalidInputError(`Unsupported live loader filter: ${key}`);
  }
}

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidInputError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

async function readContext(options: TalismanLoaderOptions, filter: TalismanLiveReadFilter) {
  const version = filter.version ?? options.version ?? 'published';
  if (version !== 'published' && version !== 'draft') throw new InvalidInputError('version must be published or draft.');
  const depth = integer(filter.depth ?? options.depth ?? 0, 'depth', 0, 5);
  let actor: Actor | undefined;
  if (version === 'draft') {
    if (!(filter.request instanceof Request)) throw new AccessDeniedError('Draft previews require a request with a CMS session.');
    const auth = await authorizeCmsRequest(filter.request);
    if (auth.response || !['admin', 'editor'].includes(auth.user.role)) {
      throw new AccessDeniedError('Draft previews require a verified CMS editor or admin session.');
    }
    actor = userActor(auth.user, filter.request);
  }
  const pkg = 'cloudflare:workers';
  const { env } = await import(/* @vite-ignore */ pkg);
  return {
    client: getClient(env as TalismanEnv, undefined, { actor }),
    // Draft reads never use the shared site cache, including relationship-free reads.
    read: { version, depth, ...(version === 'draft' ? { cache: false } : {}) },
  };
}

function toLiveEntry(entry: any): LiveDataEntry {
  const data = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
  return {
    id: entry.id,
    data: {
      ...data,
      slug: entry.slug,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
  };
}

export async function fetchLiveEntry(options: TalismanLoaderOptions, filter: TalismanLiveEntryFilter) {
  validateFilter(filter, [...READ_KEYS, 'id', 'slug']);
  const hasId = filter.id !== undefined;
  const key = hasId ? filter.id : filter.slug;
  if ((hasId && filter.slug !== undefined) || typeof key !== 'string' || !key.trim()) {
    throw new InvalidInputError('Supply exactly one non-empty id or slug.');
  }
  const { client, read } = await readContext(options, filter);
  const entry = hasId
    ? await client.entries.find(options.collection, key, read)
    : await client.entries.findBySlug(options.collection, key, read);
  return entry ? toLiveEntry(entry) : undefined;
}

export async function fetchLiveCollection(options: TalismanLoaderOptions, filter: TalismanLiveCollectionFilter = {}) {
  validateFilter(filter, [...READ_KEYS, 'where', 'sort', 'offset', 'limit']);
  const limit = integer(filter.limit ?? options.limit ?? 50, 'limit', 1, 200);
  const { client, read } = await readContext(options, filter);
  const entries = await client.entries.findMany(options.collection, {
    ...read,
    limit,
    where: filter.where,
    sort: filter.sort,
    offset: filter.offset,
  });
  return { entries: entries.map(toLiveEntry) };
}
