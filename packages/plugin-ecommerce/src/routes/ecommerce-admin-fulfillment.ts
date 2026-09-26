import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { correctCommerceFulfillment, fulfillCommerceOrder, FulfillmentInputError,
  listCommerceOrdersAdmin, type OrdersView } from '../fulfillment';

type ListOptions = Parameters<typeof listCommerceOrdersAdmin>[1];

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
  let reading = request.method === 'GET';
  try {
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv;
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const limit = params.get('limit');
      return Response.json(await listCommerceOrdersAdmin(runtimeEnv, {
        view: (params.get('view') || undefined) as OrdersView | undefined,
        cursor: params.get('cursor') || undefined,
        limit: limit ? Number(limit) : undefined,
        query: params.get('query') || undefined,
      }), { headers });
    }
    const body = await request.json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid fulfillment action' }, { status: 400, headers });
    }
    const { action, ...input } = body as Record<string, unknown>;
    // The same page as GET, read from the body: the admin screen reads the queue this way, so an
    // email address it searches for stays out of request URLs and the request logs that keep them.
    if (action === 'list') {
      reading = true;
      return Response.json(await listCommerceOrdersAdmin(runtimeEnv, input as ListOptions), { headers });
    }
    const actor = String(authorization.user?.id ?? '');
    let result: unknown;
    // A body without an action that names an order records a shipment, as before actions existed.
    if (action === 'ship' || (action === undefined && 'orderId' in input)) {
      result = await fulfillCommerceOrder(runtimeEnv, actor, input);
    } else if (action === 'correct') result = await correctCommerceFulfillment(runtimeEnv, actor, input);
    else return Response.json({ error: 'Invalid fulfillment action' }, { status: 400, headers });
    return Response.json({ result }, { headers });
  } catch (error) {
    const invalid = error instanceof FulfillmentInputError || error instanceof SyntaxError;
    return Response.json({ error: error instanceof Error ? error.message : 'Order fulfillment failed' },
      { status: invalid ? 400 : reading ? 500 : 409, headers });
  }
};
