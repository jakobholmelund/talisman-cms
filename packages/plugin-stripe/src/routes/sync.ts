import type { APIRoute } from 'astro';
import { and, eq, ne, desc, isNull, lte, or } from 'drizzle-orm';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { getWorkerEnv, readStripeSecretKey, MISSING_SECRET_KEY } from '../secrets';
import { digest, syncDb } from '../sync/journal';
import { stripeSync, stripeOperations } from '../schema';
import { stripeProxy } from '../proxy';

/** Administrator-only audit and explicit recovery; never creates a Stripe resource. */
export const GET: APIRoute = async ({ request }) => {
  const auth = await authorizeCmsRequest(request, 'admin');
  if (auth.response) return auth.response;
  const db = syncDb(await getWorkerEnv());
  const records = await db.select().from(stripeSync).where(ne(stripeSync.state, 'deleted')).orderBy(desc(stripeSync.updatedAt)).limit(100);
  const operations = await db.select().from(stripeOperations).orderBy(desc(stripeOperations.updatedAt)).limit(100);
  return Response.json({ records, operations });
};

export const POST: APIRoute = async ({ request }) => {
  const auth = await authorizeCmsRequest(request, 'admin');
  if (auth.response) return auth.response;
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') return Response.json({ error: 'Expected an object' }, { status: 400 });
    const { operation, stripeId } = body as Record<string, unknown>;
    if (typeof operation !== 'string' || typeof stripeId !== 'string') return Response.json({ error: 'operation and stripeId are required' }, { status: 400 });
    const env = await getWorkerEnv();
    const secret = readStripeSecretKey(env);
    if (!secret) return Response.json({ error: MISSING_SECRET_KEY }, { status: 503 });
    const db = syncDb(env);
    const row = await db.select().from(stripeSync).where(eq(stripeSync.operation, operation)).get();
    if (!row || !['blocked', 'pending'].includes(row.state) || row.leaseUntil && row.leaseUntil > new Date()) {
      return Response.json({ error: 'Operation is not awaiting reconciliation, or is still running' }, { status: 409 });
    }
    const audit = await db.select().from(stripeOperations).where(eq(stripeOperations.id, operation)).get();
    if (!audit || row.stripeId && row.stripeId !== stripeId) {
      return Response.json({ error: "This operation cannot be linked to that resource. Use the journal's stored Stripe ID." }, { status: 409 });
    }
    const result = await stripeProxy({ stripeSecretKey: secret, stripeMethod: `${row.resource}.retrieve`, stripeArgs: [stripeId] });
    const deleting = row.payloadHash === await digest(['delete', {}]);
    const customerRemoved = deleting && row.resource === 'customers' && row.stripeId === stripeId
      && (result.status === 404 && result.code === 'resource_missing' || result.status === 200 && result.data?.deleted === true);
    const confirmed = customerRemoved || result.status === 200 && result.data?.id === stripeId
      && (deleting ? row.stripeId === stripeId && result.data.active === false : result.data.metadata?.talisman_sync_operation === operation);
    if (!confirmed) {
      return Response.json({ error: 'Stripe has not confirmed this operation on that resource. Keep the journal and investigate in Stripe.' }, { status: 409 });
    }
    const updated = await db.update(stripeSync).set({ stripeId, state: deleting ? 'deleted' : 'ready', leaseUntil: null, lastError: null, updatedAt: new Date() })
      .where(and(eq(stripeSync.id, row.id), eq(stripeSync.state, row.state), eq(stripeSync.operation, operation),
        or(isNull(stripeSync.leaseUntil), lte(stripeSync.leaseUntil, new Date())))).returning().get();
    if (!updated) return Response.json({ error: 'Operation changed; reload before reconciling' }, { status: 409 });
    await db.update(stripeOperations).set({ stripeId, outcome: 'administrator_reconciled', updatedAt: new Date() }).where(eq(stripeOperations.id, operation));
    return Response.json({ reconciled: true, stripeId });
  } catch {
    return Response.json({ error: 'Reconciliation failed; the journal is retained. Retry after checking the database and Stripe.' }, { status: 500 });
  }
};
