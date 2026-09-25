import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { createDiscountCode, getPromotionsAdmin, saveReferralSettings,
  setReferralCodeActive, updateDiscountCode } from '../promotions';

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
  try {
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv;
    if (request.method === 'GET') return Response.json(await getPromotionsAdmin(runtimeEnv), { headers });
    const body = await request.json() as { action?: string; code?: string; data?: unknown };
    let result: unknown;
    if (body.action === 'saveReferral') result = await saveReferralSettings(runtimeEnv, body.data);
    else if (body.action === 'setReferralCodeActive' && typeof body.code === 'string') {
      result = await setReferralCodeActive(runtimeEnv, body.code,
        (body.data as { active?: unknown } | null)?.active as boolean);
    }
    else if (body.action === 'createCode') result = await createDiscountCode(runtimeEnv, body.data);
    else if (body.action === 'updateCode' && typeof body.code === 'string') {
      result = await updateDiscountCode(runtimeEnv, body.code, body.data);
    } else return Response.json({ error: 'Invalid promotion action' }, { status: 400, headers });
    return Response.json({ result }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Promotion could not be saved' },
      { status: 400, headers });
  }
};
