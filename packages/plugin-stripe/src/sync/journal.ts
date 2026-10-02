import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { stripeSync, stripeOperations } from '../schema';
import type { StripeEnv } from '../secrets';
import { stripeProxy } from '../proxy';

export async function digest(value: unknown) {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable(value))));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function syncDb(env: StripeEnv) {
  if (!env.DB) throw new Error('[plugin-stripe] DB is required for the durable sync journal. Apply the plugin migrations before saving.');
  return drizzle(env.DB as D1Database);
}

/** A lease prevents concurrent saves issuing different requests for the same logical resource. */
async function runSyncResource(input: {
  env: StripeEnv; secret: string; collection: string; resource: string; identity: string;
  storedId?: string; docId?: string; payload: Record<string, unknown>; deleting?: boolean;
}) {
  const { env, secret, collection, resource, identity, storedId, docId, payload, deleting } = input;
  const db = syncDb(env);
  const id = await digest([collection, resource, identity]);
  const now = new Date();
  await db.insert(stripeSync).values({ id, collection, resource, identity, stripeId: storedId, docId, updatedAt: now }).onConflictDoNothing();
  const row = await db.select().from(stripeSync).where(eq(stripeSync.id, id)).get();
  if (!row) throw new Error('[plugin-stripe] Cannot read the sync journal. No Stripe call was made.');
  if (row.docId && row.docId !== docId) throw new Error('[plugin-stripe] This sync identity already belongs to another CMS record.');
  if (storedId && row.stripeId && storedId !== row.stripeId) throw new Error('[plugin-stripe] Stored Stripe ID conflicts with the journal. Administrator reconciliation is required.');
  if (row.state === 'deleted') {
    if (deleting) return row.stripeId!;
    throw new Error('[plugin-stripe] This sync identity was deleted. Use a new identity for a new resource.');
  }
  if (row.state === 'blocked') throw new Error(`[plugin-stripe] Sync operation ${row.operation} requires administrator reconciliation. The CMS save was refused.`);
  const stripeId = row.stripeId ?? storedId;
  const hash = await digest([deleting ? 'delete' : 'save', payload]);
  // A confirmed create can be replayed after a CMS write failed, without creating another resource.
  if (!deleting && row.state === 'ready' && stripeId && row.payloadHash === hash && !row.lastError) return stripeId;
  if (row.state === 'pending' && row.payloadHash !== hash) throw new Error(`[plugin-stripe] Retry the unchanged fields for operation ${row.operation} before editing them, or ask an administrator to reconcile it.`);
  if (row.state === 'pending' && row.startedAt && now.getTime() - row.startedAt.getTime() >= 23 * 60 * 60 * 1000) {
    await db.update(stripeSync).set({ state: 'blocked', updatedAt: now }).where(and(eq(stripeSync.id, id), eq(stripeSync.operation, row.operation)));
    throw new Error(`[plugin-stripe] Operation ${row.operation} exceeded the safe retry window. Administrator reconciliation is required; no Stripe call was made.`);
  }
  const operation = row.state === 'pending' ? row.operation : crypto.randomUUID();
  const claimed = await db.update(stripeSync).set({
    state: 'pending', operation, payloadHash: hash,
    startedAt: row.state === 'pending' ? row.startedAt : now,
    leaseUntil: new Date(now.getTime() + 60_000), attempts: sql`${stripeSync.attempts} + 1`, updatedAt: now,
  }).where(and(eq(stripeSync.id, id), eq(stripeSync.operation, row.operation),
    eq(stripeSync.state, row.state), or(isNull(stripeSync.leaseUntil), lte(stripeSync.leaseUntil, now)))).returning().get();
  if (!claimed) throw new Error('[plugin-stripe] A sync is already running for this record. Retry after one minute.');
  const method = deleting ? (resource === 'customers' ? 'del' : 'update') : stripeId ? 'update' : 'create';
  await db.insert(stripeOperations).values({ id: operation, syncId: id, method, payloadHash: hash, startedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: stripeOperations.id, set: { attempts: sql`${stripeOperations.attempts} + 1`, updatedAt: now } });
  const params = deleting ? { active: false } : { ...payload, metadata: { ...(payload.metadata as Record<string, unknown> ?? {}), talisman_sync_operation: operation } };
  const options = { idempotencyKey: `talisman-sync-${operation}` };
  const args = method === 'del' ? [stripeId, options] : stripeId ? [stripeId, params, options] : [params, options];
  let response;
  try {
    response = await stripeProxy({ stripeSecretKey: secret, stripeMethod: `${resource}.${method}`, stripeArgs: args });
  } catch {
    response = { status: 500, type: 'StripeConnectionError' };
  }
  const deletedCustomer = deleting && resource === 'customers' && response.status === 404 && response.code === 'resource_missing';
  if (response.status !== 200 && !deletedCustomer) {
    // Do not persist/log Stripe's message: it can echo email addresses or other mapped data.
    const error = `Stripe ${response.status}: ${response.type ?? 'error'} (${response.code ?? 'unknown'})`;
    // Validation/auth failures have no side effects; allow corrected fields with a new key. Unknown
    // outcomes keep the same key and exact payload, including Stripe's cached 500 responses.
    const definitive = [400, 401, 402, 403, 404, 422].includes(response.status) && response.type !== 'StripeIdempotencyError';
    await db.update(stripeSync).set({ state: definitive ? 'ready' : 'pending', lastError: error, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(stripeSync.id, id), eq(stripeSync.operation, operation)));
    await db.update(stripeOperations).set({ outcome: error, updatedAt: new Date() }).where(eq(stripeOperations.id, operation));
    throw new Error(`[plugin-stripe] Stripe sync failed (${error}). CMS save/delete refused. ${definitive ? 'Correct the mapped fields or credentials and save again.' : `Retry unchanged fields within 23 hours. Operation ${operation}; if it keeps failing, ask an administrator to reconcile it.`}`);
  }
  const resultId = stripeId ?? response.data?.id;
  if (!resultId || typeof resultId !== 'string') throw new Error(`[plugin-stripe] Stripe returned no resource ID. Operation ${operation} requires reconciliation.`);
  // If this write fails, pending survives and the same Stripe idempotency key is reused.
  await db.batch([
    db.update(stripeSync).set({ stripeId: resultId, state: deleting ? 'deleted' : 'ready', lastError: null, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(stripeSync.id, id), eq(stripeSync.operation, operation))),
    db.update(stripeOperations).set({ stripeId: resultId, outcome: deleting ? 'deleted' : 'succeeded', updatedAt: new Date() }).where(eq(stripeOperations.id, operation)),
  ]);
  return resultId;
}

export async function bindSyncRecord(env: StripeEnv, collection: string, resource: string, identity: string, docId: string) {
  const db = syncDb(env);
  const id = await digest([collection, resource, identity]);
  await db.update(stripeSync).set({ docId, updatedAt: new Date() }).where(and(eq(stripeSync.id, id), isNull(stripeSync.docId)));
}


export async function syncResource(input: Parameters<typeof runSyncResource>[0]) {
  try { return await runSyncResource(input); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('[plugin-stripe]')) throw error;
    throw new Error('[plugin-stripe] The durable sync journal could not be read or written. CMS save/delete refused. Retry unchanged fields after one minute; if it persists, ask an administrator to inspect the journal.');
  }
}
