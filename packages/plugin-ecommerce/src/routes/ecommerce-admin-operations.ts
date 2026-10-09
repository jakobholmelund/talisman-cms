import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { ZodError } from 'zod';
import { CommerceOperationsConflict, readOrderWarehouse, recordParcelContents, receiveOrderReturn, listStockLocations, readStockHistory, recordStockMovement, listEmailRecovery, readCommerceAttention, readStockOverview, retryCommerceEmail } from '../operations';

export const ALL: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, 'admin');
  if (authorization.response) return authorization.response;
  const headers = { 'Cache-Control': 'no-store' };
  if (!['GET', 'POST'].includes(request.method)) return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  const url = new URL(request.url);
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403, headers });
  }
  try {
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv;
    if (request.method === 'GET') {
      const { view, ...params } = Object.fromEntries(url.searchParams);
      if (view === 'attention') return Response.json(await readCommerceAttention(runtimeEnv), { headers });
      if (view === 'emails') return Response.json(await listEmailRecovery(runtimeEnv, params), { headers });
      if (view === 'stockLocations') return Response.json(await listStockLocations(runtimeEnv, params), { headers });
      if (view === 'stockHistory') return Response.json(await readStockHistory(runtimeEnv, params), { headers });
      if (view === 'stock') return Response.json(await readStockOverview(runtimeEnv, { ...params, view: params.inventory }), { headers });
      return Response.json({ error: 'Choose an operations view' }, { status: 400, headers });
    }
    let body: { action?: string; data?: unknown };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers }); }
    const actor = String(authorization.user?.id ?? '');
    if (body?.action === 'warehouseRead') return Response.json(await readOrderWarehouse(runtimeEnv, body.data), { headers });
    const actions = { retryEmail: retryCommerceEmail, parcelContents: recordParcelContents, receiveReturn: receiveOrderReturn, stockMovement: recordStockMovement };
    const action = body?.action as keyof typeof actions;
    if (!Object.hasOwn(actions, action)) return Response.json({ error: 'Invalid operations action' }, { status: 400, headers });
    return Response.json({ result: await actions[action](runtimeEnv, body.data, actor) }, { headers });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: 'Check the supplied fields and give a reason of 8 to 500 characters.' }, { status: 400, headers });
    if (error instanceof CommerceOperationsConflict) return Response.json({ error: error.message }, { status: 409, headers });
    console.error('[commerce:operations] Request failed', error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.name : 'Unknown error');
    return Response.json({ error: 'Commerce operations could not be loaded or saved. Try again.' }, { status: 500, headers });
  }
};
