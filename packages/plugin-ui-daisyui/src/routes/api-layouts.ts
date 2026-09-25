import type { APIRoute } from 'astro';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';

export const GET: APIRoute = async ({ request }: { request: Request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) return authorization.response;

  try {
    // Absolute glob paths resolve against the host project's Vite root, not this package.
    const layouts = import.meta.glob('/src/layouts/*.astro');
    const layoutPaths = Object.keys(layouts);

    return new Response(JSON.stringify({ layouts: layoutPaths }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
