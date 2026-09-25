import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { readSetting } from 'talisman-cms/env';
import { isEmailDeliveryError, parseAddress, sendEmail } from 'talisman-cms/email';
import { getEmailProvider } from 'talisman-cms/email/runtime';
import { bindCommerceApi } from '../api';
import { CUSTOMER_SESSION_COOKIE, CUSTOMER_SESSION_MAX_AGE,
  consumeCustomerEmailSignIn, findCustomerSession, requestCustomerEmailSignIn,
  revokeCustomerSession } from '../accounts';
import { CART_SESSION_COOKIE, LEGACY_CART_SESSION_COOKIE, readCartSessionToken } from '../cookies';
import { shopperSignInEmail } from '../emails';

function originOf(value: string | undefined) {
  try {
    return value ? new URL(value).origin : undefined;
  } catch {
    return undefined;
  }
}

export const ALL: APIRoute = async ({ request, cookies }) => {
  const { env } = await import('cloudflare:workers');
  const runtimeEnv = env as unknown as TalismanEnv;
  const sessionToken = cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const headers = { 'Cache-Control': 'no-store' };

  if (request.method === 'GET') {
    const account = await findCustomerSession(runtimeEnv, sessionToken);
    return Response.json({ account: account ? { id: account.id, email: account.email, name: account.name } : null }, { headers });
  }

  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403, headers });
  }
  if (request.method === 'DELETE') {
    await revokeCustomerSession(runtimeEnv, sessionToken);
    cookies.delete(CUSTOMER_SESSION_COOKIE, { path: '/' });
    cookies.delete(CART_SESSION_COOKIE, { path: '/' });
    cookies.delete(LEGACY_CART_SESSION_COOKIE, { path: '/' });
    return Response.json({ account: null }, { headers });
  }
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });

  const body = await request.json().catch(() => null) as {
    basketChoice?: unknown; orderId?: unknown; email?: unknown; token?: unknown
  } | null;
  const basketToken = readCartSessionToken(cookies);
  if (typeof body?.email === 'string') {
    const settings = runtimeEnv as TalismanEnv & Record<string, unknown>;
    const provider = getEmailProvider(settings);
    const from = readSetting(settings, 'COMMERCE_EMAIL_FROM') ?? readSetting(settings, 'EMAIL_FROM');
    const publicOrigin = originOf(readSetting(settings, 'COMMERCE_PUBLIC_ORIGIN') ?? readSetting(settings, 'PUBLIC_ORIGIN'));
    // Links use the configured origin, never the Host header, and only on that origin.
    if (!provider || !from || publicOrigin !== new URL(request.url).origin) {
      console.error('[commerce] Email sign-in is not configured', {
        provider: provider?.id ?? null, from: Boolean(from),
        publicOrigin: !publicOrigin ? 'missing' : publicOrigin === new URL(request.url).origin ? 'ok' : 'mismatch',
      });
      return Response.json({ error: 'Email sign-in is unavailable' }, { status: 503, headers });
    }
    const siteName = parseAddress(from)?.name ?? new URL(publicOrigin).host;
    try {
      await requestCustomerEmailSignIn(runtimeEnv, body.email,
        // The token travels in the fragment, so it never reaches the server or its request logs.
        token => `${publicOrigin}/account/verify#token=${encodeURIComponent(token)}`,
        async (to, link) => {
          await sendEmail(settings, { to, from, ...shopperSignInEmail({ link, siteName }) }, provider);
        }, request.headers.get('cf-connecting-ip'));
      return Response.json({ accepted: true }, { headers });
    } catch (error) {
      if (error instanceof Error && error.message === 'Valid email required') {
        return Response.json({ error: error.message }, { status: 400, headers });
      }
      if (error instanceof Error && error.name === 'CustomerEmailLimitError') {
        console.warn('[commerce] Daily sign-in email limit reached');
        return Response.json({ error: 'Too many sign-in emails were requested today. Please try again later.' },
          { status: 503, headers });
      }
      // Logs carry codes only: never the address, the link or the token.
      if (isEmailDeliveryError(error)) {
        const details = { provider: error.provider, code: error.code, providerCode: error.providerCode ?? null };
        // A suppressed address gets the same answer as any other, so suppression status does not leak.
        if (error.code === 'recipient_suppressed') {
          console.warn('[commerce] Sign-in email suppressed', details);
          return Response.json({ accepted: true }, { headers });
        }
        console.error('[commerce] Sign-in email failed', details);
      } else {
        console.error('[commerce] Sign-in email failed', { name: error instanceof Error ? error.name : typeof error });
      }
      return Response.json({ error: 'The sign-in email could not be sent. Please try again later.' }, { status: 503, headers });
    }
  }
  if (typeof body?.token === 'string') {
    const result = await consumeCustomerEmailSignIn(runtimeEnv, body.token);
    if (!result) return Response.json({ error: 'Sign-in link is invalid or expired' }, { status: 400, headers });
    await revokeCustomerSession(runtimeEnv, sessionToken);
    cookies.set(CUSTOMER_SESSION_COOKIE, result.token, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:',
      maxAge: CUSTOMER_SESSION_MAX_AGE,
    });
    return Response.json({ account: { id: result.account.id, email: result.account.email, name: result.account.name } }, { headers });
  }
  if (body?.basketChoice === 'browser' || body?.basketChoice === 'account') {
    const customer = await findCustomerSession(runtimeEnv, sessionToken);
    if (!customer || !basketToken) return Response.json({ error: 'Shopper session required' }, { status: 401, headers });
    try {
      const cart = await bindCommerceApi({ env: runtimeEnv }).carts.claim(basketToken, customer.id, body.basketChoice);
      return Response.json({ cart }, { headers });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Basket could not be linked' }, { status: 409, headers });
    }
  }
  return Response.json({ error: 'Invalid account action' }, { status: 400, headers });
};
