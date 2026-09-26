import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { reconcileCommerce } from '../api';
import { runtimePaymentAdapters } from '../runtime';
import { ReconcileInputError, listParkedCommerce, releaseParkedCommerce,
  retryParkedCommerce } from '../reconcile-review';

/**
 * GET lists the pending orders and gift card purchases parked for review. POST without an action runs
 * reconciliation, as before actions existed; `{ action: 'retry' | 'release', kind, id, reason }` acts on
 * one parked record and records the administrator and the reason. A release may add
 * `confirmPaymentReturned` (see releaseParkedCommerce).
 */
export const ALL: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, 'admin');
  if (authorization.response) return authorization.response;
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'GET' && request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403, headers });
  }
  let action: unknown;
  try {
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
    if (request.method === 'GET') return Response.json(await listParkedCommerce(runtimeEnv), { headers });
    // An empty body runs reconciliation too, as it did before this route took actions.
    const text = await request.text();
    const body = text.trim() ? JSON.parse(text) as unknown : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid reconciliation action' }, { status: 400, headers });
    }
    const { action: requested, ...input } = body as Record<string, unknown>;
    action = requested;
    const paymentAdapters = runtimePaymentAdapters(runtimeEnv);
    if (action === undefined) {
      const results = await reconcileCommerce({ env: runtimeEnv, paymentAdapters });
      return Response.json({ results }, { headers });
    }
    const actor = String(authorization.user?.id ?? '');
    let result: unknown;
    if (action === 'retry') result = await retryParkedCommerce(runtimeEnv, actor, input);
    else if (action === 'release') result = await releaseParkedCommerce({ env: runtimeEnv, paymentAdapters }, actor, input);
    else return Response.json({ error: 'Invalid reconciliation action' }, { status: 400, headers });
    return Response.json({ result }, { headers });
  } catch (error) {
    const invalid = error instanceof ReconcileInputError || error instanceof SyntaxError;
    const fallback = request.method === 'GET' ? 'Parked records could not be listed' : 'Reconciliation failed';
    return Response.json({ error: error instanceof Error ? error.message : fallback },
      { status: invalid ? 400 : request.method === 'GET' || action === undefined ? 500 : 409, headers });
  }
};
