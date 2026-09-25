import type { APIRoute } from 'astro';
import { authAdapter, authConfigured } from 'virtual:talisman-cms/auth';

export const GET: APIRoute = async ({ request }) => {
  const isDevAuth = authAdapter?.__talismanAuthRuntime?.moduleId === 'talisman-cms/auth/dev';
  const isAccessAuth = authAdapter?.__talismanAuthRuntime?.moduleId === 'talisman-cms/auth/access';
  const isHybridAuth = authAdapter?.__talismanAuthRuntime?.moduleId === 'talisman-cms/auth/hybrid';
  if (authConfigured && !authAdapter) {
    return new Response(JSON.stringify({ error: 'Auth adapter could not be loaded at runtime' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  if (!authAdapter) {
    return new Response(JSON.stringify({ user: null, isDevAuth, isAccessAuth, isHybridAuth }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  const user = await authAdapter.getUser(request);
  if (!user) {
    return new Response(JSON.stringify({ user: null, isDevAuth, isAccessAuth, isHybridAuth }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  return new Response(JSON.stringify({ user, isDevAuth, isAccessAuth, isHybridAuth }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
};
