import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { runtimePaymentAdapters } from '../runtime';
import { getGiftCardBalance, startGiftCardPurchase } from '../gift-cards';

export const POST: APIRoute = async ({ request, cookies }) => {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403, headers });
  }
  try {
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
    const body = await request.json() as Record<string, unknown> | null;
    if (body && typeof body === 'object' && body.action === 'balance' && typeof body.code === 'string') {
      return Response.json(await getGiftCardBalance(runtimeEnv, body.code), { headers });
    }
    if (runtimeEnv.GALAXY_COMMERCE_CHECKOUT_ENABLED !== 'true' ||
      runtimeEnv.GALAXY_COMMERCE_GIFT_CARDS_ENABLED !== 'true') {
      return Response.json({ error: 'Gift card purchases are unavailable' }, { status: 503, headers });
    }
    const adapter = runtimePaymentAdapters(runtimeEnv).find(provider => provider.providerId === 'stripe');
    if (!adapter) return Response.json({ error: 'Stripe is not configured' }, { status: 503, headers });
    const origin = new URL(request.url).origin;
    const purchase = await startGiftCardPurchase(runtimeEnv, adapter, body, {
      successUrl: `${origin}/gift-cards/success?purchase={PURCHASE_ID}`,
      cancelUrl: `${origin}/gift-cards?cancelled=1`,
    });
    cookies.set(`talisman-gift-${purchase.id}`, purchase.accessToken, {
      httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:',
      path: '/gift-cards', maxAge: 7 * 24 * 60 * 60,
    });
    return Response.json({ purchaseId: purchase.id, redirectUrl: purchase.paymentUrl }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not start gift card purchase' },
      { status: 400, headers });
  }
};
