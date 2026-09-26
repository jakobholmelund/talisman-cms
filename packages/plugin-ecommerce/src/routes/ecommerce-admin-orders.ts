import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { getOrderAdjustmentsAdmin, OrderAdjustmentInputError, OrderAdjustmentRefusedError,
  restockOrder } from '../order-adjustments';

/**
 * The orders screen's disputes and restocks: POST `{ action: 'list', orderIds }` reads the disputes and
 * stock of those orders, and `{ action: 'restock', orderId, reason, reservations? }` returns a refunded
 * order's stock. Order ids stay in the request body, out of request logs.
 */
export const ALL: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, 'admin');
  if (authorization.response) return authorization.response;
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403, headers });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid order action' }, { status: 400, headers });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Invalid order action' }, { status: 400, headers });
  }
  const { action, ...input } = body as Record<string, unknown>;
  if (action !== 'list' && action !== 'restock') {
    return Response.json({ error: 'Invalid order action' }, { status: 400, headers });
  }
  try {
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv;
    if (action === 'list') return Response.json(await getOrderAdjustmentsAdmin(runtimeEnv, input), { headers });
    const result = await restockOrder(runtimeEnv, String(authorization.user?.id ?? ''), input);
    return Response.json({ result }, { headers });
  } catch (error) {
    if (error instanceof OrderAdjustmentInputError) {
      return Response.json({ error: error.message }, { status: 400, headers });
    }
    // A restock refused for the order's state: the message says why.
    if (error instanceof OrderAdjustmentRefusedError) {
      return Response.json({ error: error.message }, { status: 409, headers });
    }
    // Anything else, such as a database error, stays in the logs.
    const reading = action === 'list';
    console.error(reading ? '[commerce] Order adjustments could not be read' : '[commerce] Restock failed',
      error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error });
    return Response.json({ error: reading ? 'The orders could not be read. Check the server logs for details.'
      : 'The restock failed. Check the server logs for details.' }, { status: 500, headers });
  }
};
