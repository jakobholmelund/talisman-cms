import { getClient, type TalismanEnv } from './db/client';

export async function fetchLiveEntry(options: { collection: string; version?: 'draft' | 'published' }, filter: any) {
  // @ts-ignore
  const pkg = 'cloudflare:workers';
  const { env } = await import(/* @vite-ignore */ pkg);
  const client = getClient(env as TalismanEnv);
  
  const entry = await client.entries.find(options.collection, filter.id, {
    version: options.version || 'published'
  });

  if (!entry) {
    return undefined;
  }
  
  let parsedData = entry.data;
  if (typeof parsedData === 'string') {
    try { parsedData = JSON.parse(parsedData); } catch (e) {}
  }

  return {
    id: entry.id,
    data: {
       ...parsedData,
       slug: entry.slug,
       status: entry.status,
       createdAt: entry.createdAt,
       updatedAt: entry.updatedAt,
    }
  };
}

export async function fetchLiveCollection(options: { collection: string; version?: 'draft' | 'published' }, filter?: any) {
  // @ts-ignore
  const pkg = 'cloudflare:workers';
  const { env } = await import(/* @vite-ignore */ pkg);
  const client = getClient(env as TalismanEnv);
  
  const entries = await client.entries.findMany(options.collection, {
    version: options.version || 'published'
  });
  
  return {
    entries: entries.map((entry: any) => {
      let parsedData = entry.data;
      if (typeof parsedData === 'string') {
        try { parsedData = JSON.parse(parsedData); } catch (e) {}
      }
      return {
         id: entry.id,
         data: {
           ...parsedData,
           slug: entry.slug,
           status: entry.status,
           createdAt: entry.createdAt,
           updatedAt: entry.updatedAt,
         }
      };
    })
  };
}
