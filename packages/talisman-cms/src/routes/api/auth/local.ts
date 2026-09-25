import type { APIRoute } from 'astro';
import { authAdapter } from 'virtual:talisman-cms/auth';

export const ALL: APIRoute = async ({ request }) => {
  if (!authAdapter?.handle) {
    return Response.json({ error: 'Local authentication is not configured' }, { status: 404 });
  }
  return authAdapter.handle(request);
};
