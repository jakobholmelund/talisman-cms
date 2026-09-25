import type { APIRoute } from 'astro';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { readSetting } from 'talisman-cms/env';
import { parsePeriod } from '../cloudflare';
import { fetchCommerceOverview } from '../commerce';
// Provided by the Talisman CMS integration during the server build.
// @ts-ignore
import { collections } from 'virtual:talisman-cms/config';

export const GET: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, 'admin');
  if (authorization.response) return authorization.response;
  try {
    const { env } = await import('cloudflare:workers');
    const db = (env as { DB?: D1Database }).DB;
    if (!db) return Response.json({ error: 'D1 binding DB is required for Commerce analytics.' }, { status: 503 });
    const days = parsePeriod(new URL(request.url).searchParams.get('days'));
    const adminBase = new URL(request.url).pathname.split('/api/analytics/')[0];
    const productCollection = (collections as Array<{ slug: string; nativeSchemaMapping?: { schemaPath?: string; exportName?: string } }>).find(
      collection => collection.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema' &&
        collection.nativeSchemaMapping?.exportName === 'products'
    );
    // Live only when the setting is `live`, as in plugin-ecommerce. In test mode, test-mode orders are reported.
    const stripeMode = readSetting(env, 'COMMERCE_STRIPE_MODE') === 'live' ? 'live' : 'test';
    const data = await fetchCommerceOverview(db, days, adminBase, productCollection?.slug || 'products', stripeMode);
    return Response.json(data, { headers: { 'Cache-Control': 'private, max-age=120' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Commerce analytics unavailable' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
};
