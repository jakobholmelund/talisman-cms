import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { VariantChangeError, runVariantChange } from '../variants';

/** The product editor's variant configurator: save a value with its stock, delete a value or a group. */
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
    return Response.json({ error: 'Invalid variant change' }, { status: 400, headers });
  }
  try {
    const { env } = await import('cloudflare:workers');
    const result = await runVariantChange(env as unknown as TalismanEnv, body);
    return Response.json({ result }, { headers });
  } catch (error) {
    if (error instanceof VariantChangeError) {
      return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status, headers });
    }
    // A database error names the statement that failed, which stays in the logs.
    console.error('[commerce] Variant change failed', error instanceof Error
      ? { name: error.name, message: error.message } : { name: typeof error });
    return Response.json({ error: 'The variant change could not be saved. Check the server logs for details.' },
      { status: 500, headers });
  }
};
