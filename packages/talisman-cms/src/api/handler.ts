import type { APIRoute } from 'astro';
import { createDbClient, type TalismanEnv } from '../db/client';
import * as schema from '../db/schema';
import { authorizeCmsRequest } from '../auth/guard';
import { canAccessCollection, type CollectionOperation } from '../auth/collection-access';
import { collections as configCollections, globals as configGlobals, publishing } from 'virtual:talisman-cms/config';
import { uiLibraries as configuredUiLibraries } from 'virtual:talisman-cms/ui-libraries';
import { nativeSchemas } from 'virtual:talisman-cms/native-schemas';
import { collectionHooks } from 'virtual:talisman-cms/collection-hooks';
import { buildZodSchemaForCollection, buildZodSchemaForFields, generateFieldsFromDrizzle, prepareNativeWritePayload } from '../types';
import { validatePresetPayload } from '../presets';
import { eq, inArray, desc, and, count } from 'drizzle-orm';
import {
  createDraftEntry,
  getLatestRevision,
  invalidateEntryCache,
  isRevisionConflict,
  listEntryRevisions,
  restoreEntryRevision,
  saveDraftEntry,
  triggerPublishingWorkflow
} from '../versioning';

function mapNativeEntry(row: any, collectionId: string, nativeIdCol: string) {
  const resolvedId = row?.[nativeIdCol] ?? row?.id ?? '';

  return {
    id: resolvedId,
    collectionId,
    slug: row?.slug || resolvedId || '',
    status: typeof row?.status === 'string' ? row.status : 'published',
    data: row,
    createdAt: row?.createdAt || new Date(),
    updatedAt: row?.updatedAt || new Date()
  };
}

function validateCollectionPayload(slug: string, data: Record<string, any>) {
  if (slug !== '_ui_component_presets') {
    return {
      success: true as const,
      data,
    };
  }

  const result = validatePresetPayload(configuredUiLibraries as any, data);
  if (!result.success) {
    return result;
  }

  return {
    success: true as const,
    data: result.normalizedData,
  };
}

async function resolveCollectionContext(db: ReturnType<typeof createDbClient>, slug: string) {
  const configuredCollection = configCollections.find(c => c.slug === slug);
  const collectionConfig = configuredCollection
    ? { ...configuredCollection, hooks: collectionHooks[slug] }
    : undefined;
  if (!collectionConfig) {
    throw new Error(`Collection ${slug} not found in configuration`);
  }

  let collection = await db.query.collections.findFirst({
    // @ts-ignore
    where: (c, { eq }) => eq(c.slug, slug)
  });

  let activeFields = collectionConfig.fields || [];
  if (activeFields.length === 0 && collectionConfig.nativeSchemaMapping && nativeSchemas[slug]) {
    activeFields = generateFieldsFromDrizzle(nativeSchemas[slug]);
  }

  if (!collection) {
    const id = Date.now().toString() + '-' + Math.random().toString(36).substring(7);
    const createdAt = new Date();

    await db.insert(schema.collections).values({
      id,
      name: collectionConfig.name,
      slug: collectionConfig.slug,
      fields: activeFields,
      createdAt
    }).onConflictDoNothing({ target: schema.collections.slug });

    collection = await db.query.collections.findFirst({
      // @ts-ignore
      where: (c, { eq }) => eq(c.slug, slug)
    });
    if (!collection) throw new Error(`Collection ${slug} could not be initialized`);
  }

  const nativeTable = collectionConfig.nativeSchemaMapping && nativeSchemas[slug] ? nativeSchemas[slug] : null;
  const nativeIdCol = collectionConfig.nativeSchemaMapping?.idColumn || 'id';

  return {
    collection,
    collectionConfig,
    activeFields,
    nativeTable,
    nativeIdCol,
  };
}

async function syncConfiguredGlobals(db: ReturnType<typeof createDbClient>) {
  for (const globalConfig of configGlobals) {
    const existing = await db.query.globals.findFirst({
      // @ts-ignore
      where: (g, { eq }) => eq(g.slug, globalConfig.slug)
    });

    if (!existing) {
      const now = new Date();
      await db.insert(schema.globals).values({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: globalConfig.name,
        slug: globalConfig.slug,
        description: globalConfig.description || null,
        data: '{}',
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }

    const nextDescription = globalConfig.description || null;
    if (existing.name !== globalConfig.name || (existing.description || null) !== nextDescription) {
      await db.update(schema.globals).set({
        name: globalConfig.name,
        description: nextDescription,
      }).where(eq(schema.globals.id, existing.id));
    }
  }
}

async function resolveGlobalContext(db: ReturnType<typeof createDbClient>, slug: string) {
  const globalConfig = configGlobals.find((candidate) => candidate.slug === slug) || null;

  let globalRecord = await db.query.globals.findFirst({
    // @ts-ignore
    where: (g, { eq }) => eq(g.slug, slug)
  });

  if (!globalRecord && globalConfig) {
    const now = new Date();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    await db.insert(schema.globals).values({
      id,
      name: globalConfig.name,
      slug: globalConfig.slug,
      description: globalConfig.description || null,
      data: '{}',
      createdAt: now,
      updatedAt: now,
    });

    globalRecord = await db.query.globals.findFirst({
      // @ts-ignore
      where: (g, { eq }) => eq(g.slug, slug)
    });
  } else if (globalRecord && globalConfig) {
    const nextDescription = globalConfig.description || null;
    if (globalRecord.name !== globalConfig.name || (globalRecord.description || null) !== nextDescription) {
      await db.update(schema.globals).set({
        name: globalConfig.name,
        description: nextDescription,
      }).where(eq(schema.globals.id, globalRecord.id));

      globalRecord = {
        ...globalRecord,
        name: globalConfig.name,
        description: nextDescription,
      };
    }
  }

  return {
    globalConfig,
    globalRecord,
  };
}

export const ALL: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // Basic health check to verify routing and data connection
  if (path.endsWith('/api/health')) {
    try {
      // In Astro 6, bindings are accessed via `cloudflare:workers`
      const { env } = await import('cloudflare:workers');
      const db = createDbClient(env as any);
      
      // Test the connection
      await db.run('SELECT 1');
      return new Response(JSON.stringify({ status: 'ok', d1: 'connected' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ status: 'error', message: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // --- Auth Guard ---
  // Ensure an adapter is registered and the request is authenticated
  const adminOnly = request.method === 'DELETE' ||
    (request.method === 'POST' && /\/api\/collections\/[^/]+\/entries\/[^/]+\/(publish|archive)$/.test(path)) ||
    (request.method === 'POST' && /\/api\/collections\/[^/]+\/entries\/[^/]+\/revisions\/[^/]+\/restore$/.test(path)) ||
    (request.method === 'POST' && path.endsWith('/api/globals'));
  const authorization = await authorizeCmsRequest(request, adminOnly ? 'admin' : undefined);
  if (authorization.response) return authorization.response;
  const user = authorization.user;

  // Get all registered collections
  if (path.endsWith('/api/collections')) {
    try {
      const { env } = await import('cloudflare:workers');
      const db = createDbClient(env as any);
      
      // Auto-sync code-first collections to DB for foreign-key constraints
      const visibleCollections = configCollections.filter(col => canAccessCollection(col, user, 'read'));
      for (const col of visibleCollections) {
        
        let activeFields = col.fields || [];
        if (activeFields.length === 0 && col.nativeSchemaMapping && nativeSchemas[col.slug]) {
          activeFields = generateFieldsFromDrizzle(nativeSchemas[col.slug]);
        }
        
        // @ts-ignore
        const exists = await db.query.collections.findFirst({ where: (c, { eq }) => eq(c.slug, col.slug) });
        if (!exists) {
          await db.insert(schema.collections).values({
            id: Date.now().toString() + '-' + Math.random().toString(36).substring(7),
            name: col.name,
            slug: col.slug,
            fields: activeFields,
            createdAt: new Date()
          });
        } else {
          // Sync fields mapping
          await db.update(schema.collections).set({ fields: activeFields }).where(eq(schema.collections.id, exists.id));
        }
      }
      
      const persistedCollections = await db.query.collections.findMany();
      const persistedBySlug = new Map(persistedCollections.map(collection => [collection.slug, collection]));

      const entryCounts = await db.select({
        collectionId: schema.entries.collectionId,
        total: count()
      }).from(schema.entries).groupBy(schema.entries.collectionId);
      const entryCountById = new Map(entryCounts.map(row => [row.collectionId, row.total]));

      const nativeCounts = await Promise.all(visibleCollections.map(async collection => {
        const nativeTable = collection.nativeSchemaMapping && nativeSchemas[collection.slug];
        if (!nativeTable) return [collection.slug, null] as const;

        try {
          const [result] = await db.select({ total: count() }).from(nativeTable);
          return [collection.slug, result?.total ?? 0] as const;
        } catch (error) {
          console.error(`[talisman-cms] Could not count ${collection.slug}:`, error);
          return [collection.slug, null] as const;
        }
      }));
      const nativeCountBySlug = new Map(nativeCounts);

      // Return the config collections augmented with persisted metadata and generated fields.
      const augmentedCollections = visibleCollections.map(c => {
        const persisted = persistedBySlug.get(c.slug);
        const itemCount = c.nativeSchemaMapping
          ? nativeCountBySlug.get(c.slug) ?? null
          : persisted ? entryCountById.get(persisted.id) ?? 0 : 0;
        if ((!c.fields || c.fields.length === 0) && c.nativeSchemaMapping && nativeSchemas[c.slug]) {
          return { ...c, id: persisted?.id, createdAt: persisted?.createdAt, itemCount, fields: generateFieldsFromDrizzle(nativeSchemas[c.slug]) };
        }
        return { ...c, id: persisted?.id, createdAt: persisted?.createdAt, itemCount };
      });
      
      return new Response(JSON.stringify(augmentedCollections), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e: any) {
      console.error('[talisman-cms] Error in /api/collections:', e);
      return new Response(JSON.stringify({ status: 'error', message: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // --- Globals API ---
  const globalsMatch = path.match(/\/api\/globals(?:\/([^/]+))?$/);
  if (globalsMatch) {
    const slug = globalsMatch[1];
    
    try {
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      // @ts-ignore - Drizzle ORM types can be strict with the D1 env wrapper
      const db = createDbClient(env as any);

      if (request.method === 'GET') {
        if (!slug) {
          await syncConfiguredGlobals(db);
          const allGlobals = await db.query.globals.findMany();
          const configuredOrder = new Map(configGlobals.map((globalConfig, index) => [globalConfig.slug, index]));
          const list = allGlobals
            .map(g => ({ ...g, data: undefined }))
            .sort((left, right) => {
              const leftOrder = configuredOrder.get(left.slug);
              const rightOrder = configuredOrder.get(right.slug);

              if (leftOrder !== undefined && rightOrder !== undefined) {
                return leftOrder - rightOrder;
              }

              if (leftOrder !== undefined) return -1;
              if (rightOrder !== undefined) return 1;

              return left.name.localeCompare(right.name);
            });

          return new Response(JSON.stringify(list), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          const { globalRecord: globalObj } = await resolveGlobalContext(db, slug);
          if (!globalObj) return new Response(JSON.stringify({ error: 'Global not found' }), { status: 404 });
          return new Response(JSON.stringify(globalObj), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      } 
      
      if (request.method === 'POST') {
        if (!slug) {
          const bodyStr = await request.text();
          const body = bodyStr ? JSON.parse(bodyStr) : {};
          const requestedSlug = typeof body.slug === 'string' ? body.slug.trim() : '';
          const requestedName = typeof body.name === 'string' ? body.name.trim() : '';

          if (!requestedSlug) {
            return new Response(JSON.stringify({ error: 'Slug is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }

          const existing = await db.query.globals.findFirst({
            // @ts-ignore
            where: (g, { eq }) => eq(g.slug, requestedSlug)
          });

          if (existing) {
            return new Response(JSON.stringify({ error: 'A global with this slug already exists' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
          }

          const now = new Date();
          const created = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            name: requestedName || requestedSlug,
            slug: requestedSlug,
            description: typeof body.description === 'string' && body.description.trim().length > 0 ? body.description.trim() : null,
            data: JSON.stringify(body.data && typeof body.data === 'object' ? body.data : {}),
            createdAt: now,
            updatedAt: now,
          };

          await db.insert(schema.globals).values(created);

          if (env.KV) {
            await env.KV.delete('talisman:globals:all');
            await env.KV.delete(`talisman:globals:${requestedSlug}`);
          }

          return new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        
        const bodyStr = await request.text();
        let data = bodyStr ? JSON.parse(bodyStr) : {};
        const { globalConfig, globalRecord: existing } = await resolveGlobalContext(db, slug);

        if (globalConfig?.fields?.length) {
          const parsed = buildZodSchemaForFields(globalConfig.fields).safeParse(data);
          if (!parsed.success) {
            return new Response(JSON.stringify({
              error: 'Validation failed',
              details: parsed.error.flatten()
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }

          data = parsed.data;
        }
        
        const id = existing?.id || (Date.now().toString() + '-' + Math.random().toString(36).substring(7));
        const now = new Date();

        await db.insert(schema.globals).values({
          id,
          name: globalConfig?.name || existing?.name || slug,
          slug,
          description: globalConfig?.description || existing?.description || null,
          data: JSON.stringify(data),
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: schema.globals.slug,
          set: {
            name: globalConfig?.name || existing?.name || slug,
            description: globalConfig?.description || existing?.description || null,
            data: JSON.stringify(data),
            updatedAt: now
          }
        });

        const updated = await db.query.globals.findFirst({
          // @ts-ignore
          where: (g: any, { eq }: any) => eq(g.slug, slug)
        });

        if (env.KV) {
          await env.KV.delete('talisman:globals:all');
          await env.KV.delete(`talisman:globals:${slug}`);
        }

        return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    } catch (e: any) {
      return new Response(JSON.stringify({ status: 'error', message: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const revisionsMatch = path.match(/\/api\/collections\/([^/]+)\/entries\/([^/]+)\/revisions(?:\/([^/]+)\/restore)?$/);
  if (revisionsMatch) {
    const slug = revisionsMatch[1];
    const entryId = revisionsMatch[2];
    const revisionId = revisionsMatch[3];

    try {
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      // @ts-ignore
      const db = createDbClient(env as any);
      const { collection, collectionConfig, nativeTable } = await resolveCollectionContext(db, slug);

      if (!canAccessCollection(collectionConfig, user, request.method === 'GET' ? 'read' : 'update') ||
        (request.method !== 'GET' && collectionConfig.readOnly)) {
        return Response.json({ error: 'Collection access denied' }, { status: 403 });
      }

      if (nativeTable) {
        return new Response(JSON.stringify({ error: 'Revision history is not available for native collections' }), { status: 400 });
      }

      if (request.method === 'GET' && !revisionId) {
        const revisions = await listEntryRevisions(db as any, collection!.id, entryId);
        return new Response(JSON.stringify(revisions), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (request.method === 'POST' && revisionId) {
        const body = await request.json().catch(() => ({})) as { expectedRevisionId?: unknown };
        if (typeof body.expectedRevisionId !== 'string' || !body.expectedRevisionId) {
          return Response.json({ error: 'expectedRevisionId is required' }, { status: 428 });
        }
        const restored = await restoreEntryRevision(db as any, collection as any, entryId, revisionId, body.expectedRevisionId);
        await invalidateEntryCache(env, slug, entryId);
        return new Response(JSON.stringify(restored), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    } catch (e: any) {
      if (isRevisionConflict(e)) return Response.json({ error: e.message }, { status: 409 });
      return new Response(JSON.stringify({ status: 'error', message: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const transitionMatch = path.match(/\/api\/collections\/([^/]+)\/entries\/([^/]+)\/(publish|archive)$/);
  if (transitionMatch) {
    const slug = transitionMatch[1];
    const entryId = transitionMatch[2];
    const action = transitionMatch[3] as 'publish' | 'archive';

    try {
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      // @ts-ignore
      const db = createDbClient(env as any);
      const { collectionConfig, nativeTable } = await resolveCollectionContext(db, slug);

      if (!canAccessCollection(collectionConfig, user, 'update') || collectionConfig.readOnly) {
        return Response.json({ error: 'Collection access denied' }, { status: 403 });
      }

      if (nativeTable) {
        return new Response(JSON.stringify({ error: 'Publishing workflows are not available for native collections' }), { status: 400 });
      }

      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
      }

      const body = await request.json().catch(() => ({})) as { expectedRevisionId?: unknown };
      if (typeof body.expectedRevisionId !== 'string' || !body.expectedRevisionId) {
        return Response.json({ error: 'expectedRevisionId is required' }, { status: 428 });
      }

      const updated = await triggerPublishingWorkflow(env, {
        collectionSlug: slug,
        entryId,
        action,
        expectedRevisionId: body.expectedRevisionId,
      }, publishing.workflowBinding);

      await invalidateEntryCache(env, slug, entryId);
      return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      if (isRevisionConflict(e)) return Response.json({ error: e.message }, { status: 409 });
      return new Response(JSON.stringify({ status: 'error', message: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // --- Entries API ---
  const entriesMatch = path.match(/\/api\/collections\/([^/]+)\/entries(?:\/([^/]+))?$/);
  if (entriesMatch) {
    const slug = entriesMatch[1];
    const entryId = entriesMatch[2];
    
    try {
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      // @ts-ignore
      const db = createDbClient(env as any);

      const {
        collection,
        collectionConfig,
        activeFields,
        nativeTable,
        nativeIdCol
      } = await resolveCollectionContext(db, slug);

      const operation: CollectionOperation = request.method === 'GET' ? 'read'
        : request.method === 'POST' ? 'create'
        : request.method === 'PUT' ? 'update' : 'delete';
      if (!canAccessCollection(collectionConfig, user, operation)) {
        return Response.json({ error: 'Collection access denied' }, { status: 403 });
      }

      if (request.method === 'GET') {
        if (!entryId) {
          if (nativeTable) {
             const rows = await db.select().from(nativeTable);
             // Wrap in CMS envelope payload
             const mapped = rows.map((r: any) => mapNativeEntry(r, collection!.id, nativeIdCol));
             return new Response(JSON.stringify(mapped), { status: 200, headers: { 'Content-Type': 'application/json' } });
          } else {
            const allEntries = await db.query.entries.findMany({
              // @ts-ignore
              where: (e: any, { eq }: any) => eq(e.collectionId, collection!.id),
              // @ts-ignore
              orderBy: (e: any, { desc }: any) => [desc(e.createdAt)]
            });
            return new Response(JSON.stringify(allEntries), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
        } else {
          // Get specific entry
          if (nativeTable) {
             const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], entryId) as any);
             if (rows.length === 0) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
             const mapped = mapNativeEntry(rows[0], collection!.id, nativeIdCol);
             return new Response(JSON.stringify(mapped), { status: 200, headers: { 'Content-Type': 'application/json' } });
          } else {
            const entry = await db.query.entries.findFirst({
              // @ts-ignore
              where: (e, { eq, and }) => and(eq(e.collectionId, collection!.id), eq(e.id, entryId))
            });
            
            if (!entry) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
            const latestRevision = await getLatestRevision(db as any, entryId);
            return new Response(JSON.stringify({ ...entry, latestRevisionId: latestRevision?.id ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
        }
      }

      if (collectionConfig.readOnly && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
        return Response.json({ error: 'This collection is read-only' }, { status: 403 });
      }

      if (request.method === 'POST') {
        const bodyStr = await request.text();
        const payload = bodyStr ? JSON.parse(bodyStr) : {};
        let { id: userProvidedId, data = {}, slug: entrySlug } = payload;

        if (collectionConfig.hooks?.beforeValidate) {
          for (const hook of collectionConfig.hooks.beforeValidate) {
            const hData = await hook({ data, req: request, operation: 'create' });
            if (hData) data = { ...data, ...hData };
          }
        }

        // Perform schema validation using activeFields
        const dynamicSchema = buildZodSchemaForCollection({ ...collectionConfig, fields: activeFields });
        const parsedDataResult = dynamicSchema.safeParse(data);
        if (!parsedDataResult.success) {
           return new Response(JSON.stringify({ 
             error: 'Validation Error', 
             issues: parsedDataResult.error.issues 
           }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const validatedPayload = validateCollectionPayload(slug, parsedDataResult.data);
        if (!validatedPayload.success) {
          return new Response(JSON.stringify({
            error: 'Validation Error',
            issues: validatedPayload.issues,
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        let validatedData = validatedPayload.data;

        if (collectionConfig.hooks?.beforeChange) {
           for (const hook of collectionConfig.hooks.beforeChange) {
             const hData = await hook({ data: validatedData, req: request, operation: 'create' });
             if (hData) validatedData = { ...validatedData, ...hData };
           }
        }

        if (nativeTable) {
           // Insert directly to native table
           const insertPayload = prepareNativeWritePayload(
             collectionConfig,
             {
               ...validatedData,
               ...(nativeTable[nativeIdCol] && userProvidedId ? { [nativeIdCol]: userProvidedId } : {})
             },
             'create'
           );
           
           const insertedRows = await db.insert(nativeTable).values(insertPayload).returning();
           const insertedRow = (Array.isArray(insertedRows) ? insertedRows[0] : null) || (
             insertPayload[nativeIdCol] !== undefined && insertPayload[nativeIdCol] !== null
               ? (await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], insertPayload[nativeIdCol]) as any))[0]
               : null
           );
           
           await invalidateEntryCache(env, slug);

           if (!insertedRow) {
             return new Response(JSON.stringify({ error: 'Failed to load created native entry' }), {
               status: 500,
               headers: { 'Content-Type': 'application/json' }
             });
           }
           
           const doc = mapNativeEntry(insertedRow, collection!.id, nativeIdCol);
           if (collectionConfig.hooks?.afterChange) {
             for (const hook of collectionConfig.hooks.afterChange) {
               await hook({ data: validatedData, req: request, operation: 'create', doc });
             }
           }

           return new Response(JSON.stringify(doc), {
             status: 201,
             headers: { 'Content-Type': 'application/json' }
           });
        } else {
          const created = await createDraftEntry(db as any, collection as any, validatedData, {
            id: userProvidedId,
            slug: entrySlug
          });
          await invalidateEntryCache(env, slug);

          if (collectionConfig.hooks?.afterChange) {
             for (const hook of collectionConfig.hooks.afterChange) {
               await hook({ data: validatedData, req: request, operation: 'create', doc: created });
             }
          }

          return new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (request.method === 'PUT') {
        if (!entryId) return new Response(JSON.stringify({ error: 'Entry ID required for PUT' }), { status: 400 });
        
        const bodyStr = await request.text();
        const payload = bodyStr ? JSON.parse(bodyStr) : {};
        let { data, slug: entrySlug } = payload;
        const expectedRevisionId = payload.expectedRevisionId;
        if (!nativeTable && (typeof expectedRevisionId !== 'string' || !expectedRevisionId)) {
          return Response.json({ error: 'expectedRevisionId is required' }, { status: 428 });
        }
        
        if (nativeTable) {
           // Update native table
           const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], entryId) as any);
           if (rows.length === 0) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
           const originalDoc = mapNativeEntry(rows[0], collection!.id, nativeIdCol);
           
           if (data !== undefined && collectionConfig.hooks?.beforeValidate) {
             for (const hook of collectionConfig.hooks.beforeValidate) {
               const hData = await hook({ data, req: request, operation: 'update', originalDoc });
               if (hData) data = { ...data, ...hData };
             }
           }

           let updatePayload = {};
           if (data !== undefined) {
             const rawDataToValidate = typeof data === 'string' ? JSON.parse(data) : data;
             const dynamicSchema = buildZodSchemaForCollection({ ...collectionConfig, fields: activeFields });
             const parsedDataResult = dynamicSchema.safeParse(rawDataToValidate);
             
             if (!parsedDataResult.success) {
               return new Response(JSON.stringify({ error: 'Validation Error', issues: parsedDataResult.error.issues }), { status: 400, headers: { 'Content-Type': 'application/json' } });
             }
             const validatedPayload = validateCollectionPayload(slug, parsedDataResult.data);
             if (!validatedPayload.success) {
               return new Response(JSON.stringify({ error: 'Validation Error', issues: validatedPayload.issues }), { status: 400, headers: { 'Content-Type': 'application/json' } });
             }
             let validatedData = validatedPayload.data;
             if (collectionConfig.hooks?.beforeChange) {
                for (const hook of collectionConfig.hooks.beforeChange) {
                   const hData = await hook({ data: validatedData, req: request, operation: 'update', originalDoc });
                   if (hData) validatedData = { ...validatedData, ...hData };
                }
             }

             updatePayload = prepareNativeWritePayload(collectionConfig, validatedData, 'update');
           }
           
           if (Object.keys(updatePayload).length > 0) {
              await db.update(nativeTable).set(updatePayload).where(eq(nativeTable[nativeIdCol], entryId) as any);
           }
           
           await invalidateEntryCache(env, slug, entryId);
           
           const doc = {
              ...mapNativeEntry({ ...rows[0], ...updatePayload }, collection!.id, nativeIdCol),
              slug: entrySlug || rows[0].slug || entryId,
           };

           if (collectionConfig.hooks?.afterChange) {
             for (const hook of collectionConfig.hooks.afterChange) {
               await hook({ data: data || {}, req: request, operation: 'update', originalDoc, doc });
             }
           }

           return new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else {
           const origRow = await db.query.entries.findFirst({
             // @ts-ignore
             where: (e: any, { eq, and }: any) => and(eq(e.collectionId, collection!.id), eq(e.id, entryId))
           });
           if (!origRow) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
           const originalDoc = origRow;

           if (data !== undefined && collectionConfig.hooks?.beforeValidate) {
             for (const hook of collectionConfig.hooks.beforeValidate) {
               const hData = await hook({ data, req: request, operation: 'update', originalDoc });
               if (hData) data = { ...data, ...hData };
             }
           }

           if (data !== undefined) {
             const rawDataToValidate = typeof data === 'string' ? JSON.parse(data) : data;
             const dynamicSchema = buildZodSchemaForCollection({ ...collectionConfig, fields: activeFields });
             const parsedDataResult = dynamicSchema.safeParse(rawDataToValidate);
             
             if (!parsedDataResult.success) {
               return new Response(JSON.stringify({ 
                 error: 'Validation Error', 
                 issues: parsedDataResult.error.issues 
               }), { status: 400, headers: { 'Content-Type': 'application/json' } });
             }

             const validatedPayload = validateCollectionPayload(slug, parsedDataResult.data);
             if (!validatedPayload.success) {
               return new Response(JSON.stringify({
                 error: 'Validation Error',
                 issues: validatedPayload.issues
               }), { status: 400, headers: { 'Content-Type': 'application/json' } });
             }
             
             let validatedData = validatedPayload.data;
             if (collectionConfig.hooks?.beforeChange) {
                for (const hook of collectionConfig.hooks.beforeChange) {
                   const hData = await hook({ data: validatedData, req: request, operation: 'update', originalDoc });
                   if (hData) validatedData = { ...validatedData, ...hData };
                }
             }

             const updated = await saveDraftEntry(db as any, collection as any, entryId, {
               data: validatedData,
               slug: entrySlug,
               expectedRevisionId
             });

             await invalidateEntryCache(env, slug, entryId);
             
             if (collectionConfig.hooks?.afterChange) {
               for (const hook of collectionConfig.hooks.afterChange) {
                 await hook({ data: validatedData, req: request, operation: 'update', originalDoc, doc: updated });
               }
             }
             
             return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
           }

           const updated = await saveDraftEntry(db as any, collection as any, entryId, {
             slug: entrySlug,
             expectedRevisionId
           });
           await invalidateEntryCache(env, slug, entryId);

           if (collectionConfig.hooks?.afterChange) {
             for (const hook of collectionConfig.hooks.afterChange) {
               await hook({ data: {}, req: request, operation: 'update', originalDoc, doc: updated });
             }
           }

           return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (request.method === 'DELETE') {
        if (!entryId) return new Response(JSON.stringify({ error: 'Entry ID required for DELETE' }), { status: 400 });

        let originalDoc: any = undefined;
        if (nativeTable) {
           const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], entryId) as any);
           if (rows.length === 0) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
           originalDoc = mapNativeEntry(rows[0], collection!.id, nativeIdCol);
        } else {
           const origRow = await db.query.entries.findFirst({
             // @ts-ignore
             where: (e: any, { eq, and }: any) => and(eq(e.collectionId, collection!.id), eq(e.id, entryId))
           });
           if (!origRow) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
           originalDoc = origRow;
        }

        if (collectionConfig.hooks?.beforeDelete) {
          for (const hook of collectionConfig.hooks.beforeDelete) {
             await hook({ req: request, operation: 'delete', originalDoc });
          }
        }

        if (nativeTable) {
           await db.delete(nativeTable).where(eq(nativeTable[nativeIdCol], entryId) as any);
        } else {
           await db.delete(schema.entries).where(
             and(eq(schema.entries.collectionId, collection!.id), eq(schema.entries.id, entryId))
           );
        }

        await invalidateEntryCache(env, slug, entryId);

        if (collectionConfig.hooks?.afterDelete) {
          for (const hook of collectionConfig.hooks.afterDelete) {
             await hook({ req: request, operation: 'delete', originalDoc, doc: originalDoc });
          }
        }

        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

    } catch (e: any) {
      if (isRevisionConflict(e)) return Response.json({ error: e.message }, { status: 409 });
      return new Response(JSON.stringify({ status: 'error', message: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
};
