// @ts-ignore
import type { APIRoute } from 'astro';
import { getClient } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
// @ts-ignore
import { env as cfEnv } from 'cloudflare:workers';

const getSafeData = (data: any) => {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch (e) { return {}; }
  }
  return data || {};
};

export const GET: APIRoute = async () => {
  try {
    const env = { DB: (cfEnv as any).DB, KV: (cfEnv as any).KV };
    const client = getClient(env as any);
    const themeGlobal = await client.globals.find('daisyui-theme');
    
    return new Response(JSON.stringify(getSafeData(themeGlobal?.data)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }: { request: Request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) return authorization.response;

  try {
    const body = await request.json();
    const env = { DB: (cfEnv as any).DB, KV: (cfEnv as any).KV };
    const client = getClient(env as any);
    
    const updated = await client.globals.update('daisyui-theme', body);
    
    return new Response(JSON.stringify(getSafeData(updated?.data)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
