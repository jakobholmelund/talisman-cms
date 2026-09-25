// @ts-ignore
import type { APIRoute } from 'astro';
import { getClient } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
// @ts-ignore
import { env as cfEnv } from 'cloudflare:workers';
import { sanitizeThemeSettings } from '../components/theme-css';

const getSafeData = (data: any) => {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch (e) { return {}; }
  }
  return data || {};
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

export const GET: APIRoute = async ({ request }: { request: Request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) return authorization.response;

  try {
    const env = { DB: (cfEnv as any).DB, KV: (cfEnv as any).KV };
    const client = getClient(env as any);
    const themeGlobal = await client.globals.find('daisyui-theme');

    return json(sanitizeThemeSettings(getSafeData(themeGlobal?.data)).settings);
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
};

// Any CMS user may save, matching the core globals endpoint that can also write this global.
// Stored values are validated here and again when the theme is rendered.
export const POST: APIRoute = async ({ request }: { request: Request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) return authorization.response;

  // A JSON body cannot be sent cross-site without a CORS preflight, which this endpoint never grants.
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json({ error: 'Expected an application/json body' }, 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { settings, rejected } = sanitizeThemeSettings(body);
  if (rejected.length > 0) {
    return json({ error: 'Invalid theme values', fields: rejected }, 400);
  }

  try {
    const env = { DB: (cfEnv as any).DB, KV: (cfEnv as any).KV };
    const client = getClient(env as any);

    const updated = await client.globals.update('daisyui-theme', settings);

    return json(sanitizeThemeSettings(getSafeData(updated?.data)).settings);
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
};
