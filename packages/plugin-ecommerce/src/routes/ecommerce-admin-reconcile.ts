import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { reconcileCommerce } from '../api';
import { runtimePaymentAdapters } from '../runtime';

export const POST: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, 'admin');
  if (authorization.response) return authorization.response;
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403 });
  }
  try {
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
    const results = await reconcileCommerce({ env: runtimeEnv,
      paymentAdapters: runtimePaymentAdapters(runtimeEnv) });
    return Response.json({ results }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Reconciliation failed' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
};
