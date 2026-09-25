import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  try {
    // import.meta.glob from a plugin brilliantly resolves to the Vite root of the host project
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
