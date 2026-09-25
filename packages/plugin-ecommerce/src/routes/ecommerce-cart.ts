import type { APIRoute } from 'astro';
import { bindCommerceApi } from '../api';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '../accounts';
import { ensureCartSession } from '../cookies';
import type { TalismanEnv } from 'talisman-cms/client';

export const ALL: APIRoute = async ({ request, cookies }) => {
  // Reuse the basket cookie, adopting one set under the legacy name, or mint a new one
  const sessionToken = ensureCartSession(cookies, new URL(request.url).protocol === 'https:');

  try {
    const { env } = await import('cloudflare:workers');
    // In a real scenario you would pass registered payment adapters from the plugin config
    const api = bindCommerceApi({ env: env as unknown as TalismanEnv });
    const customer = await findCustomerSession(env as unknown as TalismanEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);

    if (request.method === 'GET') {
      const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
      return new Response(JSON.stringify(cart), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'POST') {
      if (request.headers.get('origin') !== new URL(request.url).origin) {
        return Response.json({ error: 'Same-origin request required' }, { status: 403 });
      }
      const body = await request.json() as any;
      
      const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
      if (!cart) {
         return new Response(JSON.stringify({ error: 'Failed to find or create cart' }), { status: 500 });
      }
      
      const updated = await api.carts.updateItems(cart.id, body.items);
      
      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  } catch (error: any) {
    if (
      error.message === 'Cart is closed' ||
      error.message === 'Basket belongs to another account' ||
      error.message?.startsWith('Both baskets have items') ||
      error.message?.startsWith('Basket changed during account upgrade') ||
      error.message === 'Checkout already started for this cart' ||
      error.message?.startsWith('Basket changed or checkout') ||
      error.message?.startsWith('Insufficient stock for ')
    ) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (error.message?.startsWith('Cart items must') || error.message === 'Duplicate cart items are not allowed') {
      return Response.json({ error: error.message }, { status: 400 });
    }

    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};
