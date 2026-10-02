import type { APIRoute } from 'astro';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { readSetting } from 'talisman-cms/env';
import { parsePeriod } from '../cloudflare';
import { privateJson, reportCache, scopeKey } from './support';
import { fetchCommerceOverview, type CommerceOverview } from '../commerce';
// Provided by the Talisman CMS integration during the server build.
// @ts-ignore
import { collections } from 'virtual:talisman-cms/config';

const cachedReport = reportCache<CommerceOverview>();

export const GET: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, 'admin');
  if (authorization.response) { authorization.response.headers.set('Cache-Control', 'no-store'); return authorization.response; }
  try {
    const { env } = await import('cloudflare:workers');
    const db = (env as { DB?: D1Database }).DB;
    if (!db) return privateJson({ error: 'D1 binding DB is required for Commerce analytics.' }, 503);
    const days = parsePeriod(new URL(request.url).searchParams.get('days'));
    const adminBase = new URL(request.url).pathname.split('/api/analytics/')[0];
    const productCollection = (collections as Array<{ slug: string; nativeSchemaMapping?: { schemaPath?: string; exportName?: string } }>).find(
      collection => collection.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema' &&
        collection.nativeSchemaMapping?.exportName === 'products'
    );
    // Live only when the setting is `live`, as in plugin-ecommerce. In test mode, test-mode orders are reported.
    const stripeMode = readSetting(env, 'COMMERCE_STRIPE_MODE') === 'live' ? 'live' : 'test';
    const data = await cachedReport(JSON.stringify([scopeKey(env as Record<string, unknown>, adminBase), productCollection?.slug, days]),
      () => fetchCommerceOverview(db, days, adminBase, productCollection?.slug || 'products', stripeMode));
    return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return privateJson({ error: 'Commerce analytics are unavailable. Check ecommerce migrations or try again later.' }, 502);
  }
};
